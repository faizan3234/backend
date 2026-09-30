/* Reliv local-only sensor adapter. See README before flashing.
 * No generated readings. No BP pump/valve actuation: RX-only CSV interface.
 * Pin defaults are copied from the supplied sketch, NOT confirmed hardware.
 */
#include <WiFi.h>
#include <PubSubClient.h>
#include <Wire.h>
#include <Adafruit_MLX90614.h>
#include <Adafruit_VL53L0X.h>
#include "MAX30105.h"
#include "spo2_algorithm.h"
#include <math.h>
#include "local_config.h"

WiFiClient transport;
PubSubClient mqtt(transport);
Adafruit_MLX90614 mlx;
Adafruit_VL53L0X tof;
MAX30105 optical;
HardwareSerial cuff(2);

enum Mode { IDLE, OXYGEN, TEMPERATURE, HEIGHT, BP };
Mode mode = IDLE;
bool mlxOK = false, tofOK = false, opticalOK = false;
uint32_t started = 0, lastSample = 0, wifiAttempt = 0, mqttAttempt = 0;
uint32_t red[100], ir[100];
unsigned sampleCount = 0, heightCount = 0;
float heights[28];
String cuffLine;
bool cuffOverflow = false;
String deviceId;

void stopMeasurement() {
  if (mode == OXYGEN && opticalOK) optical.shutDown();
  mode = IDLE;
  sampleCount = 0;
  heightCount = 0;
  cuffLine = "";
  cuffOverflow = false;
}
void status(const char *text) {
  Serial.println(text);
  if (mqtt.connected()) mqtt.publish("kiosk/status", text, false);
}
void fail(const char *text) {
  stopMeasurement();
  status(text);
}
void result(const char *topic, const char *payload) {
  // Never retain a measurement or replay it after a reconnect.
  bool sent = mqtt.connected() && mqtt.publish(topic, payload, false);
  stopMeasurement();
  if (sent) {
    Serial.printf("Published %s %s\n", topic, payload);
    // QoS 0 confirms socket write only, not UI receipt.
  } else status("Error: MQTT result send failed; start a new measurement.");
}
void command(const String &cmd) {
  if (cmd == "stop") { stopMeasurement(); return; }
  Mode requested = cmd == "oxygen" ? OXYGEN : cmd == "temperature" ? TEMPERATURE :
                   cmd == "height" ? HEIGHT : cmd == "bp" ? BP : IDLE;
  if (requested == IDLE) return; // Other devices share this command topic.
  if (requested == mode) return; // Duplicate start must not restart the scan.
  stopMeasurement();
  if (requested == OXYGEN && !opticalOK) { status("Error: Oxygen sensor missing."); return; }
  if (requested == TEMPERATURE && !mlxOK) { status("Error: Temperature sensor missing."); return; }
  if (requested == HEIGHT && (!tofOK || MOUNT_HEIGHT_CM <= 0)) {
    status("Error: Height sensor missing or mount height is not configured."); return;
  }
  // Discard pre-existing cuff bytes before arming. No unsolicited BP publishing.
  while (cuff.available()) cuff.read();
  mode = requested;
  started = millis();
  lastSample = started;
  if (mode == OXYGEN) {
    // 100 samples/s, averaging 4 => 25 FIFO samples/s for SparkFun's algorithm.
    optical.setup(70, 4, 2, 100, 411, 16384);
    optical.setPulseAmplitudeGreen(0);
    optical.clearFIFO();
    optical.wakeUp();
  }
  if (mode == BP) status("Measuring BP: start the cuff using its own controls.");
  else status("Measuring: keep the sensor positioned and stay still.");
}
void onMessage(char *topic, byte *payload, unsigned int length) {
  if (strcmp(topic, "kiosk/command") != 0 || length > 32) return;
  String cmd;
  cmd.reserve(length);
  for (unsigned int i = 0; i < length; ++i) cmd += char(payload[i]);
  cmd.trim(); cmd.toLowerCase();
  command(cmd);
}
void maintainConnection() {
  uint32_t now = millis();
  if (WiFi.status() != WL_CONNECTED) {
    if (mode != IDLE) stopMeasurement();
    if (mqtt.connected()) mqtt.disconnect();
    if (now - wifiAttempt >= 15000) {
      wifiAttempt = now;
      WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    }
    return;
  }
  if (!mqtt.connected()) {
    if (mode != IDLE) stopMeasurement();
    if (now - mqttAttempt < 5000) return;
    mqttAttempt = now;
    // All MQTT calls run in loop(), never concurrently from a Wi-Fi event task.
    bool connected = MQTT_USERNAME[0]
      ? mqtt.connect(deviceId.c_str(), MQTT_USERNAME, MQTT_PASSWORD)
      : mqtt.connect(deviceId.c_str());
    if (!connected) { Serial.printf("MQTT failed state=%d\n", mqtt.state()); return; }
    // Clean session (library default); commands must never be retained.
    if (!mqtt.subscribe("kiosk/command", 0)) { mqtt.disconnect(); return; }
    Serial.print("Local IP: "); Serial.println(WiFi.localIP());
    Serial.println("Local MQTT connected: 192.168.50.1:1883");
  }
  mqtt.loop();
}
void readCuff() {
  // Bounded work; no readStringUntil() stalls. Discard bytes while not armed.
  for (unsigned budget = 0; budget < 128 && cuff.available(); ++budget) {
    char ch = char(cuff.read());
    if (mode != BP) { cuffLine = ""; cuffOverflow = false; continue; }
    if (ch == '\r') continue;
    if (ch != '\n') {
      if (cuffLine.length() < 63 && !cuffOverflow) cuffLine += ch;
      else cuffOverflow = true;
      continue;
    }
    int sys = 0, dia = 0, pulse = 0, consumed = 0;
    String line = cuffLine; bool overflow = cuffOverflow;
    cuffLine = ""; cuffOverflow = false; line.trim();
    if (line.isEmpty() && !overflow) continue;
    if (overflow || sscanf(line.c_str(), "%d,%d,%d%n", &sys, &dia, &pulse, &consumed) != 3 ||
        consumed != int(line.length()) || sys <= 0 || dia <= 0 || pulse <= 0 ||
        sys > 999 || dia > 999 || pulse > 999) {
      fail("Error: Invalid BP serial frame; expected SYS,DIA,PULSE followed by newline."); return;
    }
    // Transport validation only. Do not discard readings just for being abnormal.
    char out[96];
    snprintf(out, sizeof(out), "{\"systolic\":%d,\"diastolic\":%d,\"bpm\":%d}", sys, dia, pulse);
    result("kiosk/sensor/bp", out);
  }
}
void pollOxygen() {
  optical.check();
  for (unsigned budget = 0; budget < 8 && optical.available(); ++budget) {
    uint32_t r = optical.getFIFORed(), i = optical.getFIFOIR();
    optical.nextSample();
    if (i < MIN_FINGER_IR) { sampleCount = 0; continue; }
    red[sampleCount] = r; ir[sampleCount] = i;
    if (++sampleCount < 100) continue;
    int32_t spo2 = 0, pulse = 0; int8_t spo2Valid = 0, pulseValid = 0;
    maxim_heart_rate_and_oxygen_saturation(ir, 100, red, &spo2, &spo2Valid, &pulse, &pulseValid);
    if (spo2Valid && pulseValid && spo2 > 0 && spo2 <= 100 && pulse > 0) {
      char out[80];
      snprintf(out, sizeof(out), "{\"oxygen\":%ld,\"bpm\":%ld}", (long)spo2, (long)pulse);
      result("kiosk/sensor/oxygen", out); return;
    }
    for (unsigned k = 25; k < 100; ++k) { red[k - 25] = red[k]; ir[k - 25] = ir[k]; }
    sampleCount = 75;
  }
}
void pollTemperature() {
  if (millis() - lastSample < 500) return;
  lastSample = millis();
  double f = mlx.readObjectTempF();
  // Matches current frontend's accepted display interval, not a clinical range.
  if (!isfinite(f)) { fail("Error: Temperature sensor read failed."); return; }
  if (f < 90 || f > 110) { fail("Error: Temperature outside frontend display range (90-110 F)."); return; }
  char out[64]; snprintf(out, sizeof(out), "{\"temperature_f\":%.2f}", f);
  result("kiosk/sensor/temperature", out);
}
void pollHeight() {
  if (millis() - lastSample < 60) return;
  lastSample = millis();
  VL53L0X_RangingMeasurementData_t m;
  tof.rangingTest(&m, false); // One library-bounded ranging operation per loop.
  if (m.RangeStatus != 0) return; // Reject signal/range failures (incl. 2 and 4).
  float h = MOUNT_HEIGHT_CM - m.RangeMilliMeter / 10.0f;
  if (h <= 0 || h >= MOUNT_HEIGHT_CM) return;
  heights[heightCount++] = h;
  if (heightCount < 28) return;
  for (unsigned a = 0; a < 27; ++a)
    for (unsigned b = a + 1; b < 28; ++b)
      if (heights[a] > heights[b]) { float t = heights[a]; heights[a] = heights[b]; heights[b] = t; }
  // Central half must be stable; never use a wide-spread set 'anyway'.
  if (heights[20] - heights[7] > HEIGHT_MAX_SPREAD_CM) {
    fail("Error: Height readings unstable; reposition and retry."); return;
  }
  float medianHeight = (heights[13] + heights[14]) / 2.0f;
  char out[64]; snprintf(out, sizeof(out), "{\"height_cm\":%.1f}", medianHeight);
  result("kiosk/sensor/height", out);
}
void setup() {
  Serial.begin(115200);
  cuffLine.reserve(64);
  Wire.begin(I2C_SDA, I2C_SCL);
  Wire.setTimeOut(100);
  mlxOK = mlx.begin();
  tofOK = tof.begin();
  opticalOK = optical.begin(Wire, I2C_SPEED_STANDARD);
  if (opticalOK) optical.shutDown();
  cuff.begin(9600, SERIAL_8N1, BP_RX_PIN, -1);
  Serial.printf("Sensors found: temperature=%d height=%d oxygen=%d\n", mlxOK, tofOK, opticalOK);
  WiFi.mode(WIFI_STA);
  deviceId = "reliv-sensors-" + WiFi.macAddress();
  WiFi.persistent(false);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  wifiAttempt = millis();
  mqtt.setServer("192.168.50.1", 1883);
  mqtt.setCallback(onMessage);
  mqtt.setBufferSize(512);
  mqtt.setKeepAlive(15);
  mqtt.setSocketTimeout(2);
}
void loop() {
  maintainConnection();
  readCuff();
  if (mode != IDLE && mqtt.connected()) {
    uint32_t limit = mode == OXYGEN ? 55000 : mode == BP ? 85000 : mode == HEIGHT ? 15000 : 10000;
    if (millis() - started >= limit) fail("Error: Measurement timeout; start a new measurement.");
    else if (mode == OXYGEN) pollOxygen();
    else if (mode == TEMPERATURE) pollTemperature();
    else if (mode == HEIGHT) pollHeight();
  }
  delay(1);
}
