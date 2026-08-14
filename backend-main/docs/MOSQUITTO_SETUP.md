# Mosquitto Local MQTT Broker Setup

## Install Mosquitto on Raspberry Pi

```bash
# Install Mosquitto broker and clients
sudo apt-get update
sudo apt-get install -y mosquitto mosquitto-clients

# Enable and start service
sudo systemctl enable mosquitto
sudo systemctl start mosquitto

# Check status
sudo systemctl status mosquitto
```

## Configuration

Create `/etc/mosquitto/conf.d/reliv.conf`:

```conf
# Listen on all interfaces (Pi local network)
listener 1883 0.0.0.0

# Allow anonymous connections (local network only)
# For production, enable authentication:
# allow_anonymous false
# password_file /etc/mosquitto/passwd

# Persistence
persistence true
persistence_location /var/lib/mosquitto/

# Logging
log_dest file /var/log/mosquitto/mosquitto.log
log_type all
log_timestamp true
```

## Create Authentication (Optional but Recommended)

```bash
# Create password file
sudo mosquitto_passwd -c /etc/mosquitto/passwd reliv_kiosk
# Enter password when prompted

# Update config to require auth
sudo nano /etc/mosquitto/conf.d/reliv.conf
# Set: allow_anonymous false
# Add: password_file /etc/mosquitto/passwd

# Restart
sudo systemctl restart mosquitto
```

## Test Locally

```bash
# Subscribe to test topic
mosquitto_sub -h localhost -t "reliv/test" -v

# Publish test message (in another terminal)
mosquitto_pub -h localhost -t "reliv/test" -m "Hello from Pi"
```

## ESP32 Configuration

Update your ESP32 code to connect to local Pi broker:

```cpp
// OLD (HiveMQ Cloud):
// const char* mqtt_server = "broker.hivemq.cloud";
// const int mqtt_port = 8883; // TLS
// WiFiClientSecure espClient;

// NEW (Local Mosquitto):
const char* mqtt_server = "192.168.50.1"; // Pi's IP
const int mqtt_port = 1883; // No TLS needed on local network
WiFiClient espClient;

// Remove TLS/certificate verification for local broker
// client.setInsecure(); // NO LONGER NEEDED
```

## Update Backend Environment

Update `.env`:

```env
# OLD:
# MQTT_BROKER_URL=mqtts://broker.hivemq.cloud:8883
# MQTT_USERNAME=reliv_user
# MQTT_PASSWORD=Reliv@Cloud2025

# NEW (Local Pi broker):
MQTT_BROKER_URL=mqtt://localhost:1883
# MQTT_USERNAME=reliv_kiosk  # if auth enabled
# MQTT_PASSWORD=your_password # if auth enabled
```

## Firewall (if enabled)

```bash
# Allow MQTT port
sudo ufw allow 1883/tcp
```

## Topics Used

- `reliv/dispense/command` - Backend → ESP32 (dispense instructions)
- `reliv/dispense/status` - ESP32 → Backend (status updates)
- `reliv/kiosk/+/status` - ESP32 → Backend (kiosk online/offline)

## Advantages of Local MQTT

✅ **Offline-First**: Kiosk works without internet
✅ **Low Latency**: No cloud round-trip
✅ **No Cloud Costs**: Free forever
✅ **Privacy**: Data never leaves local network
✅ **Reliability**: No dependency on HiveMQ Cloud uptime
✅ **Simple**: No TLS certificates, no cloud credentials

## Troubleshooting

```bash
# Check if Mosquitto is running
sudo systemctl status mosquitto

# Check logs
sudo tail -f /var/log/mosquitto/mosquitto.log

# Test connection
mosquitto_sub -h localhost -t "#" -v

# Check port is listening
sudo netstat -tuln | grep 1883
```
