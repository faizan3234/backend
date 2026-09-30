#pragma once
#include <stdint.h>
// Copy to local_config.h. Never commit the filled-in file.
constexpr char WIFI_SSID[] = "RELIV-KIOSK";
constexpr char WIFI_PASSWORD[] = "ENTER_YOUR_EXISTING_KIOSK_WIFI_PASSWORD";
constexpr char MQTT_USERNAME[] = "";
constexpr char MQTT_PASSWORD[] = "";
// ESP32-S3 wiring must be verified. GPIO8/9 are unsafe on some classic ESP32 boards.
constexpr int I2C_SDA = 8;
constexpr int I2C_SCL = 9;
constexpr int BP_RX_PIN = 4;
// Measure floor-to-sensor distance; zero disables height pending calibration.
constexpr float MOUNT_HEIGHT_CM = 0.0f;
constexpr float HEIGHT_MAX_SPREAD_CM = 2.0f;
constexpr uint32_t MIN_FINGER_IR = 50000;
