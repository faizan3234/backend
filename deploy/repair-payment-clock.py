#!/usr/bin/env python3
"""Operator clock repair. Run only while no checkup/payment/dispensing is active."""
import argparse
import datetime as dt
import os
import subprocess
import time


def run(*args):
    return subprocess.run(args, check=True, text=True, capture_output=True).stdout.strip()


def utc_value(value):
    try:
        return dt.datetime.strptime(value, '%Y-%m-%d %H:%M:%S').replace(tzinfo=dt.timezone.utc)
    except ValueError as error:
        raise argparse.ArgumentTypeError('Use current UTC: YYYY-MM-DD HH:MM:SS (not Indian local time)') from error


def save_rtc():
    # Never enable charging or change battery voltage: hardware must be appropriate.
    run('hwclock', '--systohc', '--utc')
    print('Corrected system time saved to RTC. RTC reading:', run('hwclock', '--show', '--utc'))
    print('A working backup battery is required to retain RTC time when power is removed.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--sync', action='store_true', help='Temporarily connected to Internet: wait for NTP, then save RTC')
    mode.add_argument('--set-utc', type=utc_value, help='Offline: set operator-verified current UTC, then save RTC')
    parser.add_argument('--idle-confirmed', action='store_true', help='Operator confirmed no active customer operation')
    args = parser.parse_args()
    if args.sync or args.set_utc:
        if os.geteuid() != 0 or not args.idle_confirmed:
            parser.error('Repair requires sudo and --idle-confirmed. Finish active customer operations first.')
        if args.sync:
            run('timedatectl', 'set-ntp', 'true')
            deadline = time.monotonic() + 60
            while run('timedatectl', 'show', '-p', 'NTPSynchronized', '--value') != 'yes':
                if time.monotonic() >= deadline:
                    raise RuntimeError('NTP did not synchronize. RTC was NOT overwritten. Connect Pi to Internet or use verified --set-utc.')
                time.sleep(2)
        else:
            run('timedatectl', 'set-ntp', 'false')
            run('timedatectl', 'set-time', args.set_utc.strftime('%Y-%m-%d %H:%M:%S UTC'))
        print('System UTC:', run('date', '-u', '+%Y-%m-%d %H:%M:%S UTC'))
        try:
            save_rtc()
        except subprocess.CalledProcessError as error:
            raise RuntimeError('System clock corrected, but RTC could not be saved. Not a persistent fix: check RTC hardware/configuration.') from error
        print('Restart the backend using your usual launcher, then start a NEW checkup/QR. Never repay a charged order.')
    else:
        print('System UTC:', run('date', '-u', '+%Y-%m-%d %H:%M:%S UTC'))
        print(run('timedatectl', 'status'))
        try:
            print('RTC:', run('hwclock', '--show', '--utc'))
        except subprocess.CalledProcessError:
            print('RTC unreadable. Run with sudo and inspect the RTC/battery.')
        print('Offline software cannot verify current UTC by itself. Compare with an accurate phone or trusted clock.')
        print('Matching system/RTC readings do NOT prove a backup battery works. Test after a full power disconnect.')


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, subprocess.CalledProcessError, FileNotFoundError) as error:
        raise SystemExit(f'Clock repair incomplete: {error}')
