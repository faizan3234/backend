import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * Generate RSA key pair for payment authorization
 * Private key: stays on Payment Bridge (signs authorizations)
 * Public key: deployed to Raspberry Pi (verifies authorizations)
 */

console.log('🔐 Generating RSA-4096 key pair for payment authorization...\n');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 4096,
  publicKeyEncoding: {
    type: 'spki',
    format: 'pem'
  },
  privateKeyEncoding: {
    type: 'pkcs8',
    format: 'pem'
  }
});

// Save private key (PAYMENT BRIDGE ONLY - NEVER deploy to Pi)
fs.writeFileSync(path.join(process.cwd(), 'private-key.pem'), privateKey);
console.log('✅ Private key saved: private-key.pem');
console.log('   ⚠️  KEEP THIS SECRET - Deploy to Payment Bridge only\n');

// Save public key (deploy to Raspberry Pi)
fs.writeFileSync(path.join(process.cwd(), 'public-key.pem'), publicKey);
console.log('✅ Public key saved: public-key.pem');
console.log('   📤 Deploy this to Raspberry Pi for verification\n');

// Also save to Pi's config directory for convenience
const piPublicKeyPath = path.join(process.cwd(), '..', 'config', 'payment-verification-public-key.pem');
try {
  fs.mkdirSync(path.join(process.cwd(), '..', 'config'), { recursive: true });
  fs.writeFileSync(piPublicKeyPath, publicKey);
  console.log('✅ Public key also saved to: ../config/payment-verification-public-key.pem');
  console.log('   (ready for Pi deployment)\n');
} catch (err) {
  console.log('⚠️  Could not save to ../config/ (create manually if needed)\n');
}

console.log('🔐 Key generation complete!');
console.log('\n📋 Next steps:');
console.log('   1. Add private-key.pem to Payment Bridge .env');
console.log('   2. Deploy public-key.pem to Raspberry Pi');
console.log('   3. NEVER commit private-key.pem to git');
console.log('   4. Add private-key.pem to .gitignore\n');
