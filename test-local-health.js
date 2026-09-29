import test from 'node:test';
import assert from 'node:assert/strict';
import { localHealth } from './src/services/localHealth.js';

test('offline SQLite and MQTT are healthy without MongoDB or Pi payment credentials', () => {
    let queries = 0;
    const health = localHealth({ checkSqlite: () => { queries++; return { healthy: true }; }, mqttConnected: true });
    assert.equal(queries, 1);
    assert.equal(health.status, 'healthy');
    assert.equal(health.services.mongodb, 'not_configured');
    assert.equal(health.services.paymentGateway, 'external_bridge');
});

test('SQLite failure and MQTT outage cannot be reported as healthy', () => {
    for (const checkSqlite of [() => ({ healthy: false }), () => { throw new Error('broken database'); }]) {
        assert.equal(localHealth({ checkSqlite, mqttConnected: true }).status, 'unhealthy');
    }
    const health = localHealth({ checkSqlite: () => ({ healthy: true }), mqttConnected: false, mongoConfigured: true });
    assert.equal(health.status, 'degraded');
    assert.equal(health.services.mongodb, 'unavailable');
});
