// Readiness of the offline Pi. Optional cloud features never substitute for
// an actual SQLite query, and this endpoint does not send email or make HTTP calls.
export function localHealth({ checkSqlite, mqttConnected, mongoConfigured, mongoConnected }) {
    let sqliteHealthy = false;
    try { sqliteHealthy = checkSqlite()?.healthy === true; } catch { /* Report unavailable below. */ }
    return {
        status: !sqliteHealthy ? 'unhealthy' : mqttConnected ? 'healthy' : 'degraded',
        mode: 'offline-first',
        timestamp: new Date().toISOString(),
        services: {
            sqlite: sqliteHealthy ? 'connected' : 'unavailable',
            mqtt: mqttConnected ? 'connected' : 'disconnected',
            mongodb: !mongoConfigured ? 'not_configured' : mongoConnected ? 'connected' : 'unavailable',
            paymentGateway: 'external_bridge'
        },
        uptime: process.uptime()
    };
}
