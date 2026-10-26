// Standard ESP32 motor board ONLY. Sensor ESP32-S3 uses its separate sketch.
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include "local_config.h"
#include "MotorCycle.h"

WiFiClient transport;
PubSubClient mqtt(transport);
Preferences journal;
MotorCycle cycle;
constexpr unsigned QUEUE_SIZE = 8;
String queue[QUEUE_SIZE];
unsigned queued = 0;
String pendingKey, pendingResult, clientId;
int activeMotor = -1;
bool storageOK = false;
uint32_t wifiAttempt = 0, mqttAttempt = 0, ackAttempt = 0;

void allOff() {
  for (int pin : RELAY_PINS) digitalWrite(pin, RELAY_OFF);
}
void storageFault() {
  allOff(); storageOK = false;
  Serial.println("STOPPED: journal storage failed/full. Staff review required; do not erase job history.");
}
bool persist(const String &key, const String &value) {
  if (!journal.putString(key.c_str(), value) ||
      journal.getString(key.c_str(), "") != value) { storageFault(); return false; }
  return true;
}
bool validId(const String &id) {
  if (!id.length() || id.length() > 90) return false;
  for (unsigned i = 0; i < id.length(); ++i) {
    char c = id[i];
    if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
          (c >= '0' && c <= '9') || c == '-' || c == '_')) return false;
  }
  return true;
}
String keyFor(const String &id) {
  uint64_t h = 14695981039346656037ULL;
  for (unsigned i = 0; i < id.length(); ++i) { h ^= uint8_t(id[i]); h *= 1099511628211ULL; }
  char out[16];
  snprintf(out, sizeof(out), "j%014llx", (unsigned long long)(h & 0x00ffffffffffffffULL));
  return String(out); // Full identity is checked too; a collision never runs a motor.
}
bool sameJob(JsonDocument &a, JsonDocument &b) {
  return String(a["jobId"] | "") == String(b["jobId"] | "") &&
    String(a["kitId"] | "") == String(b["kitId"] | "") &&
    a["motor"].as<int>() == b["motor"].as<int>() &&
    a["quantity"].as<int>() == b["quantity"].as<int>();
}
void onMessage(char *topic, byte *payload, unsigned length) {
  if (!storageOK || length > 1500) return;
  // Copy before any future publish: PubSubClient shares its packet buffer.
  String receivedTopic(topic);
  JsonDocument data;
  if (deserializeJson(data, payload, length)) return;
  if (receivedTopic.startsWith("reliv/dispense/receipt/")) {
    if (!pendingKey.length() || cycle.active) return;
    JsonDocument saved;
    if (deserializeJson(saved, pendingResult)) { storageFault(); return; }
    if (data["recorded"].is<bool>() && data["recorded"].as<bool>() &&
        receivedTopic == "reliv/dispense/receipt/" + String(saved["jobId"] | "") &&
        sameJob(saved, data) &&
        String(data["status"] | "") == String(saved["status"] | "")) {
      // Keep per-job replay ledger. Remove only the acknowledged outbox pointer.
      if (!journal.remove("outbox")) { storageFault(); return; }
      pendingKey = ""; pendingResult = "";
      Serial.println("Pi recorded result. Ready for next job.");
    }
    return;
  }
  String jobId = data["jobId"] | "";
  String kitId = data["kitId"] | "";
  if (receivedTopic != "reliv/dispense/" + jobId || !validId(jobId) || !validId(kitId) ||
      !data["motor"].is<int>() || !data["quantity"].is<int>() ||
      data["motor"].as<int>() < 1 || data["motor"].as<int>() > 3 ||
      data["quantity"].as<int>() < 1 || data["quantity"].as<int>() > 10) {
    Serial.println("Rejected invalid motor command."); return;
  }
  String command;
  serializeJson(data, command);
  // A duplicate of the active job is handled by its durable outbox.
  if (pendingKey == keyFor(jobId)) return;
  for (unsigned i = 0; i < queued; ++i) {
    JsonDocument existing; deserializeJson(existing, queue[i]);
    if (String(existing["jobId"] | "") == jobId) return;
  }
  if (queued == QUEUE_SIZE) {
    Serial.println("Queue full: command not executed; Pi timeout requires staff review."); return;
  }
  queue[queued++] = command;
}
void startNext() {
  if (!storageOK || pendingKey.length() || !queued || cycle.active || !mqtt.connected()) return;
  String command = queue[0];
  for (unsigned i = 1; i < queued; ++i) queue[i - 1] = queue[i];
  queue[--queued] = "";
  JsonDocument data; deserializeJson(data, command);
  String key = keyFor(data["jobId"].as<String>());
  if (journal.isKey(key.c_str())) {
    String previous = journal.getString(key.c_str(), "");
    JsonDocument saved;
    if (deserializeJson(saved, previous) || !sameJob(saved, data)) { storageFault(); return; }
    // Replay the result, NEVER the motor operation.
    if (!persist("outbox", key)) return;
    pendingKey = key; pendingResult = previous;
    return;
  }
  data["status"] = "RUNNING";
  data["success"] = false;
  data["confirmationType"] = "timed_motor_cycle";
  data["deliveryVerified"] = false;
  String record; serializeJson(data, record);
  // Both writes must succeed and read back before any GPIO is energized.
  if (!persist(key, record) || !persist("outbox", key)) return;
  pendingKey = key; pendingResult = record;
  activeMotor = data["motor"].as<int>() - 1;
  cycle.start(data["quantity"].as<unsigned>(), millis());
  digitalWrite(RELAY_PINS[activeMotor], RELAY_ON);
  Serial.println("Running paid dispense job: " + data["jobId"].as<String>());
}
void tickMotor() {
  if (!cycle.active) return;
  cycle.tick(millis());
  digitalWrite(RELAY_PINS[activeMotor], cycle.on ? RELAY_ON : RELAY_OFF);
  if (cycle.active) return;
  allOff(); activeMotor = -1;
  JsonDocument result; deserializeJson(result, pendingResult);
  result["status"] = "SUCCESS"; result["success"] = true;
  result["message"] = "Timed motor cycles completed; medicine drop not sensor-verified.";
  String record; serializeJson(result, record);
  if (persist(pendingKey, record)) pendingResult = record;
}
void sendResult() {
  if (!pendingKey.length() || cycle.active || millis() - ackAttempt < 3000) return;
  ackAttempt = millis();
  JsonDocument data;
  if (deserializeJson(data, pendingResult)) { storageFault(); return; }
  if (String(data["status"] | "") == "RUNNING") {
    // A reboot or a failed final write makes the physical result uncertain.
    data["status"] = "ERROR"; data["success"] = false;
    data["message"] = "Interrupted or unrecorded motor operation. Staff must check tray; no automatic retry.";
    String record; serializeJson(data, record);
    if (!persist(pendingKey, record)) return;
    pendingResult = record;
  }
  String topic = "reliv/dispense/confirm/" + String(data["jobId"] | "");
  mqtt.publish(topic.c_str(), pendingResult.c_str(), false);
  // A socket write is NOT a receipt. Retry until Pi confirms durable storage.
}
void maintainConnection() {
  uint32_t now = millis();
  if (WiFi.status() != WL_CONNECTED) {
    if (now - wifiAttempt >= 20000) {
      wifiAttempt = now; WiFi.disconnect();
      WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    }
    return;
  }
  if (!mqtt.connected() && now - mqttAttempt >= 5000) {
    mqttAttempt = now;
    bool connected = MQTT_USERNAME[0]
      ? mqtt.connect(clientId.c_str(), MQTT_USERNAME, MQTT_PASSWORD)
      : mqtt.connect(clientId.c_str());
    if (connected) {
      if (!mqtt.subscribe("reliv/dispense/+", 1) ||
          !mqtt.subscribe("reliv/dispense/receipt/+", 1)) mqtt.disconnect();
      else Serial.println("Motor ESP connected to local Pi MQTT.");
    }
  }
}
void setup() {
  Serial.begin(115200);
  for (int pin : RELAY_PINS) { digitalWrite(pin, RELAY_OFF); pinMode(pin, OUTPUT); }
  allOff();
  storageOK = journal.begin("reliv-motor", false);
  if (!storageOK) { storageFault(); return; }
  pendingKey = journal.getString("outbox", "");
  if (pendingKey.length()) {
    pendingResult = journal.getString(pendingKey.c_str(), "");
    if (!pendingResult.length()) { storageFault(); return; }
  }
  WiFi.mode(WIFI_STA);
  clientId = "reliv-motor-" + WiFi.macAddress();
  WiFi.setAutoReconnect(true); WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD); wifiAttempt = millis();
  mqtt.setServer("192.168.50.1", 1883);
  mqtt.setCallback(onMessage);
  mqtt.setKeepAlive(30); mqtt.setSocketTimeout(1);
  if (!mqtt.setBufferSize(2048)) storageFault();
}
void loop() {
  if (!storageOK) { allOff(); delay(100); return; }
  tickMotor();
  if (!storageOK) return;
  // Reconnect/socket/flash work cannot extend an energized 2.3-second phase.
  if (cycle.on) { delay(1); return; }
  maintainConnection();
  if (mqtt.connected()) {
    mqtt.loop();
    if (storageOK) sendResult();
    if (storageOK) startNext();
  }
  delay(1);
}
