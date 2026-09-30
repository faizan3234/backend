import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBackendMqttConfig } from './src/services/mqttConfig.js';

test('offline broker defaults and old loopback URLs use the existing AP listener', () => {
    for (const url of [undefined, 'mqtt://localhost:1883', 'mqtt://127.0.0.1', 'mqtt://[::1]:1883']) {
        const config = resolveBackendMqttConfig({ MQTT_BROKER_URL: url });
        assert.equal(new URL(config.brokerUrl).hostname, '192.168.50.1');
        assert.equal(config.options.username, undefined);
        assert.equal(config.options.password, undefined);
    }
});
test('explicit authenticated brokers are preserved and partial configuration fails clearly', () => {
    const config = resolveBackendMqttConfig({ MQTT_BROKER_URL:'mqtts://broker.example:8883', MQTT_USERNAME:'user', MQTT_PASSWORD:'synthetic' });
    assert.equal(new URL(config.brokerUrl).hostname, 'broker.example');
    assert.equal(config.options.username, 'user');
    assert.throws(() => resolveBackendMqttConfig({ MQTT_USERNAME:'user' }), /both/);
    assert.throws(() => resolveBackendMqttConfig({ MQTT_BROKER_URL:'https://example.com' }), /protocol/);
});
