import test from 'node:test';
import assert from 'node:assert/strict';
import { wifiManager } from './src/services/wifiManager.js';
import express from 'express';
import { createWifiRouter, wifiPortalHtmlHandler } from './src/routes/wifiRoutes.js';

test('WifiManager - getStatus returns valid connection status', async () => {
    const status = await wifiManager.getStatus();
    assert.ok(status, 'status should exist');
    assert.equal(typeof status.connected, 'boolean');
    assert.ok('signal' in status);
    assert.ok('bars' in status);
});

test('WifiManager - scanNetworks returns list of networks', async () => {
    const networks = await wifiManager.scanNetworks({ forceRescan: false });
    assert.ok(Array.isArray(networks), 'networks should be an array');
    assert.ok(networks.length > 0, 'should return at least one nearby network');
    const first = networks[0];
    assert.ok('ssid' in first, 'network should have ssid');
    assert.ok('signal' in first, 'network should have signal');
    assert.ok('security' in first, 'network should have security');
});

test('WifiManager - getSavedNetworks returns saved profiles', async () => {
    const saved = await wifiManager.getSavedNetworks();
    assert.ok(Array.isArray(saved), 'saved should be an array');
    assert.ok(saved.length > 0, 'should have initial saved networks');
    assert.ok('ssid' in saved[0], 'saved network should have ssid');
    assert.ok('autoConnect' in saved[0], 'saved network should have autoConnect');
});

test('WifiManager - connectNetwork connects and persists network', async () => {
    const testSsid = 'Test_Kiosk_Hotspot_5G';
    const res = await wifiManager.connectNetwork({
        ssid: testSsid,
        password: 'SecretPassword123'
    });

    assert.ok(res.success, 'connectNetwork should return success: true');
    assert.equal(res.status.connected, true);
    assert.equal(res.status.ssid, testSsid);

    const statusAfter = await wifiManager.getStatus();
    assert.equal(statusAfter.connected, true);
    assert.equal(statusAfter.ssid, testSsid);

    const saved = await wifiManager.getSavedNetworks();
    const found = saved.find((s) => s.ssid === testSsid);
    assert.ok(found, 'new network should be present in saved networks');
    assert.equal(found.isCurrent, true);
});

test('WifiManager - switchNetwork switches back to saved network', async () => {
    const saved = await wifiManager.getSavedNetworks();
    const otherNetwork = saved.find((s) => s.ssid !== 'Test_Kiosk_Hotspot_5G');
    assert.ok(otherNetwork, 'should have another saved network to switch back to');

    const res = await wifiManager.switchNetwork(otherNetwork.ssid);
    assert.ok(res.success, 'switchNetwork should return success: true');
    assert.equal(res.status.ssid, otherNetwork.ssid);

    const statusAfter = await wifiManager.getStatus();
    assert.equal(statusAfter.ssid, otherNetwork.ssid);
});

test('WifiManager - disconnectNetwork disconnects Wi-Fi', async () => {
    const res = await wifiManager.disconnectNetwork();
    assert.ok(res.success);
    assert.equal(res.status.connected, false);

    const statusAfter = await wifiManager.getStatus();
    assert.equal(statusAfter.connected, false);
});

test('WifiManager - forgetNetwork removes saved profile', async () => {
    const testSsid = 'Test_Kiosk_Hotspot_5G';
    const res = await wifiManager.forgetNetwork(testSsid);
    assert.ok(res.success);

    const saved = await wifiManager.getSavedNetworks();
    const found = saved.find((s) => s.ssid === testSsid);
    assert.equal(found, undefined, 'forgotten network should not be in saved list');
});

test('Express API - Router endpoints and HTML portal respond correctly', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/wifi', createWifiRouter());
    app.get('/wifi', wifiPortalHtmlHandler);

    const server = app.listen(0);
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
        // Test status endpoint
        const resStatus = await fetch(`${baseUrl}/api/wifi/status`);
        assert.equal(resStatus.status, 200);
        const dataStatus = await resStatus.json();
        assert.equal(dataStatus.success, true);
        assert.ok('status' in dataStatus);

        // Test scan endpoint
        const resScan = await fetch(`${baseUrl}/api/wifi/scan`);
        assert.equal(resScan.status, 200);
        const dataScan = await resScan.json();
        assert.equal(dataScan.success, true);
        assert.ok(Array.isArray(dataScan.networks));

        // Test saved endpoint
        const resSaved = await fetch(`${baseUrl}/api/wifi/saved`);
        assert.equal(resSaved.status, 200);
        const dataSaved = await resSaved.json();
        assert.equal(dataSaved.success, true);
        assert.ok(Array.isArray(dataSaved.saved));

        // Test HTML portal endpoint
        const resHtml = await fetch(`${baseUrl}/wifi`);
        assert.equal(resHtml.status, 200);
        const html = await resHtml.text();
        assert.ok(html.includes('Reliv Kiosk Wi-Fi Control'));
        assert.ok(html.includes('Current Connection'));
        assert.ok(html.includes('Available Networks'));
    } finally {
        server.close();
    }
});
