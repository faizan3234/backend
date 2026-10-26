#pragma once
// Copy this file to local_config.h (gitignored), then fill in your AP password.
constexpr char WIFI_SSID[] = "RELIV-KIOSK";
constexpr char WIFI_PASSWORD[] = "CHANGE_ME";
constexpr char MQTT_USERNAME[] = "";
constexpr char MQTT_PASSWORD[] = "";
constexpr int RELAY_PINS[] = {18, 19, 21};
// Matches the supplied active-HIGH relay circuit. Verify with motors disconnected.
constexpr int RELAY_ON = HIGH;
constexpr int RELAY_OFF = LOW;
