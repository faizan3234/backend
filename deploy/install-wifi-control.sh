#!/bin/bash
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Run with sudo.'; exit 1; }
owner=${SUDO_USER:-reliv}
ap=${1:-wlan0}
client=${2:-$ap}
[[ $owner =~ ^[a-z_][a-z0-9_-]*$ && $ap =~ ^[a-zA-Z0-9_.-]+$ && $client =~ ^[a-zA-Z0-9_.-]+$ ]] || exit 1
id "$owner" >/dev/null
command -v nmcli >/dev/null
command -v visudo >/dev/null
ap_uuid=$(nmcli -g GENERAL.CON-UUID device show "$ap")
[[ $(nmcli -g 802-11-wireless.mode connection show uuid "$ap_uuid") == ap ]] || { echo 'RELIV-KIOSK must be an active NetworkManager access point.'; exit 1; }
[[ $(nmcli -g 802-11-wireless.ssid connection show uuid "$ap_uuid") == RELIV-KIOSK ]] || exit 1
nmcli -g IP4.ADDRESS device show "$ap" | grep -q '^192\.168\.50\.1/24$' || { echo 'Expected kiosk address 192.168.50.1/24.'; exit 1; }
[[ -d /sys/class/net/$client/phy80211 ]] || { echo 'Client Wi-Fi adapter missing.'; exit 1; }
if [[ $ap != "$client" && $(readlink -f "/sys/class/net/$ap/phy80211") == $(readlink -f "/sys/class/net/$client/phy80211") ]]; then
 echo 'Use a second physical Wi-Fi adapter, not another virtual interface.'; exit 1
fi
python3 - <<'PY'
import json
from pathlib import Path
p=Path('/var/lib/reliv-wifi/state.json')
if p.exists() and json.loads(p.read_text()).get('phase') in {'scheduled','connecting','connected','restoring','restore_failed'}:
 raise SystemExit('Finish the current maintenance window before reinstalling.')
PY
root=$(cd -- "$(dirname -- "$0")" && pwd)
install -d -m 755 /usr/local/libexec
install -m 755 -o root -g root "$root/reliv-wifi-helper.py" /usr/local/libexec/reliv-wifi-helper
python3 - "$ap" "$client" "$ap_uuid" <<'PY'
import json,os,sys
fd=os.open('/etc/reliv-wifi.json',os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
os.fchmod(fd,0o600)
with os.fdopen(fd,'w') as f:
 json.dump(dict(apInterface=sys.argv[1],clientInterface=sys.argv[2],apUuid=sys.argv[3],singleAdapter=sys.argv[1]==sys.argv[2]),f)
PY
sudoers=$(mktemp)
trap 'rm -f "$sudoers"' EXIT
printf '%s ALL=(root) NOPASSWD: /usr/local/libexec/reliv-wifi-helper ""\n' "$owner" > "$sudoers"
visudo -cf "$sudoers"
install -m 440 -o root -g root "$sudoers" /etc/sudoers.d/reliv-wifi
cat > /etc/systemd/system/reliv-wifi-recover.service <<'UNIT'
[Unit]
Description=Restore Reliv kiosk Wi-Fi after interrupted maintenance
Wants=NetworkManager.service
After=NetworkManager.service
StartLimitIntervalSec=0
[Service]
Type=oneshot
ExecStart=/usr/local/libexec/reliv-wifi-helper --restore
Restart=on-failure
RestartSec=15
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable reliv-wifi-recover.service
echo 'Installed. No network was switched. Restart the Node backend, then open /wifi and sign in.'
