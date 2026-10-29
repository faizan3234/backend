# Owner Wi-Fi maintenance

Open `http://192.168.50.1/wifi` while your phone is connected to RELIV-KIOSK, and sign in with the local admin account. Requires the matching frontend PR.

## Install on the Pi (once, after merging and pulling)

Run as the Linux user that runs the Node backend:

```bash
cd ~/backend
sudo bash deploy/install-wifi-control.sh
```

Restart the backend using your normal process manager. The installer does not switch Wi-Fi or deploy software. It only supports an existing NetworkManager RELIV-KIOSK AP at 192.168.50.1/24. Re-run the installer after updating its helper code.

1. Finish every customer visit and any pending payment/dispense first.
2. Select a nearby network, or enter your phone hotspot name and password manually.
3. Choose 5, 10 or 20 minutes, confirm the kiosk is idle and press Connect.
4. There is a 12-second delay. If using this same phone, turn on its hotspot now.
5. A single-radio Pi temporarily stops RELIV-KIOSK. The phone page loses contact, ESP32s disconnect, and customer visits are paused. This is expected. Do not repeatedly submit the request.
6. The Pi verifies the actual NetworkManager connection. A failed connection triggers restoration; a successful connection still returns automatically at the selected deadline.
7. Rejoin RELIV-KIOSK on your phone after the deadline. The address returns to 192.168.50.1.

A browser cannot follow arbitrary changes in your phone Wi-Fi settings or automatically toggle its hotspot. Select the network in this page to change the Pi. Phone OS settings remain under your control. A one-radio setup cannot promise uninterrupted ESP32 connections while switching the AP to client mode.

## Keep the kiosk AP available

Use a second physical Wi-Fi adapter supported by your Pi OS, then install with its actual interface name (example):

```bash
sudo bash deploy/install-wifi-control.sh wlan0 wlan1
```

The original AP stays on wlan0 while wlan1 connects. Returning restores the second adapter's previous connection. Virtual interfaces on the same radio are rejected. Network access enables your existing update process; this feature does not automatically merge PRs or run arbitrary update commands.

## Recovery and security

A persistent root-only job record is written before network mutation. A systemd return timer is armed before applying credentials. Boot recovery retries interrupted work. The original AP profile and its credentials are never replaced. Temporary client credentials live in a root-only runtime keyfile and are removed at restoration. No shell interpolation or password arguments are used. Admin authentication protects reads and writes; customer API writes are blocked during single-radio maintenance. This is an owner feature on a trusted local network; HTTP is not encrypted.

Local emergency return (Pi terminal):

```bash
sudo /usr/local/libexec/reliv-wifi-helper --restore
sudo systemctl status reliv-wifi-recover.service
sudo journalctl -u reliv-wifi-recover.service -n 40 --no-pager
sudo ss -lntp | grep -E ':(1883|9001)\b'
```

## Required physical check before unattended use

Test a five-minute window while idle: wrong password → AP returns; correct hotspot → Pi gets Internet → AP returns; reboot during the window → AP returns. Verify both ESP32s reconnect and both MQTT ports listen. Test your update service separately. No physical Pi, hotspot, radio driver, captive-portal reconnection or update deployment was tested remotely.
