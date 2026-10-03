import express from 'express';
import { wifiManager } from '../services/wifiManager.js';

export function createWifiRouter() {
    const router = express.Router();

    // ── JSON API ENDPOINTS ──

    // 1. Get current Wi-Fi status
    router.get('/status', async (req, res) => {
        try {
            const status = await wifiManager.getStatus();
            res.json({ success: true, status });
        } catch (err) {
            console.error('[API /api/wifi/status] Error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // 2. Scan available Wi-Fi networks (cached / passive scan)
    router.get('/scan', async (req, res) => {
        try {
            const networks = await wifiManager.scanNetworks({ forceRescan: false });
            res.json({ success: true, networks, count: networks.length });
        } catch (err) {
            console.error('[API /api/wifi/scan] Error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // 3. Force fresh active Wi-Fi rescan
    router.post('/rescan', async (req, res) => {
        try {
            const networks = await wifiManager.scanNetworks({ forceRescan: true });
            res.json({ success: true, networks, count: networks.length });
        } catch (err) {
            console.error('[API /api/wifi/rescan] Error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // 4. Get saved network profiles
    router.get('/saved', async (req, res) => {
        try {
            const saved = await wifiManager.getSavedNetworks();
            res.json({ success: true, saved });
        } catch (err) {
            console.error('[API /api/wifi/saved] Error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // 5. Connect to a Wi-Fi network (with optional password and hidden flag)
    router.post('/connect', async (req, res) => {
        try {
            const { ssid, password, hidden } = req.body || {};
            if (!ssid) {
                return res.status(400).json({ success: false, error: 'SSID is required' });
            }

            const result = await wifiManager.connectNetwork({
                ssid: String(ssid).trim(),
                password: password ? String(password) : '',
                hidden: Boolean(hidden)
            });

            res.json(result);
        } catch (err) {
            console.error('[API /api/wifi/connect] Error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // 6. Switch back to a saved network
    router.post('/switch', async (req, res) => {
        try {
            const { ssid } = req.body || {};
            if (!ssid) {
                return res.status(400).json({ success: false, error: 'SSID is required' });
            }

            const result = await wifiManager.switchNetwork(String(ssid).trim());
            res.json(result);
        } catch (err) {
            console.error('[API /api/wifi/switch] Error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // 7. Disconnect from current Wi-Fi
    router.post('/disconnect', async (req, res) => {
        try {
            const result = await wifiManager.disconnectNetwork();
            res.json(result);
        } catch (err) {
            console.error('[API /api/wifi/disconnect] Error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // 8. Forget a saved Wi-Fi profile
    router.post('/forget', async (req, res) => {
        try {
            const { ssid } = req.body || {};
            if (!ssid) {
                return res.status(400).json({ success: false, error: 'SSID is required' });
            }

            const result = await wifiManager.forgetNetwork(String(ssid).trim());
            res.json(result);
        } catch (err) {
            console.error('[API /api/wifi/forget] Error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    return router;
}

/**
 * Express handler that renders the standalone, self-contained, Apple-designed mobile Wi-Fi portal
 */
export function wifiPortalHtmlHandler(req, res) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <title>Reliv Kiosk Wi-Fi Control</title>
  <style>
    :root {
      --bg-primary: #f2f2f7;
      --card-bg: #ffffff;
      --card-border: #e5e5ea;
      --text-main: #1c1c1e;
      --text-secondary: #8e8e93;
      --accent: #007aff;
      --accent-hover: #0056b3;
      --success: #34c759;
      --danger: #ff3b30;
      --warning: #ff9500;
      --separator: #c6c6c8;
      --font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
    body {
      font-family: var(--font-family);
      background-color: var(--bg-primary);
      color: var(--text-main);
      padding: 16px 16px 80px 16px;
      line-height: 1.4;
      -webkit-font-smoothing: antialiased;
    }
    .container {
      max-width: 460px;
      margin: 0 auto;
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 20px;
      padding-top: 8px;
    }
    .header-left {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .logo-badge {
      width: 40px;
      height: 40px;
      background: linear-gradient(135deg, #0f766e, #0e7490);
      border-radius: 11px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      font-weight: 800;
      font-size: 20px;
      box-shadow: 0 4px 12px rgba(15, 118, 110, 0.25);
    }
    .title-group h1 {
      font-size: 20px;
      font-weight: 700;
      letter-spacing: -0.4px;
    }
    .title-group p {
      font-size: 13px;
      color: var(--text-secondary);
    }
    .rescan-btn {
      background: #fff;
      border: 1px solid var(--card-border);
      border-radius: 20px;
      padding: 7px 14px;
      font-size: 13px;
      font-weight: 600;
      color: var(--accent);
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      transition: all 0.2s ease;
      box-shadow: 0 1px 3px rgba(0,0,0,0.05);
    }
    .rescan-btn:active {
      background: #e5e5ea;
      transform: scale(0.97);
    }
    .rescan-btn.spinning svg {
      animation: spin 1s linear infinite;
    }
    @keyframes spin { 100% { transform: rotate(360deg); } }

    /* SECTION CARDS */
    .section-label {
      font-size: 13px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.2px;
      color: var(--text-secondary);
      margin: 20px 0 8px 12px;
    }
    .card {
      background: var(--card-bg);
      border-radius: 14px;
      overflow: hidden;
      box-shadow: 0 1px 4px rgba(0,0,0,0.04);
      border: 0.5px solid var(--card-border);
    }

    /* CURRENT WIFI HERO CARD */
    .current-card {
      padding: 18px;
    }
    .current-top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      margin-bottom: 12px;
    }
    .current-ssid-title {
      font-size: 21px;
      font-weight: 700;
      letter-spacing: -0.3px;
      color: var(--text-main);
      display: flex;
      align-items: center;
      gap: 8px;
      word-break: break-word;
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 600;
    }
    .status-connected {
      background: #e8f9ed;
      color: #1b873f;
    }
    .status-local {
      background: #fff8e6;
      color: #b45309;
    }
    .status-disconnected {
      background: #f2f2f7;
      color: #636366;
    }
    .pulse-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: currentColor;
      box-shadow: 0 0 0 rgba(52, 199, 89, 0.4);
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0% { box-shadow: 0 0 0 0 currentColor; }
      70% { box-shadow: 0 0 0 5px rgba(0,0,0,0); }
      100% { box-shadow: 0 0 0 0 rgba(0,0,0,0); }
    }
    .details-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 10px;
      padding-top: 14px;
      border-top: 0.5px solid #efeff4;
      margin-top: 14px;
    }
    .grid-item {
      font-size: 12px;
    }
    .grid-item .label {
      color: var(--text-secondary);
      margin-bottom: 2px;
    }
    .grid-item .val {
      font-weight: 600;
      color: var(--text-main);
      font-size: 13px;
    }
    .btn-disconnect {
      width: 100%;
      margin-top: 14px;
      background: #ffe5e5;
      color: var(--danger);
      border: none;
      padding: 10px;
      border-radius: 10px;
      font-weight: 600;
      font-size: 13px;
      cursor: pointer;
    }
    .btn-disconnect:active { background: #ffd0d0; }

    /* NETWORK LIST */
    .network-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 16px;
      border-bottom: 0.5px solid #efeff4;
      cursor: pointer;
      user-select: none;
      transition: background 0.15s ease;
    }
    .network-row:last-child {
      border-bottom: none;
    }
    .network-row:active {
      background: #f2f2f7;
    }
    .net-left {
      display: flex;
      align-items: center;
      gap: 12px;
      flex: 1;
      overflow: hidden;
    }
    .net-name {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-main);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .net-meta {
      font-size: 12px;
      color: var(--text-secondary);
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .net-right {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .sig-bars {
      display: flex;
      align-items: flex-end;
      gap: 2px;
      height: 14px;
    }
    .bar {
      width: 3.5px;
      background: #d1d1d6;
      border-radius: 1px;
    }
    .bar.active { background: var(--text-main); }
    .bar-1 { height: 3.5px; }
    .bar-2 { height: 7px; }
    .bar-3 { height: 10.5px; }
    .bar-4 { height: 14px; }

    .in-use-check {
      color: var(--accent);
      width: 18px;
      height: 18px;
    }
    .btn-action-small {
      border: 1px solid var(--card-border);
      background: #fff;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 600;
      padding: 5px 10px;
      color: var(--accent);
      cursor: pointer;
    }
    .btn-action-small:active { background: #e5e5ea; }
    .btn-forget {
      color: var(--danger);
      background: #fff5f5;
      border-color: #ffd0d0;
    }

    /* ADD OTHER NETWORK BUTTON */
    .btn-add-other {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      width: 100%;
      padding: 14px;
      background: var(--card-bg);
      border: 0.5px solid var(--card-border);
      border-radius: 14px;
      font-size: 15px;
      font-weight: 600;
      color: var(--accent);
      cursor: pointer;
      margin-top: 14px;
    }
    .btn-add-other:active { background: #e5e5ea; }

    /* MODAL */
    .modal-overlay {
      display: none;
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.45);
      backdrop-filter: blur(4px);
      z-index: 1000;
      align-items: center;
      justify-content: center;
      padding: 16px;
    }
    .modal-overlay.open { display: flex; }
    .modal-card {
      background: #fff;
      border-radius: 18px;
      width: 100%;
      max-width: 380px;
      padding: 22px;
      box-shadow: 0 20px 40px rgba(0,0,0,0.2);
      animation: modalSlideUp 0.25s ease-out;
    }
    @keyframes modalSlideUp {
      from { transform: translateY(20px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }
    .modal-title {
      font-size: 18px;
      font-weight: 700;
      margin-bottom: 4px;
    }
    .modal-sub {
      font-size: 13px;
      color: var(--text-secondary);
      margin-bottom: 18px;
    }
    .input-group {
      margin-bottom: 14px;
    }
    .input-label {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-secondary);
      margin-bottom: 5px;
      display: block;
    }
    .input-field {
      width: 100%;
      border: 1px solid var(--card-border);
      background: #f9f9fb;
      border-radius: 10px;
      padding: 12px 14px;
      font-size: 15px;
      outline: none;
      transition: border-color 0.2s;
    }
    .input-field:focus {
      border-color: var(--accent);
      background: #fff;
    }
    .pass-container {
      position: relative;
    }
    .toggle-pass-btn {
      position: absolute;
      right: 12px;
      top: 50%;
      transform: translateY(-50%);
      background: none;
      border: none;
      color: var(--text-secondary);
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
    }
    .modal-buttons {
      display: flex;
      gap: 10px;
      margin-top: 20px;
    }
    .btn-modal-cancel {
      flex: 1;
      padding: 12px;
      background: #efeff4;
      color: var(--text-main);
      border: none;
      border-radius: 11px;
      font-weight: 600;
      font-size: 15px;
      cursor: pointer;
    }
    .btn-modal-join {
      flex: 1;
      padding: 12px;
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 11px;
      font-weight: 600;
      font-size: 15px;
      cursor: pointer;
    }
    .btn-modal-join:disabled {
      background: #a0c9ff;
      cursor: not-allowed;
    }

    /* TOAST */
    .toast {
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%) translateY(100px);
      background: rgba(28, 28, 30, 0.95);
      color: #fff;
      padding: 10px 18px;
      border-radius: 20px;
      font-size: 13px;
      font-weight: 500;
      backdrop-filter: blur(10px);
      box-shadow: 0 8px 24px rgba(0,0,0,0.25);
      transition: transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
      z-index: 2000;
      white-space: nowrap;
      pointer-events: none;
    }
    .toast.show {
      transform: translateX(-50%) translateY(0);
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- HEADER -->
    <div class="header">
      <div class="header-left">
        <div class="logo-badge">R</div>
        <div class="title-group">
          <h1>Wi-Fi Settings</h1>
          <p id="kioskSubtitle">Raspberry Pi Kiosk • 192.168.50.1</p>
        </div>
      </div>
      <button class="rescan-btn" id="btnRescan" onclick="triggerRescan()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/>
        </svg>
        <span>Scan</span>
      </button>
    </div>

    <!-- CURRENT CONNECTION -->
    <div class="section-label">Current Connection</div>
    <div class="card current-card" id="currentWifiCard">
      <div class="current-top">
        <div>
          <div class="current-ssid-title" id="currentSsid">Loading...</div>
          <div style="font-size: 13px; color: var(--text-secondary); margin-top: 3px;" id="currentIp">Detecting...</div>
        </div>
        <div class="status-badge status-disconnected" id="statusBadge">
          <div class="pulse-dot"></div>
          <span id="statusText">Checking</span>
        </div>
      </div>

      <div class="details-grid" id="currentDetails" style="display:none;">
        <div class="grid-item">
          <div class="label">Signal Strength</div>
          <div class="val" id="valSignal">--</div>
        </div>
        <div class="grid-item">
          <div class="label">Frequency Band</div>
          <div class="val" id="valFreq">--</div>
        </div>
        <div class="grid-item">
          <div class="label">Security</div>
          <div class="val" id="valSec">--</div>
        </div>
        <div class="grid-item">
          <div class="label">Gateway Router</div>
          <div class="val" id="valGateway">--</div>
        </div>
        <div class="grid-item">
          <div class="label">Pi MAC Address</div>
          <div class="val" id="valMac">--</div>
        </div>
        <div class="grid-item">
          <div class="label">Internet Status</div>
          <div class="val" id="valInternet">--</div>
        </div>
      </div>

      <button class="btn-disconnect" id="btnDisconnect" style="display:none;" onclick="disconnectCurrent()">Disconnect Wi-Fi</button>
    </div>

    <!-- SAVED NETWORKS -->
    <div class="section-label" id="savedLabel" style="display:none;">Saved Networks</div>
    <div class="card" id="savedListCard" style="display:none;">
      <!-- Populated dynamically -->
    </div>

    <!-- AVAILABLE NETWORKS -->
    <div class="section-label">Available Networks</div>
    <div class="card" id="networkListCard">
      <div style="padding: 24px; text-align: center; color: var(--text-secondary); font-size: 14px;">
        Searching for nearby networks...
      </div>
    </div>

    <!-- ADD OTHER NETWORK BUTTON -->
    <button class="btn-add-other" onclick="openJoinModal('', true)">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="12" y1="5" x2="12" y2="19"></line>
        <line x1="5" y1="12" x2="19" y2="12"></line>
      </svg>
      <span>Join Other Network...</span>
    </button>
  </div>

  <!-- PASSWORD / JOIN MODAL -->
  <div class="modal-overlay" id="joinModal">
    <div class="modal-card">
      <div class="modal-title" id="modalTitle">Enter Password</div>
      <div class="modal-sub" id="modalSub">Connect to Wi-Fi</div>

      <div class="input-group" id="ssidInputGroup" style="display:none;">
        <label class="input-label">Network Name (SSID)</label>
        <input type="text" class="input-field" id="inputCustomSsid" placeholder="e.g. MyHomeWiFi" autocomplete="off" autocorrect="off" autocapitalize="none">
      </div>

      <div class="input-group" id="passInputGroup">
        <label class="input-label">Password</label>
        <div class="pass-container">
          <input type="password" class="input-field" id="inputPassword" placeholder="Required" autocomplete="off" autocorrect="off" autocapitalize="none">
          <button type="button" class="toggle-pass-btn" onclick="togglePasswordVisibility()">Show</button>
        </div>
      </div>

      <div class="modal-buttons">
        <button class="btn-modal-cancel" onclick="closeJoinModal()">Cancel</button>
        <button class="btn-modal-join" id="btnModalJoin" onclick="submitJoin()">Join</button>
      </div>
    </div>
  </div>

  <!-- TOAST NOTIFICATION -->
  <div class="toast" id="toast"></div>

  <script>
    let currentStatus = null;
    let selectedSsid = '';
    let isHiddenCustom = false;
    let pollInterval = null;

    function showToast(msg) {
      const toast = document.getElementById('toast');
      toast.innerText = msg;
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 3500);
    }

    function renderBars(signal) {
      const s = Number(signal) || 0;
      return \`
        <div class="sig-bars" title="\${s}%">
          <div class="bar bar-1 \${s >= 20 ? 'active' : ''}"></div>
          <div class="bar bar-2 \${s >= 40 ? 'active' : ''}"></div>
          <div class="bar bar-3 \${s >= 65 ? 'active' : ''}"></div>
          <div class="bar bar-4 \${s >= 85 ? 'active' : ''}"></div>
        </div>
      \`;
    }

    async function loadStatus() {
      try {
        const res = await fetch('/api/wifi/status');
        const data = await res.json();
        if (data && data.success) {
          currentStatus = data.status;
          updateStatusUI(currentStatus);
        }
      } catch (err) {
        console.warn('Failed to load Wi-Fi status:', err);
      }
    }

    function updateStatusUI(st) {
      const ssidEl = document.getElementById('currentSsid');
      const ipEl = document.getElementById('currentIp');
      const badgeEl = document.getElementById('statusBadge');
      const textEl = document.getElementById('statusText');
      const detailsEl = document.getElementById('currentDetails');
      const discBtn = document.getElementById('btnDisconnect');

      if (st && st.connected && st.ssid) {
        ssidEl.innerText = st.ssid;
        ipEl.innerText = st.ip ? \`IP: \${st.ip}\` : 'Connected';
        
        badgeEl.className = 'status-badge ' + (st.internetReachable ? 'status-connected' : 'status-local');
        textEl.innerText = st.internetReachable ? 'Online' : 'Local Only';
        
        detailsEl.style.display = 'grid';
        discBtn.style.display = 'block';

        document.getElementById('valSignal').innerText = \`\${st.signal || 0}% (\${st.bars || ''})\`;
        document.getElementById('valFreq').innerText = st.frequency || '2.4 GHz';
        document.getElementById('valSec').innerText = st.security || 'WPA2';
        document.getElementById('valGateway').innerText = st.gateway || '--';
        document.getElementById('valMac').innerText = st.mac || '--';
        document.getElementById('valInternet').innerText = st.internetReachable ? '✓ Connected to Internet' : '⚠ No external Internet';
      } else {
        ssidEl.innerText = 'Not Connected';
        ipEl.innerText = 'Pi is not connected to any external Wi-Fi';
        badgeEl.className = 'status-badge status-disconnected';
        textEl.innerText = 'Disconnected';
        detailsEl.style.display = 'none';
        discBtn.style.display = 'none';
      }
    }

    async function loadSaved() {
      try {
        const res = await fetch('/api/wifi/saved');
        const data = await res.json();
        const savedCard = document.getElementById('savedListCard');
        const savedLabel = document.getElementById('savedLabel');

        if (data && data.success && data.saved && data.saved.length > 0) {
          savedLabel.style.display = 'block';
          savedCard.style.display = 'block';

          savedCard.innerHTML = data.saved.map(net => {
            const isCurrent = currentStatus && currentStatus.connected && currentStatus.ssid === net.ssid;
            return \`
              <div class="network-row" onclick="onSavedClicked('\${encodeURIComponent(net.ssid)}', \${isCurrent})">
                <div class="net-left">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: \${isCurrent ? 'var(--accent)' : 'var(--text-secondary)'}; flex-shrink: 0;">
                    <path d="M5 12.55a11 11 0 0 1 14.08 0"/>
                    <path d="M1.42 9a16 16 0 0 1 21.16 0"/>
                    <path d="M8.53 16.11a6 6 0 0 1 6.95 0"/>
                    <line x1="12" y1="20" x2="12.01" y2="20"/>
                  </svg>
                  <div style="overflow: hidden;">
                    <div class="net-name">\${escapeHtml(net.ssid)}</div>
                    <div class="net-meta">
                      \${isCurrent ? '<span style="color:var(--success); font-weight:600;">Active Now</span>' : 'Saved Profile'}
                    </div>
                  </div>
                </div>
                <div class="net-right">
                  \${!isCurrent ? \`<button class="btn-action-small" onclick="event.stopPropagation(); switchToSaved('\${encodeURIComponent(net.ssid)}')">Switch Back</button>\` : ''}
                  <button class="btn-action-small btn-forget" onclick="event.stopPropagation(); forgetSaved('\${encodeURIComponent(net.ssid)}')">Forget</button>
                </div>
              </div>
            \`;
          }).join('');
        } else {
          savedLabel.style.display = 'none';
          savedCard.style.display = 'none';
        }
      } catch (err) {
        console.warn('Failed to load saved networks:', err);
      }
    }

    async function loadNetworks(force = false) {
      const card = document.getElementById('networkListCard');
      const btn = document.getElementById('btnRescan');

      btn.classList.add('spinning');
      if (force) {
        card.innerHTML = '<div style="padding: 24px; text-align: center; color: var(--text-secondary); font-size: 14px;">Scanning nearby Wi-Fi networks...</div>';
      }

      try {
        const url = force ? '/api/wifi/rescan' : '/api/wifi/scan';
        const method = force ? 'POST' : 'GET';
        const res = await fetch(url, { method });
        const data = await res.json();

        if (data && data.success && Array.isArray(data.networks)) {
          if (data.networks.length === 0) {
            card.innerHTML = '<div style="padding: 24px; text-align: center; color: var(--text-secondary); font-size: 14px;">No Wi-Fi networks found in range</div>';
            return;
          }

          card.innerHTML = data.networks.map(net => {
            const isCurrent = (currentStatus && currentStatus.connected && currentStatus.ssid === net.ssid) || net.inUse;
            return \`
              <div class="network-row" onclick="onNetworkClicked('\${encodeURIComponent(net.ssid)}', \${net.isOpen}, \${net.isSaved})">
                <div class="net-left">
                  <div style="overflow: hidden;">
                    <div class="net-name">\${escapeHtml(net.ssid)}</div>
                    <div class="net-meta">
                      <span>\${net.frequency || '2.4 GHz'}</span>
                      <span>•</span>
                      <span>\${net.security || 'Open'}</span>
                      \${net.isSaved ? '<span>• Saved</span>' : ''}
                    </div>
                  </div>
                </div>
                <div class="net-right">
                  \${!net.isOpen ? \`
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="color: var(--text-secondary);">
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                      <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                    </svg>
                  \` : ''}
                  \${renderBars(net.signal)}
                  \${isCurrent ? \`
                    <svg class="in-use-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                  \` : \`
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: #c7c7cc;">
                      <polyline points="9 18 15 12 9 6"/>
                    </svg>
                  \`}
                </div>
              </div>
            \`;
          }).join('');
        }
      } catch (err) {
        console.error('Error fetching networks:', err);
        card.innerHTML = '<div style="padding: 24px; text-align: center; color: var(--danger); font-size: 14px;">Error loading networks. Tap Scan to retry.</div>';
      } finally {
        btn.classList.remove('spinning');
      }
    }

    function triggerRescan() {
      loadNetworks(true);
    }

    function onNetworkClicked(encodedSsid, isOpen, isSaved) {
      const ssid = decodeURIComponent(encodedSsid);
      if (currentStatus && currentStatus.connected && currentStatus.ssid === ssid) {
        showToast(\`Already connected to \${ssid}\`);
        return;
      }

      if (isSaved) {
        // Can directly switch without retyping password
        switchToSaved(encodedSsid);
        return;
      }

      if (isOpen) {
        // Connect directly without password
        connectToNetwork(ssid, '');
        return;
      }

      // Prompt for password
      openJoinModal(ssid, false);
    }

    function onSavedClicked(encodedSsid, isCurrent) {
      if (isCurrent) return;
      switchToSaved(encodedSsid);
    }

    async function switchToSaved(encodedSsid) {
      const ssid = decodeURIComponent(encodedSsid);
      showToast(\`Switching to \${ssid}...\`);
      try {
        const res = await fetch('/api/wifi/switch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ssid })
        });
        const data = await res.json();
        if (data.success) {
          showToast(\`Connected to \${ssid}\`);
          await refreshAll();
        } else {
          showToast(\`Error: \${data.error || 'Failed to switch'}\`);
        }
      } catch (err) {
        showToast('Connection request failed');
      }
    }

    async function forgetSaved(encodedSsid) {
      const ssid = decodeURIComponent(encodedSsid);
      if (!confirm(\`Forget Wi-Fi network "\${ssid}"?\`)) return;
      try {
        const res = await fetch('/api/wifi/forget', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ssid })
        });
        const data = await res.json();
        if (data.success) {
          showToast(\`Forgot \${ssid}\`);
          await refreshAll();
        } else {
          showToast(\`Error: \${data.error || 'Failed'}\`);
        }
      } catch (err) {
        showToast('Failed to forget network');
      }
    }

    async function disconnectCurrent() {
      if (!confirm('Disconnect kiosk from current Wi-Fi?')) return;
      showToast('Disconnecting...');
      try {
        const res = await fetch('/api/wifi/disconnect', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          showToast('Disconnected');
          await refreshAll();
        }
      } catch (err) {
        showToast('Failed to disconnect');
      }
    }

    function openJoinModal(ssid, isCustom = false) {
      selectedSsid = ssid;
      isHiddenCustom = isCustom;

      const title = document.getElementById('modalTitle');
      const sub = document.getElementById('modalSub');
      const ssidGroup = document.getElementById('ssidInputGroup');
      const passInput = document.getElementById('inputPassword');
      const customSsidInput = document.getElementById('inputCustomSsid');

      passInput.value = '';
      customSsidInput.value = '';

      if (isCustom) {
        title.innerText = 'Join Other Network';
        sub.innerText = 'Enter network name and password';
        ssidGroup.style.display = 'block';
      } else {
        title.innerText = \`"\${ssid}"\`;
        sub.innerText = 'Enter Wi-Fi password';
        ssidGroup.style.display = 'none';
      }

      document.getElementById('joinModal').classList.add('open');
      setTimeout(() => {
        if (isCustom) customSsidInput.focus();
        else passInput.focus();
      }, 100);
    }

    function closeJoinModal() {
      document.getElementById('joinModal').classList.remove('open');
    }

    function togglePasswordVisibility() {
      const pass = document.getElementById('inputPassword');
      const btn = event.currentTarget;
      if (pass.type === 'password') {
        pass.type = 'text';
        btn.innerText = 'Hide';
      } else {
        pass.type = 'password';
        btn.innerText = 'Show';
      }
    }

    async function submitJoin() {
      const pass = document.getElementById('inputPassword').value;
      const ssid = isHiddenCustom ? document.getElementById('inputCustomSsid').value.trim() : selectedSsid;

      if (!ssid) {
        alert('Please enter a network name');
        return;
      }

      const btn = document.getElementById('btnModalJoin');
      btn.disabled = true;
      btn.innerText = 'Connecting...';

      closeJoinModal();
      showToast(\`Connecting to \${ssid}...\`);

      await connectToNetwork(ssid, pass, isHiddenCustom);

      btn.disabled = false;
      btn.innerText = 'Join';
    }

    async function connectToNetwork(ssid, password, hidden = false) {
      try {
        const res = await fetch('/api/wifi/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ssid, password, hidden })
        });
        const data = await res.json();
        if (data.success) {
          showToast(\`Connected to \${ssid}\`);
          await refreshAll();
        } else {
          showToast(\`Failed: \${data.error || 'Connection error'}\`);
        }
      } catch (err) {
        showToast('Connection attempt timed out or failed');
      }
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    async function refreshAll() {
      await loadStatus();
      await loadSaved();
      await loadNetworks(false);
    }

    // Auto-init and background poll
    window.addEventListener('DOMContentLoaded', () => {
      refreshAll();
      // Periodically refresh status every 5 seconds
      pollInterval = setInterval(loadStatus, 5000);
    });
  </script>
</body>
</html>
`;
    res.send(html);
}
