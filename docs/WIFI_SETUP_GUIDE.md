# Reliv Kiosk Phone-Controlled Wi-Fi System

This system enables operators or technicians to connect to the kiosk's local Wi-Fi hotspot (`192.168.50.1`) on their smartphone and manage the kiosk's internet Wi-Fi connection via an Apple-designed, mobile-first interface.

---

## 1. How It Works

1. **Connect Phone to Kiosk Hotspot**:
   - Operator connects their smartphone to the Reliv Kiosk Wi-Fi network (AP runs on `192.168.50.1`).
2. **Open the Setup Page**:
   - Open browser on phone and navigate to:
     - `http://192.168.50.1/wifi` (via port 80 Nginx proxy)
     - or `http://192.168.50.1:5000/wifi` (direct Express backend)
     - or within the React app at `/wifi`.
3. **Manage Connection**:
   - **View Current Wi-Fi**: See what Wi-Fi the kiosk is currently connected to, its IP address, signal strength (RSSI), frequency band (2.4/5GHz), MAC address, and gateway router.
   - **Available Networks**: View all nearby Wi-Fi networks in range with security indicators and signal strength.
   - **Saved Networks**: View all saved network profiles.
   - **Switch Back**: One-tap switch back to any previously saved network.
   - **Add / Connect**: Tap any network to enter password, or join hidden networks with custom SSID & password.
   - **Forget**: Delete saved credentials.
   - **Disconnect**: Safely disconnect client Wi-Fi without disrupting the AP hotspot.

---

## 2. Architecture & Offline Safety

- **Dual-Interface Raspberry Pi Support**:
  The Raspberry Pi's local Access Point (`192.168.50.1`) is maintained on its hotspot interface while client internet Wi-Fi is managed on `wlan0`. Switching or changing external Wi-Fi never breaks the phone's connection to the setup portal.
- **Native NetworkManager (`nmcli`) on Linux**:
  On Raspberry Pi OS (Bookworm and modern Bullseye), `WifiManager` interacts directly with NetworkManager via `nmcli` for real-time scanning, connecting, saving, and switching network profiles.
- **Cross-Platform Mock Engine**:
  On non-Linux / development environments (Windows, macOS), the system uses an in-memory & JSON-persisted state engine (`data/wifi_state.json`) that fully simulates live scanning, connecting, switching, and forgetting networks.

---

## 3. REST API Reference

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/wifi/status` | Get current connection status (SSID, IP, signal, band, gateway, internet reachability) |
| `GET` | `/api/wifi/scan` | Get cached/recent list of nearby Wi-Fi networks |
| `POST` | `/api/wifi/rescan` | Trigger fresh active scan of nearby networks |
| `GET` | `/api/wifi/saved` | List all saved Wi-Fi network profiles on the kiosk |
| `POST` | `/api/wifi/connect` | Connect to a network: `{ ssid, password, hidden }` |
| `POST` | `/api/wifi/switch` | Switch back to a saved network: `{ ssid }` |
| `POST` | `/api/wifi/disconnect` | Disconnect from current Wi-Fi network |
| `POST` | `/api/wifi/forget` | Forget/delete a saved network profile: `{ ssid }` |
| `GET` | `/wifi` | Standalone Apple-designed mobile portal (0 dependencies) |
