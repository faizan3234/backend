import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
const HELPER = '/usr/local/libexec/reliv-wifi-helper';
const active = new Set(['scheduled', 'connecting', 'connected', 'restoring', 'restore_failed']);
export function helperRequest(input) {
    return new Promise((resolve, reject) => {
        const child = execFile('/usr/bin/sudo', ['-n', HELPER], { timeout: 65000, maxBuffer: 65536 }, (error, stdout) => {
            let response;
            try { response = JSON.parse(stdout); } catch { /* Never return stderr / credentials. */ }
            if (error || !response?.ok) return reject(new Error(response?.error || 'Wi-Fi control is unavailable. Install the Pi helper first.'));
            resolve(response.result);
        });
        child.stdin.on('error', () => {});
        child.stdin.end(JSON.stringify(input));
    });
}
export function assertWifiIdle(db) {
    if (!db) throw new Error('Local database is not ready.');
    const now = Date.now();
    const jobs = db.prepare("SELECT 1 FROM fulfillment_jobs WHERE state IN ('PENDING','IN_PROGRESS') LIMIT 1").get();
    const session = db.prepare("SELECT 1 FROM sessions WHERE status NOT IN ('CREATED','COMPLETED','EXPIRED','CANCELLED') AND julianday(expires_at)>julianday(?) LIMIT 1").get(new Date(now).toISOString());
    const payment = db.prepare("SELECT 1 FROM payment_v2_requests WHERE status='ACTIVE' AND expires_at>? LIMIT 1").get(now);
    const ad = db.prepare("SELECT 1 FROM ad_payment_requests WHERE status IN ('ACTIVE','VERIFIED') AND expires_at+900000>? LIMIT 1").get(now);
    if (jobs || session || payment || ad) {
        const error = new Error('Finish the active visit, payment or dispensing before changing Wi-Fi.');
        error.status = 409; throw error;
    }
}
export class WifiManager {
    constructor({ request = helperRequest, checkIdle = () => {}, installed = existsSync(HELPER) } = {}) {
        this.request = request; this.checkIdle = checkIdle; this.installed = installed;
        this.changing = false; this.unknown = installed; this.status = null;
    }
    async getStatus() {
        try {
            this.status = await this.request({ command: 'status' }); this.unknown = false;
            return this.status;
        } catch (error) { this.unknown = this.installed; throw error; }
    }
    async scanNetworks() { return this.request({ command: 'scan' }); }
    async connectNetwork(input) {
        if (this.changing || active.has(this.status?.operation?.phase)) {
            const error = new Error('A Wi-Fi change is already in progress.'); error.status = 409; throw error;
        }
        this.changing = true;
        try {
            this.checkIdle();
            const operation = await this.request({ ...input, command: 'connect' });
            this.status = { ...this.status, singleAdapter: operation.singleAdapter, operation };
            return operation;
        } catch (error) { this.unknown = this.installed; throw error; }
        finally { this.changing = false; }
    }
    async restore() {
        const operation = await this.request({ command: 'restore' });
        this.status = { ...this.status, operation }; return operation;
    }
    isMaintenance() {
        return this.changing || this.unknown || (this.status?.singleAdapter !== false && active.has(this.status?.operation?.phase));
    }
    startPolling() {
        let stopped = false, timer;
        const poll = async () => {
            if (!this.installed || stopped) return;
            try { await this.getStatus(); } catch { /* Reads expose the actionable error. */ }
            if (!stopped) { timer = setTimeout(poll, 5000); timer.unref(); }
        };
        void poll(); return () => { stopped = true; clearTimeout(timer); };
    }
}
export default WifiManager;
