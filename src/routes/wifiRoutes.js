import express from 'express';
export function createWifiRouter({ manager, requireAdmin }) {
    if (typeof requireAdmin !== 'function') throw new Error('Wi-Fi control requires admin authentication.');
    const router = express.Router();
    router.use(requireAdmin, (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    const wrap = (handler) => async (req, res) => {
        try { await handler(req, res); }
        catch (error) { res.status(error.status || 503).json({ success: false, error: error.message }); }
    };
    router.get('/status', wrap(async (_req, res) => res.json({ success: true, status: await manager.getStatus() })));
    const scan = wrap(async (_req, res) => res.json({ success: true, networks: await manager.scanNetworks() }));
    router.get('/scan', scan); router.post('/rescan', scan);
    router.post('/connect', wrap(async (req, res) => res.status(202).json({ success: true, operation: await manager.connectNetwork(req.body) })));
    router.post('/restore', wrap(async (_req, res) => res.json({ success: true, operation: await manager.restore() })));
    return router;
}
export function wifiMaintenanceGuard(manager) {
    return (req, res, next) => {
        if (req.path.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
            !/^\/api\/(wifi\/|check-login$|admin\/logout$)/.test(req.path) && manager.isMaintenance()) {
            return res.status(503).json({ ok: false, code: 'KIOSK_MAINTENANCE', message: 'Wi-Fi maintenance is in progress. Please wait; do not pay again.' });
        }
        next();
    };
}
