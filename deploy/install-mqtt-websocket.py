#!/usr/bin/env python3
"""Add browser MQTT to the confirmed anonymous AP broker; preserve existing config."""
import argparse
import base64
import hashlib
import os
from pathlib import Path
import socket
import subprocess
import time

TARGET = Path('/etc/mosquitto/conf.d/reliv-websocket.conf')
FRAGMENT = '# Reliv browser MQTT; inherits the existing global authentication policy.\nlistener 9001 192.168.50.1\nprotocol websockets\n'

def directives(path, seen=None):
    seen = set() if seen is None else seen
    path = path.resolve()
    if path in seen:
        raise ValueError('Repeated or recursive configuration include: ' + str(path))
    seen.add(path)
    result = []
    for line in path.read_text().splitlines():
        words = line.strip().split()
        if not words or words[0].startswith('#'):
            continue
        if words[0] == 'include_dir':
            if len(words) != 2 or not Path(words[1]).is_absolute():
                raise ValueError('Review nonstandard include_dir manually.')
            for child in sorted(Path(words[1]).glob('*.conf')):
                result.extend(directives(child, seen))
        else:
            result.append((path, words))
    return result

def validate(rows, target=TARGET):
    listeners = []
    anonymous = []
    for path, words in rows:
        key, values = words[0], words[1:]
        if key in {'password_file', 'acl_file', 'plugin', 'auth_plugin', 'global_plugin', 'port', 'bind_address', 'listener_allow_anonymous', 'cafile', 'certfile', 'keyfile', 'psk_file', 'require_certificate'} or key.startswith('auth_opt_'):
            raise ValueError('Custom broker configuration found; preserve it and configure WebSockets manually: ' + key)
        if key == 'per_listener_settings' and values != ['false']:
            raise ValueError('Per-listener authentication needs manual configuration.')
        if key == 'allow_anonymous':
            anonymous.append(values)
        if key == 'listener':
            listeners.append((path, values))
    if not anonymous or any(value != ['true'] for value in anonymous):
        raise ValueError('This installer only supports the confirmed allow_anonymous true broker.')
    tcp = [(path, value) for path, value in listeners if value == ['1883', '192.168.50.1']]
    others = [(path, value) for path, value in listeners if value != ['1883', '192.168.50.1']]
    if len(tcp) != 1 or any(path != target.resolve() or value != ['9001', '192.168.50.1'] for path, value in others) or len(others) > 1:
        raise ValueError('Unexpected/duplicate listeners. No existing configuration was changed.')

def check_listeners():
    # Real anonymous MQTT CONNACK, not just an open TCP socket. No publishing.
    client = b'reliv-install-check'
    body = b'\x00\x04MQTT\x04\x02\x00\x0a' + len(client).to_bytes(2, 'big') + client
    with socket.create_connection(('192.168.50.1', 1883), timeout=3) as conn:
        conn.sendall(b'\x10' + bytes([len(body)]) + body)
        response = b''
        while len(response) < 4:
            part = conn.recv(4 - len(response))
            if not part:
                break
            response += part
        if response != b'\x20\x02\x00\x00':
            raise ValueError('Anonymous MQTT connection was not accepted.')
        conn.sendall(b'\xe0\x00')
    key = base64.b64encode(os.urandom(16)).decode()
    expected = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
    with socket.create_connection(('192.168.50.1', 9001), timeout=3) as conn:
        conn.sendall(('GET / HTTP/1.1\r\nHost: 192.168.50.1:9001\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: mqtt\r\nSec-WebSocket-Key: ' + key + '\r\n\r\n').encode())
        response = b''
        while b'\r\n\r\n' not in response and len(response) < 8192:
            part = conn.recv(1024)
            if not part:
                break
            response += part
        if not response.startswith(b'HTTP/1.1 101 ') or expected.encode() not in response:
            raise ValueError('MQTT WebSocket upgrade failed. Check Mosquitto WebSocket support.')

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Read-only configuration and connection check')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise ValueError('Run with sudo on the Pi.')
    rows = directives(Path('/etc/mosquitto/mosquitto.conf'))
    validate(rows)
    root = Path('/etc/mosquitto/mosquitto.conf').read_text().splitlines()
    if not any(line.strip().split() == ['include_dir', str(TARGET.parent)] for line in root):
        raise ValueError('The main config must already include /etc/mosquitto/conf.d.')
    if args.check or TARGET.exists():
        if TARGET.exists() and TARGET.read_text() != FRAGMENT:
            raise ValueError('Existing reliv-websocket.conf is not managed by this installer; review manually.')
        check_listeners()
        print('MQTT TCP 1883 and browser WebSocket 9001 are reachable.')
        return
    print('Restarting Mosquitto: run only when no measurements or dispensing are active.', flush=True)
    with TARGET.open('x') as output:
        output.write(FRAGMENT)
    TARGET.chmod(0o644)
    try:
        subprocess.run(['systemctl', 'restart', 'mosquitto'], check=True, timeout=30)
        for attempt in range(5):
            try:
                check_listeners()
                break
            except (OSError, ValueError):
                if attempt == 4:
                    raise
                time.sleep(1)
    except Exception:
        TARGET.unlink()
        subprocess.run(['systemctl', 'restart', 'mosquitto'], timeout=30, check=False)
        raise ValueError('Installation failed; removed only the new fragment and restarted the original config. Inspect journalctl -u mosquitto.')
    print('Installed: TCP 1883 + WebSockets 9001 on 192.168.50.1. Existing TCP/auth settings preserved.')

if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        raise SystemExit('ERROR: ' + str(error))
