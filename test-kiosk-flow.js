import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:net";
import Database from "better-sqlite3";

test("real offline API: session -> customer -> health/medicine, retries and failures", { timeout: 30000 }, async (t) => {
  const temp = mkdtempSync(join(tmpdir(), "reliv-flow-test-"));
  mkdirSync(join(temp, "config"));
  const { publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" },
  });
  writeFileSync(join(temp, "config/payment-verification-public-key.pem"), publicKey);
  const portProbe = createServer();
  portProbe.listen(0, "127.0.0.1");
  await once(portProbe, "listening");
  const port = portProbe.address().port;
  await new Promise((resolve) => portProbe.close(resolve));
  const child = spawn(process.execPath, [fileURLToPath(new URL("./server.js", import.meta.url))], {
    cwd: temp,
    env: {
      ...process.env, PORT: String(port), HOST: "127.0.0.1",
      KIOSK_IP: "127.0.0.1", DB_PATH: join(temp, "kiosk-test.db"),
      MQTT_BROKER_URL: "mqtt://127.0.0.1:9",
      MONGODB_URI: "", GMAIL_USER: "", GMAIL_PASS: "", CUSTOMER_GMAIL_USER: "",
      RAZORPAY_KEY_ID: "", RAZORPAY_KEY_SECRET: "",
      RELIV_ADMIN_EMAIL: "audit@example.invalid", RELIV_ADMIN_PASSWORD: "Synthetic-admin-password",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output = (output + chunk).slice(-12000); });
  child.stderr.on("data", (chunk) => { output = (output + chunk).slice(-12000); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
      await exited;
      clearTimeout(timer);
    }
    rmSync(temp, { recursive: true, force: true });
  });
  const base = "http://127.0.0.1:" + port;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(output);
    try {
      const res = await fetch(base + "/api/speech-config");
      if (res.ok) { ready = true; break; }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, output);
  const config = await (await fetch(base + "/api/speech-config")).json();
  assert.ok(config["two-options"].en);
  async function post(path, body) {
    const res = await fetch(base + path, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }
  for (const serviceType of ["HEALTH_CHECKUP", "MEDICINE"]) {
    const created = await post("/api/create-qr-session", {});
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const { sessionId, pairingToken } = created.body;
    assert.ok(sessionId && pairingToken);
    const path = "/api/sessions/" + sessionId;
    assert.equal((await post(path + "/service", { pairingToken, serviceType })).status, 409);
    const customerData = { name: "Test Customer", age: 40, gender: "female" };
    assert.equal((await post(path + "/customer", { customerData, pairingToken: "wrong" })).status, 403);
    assert.equal((await post(path + "/customer", { customerData, pairingToken })).status, 200);
    assert.equal((await post(path + "/customer", { customerData, pairingToken })).status, 200);
    const selected = await post(path + "/service", { pairingToken, serviceType });
    assert.equal(selected.status, 200, JSON.stringify(selected.body));
    assert.equal(selected.body.serviceType, serviceType);
    const otherService = serviceType === 'MEDICINE' ? 'HEALTH_CHECKUP' : 'MEDICINE';
    assert.equal((await post(path + '/service', { pairingToken, serviceType: otherService })).body.serviceType, otherService);
    assert.equal((await post(path + '/service', { pairingToken, serviceType })).body.serviceType, serviceType);
    assert.equal((await post(path + "/service", { pairingToken, serviceType })).body.alreadySelected, true);
    assert.equal((await post(path + "/service", { pairingToken: "wrong", serviceType })).status, 403);
    assert.equal((await post(path + "/customer", { customerData, pairingToken })).status, 409);
    const db = new Database(join(temp, "kiosk-test.db"));
    const stored = db.prepare("SELECT status, customer_data FROM sessions WHERE session_id = ?").get(sessionId);
    assert.equal(stored.status, "SERVICE_SELECTED");
    assert.equal(JSON.parse(stored.customer_data).gender, "female");
    const transactionId = 'TX-' + sessionId;
    db.prepare('INSERT INTO transactions(transaction_id,session_id,type,amount,status) VALUES(?,?,?,?,?)').run(transactionId, sessionId, serviceType, 2700, 'PENDING');
    assert.equal((await post(path + '/receipt', {})).status, 403);
    assert.equal((await post('/api/send-receipt', { sessionId })).status, 403);
    assert.notEqual((await post('/api/save-report', { sessionId, healthData: {} })).status, 200);
    assert.equal((await post('/api/receipts/generate', { sessionId })).status, 403);
    db.prepare("UPDATE transactions SET verified=1,status='VERIFIED' WHERE transaction_id=?").run(transactionId);
    const receipt = await post('/api/receipts/generate', { sessionId });
    assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
    assert.equal(receipt.body.emailQueued, false);
    assert.equal((await post(path + '/receipt', {})).body.receiptId, receipt.body.receiptId);
    assert.match(await (await fetch(base + path + '/receipt/download')).text(), /^%PDF-/);
    db.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE session_id = ?").run(sessionId);
    db.close();
    assert.equal((await post(path + "/service", { pairingToken, serviceType })).status, 410);
    assert.equal((await post(path + "/customer", { customerData, pairingToken })).status, 410);
  }
  const admin = await post('/api/check-login', { email: 'audit@example.invalid', password: 'Synthetic-admin-password' });
  assert.equal(admin.status, 200);
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + admin.body.token };
  const speechEdit = await fetch(base + '/api/speech-config', { method: 'PUT', headers, body: JSON.stringify({ config: { 'two-options': { en: 'Audit prompt' } } }) });
  assert.equal(speechEdit.status, 200, await speechEdit.text());
  assert.equal((await (await fetch(base + '/api/speech-config')).json())['two-options'].en, 'Audit prompt');
  console.log("Verified both service paths, duplicate requests, token rejection and expiration.");
});

