import asyncio
import datetime
import json
from bleak import BleakScanner
import sys

# Configuration for the BLE device
TARGET_NAME_SUBSTRING = "Yoda1"
STABLE_WEIGHT_THRESHOLD = 0.05
STABLE_READINGS_REQUIRED = 3
SCAN_TIMEOUT_SEC = 15

# App state
latest_ble_data = {"weight": None}
last_weights = []
weight_printed = False

def parse_advertisement_data(data: bytes):
    """Parses weight from the raw advertisement data."""
    if len(data) < 2:
        return None
    weight_raw = int.from_bytes(data[0:2], 'big')
    weight_kg = weight_raw * 0.01
    return weight_kg if weight_kg > 0 else None

def is_weight_stable(new_weight):
    """Checks if the weight reading is stable over a few readings."""
    global last_weights, weight_printed
    last_weights.append(new_weight)
    if len(last_weights) > STABLE_READINGS_REQUIRED:
        last_weights.pop(0)
        if all(abs(w - last_weights[0]) < STABLE_WEIGHT_THRESHOLD for w in last_weights):
            return True
    return False

def detection_callback(device, adv_data):
    """Callback for BLE device detection."""
    global latest_ble_data, weight_printed
    device_name = device.name or "Unknown"
    if TARGET_NAME_SUBSTRING.lower() in device_name.lower() and adv_data.manufacturer_data:
        for _, data in adv_data.manufacturer_data.items():
            weight_kg = parse_advertisement_data(data)
            if weight_kg and is_weight_stable(weight_kg) and not weight_printed:
                latest_ble_data["weight"] = weight_kg
                weight_printed = True

async def scan_for_weight():
    """Main asynchronous scanning function."""
    scanner = BleakScanner(detection_callback=detection_callback)
    await scanner.start()
    await asyncio.sleep(SCAN_TIMEOUT_SEC)
    await scanner.stop()

if __name__ == '__main__':
    try:
        asyncio.run(scan_for_weight())
        if latest_ble_data["weight"] is not None:
            print(json.dumps(latest_ble_data))
        else:
            print(json.dumps({"error": "No stable weight detected. Please try again."}))
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)