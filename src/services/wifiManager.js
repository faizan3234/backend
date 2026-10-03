import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import net from 'net';

const execAsync = promisify(exec);

const STATE_FILE_PATH = path.join(process.cwd(), 'data', 'wifi_state.json');

// Helper to test if external internet is reachable via DNS port (53)
async function checkInternetReachable(timeoutMs = 1200) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let settled = false;

        const timer = setTimeout(() => {
            if (!settled) {
                settled = true;
                socket.destroy();
                resolve(false);
            }
        }, timeoutMs);

        socket.connect(53, '1.1.1.1', () => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                socket.destroy();
                resolve(true);
            }
        });

        socket.on('error', () => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                socket.destroy();
                resolve(false);
            }
        });
    });
}

function parseNmcliLine(line) {
    if (!line) return [];
    // Split on unescaped colons
    return line.split(/(?<!\\):/).map((part) => part.replace(/\\:/g, ':').trim());
}

function signalToBars(signal) {
    const s = Number(signal) || 0;
    if (s >= 75) return '▂▄▆█';
    if (s >= 50) return '▂▄▆_';
    if (s >= 25) return '▂▄__';
    if (s > 0) return '▂___';
    return '____';
}

function freqToBand(freqStr) {
    if (!freqStr) return '2.4 GHz';
    const num = parseInt(freqStr, 10);
    if (!Number.isNaN(num)) {
        if (num >= 4900 && num <= 5900) return '5 GHz';
        if (num >= 5925 && num <= 7125) return '6 GHz';
        if (num >= 2400 && num <= 2500) return '2.4 GHz';
    }
    const lower = String(freqStr).toLowerCase();
    if (lower.includes('5')) return '5 GHz';
    return '2.4 GHz';
}

export class WifiManager {
    constructor(options = {}) {
        this.interfaceName = options.interfaceName || 'wlan0';
        this.isLinux = process.platform === 'linux';
        this.backendMode = null; // 'nmcli' | 'mock'
        this._initPromise = this._detectBackend();
    }

    async _detectBackend() {
        if (!this.isLinux) {
            this.backendMode = 'mock';
            return;
        }

        try {
            const { stdout } = await execAsync('which nmcli');
            if (stdout && stdout.trim().length > 0) {
                this.backendMode = 'nmcli';
                return;
            }
        } catch {
            // nmcli not found
        }

        this.backendMode = 'mock';
    }

    async _ensureReady() {
        if (!this.backendMode) {
            await this._initPromise;
        }
    }

    // ── MOCK PERSISTENCE LAYER (Used on Windows / Dev / non-Linux) ──

    _loadMockState() {
        try {
            if (fs.existsSync(STATE_FILE_PATH)) {
                const raw = fs.readFileSync(STATE_FILE_PATH, 'utf8');
                return JSON.parse(raw);
            }
        } catch (err) {
            console.warn('[WifiManager] Warning reading mock state:', err.message);
        }

        const defaultState = {
            connected: true,
            currentSsid: 'Reliv_Office_5GHz',
            bssid: '84:D8:1B:32:89:C4',
            ip: '192.168.1.145',
            mac: 'B8:27:EB:4A:8C:91',
            signal: 92,
            bars: '▂▄▆█',
            frequency: '5 GHz',
            channel: 44,
            security: 'WPA2-PSK',
            gateway: '192.168.1.1',
            internetReachable: true,
            lastUpdated: new Date().toISOString(),
            savedNetworks: [
                {
                    ssid: 'Reliv_Office_5GHz',
                    uuid: 'c4e85d10-8b9a-4e20-8012-701928bc001',
                    type: '802-11-wireless',
                    autoConnect: true,
                    isCurrent: true,
                    lastUsed: new Date(Date.now() - 3600000).toISOString()
                },
                {
                    ssid: 'Reliv_Field_Hotspot',
                    uuid: 'd893f412-1a2b-4390-99aa-881290bb002',
                    type: '802-11-wireless',
                    autoConnect: false,
                    isCurrent: false,
                    lastUsed: new Date(Date.now() - 86400000).toISOString()
                }
            ],
            nearbyPool: [
                { ssid: 'Reliv_Office_5GHz', signal: 94, security: 'WPA2', channel: 44, freq: '5 GHz' },
                { ssid: 'Airtel_Fiber_5G', signal: 86, security: 'WPA2/WPA3', channel: 36, freq: '5 GHz' },
                { ssid: 'Faizan_iPhone_Hotspot', signal: 78, security: 'WPA2', channel: 6, freq: '2.4 GHz' },
                { ssid: 'JioFiber_2.4G', signal: 68, security: 'WPA2', channel: 11, freq: '2.4 GHz' },
                { ssid: 'Reliv_Guest_Open', signal: 62, security: 'Open', channel: 1, freq: '2.4 GHz' },
                { ssid: 'Office_Warehouse_Ext', signal: 45, security: 'WPA2', channel: 9, freq: '2.4 GHz' }
            ]
        };

        this._saveMockState(defaultState);
        return defaultState;
    }

    _saveMockState(state) {
        try {
            const dir = path.dirname(STATE_FILE_PATH);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(state, null, 2), 'utf8');
        } catch (err) {
            console.error('[WifiManager] Failed to persist mock state:', err.message);
        }
    }

    // ── PUBLIC API METHODS ──

    /**
     * Get current Wi-Fi status and connection details
     */
    async getStatus() {
        await this._ensureReady();

        if (this.backendMode === 'nmcli') {
            return await this._getNmcliStatus();
        }
        return await this._getMockStatus();
    }

    /**
     * Scan available Wi-Fi networks in range
     */
    async scanNetworks(options = {}) {
        await this._ensureReady();
        const forceRescan = options.forceRescan !== false;

        if (this.backendMode === 'nmcli') {
            return await this._nmcliScan(forceRescan);
        }
        return await this._mockScan();
    }

    /**
     * List all saved network profiles on the system
     */
    async getSavedNetworks() {
        await this._ensureReady();

        if (this.backendMode === 'nmcli') {
            return await this._getNmcliSaved();
        }
        return await this._getMockSaved();
    }

    /**
     * Connect to a Wi-Fi network (with optional password and hidden flag)
     */
    async connectNetwork({ ssid, password, hidden = false }) {
        await this._ensureReady();
        if (!ssid || typeof ssid !== 'string' || !ssid.trim()) {
            throw new Error('SSID is required');
        }

        const trimmedSsid = ssid.trim();

        if (this.backendMode === 'nmcli') {
            return await this._nmcliConnect({ ssid: trimmedSsid, password, hidden });
        }
        return await this._mockConnect({ ssid: trimmedSsid, password, hidden });
    }

    /**
     * Switch back to an already saved network
     */
    async switchNetwork(ssid) {
        await this._ensureReady();
        if (!ssid || typeof ssid !== 'string' || !ssid.trim()) {
            throw new Error('SSID is required');
        }

        const trimmedSsid = ssid.trim();

        if (this.backendMode === 'nmcli') {
            return await this._nmcliSwitch(trimmedSsid);
        }
        return await this._mockSwitch(trimmedSsid);
    }

    /**
     * Disconnect from current Wi-Fi network
     */
    async disconnectNetwork() {
        await this._ensureReady();

        if (this.backendMode === 'nmcli') {
            return await this._nmcliDisconnect();
        }
        return await this._mockDisconnect();
    }

    /**
     * Forget / delete a saved Wi-Fi network profile
     */
    async forgetNetwork(ssid) {
        await this._ensureReady();
        if (!ssid || typeof ssid !== 'string' || !ssid.trim()) {
            throw new Error('SSID is required');
        }

        const trimmedSsid = ssid.trim();

        if (this.backendMode === 'nmcli') {
            return await this._nmcliForget(trimmedSsid);
        }
        return await this._mockForget(trimmedSsid);
    }

    // ── NMCLI IMPLEMENTATION (LINUX / RASPBERRY PI) ──

    async _getNmcliStatus() {
        try {
            const { stdout: wifiOut } = await execAsync(
                `nmcli -t -f active,ssid,bssid,signal,bars,security,freq dev wifi list ifname ${this.interfaceName} 2>/dev/null || nmcli -t -f active,ssid,bssid,signal,bars,security,freq dev wifi list`
            );

            let activeLine = null;
            const lines = wifiOut.split('\n');
            for (const line of lines) {
                const parts = parseNmcliLine(line);
                if (parts[0] && parts[0].toLowerCase() === 'yes') {
                    activeLine = parts;
                    break;
                }
            }

            let ipAddress = null;
            let macAddress = null;
            try {
                const { stdout: devOut } = await execAsync(
                    `nmcli -t -f IP4.ADDRESS,GENERAL.HWADDR dev show ${this.interfaceName} 2>/dev/null`
                );
                for (const line of devOut.split('\n')) {
                    const parts = parseNmcliLine(line);
                    if (parts[0] === 'IP4.ADDRESS[1]' || parts[0] === 'IP4.ADDRESS') {
                        ipAddress = parts[1]?.split('/')[0] || null;
                    }
                    if (parts[0] === 'GENERAL.HWADDR') {
                        macAddress = parts[1] || null;
                    }
                }
            } catch {
                // Ignore fallback to ip addr
            }

            if (!ipAddress) {
                try {
                    const { stdout: ipOut } = await execAsync(
                        `ip -j addr show ${this.interfaceName} 2>/dev/null`
                    );
                    const parsed = JSON.parse(ipOut);
                    const addrInfo = parsed[0]?.addr_info?.find((a) => a.family === 'inet');
                    if (addrInfo) ipAddress = addrInfo.local;
                    if (parsed[0]?.address) macAddress = parsed[0].address;
                } catch {
                    // Ignore
                }
            }

            let gateway = null;
            try {
                const { stdout: routeOut } = await execAsync(
                    `ip route show default dev ${this.interfaceName} 2>/dev/null || ip route show default 2>/dev/null`
                );
                const match = routeOut.match(/default via ([0-9.]+)/);
                if (match) gateway = match[1];
            } catch {
                // Ignore
            }

            const isConnected = !!activeLine && activeLine.length >= 2 && Boolean(activeLine[1]);
            const internetReachable = isConnected ? await checkInternetReachable() : false;

            if (isConnected) {
                const ssid = activeLine[1] || null;
                const bssid = activeLine[2] || null;
                const signal = Number(activeLine[3]) || 0;
                const bars = activeLine[4] || signalToBars(signal);
                const security = activeLine[5] || 'Open';
                const frequency = freqToBand(activeLine[6]);

                return {
                    connected: true,
                    ssid,
                    bssid,
                    ip: ipAddress,
                    mac: macAddress,
                    signal,
                    bars,
                    frequency,
                    security,
                    gateway,
                    internetReachable,
                    interface: this.interfaceName,
                    backend: 'nmcli',
                    lastUpdated: new Date().toISOString()
                };
            }

            return {
                connected: false,
                ssid: null,
                bssid: null,
                ip: ipAddress,
                mac: macAddress,
                signal: 0,
                bars: '____',
                frequency: null,
                security: null,
                gateway: null,
                internetReachable: false,
                interface: this.interfaceName,
                backend: 'nmcli',
                lastUpdated: new Date().toISOString()
            };
        } catch (err) {
            console.error('[WifiManager] Error getting nmcli status:', err.message);
            return {
                connected: false,
                ssid: null,
                error: err.message,
                interface: this.interfaceName,
                backend: 'nmcli',
                lastUpdated: new Date().toISOString()
            };
        }
    }

    async _nmcliScan(forceRescan = true) {
        try {
            if (forceRescan) {
                try {
                    await execAsync(
                        `nmcli dev wifi rescan ifname ${this.interfaceName} 2>/dev/null || nmcli dev wifi rescan 2>/dev/null`
                    );
                } catch {
                    // Ignore rescan throttle error (nmcli returns code 1 if scanned within 10s)
                }
            }

            const { stdout } = await execAsync(
                `nmcli -t -f IN-USE,SSID,BSSID,CHAN,FREQ,RATE,SIGNAL,BARS,SECURITY dev wifi list ifname ${this.interfaceName} 2>/dev/null || nmcli -t -f IN-USE,SSID,BSSID,CHAN,FREQ,RATE,SIGNAL,BARS,SECURITY dev wifi list`
            );

            const saved = await this._getNmcliSaved();
            const savedMap = new Set(saved.map((s) => s.ssid));

            const lines = stdout.split('\n');
            const networkMap = new Map();

            for (const line of lines) {
                if (!line.trim()) continue;
                const parts = parseNmcliLine(line);
                if (parts.length < 8) continue;

                const inUse = parts[0] === '*';
                const ssid = parts[1];
                if (!ssid || ssid === '--') continue;

                const bssid = parts[2];
                const channel = parseInt(parts[3], 10) || null;
                const freq = freqToBand(parts[4]);
                const signal = Number(parts[6]) || 0;
                const bars = parts[7] || signalToBars(signal);
                const rawSec = parts[8] || '';
                const isOpen = !rawSec || rawSec === '--';
                const security = isOpen ? 'Open' : rawSec;

                const existing = networkMap.get(ssid);
                if (!existing || signal > existing.signal || inUse) {
                    networkMap.set(ssid, {
                        ssid,
                        bssid,
                        signal,
                        bars,
                        channel,
                        frequency: freq,
                        security,
                        isOpen,
                        inUse,
                        isSaved: savedMap.has(ssid)
                    });
                }
            }

            const list = Array.from(networkMap.values());
            list.sort((a, b) => {
                if (a.inUse && !b.inUse) return -1;
                if (!a.inUse && b.inUse) return 1;
                return b.signal - a.signal;
            });

            return list;
        } catch (err) {
            console.error('[WifiManager] Error scanning networks with nmcli:', err.message);
            throw new Error(`Failed to scan networks: ${err.message}`);
        }
    }

    async _getNmcliSaved() {
        try {
            const { stdout } = await execAsync(
                `nmcli -t -f NAME,TYPE,UUID,AUTOCONNECT connection show 2>/dev/null`
            );

            const status = await this._getNmcliStatus();
            const currentSsid = status.connected ? status.ssid : null;

            const saved = [];
            for (const line of stdout.split('\n')) {
                if (!line.trim()) continue;
                const parts = parseNmcliLine(line);
                if (parts.length >= 3) {
                    const name = parts[0];
                    const type = parts[1];
                    const uuid = parts[2];
                    const autoConnect = parts[3] === 'yes';

                    if (type === '802-11-wireless' || type === 'wifi') {
                        saved.push({
                            ssid: name,
                            uuid,
                            type: '802-11-wireless',
                            autoConnect,
                            isCurrent: name === currentSsid
                        });
                    }
                }
            }
            return saved;
        } catch (err) {
            console.error('[WifiManager] Error getting saved networks:', err.message);
            return [];
        }
    }

    async _nmcliConnect({ ssid, password, hidden }) {
        try {
            const saved = await this._getNmcliSaved();
            const existing = saved.find((s) => s.ssid === ssid);

            if (existing && !password) {
                await execAsync(`nmcli connection up id "${ssid}"`);
            } else {
                const hiddenFlag = hidden ? 'hidden yes' : '';
                const passFlag = password ? `password "${password.replace(/"/g, '\\"')}"` : '';
                const cmd = `nmcli dev wifi connect "${ssid.replace(/"/g, '\\"')}" ${passFlag} ${hiddenFlag} ifname ${this.interfaceName}`.trim();
                
                await execAsync(cmd, { timeout: 25000 });
            }

            await new Promise((r) => setTimeout(r, 2000));
            const newStatus = await this._getNmcliStatus();

            return {
                success: true,
                message: `Successfully connected to ${ssid}`,
                status: newStatus
            };
        } catch (err) {
            console.error(`[WifiManager] Error connecting to ${ssid}:`, err.message);
            throw new Error(`Failed to connect to ${ssid}: ${err.message}`);
        }
    }

    async _nmcliSwitch(ssid) {
        try {
            await execAsync(`nmcli connection up id "${ssid.replace(/"/g, '\\"')}"`, { timeout: 20000 });
            await new Promise((r) => setTimeout(r, 1500));
            const newStatus = await this._getNmcliStatus();

            return {
                success: true,
                message: `Switched connection to ${ssid}`,
                status: newStatus
            };
        } catch (err) {
            console.error(`[WifiManager] Error switching to ${ssid}:`, err.message);
            throw new Error(`Failed to switch to ${ssid}: ${err.message}`);
        }
    }

    async _nmcliDisconnect() {
        try {
            await execAsync(`nmcli dev disconnect iface ${this.interfaceName} 2>/dev/null || nmcli dev disconnect ${this.interfaceName}`);
            await new Promise((r) => setTimeout(r, 1000));
            const status = await this._getNmcliStatus();
            return {
                success: true,
                message: 'Wi-Fi disconnected',
                status
            };
        } catch (err) {
            console.error('[WifiManager] Error disconnecting Wi-Fi:', err.message);
            throw new Error(`Failed to disconnect: ${err.message}`);
        }
    }

    async _nmcliForget(ssid) {
        try {
            await execAsync(`nmcli connection delete id "${ssid.replace(/"/g, '\\"')}"`);
            return {
                success: true,
                message: `Removed saved network ${ssid}`
            };
        } catch (err) {
            console.error(`[WifiManager] Error forgetting network ${ssid}:`, err.message);
            throw new Error(`Failed to forget network: ${err.message}`);
        }
    }

    // ── MOCK IMPLEMENTATION (WINDOWS / DEV / TESTS) ──

    async _getMockStatus() {
        const state = this._loadMockState();
        return {
            connected: state.connected,
            ssid: state.connected ? state.currentSsid : null,
            bssid: state.connected ? state.bssid : null,
            ip: state.connected ? state.ip : null,
            mac: state.mac || 'B8:27:EB:4A:8C:91',
            signal: state.connected ? state.signal : 0,
            bars: state.connected ? state.bars : '____',
            frequency: state.connected ? state.frequency : null,
            security: state.connected ? state.security : null,
            channel: state.connected ? state.channel : null,
            gateway: state.connected ? state.gateway : null,
            internetReachable: state.connected ? state.internetReachable : false,
            interface: this.interfaceName,
            backend: 'mock',
            lastUpdated: new Date().toISOString()
        };
    }

    async _mockScan() {
        const state = this._loadMockState();
        const savedMap = new Set(state.savedNetworks.map((s) => s.ssid));

        const list = state.nearbyPool.map((net) => {
            const inUse = state.connected && net.ssid === state.currentSsid;
            const signalJitter = Math.min(100, Math.max(10, net.signal + Math.floor(Math.random() * 5 - 2)));
            return {
                ssid: net.ssid,
                bssid: `B8:27:EB:${Math.floor(Math.random() * 89 + 10)}:${Math.floor(Math.random() * 89 + 10)}:${Math.floor(Math.random() * 89 + 10)}`,
                signal: signalJitter,
                bars: signalToBars(signalJitter),
                channel: net.channel || 6,
                frequency: net.freq || '2.4 GHz',
                security: net.security || 'WPA2',
                isOpen: net.security === 'Open',
                inUse,
                isSaved: savedMap.has(net.ssid)
            };
        });

        list.sort((a, b) => {
            if (a.inUse && !b.inUse) return -1;
            if (!a.inUse && b.inUse) return 1;
            return b.signal - a.signal;
        });

        return list;
    }

    async _getMockSaved() {
        const state = this._loadMockState();
        return state.savedNetworks.map((net) => ({
            ssid: net.ssid,
            uuid: net.uuid,
            type: '802-11-wireless',
            autoConnect: net.autoConnect ?? true,
            isCurrent: state.connected && net.ssid === state.currentSsid,
            lastUsed: net.lastUsed
        }));
    }

    async _mockConnect({ ssid, password, hidden }) {
        const state = this._loadMockState();

        await new Promise((r) => setTimeout(r, 400));

        state.connected = true;
        state.currentSsid = ssid;
        state.ip = '192.168.1.' + Math.floor(Math.random() * 150 + 50);
        state.signal = Math.floor(Math.random() * 20 + 80);
        state.bars = signalToBars(state.signal);
        state.internetReachable = true;
        state.security = password ? 'WPA2' : 'Open';
        state.lastUpdated = new Date().toISOString();

        const existingIdx = state.savedNetworks.findIndex((s) => s.ssid === ssid);
        if (existingIdx >= 0) {
            state.savedNetworks[existingIdx].lastUsed = new Date().toISOString();
            state.savedNetworks[existingIdx].isCurrent = true;
        } else {
            state.savedNetworks.push({
                ssid,
                uuid: 'mock-uuid-' + Date.now().toString(36),
                type: '802-11-wireless',
                autoConnect: true,
                isCurrent: true,
                lastUsed: new Date().toISOString()
            });
        }

        if (!state.nearbyPool.some((n) => n.ssid === ssid)) {
            state.nearbyPool.push({
                ssid,
                signal: state.signal,
                security: state.security,
                channel: 36,
                freq: '5 GHz'
            });
        }

        for (const net of state.savedNetworks) {
            if (net.ssid !== ssid) {
                net.isCurrent = false;
            }
        }

        this._saveMockState(state);

        return {
            success: true,
            message: `Connected to ${ssid}`,
            status: await this._getMockStatus()
        };
    }

    async _mockSwitch(ssid) {
        const state = this._loadMockState();
        const saved = state.savedNetworks.find((s) => s.ssid === ssid);
        if (!saved) {
            throw new Error(`Network ${ssid} is not in saved networks list`);
        }

        await new Promise((r) => setTimeout(r, 300));

        state.connected = true;
        state.currentSsid = ssid;
        state.ip = '192.168.1.' + Math.floor(Math.random() * 150 + 50);
        state.signal = Math.floor(Math.random() * 15 + 85);
        state.bars = signalToBars(state.signal);
        state.internetReachable = true;
        state.lastUpdated = new Date().toISOString();

        for (const net of state.savedNetworks) {
            net.isCurrent = net.ssid === ssid;
            if (net.isCurrent) net.lastUsed = new Date().toISOString();
        }

        this._saveMockState(state);

        return {
            success: true,
            message: `Switched connection to ${ssid}`,
            status: await this._getMockStatus()
        };
    }

    async _mockDisconnect() {
        const state = this._loadMockState();
        state.connected = false;
        state.currentSsid = null;
        state.signal = 0;
        state.bars = '____';
        state.internetReachable = false;
        state.lastUpdated = new Date().toISOString();

        for (const net of state.savedNetworks) {
            net.isCurrent = false;
        }

        this._saveMockState(state);

        return {
            success: true,
            message: 'Wi-Fi disconnected',
            status: await this._getMockStatus()
        };
    }

    async _mockForget(ssid) {
        const state = this._loadMockState();
        state.savedNetworks = state.savedNetworks.filter((s) => s.ssid !== ssid);

        if (state.connected && state.currentSsid === ssid) {
            state.connected = false;
            state.currentSsid = null;
            state.signal = 0;
            state.bars = '____';
            state.internetReachable = false;
        }

        this._saveMockState(state);

        return {
            success: true,
            message: `Removed saved network ${ssid}`
        };
    }
}

export const wifiManager = new WifiManager();
export default wifiManager;
