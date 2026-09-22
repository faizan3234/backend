#!/usr/bin/env bash
# Install only the ad portal's probe DNS/HTTP rules into an existing NM shared AP.
set -Eeuo pipefail

mode=check
reconnect=false
for arg in "$@"; do
  case "$arg" in
    --check) mode=check ;;
    --apply) mode=apply ;;
    --reconnect) reconnect=true ;;
    *) echo 'Usage: sudo bash deploy/install-ads-captive-portal.sh [--check|--apply] [--reconnect]' >&2; exit 2 ;;
  esac
done
fail() { echo "ERROR: $*" >&2; exit 1; }
[[ $EUID == 0 ]] || fail 'Run with sudo; nginx configuration and AP diagnostics require root.'
[[ $mode == apply || $reconnect == false ]] || fail '--reconnect requires --apply.'
for binary in nmcli dnsmasq nginx curl install ps awk systemctl; do
  command -v "$binary" >/dev/null || fail "Missing $binary. Install the existing AP/web-server dependencies first."
done
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
dns_target=/etc/NetworkManager/dnsmasq-shared.d/reliv-ads.conf
web_target=/etc/nginx/conf.d/reliv-ads-captive.conf
portal=http://192.168.50.1/advertise

# Use the UUID, never a shell-parsed SSID or connection name. No credentials read.
ap_uuid=''
while IFS= read -r candidate; do
  [[ -n $candidate ]] || continue
  if [[ $(nmcli -g 802-11-wireless.mode connection show "$candidate" 2>/dev/null || true) == ap ]] &&
     [[ $(nmcli -g 802-11-wireless.ssid connection show "$candidate") == RELIV-KIOSK ]]; then
    [[ -z $ap_uuid ]] || fail 'More than one active RELIV-KIOSK AP. Resolve the duplicate AP first.'
    ap_uuid=$candidate
  fi
done < <(nmcli -g UUID connection show --active)
[[ -n $ap_uuid ]] || fail 'No active RELIV-KIOSK NetworkManager access point. This installer does not replace standalone AP configurations.'
[[ $(nmcli -g ipv4.method connection show "$ap_uuid") == shared ]] || fail 'The AP must already use NetworkManager shared mode.'
ap_addresses=$(nmcli -g ipv4.addresses connection show "$ap_uuid")
[[ $ap_addresses == *192.168.50.1/24* ]] || fail 'The AP address must already be 192.168.50.1/24.'
dns_processes=$(ps -eo args= | awk '/[d]nsmasq/ {print}')
[[ $dns_processes == *'/etc/NetworkManager/dnsmasq-shared.d'* ]] || fail 'The running shared dnsmasq does not load /etc/NetworkManager/dnsmasq-shared.d. Follow ADS-DEPLOYMENT.md for your AP manager instead.'
nginx_config=$(nginx -T 2>&1) || fail 'Existing nginx configuration is invalid. Fix it before installation.'
[[ $nginx_config == *'include /etc/nginx/conf.d/'* ]] || fail 'nginx does not include /etc/nginx/conf.d. Add the portal block to its enabled configuration manually.'
dnsmasq --test --conf-file="$source_dir/ads-captive-dnsmasq.conf"
curl --noproxy '*' --fail --silent --show-error --max-time 10 "$portal" | awk 'BEGIN {IGNORECASE=1} /<[hH][tT][mM][lL]/ {found=1} END {exit !found}' || fail '/advertise does not serve the frontend HTML on port 80. Deploy the frontend SPA fallback first.'
curl --noproxy '*' --fail --silent --show-error --max-time 10 http://192.168.50.1/api/ads/config >/dev/null || fail 'The local /api/ads/config route is not reachable. Check nginx API proxy and backend.'

check_redirect() {
  local headers
  headers=$(curl --noproxy '*' --silent --show-error --max-time 10 --head \
    --resolve captive.apple.com:80:192.168.50.1 http://captive.apple.com/hotspot-detect.html) || return 1
  [[ $headers == *'302 '* ]] && [[ $headers == *"Location: $portal"* || $headers == *"location: $portal"* ]]
}
if [[ $mode == check ]]; then
  [[ -f $dns_target ]] || fail 'Portal DNS rules are not installed. Run --apply from the Pi console.'
  check_redirect || fail 'The connectivity probe is not redirected to /advertise. Run --apply.'
  echo 'AP, booking page, backend and HTTP portal redirect are reachable.'
  echo 'Rejoin RELIV-KIOSK on a phone to verify its DNS and OS sign-in prompt.'
  exit 0
fi

# Refuse a conflicting probe server rather than silently shadowing it.
conflict=$(printf '%s\n' "$nginx_config" | awk -v target="$web_target" '
  /^# configuration file / {file=$4; sub(/:$/, "", file)}
  /^[[:space:]]*#/ {next}
  /captive\.apple\.com/ && file != target {print file}')
[[ -z $conflict ]] || fail "An existing captive portal block is configured in $conflict. Consolidate it before running this installer."
backup_dir=$(mktemp -d /var/backups/reliv-ads-XXXXXXXX)
chmod 700 "$backup_dir"
[[ ! -f $dns_target ]] || cp -p "$dns_target" "$backup_dir/dns.conf"
[[ ! -f $web_target ]] || cp -p "$web_target" "$backup_dir/web.conf"
rollback() {
  trap - ERR
  if [[ -f $backup_dir/dns.conf ]]; then cp -p "$backup_dir/dns.conf" "$dns_target"; else rm -f -- "$dns_target"; fi
  if [[ -f $backup_dir/web.conf ]]; then cp -p "$backup_dir/web.conf" "$web_target"; else rm -f -- "$web_target"; fi
  nginx -t && systemctl reload nginx || true
  echo "Installation failed; the two portal configuration files were restored. Backup: $backup_dir" >&2
}
trap rollback ERR
install -d -m 755 /etc/NetworkManager/dnsmasq-shared.d /etc/nginx/conf.d
install -m 644 "$source_dir/ads-captive-dnsmasq.conf" "$dns_target"
install -m 644 "$source_dir/ads-captive-nginx.conf" "$web_target"
nginx -t
systemctl reload nginx
check_redirect
trap - ERR
echo "Portal rules installed. Previous files: $backup_dir"
if [[ $reconnect == true ]]; then
  echo 'Reconnecting the AP now. Connected phones and Wi-Fi SSH sessions will disconnect.'
  nmcli connection down uuid "$ap_uuid"
  nmcli connection up uuid "$ap_uuid"
else
  echo 'DNS changes need an AP restart. At the Pi console, rerun with --apply --reconnect, or reboot during maintenance.'
fi
echo 'Scan the existing Wi-Fi QR and accept the join/sign-in prompt. The portal opens /advertise.'
echo 'Some phones require tapping Sign in to network; fallback: http://192.168.50.1/advertise'
