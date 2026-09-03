"""
Audio Device Discovery & Resolution.

Finds audio input devices dynamically by stable name/chipset (e.g. PCM2902)
to prevent hardcoding card indices (e.g. plughw:3,0) that can shift upon reboot.
"""
import re
import subprocess
from pathlib import Path
from typing import Optional, Tuple

from config import MIC_DEVICE_FALLBACK, MIC_DEVICE_HINT


def find_alsa_card_by_name(name_hint: str) -> Optional[int]:
    """
    Scans /proc/asound/cards for a matching device string.
    Returns the integer card index if found, else None.
    """
    cards_path = Path("/proc/asound/cards")
    if not cards_path.exists():
        return None

    try:
        content = cards_path.read_text(encoding="utf-8", errors="ignore")
        # Format example:
        #  0 [bcm2835_hdmi   ]: bcm2835_hdmi - bcm2835 HDMI 1
        #  3 [CODEC          ]: USB-Audio - USB Audio CODEC (PCM2902)
        pattern = re.compile(r"^\s*(\d+)\s+\[.+?\]:\s*(.+)$", re.MULTILINE)
        for match in pattern.finditer(content):
            card_num = int(match.group(1))
            card_desc = match.group(2)
            if name_hint.lower() in card_desc.lower():
                return card_num
    except Exception:
        pass
    return None


def find_arecord_device_by_name(name_hint: str) -> Optional[Tuple[int, int]]:
    """
    Runs `arecord -l` to find matching capture card and subdevice.
    Returns (card_num, subdevice_num) if found.
    """
    try:
        res = subprocess.run(
            ["arecord", "-l"],
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
        if res.returncode != 0:
            return None

        # Format example:
        # card 3: CODEC [USB Audio CODEC], device 0: USB Audio [USB Audio]
        pattern = re.compile(
            r"card\s+(\d+):\s+([^,]+),\s+device\s+(\d+):\s+([^\n]+)",
            re.IGNORECASE,
        )
        for match in pattern.finditer(res.stdout):
            card = int(match.group(1))
            card_name = match.group(2)
            dev = int(match.group(3))
            dev_name = match.group(4)

            full_desc = f"{card_name} {dev_name}"
            if name_hint.lower() in full_desc.lower():
                return (card, dev)
    except Exception:
        pass
    return None


def resolve_capture_device() -> Tuple[str, str]:
    """
    Resolves the best ALSA capture device identifier and description.
    Returns:
        (device_id, display_name)
        e.g. ("plughw:3,0", "USB Audio CODEC (PCM2902)")
    """
    # 1. Try arecord -l search
    found_dev = find_arecord_device_by_name(MIC_DEVICE_HINT)
    if found_dev:
        card, subdev = found_dev
        return (f"plughw:{card},{subdev}", f"{MIC_DEVICE_HINT} (card {card})")

    # 2. Try /proc/asound/cards search
    card_idx = find_alsa_card_by_name(MIC_DEVICE_HINT)
    if card_idx is not None:
        return (f"plughw:{card_idx},0", f"{MIC_DEVICE_HINT} (card {card_idx})")

    # 3. Fallback to configured device string
    return (MIC_DEVICE_FALLBACK, f"Default ({MIC_DEVICE_FALLBACK})")
