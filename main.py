
import asyncio
import threading
import serial
import time
import serial.tools.list_ports
from flask import Flask, jsonify
from flask_cors import CORS

TARGET_NAME_SUBSTRING = "Yoda1"
SCAN_TIMEOUT_SEC = 1
SERIAL_PORT = "COM7"
SERIAL_BAUD = 9600

# Shared global state
latest_data = {"weight": None, "impedance": None, "height": None, "error": "Not scanned yet."}
latest_bp_data = {"bpString": None, "timestamp": 0}
latest_oxygen_data = {"value": None, "timestamp": 0}
latest_temp_data = {"value": None, "timestamp": 0}

app = Flask(__name__)
CORS(app)
lock = threading.Lock()
serial_connection = None

def get_available_ports():
    ports = serial.tools.list_ports.comports()
    return [port.device for port in ports]

def connect_serial(attempt=1, max_attempts=10, base_delay=1):
    global serial_connection
    ports_to_try = [SERIAL_PORT] + get_available_ports()
    ports_to_try = list(set(ports_to_try))
    for port in ports_to_try:
        try:
            if serial_connection is not None and serial_connection.is_open:
                serial_connection.close()
            serial_connection = serial.Serial(port, SERIAL_BAUD, timeout=1)
            print(f"Serial connection established on {port} (attempt {attempt})")
            return True
        except Exception as e:
            print(f"Failed to connect to {port}: {e}")
            continue
    if attempt < max_attempts:
        delay = base_delay * (2 ** (attempt - 1))
        print(f"Retry {attempt}/{max_attempts} in {delay} seconds...")
        time.sleep(delay)
        return connect_serial(attempt + 1, max_attempts, base_delay)
    print(f"Failed to connect after {max_attempts} attempts. Available ports: {get_available_ports()}")
    return False

def update_error():
    if latest_data["weight"] is not None and latest_data["impedance"] is not None and latest_data["height"] is not None:
        latest_data["error"] = None
    else:
        latest_data["error"] = "Waiting for all data..."

def parse_advertisement_data(data: bytes):
    if len(data) < 4:
        print("Received data is too short for parsing.")
        return None, None
    weight_raw = int.from_bytes(data[0:2], 'big')
    impedance_raw = int.from_bytes(data[2:4], 'big')
    weight_kg = weight_raw * 0.01
    impedance = impedance_raw / 10 if impedance_raw > 0 else 0
    if weight_kg <= 0:
        print("Invalid weight data (0 or negative).")
        return None, None
    return weight_kg, impedance

def detection_callback(device, advertisement_data):
    global latest_data
    device_name = device.name if device.name else "Unknown"
    if TARGET_NAME_SUBSTRING.lower() in device_name.lower():
        print(f"Found target device: {device_name} ({device.address})")
        if advertisement_data.manufacturer_data:
            for manu_id, data in advertisement_data.manufacturer_data.items():
                weight, impedance = parse_advertisement_data(data)
                if weight is not None:
                    print(f"Received Weight: {weight:.2f} kg, Impedance: {impedance} ohms")
                    with lock:
                        latest_data["weight"] = weight
                        latest_data["impedance"] = impedance
                    update_error()
                    break

async def scan_for_devices():
    from bleak import BleakScanner
    while True:
        print(f"Scanning for '{TARGET_NAME_SUBSTRING}' for {SCAN_TIMEOUT_SEC} seconds...")
        scanner = BleakScanner(detection_callback=detection_callback)
        await scanner.start()
        await asyncio.sleep(SCAN_TIMEOUT_SEC)
        await scanner.stop()
        print("Scan cycle finished. Waiting before next scan...")
        await asyncio.sleep(5)

def run_ble_scanner_in_thread():
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    loop.run_until_complete(scan_for_devices())

def run_serial_reader():
    global serial_connection, latest_data, latest_bp_data, latest_oxygen_data, latest_temp_data
    if not connect_serial():
        print("Could not establish serial connection. Height measurements will not work.")
        while True:
            time.sleep(5)
        return
    while True:
        try:
            if not serial_connection.is_open:
                print("Serial connection lost. Reconnecting...")
                if not connect_serial():
                    time.sleep(5)
                    continue
            line = serial_connection.readline().decode('utf-8', errors='ignore').strip()
            if line.startswith("Height: "):
                height = float(line.replace("Height: ", ""))
                print(f"Received Height: {height} cm")
                with lock:
                    latest_data["height"] = height
                update_error()
            elif line.startswith("BP:") and "BPM:" in line:
                print(f"Arduino BP line received: {line}")
                with lock:
                    latest_bp_data["bpString"] = line
                    latest_bp_data["timestamp"] = time.time()
            elif line.isdigit():
                oxygen_num = int(line)
                with lock:
                    if 20 <= oxygen_num <= 100:  # Basic sanity check for SpO2
                        latest_oxygen_data["value"] = oxygen_num
                        latest_oxygen_data["timestamp"] = time.time()
                        print(f"Arduino Oxygen value received: {oxygen_num}")
            elif line.replace('.', '', 1).isdigit():
                try:
                    temp_val = float(line)
                    with lock:
                        latest_temp_data["value"] = temp_val
                        latest_temp_data["timestamp"] = time.time()
                    print(f"Arduino Temperature numeric line received: {temp_val}")
                except ValueError:
                    pass
            elif line.startswith("Temp:"):
                temp_val_str = line.replace("Temp:", "").strip()
                try:
                    temp_val = float(temp_val_str)
                    with lock:
                        latest_temp_data["value"] = temp_val
                        latest_temp_data["timestamp"] = time.time()
                    print(f"Arduino Temperature line received: {temp_val}")
                except ValueError:
                    print(f"Invalid temperature data: {temp_val_str}")
            elif line:
                print(f"Arduino: {line}")
        except ValueError:
            print("Invalid data received from serial.")
        except Exception as e:
            print(f"Serial read error: {e}")
            try:
                if serial_connection.is_open:
                    serial_connection.close()
                time.sleep(1)
                connect_serial()
            except Exception as reconn_e:
                print(f"Reconnection failed: {reconn_e}")
            time.sleep(2)

@app.route('/get_ble_data', methods=['GET'])
def get_ble_data():
    print("Data requested from React app. Sending:", latest_data)
    return jsonify(latest_data)

@app.route('/trigger_height', methods=['POST'])
def trigger_height():
    global serial_connection
    try:
        if serial_connection is None or not serial_connection.is_open:
            if not connect_serial():
                return jsonify({"status": "error", "message": "Could not connect to Arduino"}), 500
        serial_connection.write(b"START\n")
        serial_connection.flush()
        print("Sent START command to Arduino")
        return jsonify({"status": "success", "message": "START command sent"})
    except Exception as e:
        print(f"Failed to send START command: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/trigger_blood_pressure', methods=['POST'])
def trigger_blood_pressure():
    global serial_connection, latest_bp_data
    if serial_connection is None or not serial_connection.is_open:
        if not connect_serial():
            return jsonify({"status": "error", "bpString": "", "message": "Could not connect to device"}), 500
    try:
        with lock:
            before_time = time.time()
            latest_bp_data["bpString"] = None
            latest_bp_data["timestamp"] = 0

        serial_connection.reset_input_buffer()
        serial_connection.write(b"blood pressure\n")
        serial_connection.flush()
        print("Sent 'blood pressure' command to device.")

        timeout = 20  # seconds
        start_time = time.time()
        bp_response = None
        while time.time() - start_time < timeout:
            with lock:
                if (latest_bp_data["bpString"] is not None and
                    latest_bp_data["timestamp"] > before_time):
                    bp_response = latest_bp_data["bpString"]
                    break
            time.sleep(0.1)

        if bp_response is None:
            return jsonify({"status": "error", "bpString": "", "message": "No valid BP data received"}), 504

        return jsonify({"status": "success", "bpString": bp_response})

    except Exception as e:
        print(f"Blood pressure command failed: {e}")
        return jsonify({"status": "error", "bpString": "", "message": str(e)}), 500

@app.route('/trigger_oxygen', methods=['POST'])
def trigger_oxygen():
    global serial_connection, latest_oxygen_data
    if serial_connection is None or not serial_connection.is_open:
        if not connect_serial():
            return jsonify({"status": "error", "value": None, "message": "Could not connect to device"}), 500
    try:
        with lock:
            before_time = time.time()
            latest_oxygen_data["value"] = None
            latest_oxygen_data["timestamp"] = 0

        serial_connection.reset_input_buffer()
        serial_connection.write(b"oxygen\n")
        serial_connection.flush()
        print("Sent 'oxygen' command to device.")

        timeout = 20  # seconds
        start_time = time.time()
        oxygen_value = None
        while time.time() - start_time < timeout:
            with lock:
                if (latest_oxygen_data["value"] is not None and
                    latest_oxygen_data["timestamp"] > before_time):
                    oxygen_value = latest_oxygen_data["value"]
                    break
            time.sleep(0.1)

        if oxygen_value is None:
            return jsonify({"status": "error", "value": None, "message": "No oxygen data received"}), 504

        return jsonify({"status": "success", "value": oxygen_value})

    except Exception as e:
        print(f"Oxygen command failed: {e}")
        return jsonify({"status": "error", "value": None, "message": str(e)}), 500

@app.route('/trigger_temperature', methods=['POST'])
def trigger_temperature():
    global serial_connection, latest_temp_data
    if serial_connection is None or not serial_connection.is_open:
        if not connect_serial():
            return jsonify({"status": "error", "value": None, "message": "Could not connect to device"}), 500
    try:
        with lock:
            before_time = time.time()
            latest_temp_data["value"] = None
            latest_temp_data["timestamp"] = 0

        serial_connection.reset_input_buffer()
        serial_connection.write(b"temperature\n")
        serial_connection.flush()
        print("Sent 'temperature' command to device.")

        timeout = 20  # seconds
        start_time = time.time()
        temp_value = None
        while time.time() - start_time < timeout:
            with lock:
                if latest_temp_data["value"] is not None and latest_temp_data["timestamp"] > before_time:
                    temp_value = latest_temp_data["value"]
                    break
            time.sleep(0.1)

        if temp_value is None:
            return jsonify({"status": "error", "value": None, "message": "No temperature data received"}), 504

        return jsonify({"status": "success", "value": temp_value})

    except Exception as e:
        print(f"Temperature command failed: {e}")
        return jsonify({"status": "error", "value": None, "message": str(e)}), 500

if __name__ == "__main__":
    print("Available serial ports:", get_available_ports())
    serial_thread = threading.Thread(target=run_serial_reader, daemon=True)
    serial_thread.start()
    ble_thread = threading.Thread(target=run_ble_scanner_in_thread, daemon=True)
    ble_thread.start()
    app.run(port=5001, debug=False)