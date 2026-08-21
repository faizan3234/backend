#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RELIV KIOSK - PAYMENT V2 KIOSK SIGNING KEYPAIR GENERATOR
 * Purpose: Generate an asymmetric Ed25519 keypair for Kiosk request signing.
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * Generates:
 * 1. payment-v2-kiosk-private-key.pem (KEEP ON PI ONLY - NEVER COMMIT TO GIT)
 * 2. payment-v2-kiosk-public-key.pem  (REGISTER WITH ORACLE PAYMENT BACKEND)
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const outputDir = process.argv[2] || path.join(process.cwd(), 'config');

console.log('\n═══════════════════════════════════════════════════════════');
console.log('🔐 RELIV PAYMENT V2 — KIOSK KEYPAIR GENERATOR (Ed25519)');
console.log('═══════════════════════════════════════════════════════════\n');

if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
    console.log(`📁 Created directory: ${outputDir}`);
}

const privateKeyPath = path.join(outputDir, 'payment-v2-kiosk-private-key.pem');
const publicKeyPath = path.join(outputDir, 'payment-v2-kiosk-public-key.pem');

// Check if keys already exist to prevent accidental overwrite
if (fs.existsSync(privateKeyPath) && !process.argv.includes('--force')) {
    console.warn(`⚠️ Key file already exists: ${privateKeyPath}`);
    console.warn('   Use --force to overwrite.');
    process.exit(0);
}

// Generate Ed25519 keypair
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519', {
    privateKeyEncoding: {
        type: 'pkcs8',
        format: 'pem'
    },
    publicKeyEncoding: {
        type: 'spki',
        format: 'pem'
    }
});

fs.writeFileSync(privateKeyPath, privateKey, { mode: 0o600 });
fs.writeFileSync(publicKeyPath, publicKey, { mode: 0o644 });

console.log('✅ Generated Ed25519 Kiosk signing keypair:');
console.log(`   🔑 Private Key (Pi only): ${privateKeyPath}`);
console.log(`   🔓 Public Key  (Oracle):  ${publicKeyPath}`);
console.log('\n⚠️ SECURITY INSTRUCTIONS:');
console.log('   - NEVER commit the private key to git or share it.');
console.log('   - Register the public key with the Oracle Payment Bridge.');
console.log('═══════════════════════════════════════════════════════════\n');
