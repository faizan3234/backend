#!/usr/bin/python3
"""Narrow root helper: JSON stdin only. Never execute caller-supplied commands."""
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid

CONFIG = Path('/etc/reliv-wifi.json')
STATE = Path('/var/lib/reliv-wifi/state.json')
PROFILES = Path('/run/NetworkManager/system-connections')
SELF = '/usr/local/libexec/reliv-wifi-helper'
ACTIVE = {'scheduled', 'connecting', 'connected', 'restoring', 'restore_failed'}


def run(*args, timeout=30):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout,
                            env={**os.environ, 'LC_ALL': 'C'})
    if result.returncode:
        # nmcli diagnostics may contain network names; credentials never enter argv.
        raise RuntimeError('NetworkManager/systemd operation failed. Check Pi service logs.')
    return result.stdout.strip()


def nm(*args, **kwargs):
    return run('/usr/bin/nmcli', *args, **kwargs)


def read_state():
    return json.loads(STATE.read_text()) if STATE.exists() else {'phase': 'idle'}


def save(state):
    STATE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temp = STATE.with_suffix('.tmp')
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(state, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, STATE)
    fd = os.open(STATE.parent, os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def validate(data):
    ssid, password = data.get('ssid'), data.get('password', '')
    if not isinstance(ssid, str) or not 1 <= len(ssid.encode()) <= 32 or any(ord(c) < 32 for c in ssid):
        raise ValueError('Enter a network name of 1–32 bytes.')
    if data.get('security') not in ('personal', 'open') or not isinstance(password, str):
        raise ValueError('Choose a personal or open network.')
    if any(ord(c) < 32 for c in password):
        raise ValueError('Password contains unsupported characters.')
    if data['security'] == 'personal' and not (8 <= len(password.encode()) <= 63 or re.fullmatch('[a-fA-F0-9]{64}', password)):
        raise ValueError('Enter the Wi-Fi password (8–63 bytes or 64 hex digits).')
    if data.get('minutes') not in (5, 10, 20) or data.get('acknowledged') is not True:
        raise ValueError('Choose a maintenance duration and confirm the kiosk is idle.')
    if not isinstance(data.get('hidden', False), bool):
        raise ValueError('Invalid hidden-network option.')
    return ssid, password


def keyfile(data, job, interface):
    ssid, password = validate(data)
    # Byte-list SSID and escaped keyfile string preserve spaces, colons and slashes.
    encoded = ''.join(str(b) + ';' for b in ssid.encode())
    psk = password.replace('\\', '\\\\').replace(' ', '\\s')
    value = (f'[connection]\nid=Reliv maintenance\nuuid={job}\ntype=wifi\ninterface-name={interface}\nautoconnect=false\n'
             f'[wifi]\nmode=infrastructure\nssid={encoded}\nhidden={str(data.get("hidden", False)).lower()}\n'
             '[ipv4]\nmethod=auto\n[ipv6]\nmethod=auto\n')
    if data['security'] == 'personal':
        value += f'[wifi-security]\nkey-mgmt=wpa-psk\npsk={psk}\n'
    return value


def unit(job, suffix):
    return 'reliv-wifi-' + job + '-' + suffix


def timer(job, suffix, delay, mode):
    run('/usr/bin/systemd-run', '--quiet', '--collect', '--unit=' + unit(job, suffix),
        '--on-active=' + str(delay) + 's', '--timer-property=AccuracySec=1s',
        '--property=Restart=on-failure', '--property=RestartSec=15s', SELF, mode, job)


def current_uuid(interface):
    return nm('-g', 'GENERAL.CON-UUID', 'device', 'show', interface)


def restore(config, expected=None):
    state = read_state()
    if state.get('phase') not in ACTIVE or (expected and state.get('job') != expected):
        return state
    job = state['job']
    state['phase'] = 'restoring'
    save(state)
    # Stop both a queued timer and a running nmcli connect before restoring the AP.
    try:
        run('/usr/bin/systemctl', 'stop', unit(job, 'apply') + '.timer', unit(job, 'apply') + '.service')
    except RuntimeError:
        pass  # Transient units may already be collected or absent after reboot.
    try:
        if current_uuid(config['clientInterface']) == job:
            nm('connection', 'down', 'uuid', job)
        nm('connection', 'delete', 'uuid', job)
    except RuntimeError:
        pass  # May have rebooted before the temporary profile was loaded.
    (PROFILES / (job + '.nmconnection')).unlink(missing_ok=True)
    try:
        previous = config['apUuid'] if config['singleAdapter'] else state.get('previousUuid')
        if previous and previous != '--':
            nm('--wait', '45', 'connection', 'up', 'uuid', previous,
               'ifname', config['clientInterface'], timeout=50)
        if config['singleAdapter']:
            # A broker bound to the AP address may have exhausted restart attempts.
            try:
                run('/usr/bin/systemctl', 'is-active', '--quiet', 'mosquitto')
            except RuntimeError:
                run('/usr/bin/systemctl', 'reset-failed', 'mosquitto')
                run('/usr/bin/systemctl', 'start', 'mosquitto')
        state['phase'] = 'restored'
        save(state)
        return state
    except Exception:
        state['phase'] = 'restore_failed'
        save(state)
        raise RuntimeError('Automatic restoration is retrying. Check the Pi locally.')


def schedule(config, data):
    validate(data)
    if read_state().get('phase') in ACTIVE:
        raise ValueError('A Wi-Fi maintenance window is already active.')
    if nm('-g', '802-11-wireless.mode', 'connection', 'show', 'uuid', config['apUuid']) != 'ap':
        raise RuntimeError('The saved kiosk access point is unavailable.')
    job = str(uuid.uuid4())
    state = {'phase': 'scheduled', 'job': job, 'ssid': data['ssid'], 'singleAdapter': config['singleAdapter'],
             'previousUuid': current_uuid(config['clientInterface']), 'startsAt': int(time.time()*1000)+12000,
             'returnsAt': int(time.time()*1000)+data['minutes']*60000}
    save(state)  # Persistent boot recovery exists before any network change.
    try:
        timer(job, 'return', data['minutes']*60, '--restore')
        PROFILES.mkdir(parents=True, exist_ok=True)
        path = PROFILES / (job + '.nmconnection')
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as stream:
            stream.write(keyfile(data, job, config['clientInterface']))
        nm('connection', 'load', str(path))
        timer(job, 'apply', 12, '--apply')
        return state
    except Exception:
        # The return timer / boot recovery remains authoritative if cleanup fails.
        restore(config, job)
        raise


def apply(config, job):
    state = read_state()
    if state.get('job') != job or state.get('phase') != 'scheduled':
        return
    state['phase'] = 'connecting'
    save(state)
    try:
        nm('--wait', '90', 'connection', 'up', 'uuid', job, 'ifname', config['clientInterface'], timeout=95)
        if current_uuid(config['clientInterface']) != job:
            raise RuntimeError('Connection did not become active.')
        state = read_state()
        if state.get('job') == job and state['phase'] == 'connecting':
            state['phase'] = 'connected'
            save(state)
    except Exception:
        # Separate worker: restore must stop this apply unit without killing itself.
        run('/usr/bin/systemd-run', '--quiet', '--collect', '--unit=' + unit(job, 'failed'),
            '--property=Restart=on-failure', '--property=RestartSec=15s', SELF, '--restore', job)


def split_line(line):
    result, part, escaped = [], '', False
    for char in line:
        if escaped:
            part += char
            escaped = False
        elif char == '\\':
            escaped = True
        elif char == ':':
            result.append(part)
            part = ''
        else:
            part += char
    return result + [part]


def status(config):
    interface = config['clientInterface']
    active = current_uuid(interface)
    ssid = nm('-g', '802-11-wireless.ssid', 'connection', 'show', 'uuid', active) if active and active != '--' else ''
    return {'connected': bool(ssid), 'ssid': ssid,
            'ip': nm('-g', 'IP4.ADDRESS', 'device', 'show', interface).split('/')[0],
            'connectivity': nm('-t', '-f', 'CONNECTIVITY', 'general'),
            'singleAdapter': config['singleAdapter'], 'operation': read_state()}


def scan(config):
    # Never force an off-channel scan on the live kiosk AP; use cached observations.
    raw = nm('-t', '-f', 'SSID,SIGNAL,SECURITY', 'device', 'wifi', 'list',
             'ifname', config['clientInterface'], '--rescan', 'no' if config['singleAdapter'] else 'yes')
    networks = {}
    for line in raw.splitlines():
        parts = split_line(line)
        if len(parts) != 3 or not parts[0] or parts[0] == 'RELIV-KIOSK':
            continue
        name, signal, security = parts
        value = {'ssid': name, 'signal': int(signal), 'security': security,
                 'supported': '802.1X' not in security and not ('WPA3' in security and 'WPA2' not in security)}
        if name not in networks or value['signal'] > networks[name]['signal']:
            networks[name] = value
    return sorted(networks.values(), key=lambda item: -item['signal'])


def main():
    config = json.loads(CONFIG.read_text())
    for key in ('apInterface', 'clientInterface'):
        if not re.fullmatch(r'[a-zA-Z0-9_.-]{1,32}', config[key]):
            raise ValueError('Invalid installed interface.')
    if len(sys.argv) == 3 and sys.argv[1] == '--apply':
        uuid.UUID(sys.argv[2])
        apply(config, sys.argv[2])
        return
    Path('/run/reliv-wifi').mkdir(mode=0o700, exist_ok=True)
    with open('/run/reliv-wifi/lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if len(sys.argv) >= 2 and sys.argv[1] == '--restore':
            expected = sys.argv[2] if len(sys.argv) == 3 else None
            if expected:
                uuid.UUID(expected)
            result = restore(config, expected)
        else:
            if len(sys.argv) != 1:
                raise ValueError('Unsupported arguments.')
            data = json.loads(sys.stdin.read(4097))
            command = data.get('command')
            if command == 'status': result = status(config)
            elif command == 'scan': result = scan(config)
            elif command == 'connect': result = schedule(config, data)
            elif command == 'restore': result = restore(config)
            else: raise ValueError('Unsupported command.')
        print(json.dumps({'ok': True, 'result': result}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error) if isinstance(error, (ValueError, RuntimeError)) else 'Wi-Fi helper unavailable; check the Pi installation.'}))
        sys.exit(1)
