#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RELIV CLOUD PAYMENT BRIDGE - PAYMENT V2 CLOUD KEYPAIR GENERATOR
 * Purpose: Generate an asymmetric RSA-2048 keypair for Cloud OAEP decryption.
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * Generates:
 * 1. payment-v2-cloud-private-key.pem (KEEP ON ORACLE ONLY - NEVER COMMIT TO GIT)
 * 2. payment-v2-cloud-public-key.pem  (DEPLOY TO PI KIOSKS FOR HYBRID ENCRYPTION)
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const outputDir = process.argv[2] || process.cwd();

console.log('\n═══════════════════════════════════════════════════════════');
console.log('🔐 RELIV PAYMENT V2 — CLOUD KEYPAIR GENERATOR (RSA-2048)');
console.log('═══════════════════════════════════════════════════════════\n');

if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
    console.log(`📁 Created directory: ${outputDir}`);
}

const privateKeyPath = path.join(outputDir, 'payment-v2-cloud-private-key.pem');
const publicKeyPath = path.join(outputDir, 'payment-v2-cloud-public-key.pem');

// Check if keys already exist to prevent accidental overwrite
if (fs.existsSync(privateKeyPath) && !process.argv.includes('--force')) {
    console.warn(`⚠️ Key file already exists: ${privateKeyPath}`);
    console.warn('   Use --force to overwrite.');
    process.exit(0);
}

// Generate RSA-2048 keypair
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
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

console.log('✅ Generated RSA-2048 Cloud keypair:');
console.log(`   🔑 Private Key (Oracle only): ${privateKeyPath}`);
console.log(`   🔓 Public Key  (Pi Kiosks):   ${publicKeyPath}`);
console.log('\n⚠️ SECURITY INSTRUCTIONS:');
console.log('   - NEVER commit the private key to git or share it.');
console.log('   - Place the public key on Raspberry Pi kiosks in config/ folder.');
console.log('═══════════════════════════════════════════════════════════\n');
