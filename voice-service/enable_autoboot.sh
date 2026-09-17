#!/usr/bin/env bash
set -e

echo "============================================================"
echo " RELIV KIOSK AUTO-BOOT & SELF-HEALING SYSTEM SETUP"
echo "============================================================"

# Ensure root privileges
if [ "$EUID" -ne 0 ]; then
  echo "Error: Please run as root:"
  echo "  sudo bash enable_autoboot.sh"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[1/5] Installing systemd service units..."
cp "$SCRIPT_DIR/reliv-whisper.service" /etc/systemd/system/reliv-whisper.service
cp "$SCRIPT_DIR/reliv-voice.service" /etc/systemd/system/reliv-voice.service

echo "[2/5] Ensuring offline TTS speaker package is available..."
if ! command -v espeak-ng &> /dev/null; then
  echo "Installing espeak-ng for local voice speaker output..."
  apt-get update -y && apt-get install -y espeak-ng || true
else
  echo "espeak-ng is already installed."
fi

echo "[3/5] Reloading systemd daemon..."
systemctl daemon-reload

echo "[4/5] Enabling services for automatic start on EVERY boot/reboot..."
systemctl enable reliv-whisper.service
systemctl enable reliv-voice.service

echo "[5/5] Starting / restarting both services now..."
systemctl restart reliv-whisper.service
systemctl restart reliv-voice.service

echo ""
echo "============================================================"
echo " SUCCESS: Services are now permanent and will auto-start!"
echo "============================================================"
echo ""
echo "Whisper status: $(systemctl is-active reliv-whisper.service) (Enabled on boot: $(systemctl is-enabled reliv-whisper.service))"
echo "Voice status:   $(systemctl is-active reliv-voice.service) (Enabled on boot: $(systemctl is-enabled reliv-voice.service))"
echo ""
