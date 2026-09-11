import assert from "node:assert/strict";
import { test } from "node:test";
import { createSpeechConfigHandler, DEFAULT_SPEECH_CONFIG } from "./src/routes/speechConfig.js";

async function request(options) {
  let body;
  const res = { set() {}, json(value) { body = value; } };
  await createSpeechConfigHandler(options)({}, res);
  return body;
}
test("speech config works without MongoDB", async () => {
  const result = await request({ getDb: () => null, isConnected: () => false });
  assert.deepEqual(result, DEFAULT_SPEECH_CONFIG);
  assert.ok(result["two-options"].en);
});
test("saved translations merge with offline defaults", async () => {
  const result = await request({
    isConnected: () => true,
    getDb: () => ({ collection: () => ({
      findOne: async () => ({ config: { "two-options": { en: "Custom prompt" }, _voiceSettings: { rate: 1 } } }),
    }) }),
  });
  assert.equal(result["two-options"].en, "Custom prompt");
  assert.equal(result["two-options"].bn, DEFAULT_SPEECH_CONFIG["two-options"].bn);
  assert.equal(result._voiceSettings.rate, 1);
});
test("MongoDB failure returns defaults", async () => {
  const warnings = [];
  const result = await request({
    isConnected: () => true, warn: (message) => warnings.push(message),
    getDb: () => ({ collection() { throw new Error("unavailable"); } }),
  });
  assert.deepEqual(result, DEFAULT_SPEECH_CONFIG);
  assert.equal(warnings.length, 1);
});
test("no saved document returns defaults", async () => {
  assert.deepEqual(await request({
    isConnected: () => true,
    getDb: () => ({ collection: () => ({ findOne: async () => null }) }),
  }), DEFAULT_SPEECH_CONFIG);
});

