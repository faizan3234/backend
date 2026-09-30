# Pi, browser and ESP32 MQTT alignment

The observed Pi config is `listener 1883 192.168.50.1` with
`allow_anonymous true`. ESP32 uses this address with empty MQTT credentials.
Browser MQTT additionally needs WebSockets on port 9001. Backend loopback will
not reach a listener bound exclusively to the AP address.

## Frontend deployment

Local pages at 192.168.50.1, localhost and 127.0.0.1 now connect anonymously to
`ws://192.168.50.1:9001/`. Old cloud build variables are deliberately ignored on
these kiosk hosts. Other hosts use explicit VITE_MQTT_BROKER and optional paired
credentials. HTTPS local pages report a clear error; use http://192.168.50.1.
This policy matches the supplied anonymous kiosk configuration. If broker auth
changes, update this local policy together with ESP32 and backend credentials.

Run `npm ci`, `npm run lint`, `npm test`, `npm run build`; deploy dist using the
existing nginx site configuration. Changing source alone does not replace the
served build. No internet is needed after the build/dependencies are transferred.

## Pi configuration and backend deployment

Apply the companion backend change, then run on the Pi during maintenance:

```bash
cd ~/backend
sudo python3 deploy/install-mqtt-websocket.py
sudo ss -lntp | grep -E ':(1883|9001)\b'
```

The installer adds only a new WebSocket fragment; it checks the reported existing
configuration, refuses custom auth/duplicate listeners, and removes its own
fragment if broker restart fails. Existing TCP configuration is preserved.
Mosquitto needs WebSocket support. A broker restart disconnects current clients.
Do this while no measurements or dispensing operations are active.

Set the EXISTING backend .env entry (do not replace the whole file) to:
`MQTT_BROKER_URL=mqtt://192.168.50.1:1883`.
Leave MQTT_USERNAME and MQTT_PASSWORD empty for this confirmed anonymous setup.
Stop the manually running backend with Ctrl+C, then restart with `npm start`.
The backend helper also maps old localhost:1883 to the AP address.

## ESP32

The backend patch contains firmware/RelivLocalSensors. Copy local_config.example.h
to local_config.h alongside its .ino and open in Arduino IDE. Fill the Wi-Fi password locally; MQTT
username and password stay empty. Confirm the exact board before using GPIO8/9
and UART2. Set measured MOUNT_HEIGHT_CM; zero disables height. Select your actual
board, upload, and monitor at115200 baud. BP UART is9600 and expects ASCII
SYS,DIA,PULSE plus newline. BP is armed by `bp`, but cuff activation uses its own
button until the actual manufacturer's start protocol is provided.
This repository copy has not been compiled with an Arduino toolchain, flashed,
or hardware-verified here. Install PubSubClient, Adafruit MLX90614, Adafruit
VL53L0X and SparkFun MAX3010x libraries and their dependencies. Oxygen timeout
is 55 seconds, before the UI's 60-second deadline. This is a sensor adapter,
not replacement firmware for the dispensing controller.

## Test the actual UI without sensors

Power off the sensor ESP32 temporarily. Use a disposable test session, no patient:
these are synthetic measurements and may be cached/saved by the backend.

Terminal1:
```bash
mosquitto_sub -h 192.168.50.1 -p 1883 -v -t kiosk/command -t 'kiosk/sensor/#'
```

Open the BP page and press Measure. After `kiosk/command bp` appears, Terminal2:
```bash
mosquitto_pub -h 192.168.50.1 -p 1883 -t kiosk/sensor/bp -m '{"systolic":120,"diastolic":80,"bpm":72}'
```
Expected UI120/80. On oxygen page press Measure, then:
```bash
mosquitto_pub -h 192.168.50.1 -p 1883 -t kiosk/sensor/oxygen -m '{"oxygen":98,"bpm":72}'
```
Expected98% and72bpm. Do not use -r (retained data) and do not run both publishes
on the same page. Stop/reset the test session without creating a patient report.

Commands: bp, oxygen, temperature, height, stop on kiosk/command.
Results: kiosk/sensor/bp {systolic,diastolic,bpm}; kiosk/sensor/oxygen {oxygen,bpm};
kiosk/sensor/temperature {temperature_f}; kiosk/sensor/height {height_cm}.
Never retain commands. Remove an old retained kiosk/command during maintenance
before connecting the firmware: `mosquitto_pub -h 192.168.50.1 -t kiosk/command -r -n`.

Still requires on-site testing: real AP association, broker listeners/firewall,
Chromium WebSocket connection, physical sensors and calibration. Existing shared
sensor topics have no measurement IDs; use only one active measurement UI.
No payment, ad activation or dispensing protocol is changed by this MQTT patch.

Local kiosk API calls also ignore stale VITE_BACKEND_URL cloud values and use
the local host on port 5000. Only the existing phone payment bridge stays online.
The Pi does not need internet for MQTT, media playback, inventory or SQLite.
The anonymous broker trusts devices on the kiosk Wi-Fi; do not forward ports
1883/9001 to the internet. Restrict access to trusted devices or plan coordinated
authentication/ACL changes across all three clients for a hostile network.
