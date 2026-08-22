/**
 * Automated Regression Test Suite for Local Medicine Image Storage
 */
import assert from "assert";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { initializeDatabase } from "./src/database/db.js";
import { InventoryManager } from "./src/services/inventoryManager.js";
import crypto from "crypto";

const TEST_DB_PATH = path.join(process.cwd(), "data", `test-images-${Date.now()}.db`);
const TEST_IMAGE_DIR = path.join(process.cwd(), "data", `test-img-dir-${Date.now()}`);

process.env.MEDICINE_IMAGE_DIR = TEST_IMAGE_DIR;

console.log("═══════════════════════════════════════════════════════════════════════");
console.log("  TESTING LOCAL MEDICINE IMAGE STORAGE & MIGRATIONS");
console.log("═══════════════════════════════════════════════════════════════════════\n");

let passed = 0;
let failed = 0;

function it(desc, fn) {
  try {
    fn();
    console.log(`  ✅ ${desc}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${desc}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

async function itAsync(desc, fn) {
  try {
    await fn();
    console.log(`  ✅ ${desc}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${desc}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

// Helper: Magic byte detectors (mirror of server.js)
function detectMedicineImageExtension(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return ".jpg";
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) return ".png";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return ".webp";
  return null;
}

function sanitizeMedicineIdForFilename(kitId) {
  return String(kitId).trim().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
}

function createMedicineImageFilename(kitId, extension) {
  const safeKitId = sanitizeMedicineIdForFilename(kitId);
  const random = crypto.randomBytes(6).toString("hex");
  return `${safeKitId}-${Date.now()}-${random}${extension}`;
}

async function runTests() {
  // Test 1: Database Migration
  const db = initializeDatabase(TEST_DB_PATH);
  const invMgr = new InventoryManager(db);

  it("PRAGMA table_info(inventory) contains image_path column", () => {
    const columns = db.prepare("PRAGMA table_info(inventory)").all();
    const hasImagePath = columns.some((col) => col.name === "image_path");
    assert.strictEqual(hasImagePath, true, "image_path column must exist in inventory table");
  });

  // Seed sample medicines
  db.prepare(`
    INSERT INTO inventory (kit_id, name, price, quantity, motor_id, description, image_path, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run("KIT-PARACETAMOL", "Paracetamol 650mg", 30, 20, 1, "Pain relief", "", );

  db.prepare(`
    INSERT INTO inventory (kit_id, name, price, quantity, motor_id, description, image_path, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run("KIT-FIRST-AID", "First Aid Kit", 150, 10, 2, "Emergency kit", "/medicine-images/first-aid.png");

  it("InventoryManager.getAllInventory() returns image_path and imageUrl", () => {
    const all = invMgr.getAllInventory();
    const para = all.find((k) => k.kit_id === "KIT-PARACETAMOL");
    const aid = all.find((k) => k.kit_id === "KIT-FIRST-AID");

    assert.ok(para, "Paracetamol must exist");
    assert.strictEqual(para.image_path, "");
    assert.strictEqual(para.imageUrl, "");

    assert.ok(aid, "First Aid must exist");
    assert.strictEqual(aid.image_path, "/medicine-images/first-aid.png");
    assert.strictEqual(aid.imageUrl, "/medicine-images/first-aid.png");
  });

  it("InventoryManager.getInventoryItem() returns image_path and imageUrl", () => {
    const item = invMgr.getInventoryItem("KIT-FIRST-AID");
    assert.strictEqual(item.image_path, "/medicine-images/first-aid.png");
    assert.strictEqual(item.imageUrl, "/medicine-images/first-aid.png");
  });

  // Test Magic Byte Signature Detection
  it("Validates JPEG magic bytes FF D8 FF", () => {
    const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    assert.strictEqual(detectMedicineImageExtension(jpegBuffer), ".jpg");
  });

  it("Validates PNG magic bytes 89 50 4E 47 0D 0A 1A 0A", () => {
    const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    assert.strictEqual(detectMedicineImageExtension(pngBuffer), ".png");
  });

  it("Validates WEBP magic bytes RIFF....WEBP", () => {
    const webpHeader = Buffer.alloc(16);
    webpHeader.write("RIFF", 0, 4, "ascii");
    webpHeader.writeUInt32LE(100, 4);
    webpHeader.write("WEBP", 8, 4, "ascii");
    assert.strictEqual(detectMedicineImageExtension(webpHeader), ".webp");
  });

  it("Rejects non-image binary / disguised executable", () => {
    const exeBuffer = Buffer.from("MZ\x90\x00\x03\x00\x00\x00", "binary");
    assert.strictEqual(detectMedicineImageExtension(exeBuffer), null);
    const txtBuffer = Buffer.from("Hello world not an image");
    assert.strictEqual(detectMedicineImageExtension(txtBuffer), null);
  });

  // Test Image Saving & Lifecycle Simulation
  await itAsync("Simulates image upload, file persistence, and DB update", async () => {
    fs.mkdirSync(TEST_IMAGE_DIR, { recursive: true });

    const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0x03, 0x04]);
    const ext = detectMedicineImageExtension(fakeJpeg);
    assert.strictEqual(ext, ".jpg");

    const filename = createMedicineImageFilename("KIT-PARACETAMOL", ext);
    const physicalPath = path.join(TEST_IMAGE_DIR, filename);
    const publicPath = `/medicine-images/${filename}`;

    fs.writeFileSync(physicalPath, fakeJpeg);
    assert.strictEqual(fs.existsSync(physicalPath), true);

    db.prepare("UPDATE inventory SET image_path = ?, updated_at = datetime('now') WHERE kit_id = ?")
      .run(publicPath, "KIT-PARACETAMOL");

    const updated = invMgr.getInventoryItem("KIT-PARACETAMOL");
    assert.strictEqual(updated.image_path, publicPath);
    assert.strictEqual(updated.imageUrl, publicPath);
  });

  await itAsync("Simulates image replacement and cleanup of previous image file", async () => {
    const itemBefore = invMgr.getInventoryItem("KIT-PARACETAMOL");
    const oldPhysicalPath = path.join(TEST_IMAGE_DIR, path.basename(itemBefore.image_path));
    assert.strictEqual(fs.existsSync(oldPhysicalPath), true, "Old image file must exist before replace");

    // Upload new PNG
    const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
    const newFilename = createMedicineImageFilename("KIT-PARACETAMOL", ".png");
    const newPhysicalPath = path.join(TEST_IMAGE_DIR, newFilename);
    const newPublicPath = `/medicine-images/${newFilename}`;

    fs.writeFileSync(newPhysicalPath, fakePng);
    db.prepare("UPDATE inventory SET image_path = ?, updated_at = datetime('now') WHERE kit_id = ?")
      .run(newPublicPath, "KIT-PARACETAMOL");

    // Delete old physical file
    fs.unlinkSync(oldPhysicalPath);

    assert.strictEqual(fs.existsSync(oldPhysicalPath), false, "Old image file must be deleted");
    assert.strictEqual(fs.existsSync(newPhysicalPath), true, "New image file must exist");

    const updated = invMgr.getInventoryItem("KIT-PARACETAMOL");
    assert.strictEqual(updated.image_path, newPublicPath);
  });

  await itAsync("Simulates DELETE /api/kits/:id/image removing DB image_path and physical file", async () => {
    const item = invMgr.getInventoryItem("KIT-PARACETAMOL");
    const physPath = path.join(TEST_IMAGE_DIR, path.basename(item.image_path));
    assert.strictEqual(fs.existsSync(physPath), true);

    db.prepare("UPDATE inventory SET image_path = '', updated_at = datetime('now') WHERE kit_id = ?")
      .run("KIT-PARACETAMOL");
    fs.unlinkSync(physPath);

    const cleared = invMgr.getInventoryItem("KIT-PARACETAMOL");
    assert.strictEqual(cleared.image_path, "");
    assert.strictEqual(cleared.imageUrl, "");
    assert.strictEqual(fs.existsSync(physPath), false);
  });

  // Cleanup test artifacts
  db.close();
  try { fs.unlinkSync(TEST_DB_PATH); } catch {}
  try { fs.rmSync(TEST_IMAGE_DIR, { recursive: true, force: true }); } catch {}

  console.log("\n═══════════════════════════════════════════════════════════════════════");
  console.log(`📊 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log("═══════════════════════════════════════════════════════════════════════\n");

  if (failed > 0) process.exit(1);
}

runTests();
