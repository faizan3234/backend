// Read after dotenv has loaded. The installed broker binds only to the AP IP.
export function resolveBackendMqttConfig(env = {}) {
    const raw = env.MQTT_BROKER_URL?.trim() || 'mqtt://192.168.50.1:1883';
    let url;
    try { url = new URL(raw); } catch { throw new Error('MQTT_BROKER_URL is invalid.'); }
    if (!['mqtt:', 'mqtts:', 'ws:', 'wss:'].includes(url.protocol)) throw new Error('Unsupported MQTT_BROKER_URL protocol.');
    if (url.protocol === 'mqtt:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && (!url.port || url.port === '1883')) {
        url.hostname = '192.168.50.1';
    }
    const username = env.MQTT_USERNAME?.trim() || '';
    const password = env.MQTT_PASSWORD || '';
    if (Boolean(username) !== Boolean(password)) throw new Error('Set both MQTT credentials, or leave both empty for the local anonymous broker.');
    return {
        brokerUrl: url.toString(),
        options: { reconnectPeriod: 5000, connectTimeout: 5000, keepalive: 60,
            ...(username ? { username, password } : {}) }
    };
}
