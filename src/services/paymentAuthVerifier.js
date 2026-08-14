import crypto from 'crypto';
import fs from 'fs';
import { getDb } from '../database/db.js';

/**
 * Payment Authorization Verification Service
 * 
 * Verifies cryptographically signed payment authorizations from Payment Bridge
 * using public key cryptography (RSA-4096).
 * 
 * SECURITY MODEL:
 * - Payment Bridge has private key 🔐 (signs authorizations)
 * - Raspberry Pi has public key 🔓 (verifies authorizations)
 * - Compromising the Pi does NOT allow creating fake authorizations
 * - Only Payment Bridge (which verifies with Razorpay API) can create valid authorizations
 * 
 * This service is completely offline-capable. No Internet required.
 */

class PaymentAuthorizationVerifier {
  constructor() {
    this.publicKey = null;
    this.loadPublicKey();
  }

  /**
   * Load public key for verifying payment authorizations
   */
  loadPublicKey() {
    const publicKeyPaths = [
      './config/payment-verification-public-key.pem',
      '../config/payment-verification-public-key.pem',
      './payment-verification-public-key.pem'
    ];

    for (const path of publicKeyPaths) {
      try {
        this.publicKey = fs.readFileSync(path, 'utf8');
        console.log(`✅ Payment verification public key loaded from: ${path}`);
        return;
      } catch (error) {
        // Try next path
      }
    }

    console.error('❌ CRITICAL: Payment verification public key not found!');
    console.error('   Expected locations:');
    publicKeyPaths.forEach(path => console.error(`   - ${path}`));
    console.error('   Generate keys: cd payment-bridge-service && npm run generate-keys');
    throw new Error('Payment verification public key not found');
  }

  /**
   * Verify RSA signature on payment authorization
   * 
   * @param {object} authorization - Payment authorization object
   * @param {string} signature - Base64-encoded signature
   * @returns {boolean} - True if signature is valid
   */
  verifySignature(authorization, signature) {
    try {
      const verify = crypto.createVerify('RSA-SHA256');
      verify.update(JSON.stringify(authorization));
      verify.end();
      
      return verify.verify(this.publicKey, signature, 'base64');
    } catch (error) {
      console.error('❌ Signature verification error:', error.message);
      return false;
    }
  }

  /**
   * Check if nonce has already been used (replay attack prevention)
   * 
   * @param {string} nonce - Authorization nonce
   * @returns {Promise<boolean>} - True if nonce already used
   */
  async isNonceUsed(nonce) {
    const db = getDb();
    
    const existing = db.prepare(`
      SELECT nonce FROM payment_nonces WHERE nonce = ?
    `).get(nonce);
    
    return !!existing;
  }

  /**
   * Store nonce to prevent future reuse
   * 
   * @param {string} nonce - Authorization nonce
   * @param {string} sessionId - Session ID
   * @param {string} transactionId - Transaction ID
   * @param {string} paymentId - Razorpay payment ID
   * @param {number} amount - Payment amount in paise
   */
  async storeNonce(nonce, sessionId, transactionId, paymentId, amount) {
    const db = getDb();
    
    db.prepare(`
      INSERT INTO payment_nonces (nonce, session_id, transaction_id, payment_id, amount)
      VALUES (?, ?, ?, ?, ?)
    `).run(nonce, sessionId, transactionId, paymentId, amount);
    
    console.log(`✅ Nonce stored: ${nonce.substring(0, 16)}...`);
  }

  /**
   * Clean up old nonces (older than 24 hours)
   * Call this periodically to prevent table bloat
   */
  async cleanupOldNonces() {
    const db = getDb();
    
    const result = db.prepare(`
      DELETE FROM payment_nonces
      WHERE used_at < datetime('now', '-24 hours')
    `).run();
    
    if (result.changes > 0) {
      console.log(`🧹 Cleaned up ${result.changes} old payment nonces`);
    }
  }

  /**
   * Verify complete payment authorization
   * 
   * This is the main entry point for payment verification on the Pi.
   * 
   * @param {object} params - Verification parameters
   * @param {object} params.authorization - Payment authorization object
   * @param {string} params.signature - Base64-encoded signature
   * @param {string} params.sessionId - Expected session ID
   * @param {string} params.transactionId - Expected transaction ID
   * @param {number} params.expectedAmount - Expected amount in paise (from backend calculation)
   * @returns {Promise<object>} - { success: boolean, error?: string, paymentId?: string }
   */
  async verifyPaymentAuthorization({ authorization, signature, sessionId, transactionId, expectedAmount }) {
    const startTime = Date.now();
    
    try {
      // Step 1: Verify signature
      const signatureValid = this.verifySignature(authorization, signature);
      if (!signatureValid) {
        console.warn('❌ Invalid payment authorization signature');
        return { success: false, error: 'Invalid authorization signature' };
      }
      console.log('✅ Signature verified');

      // Step 2: Check authorization version
      if (authorization.version !== '1.0') {
        console.warn(`❌ Unsupported authorization version: ${authorization.version}`);
        return { success: false, error: 'Unsupported authorization version' };
      }

      // Step 3: Check expiry
      const now = Date.now();
      if (now > authorization.expiresAt) {
        console.warn(`❌ Authorization expired (issued: ${new Date(authorization.issuedAt).toISOString()}, expired: ${new Date(authorization.expiresAt).toISOString()})`);
        return { success: false, error: 'Authorization expired' };
      }
      console.log('✅ Authorization not expired');

      // Step 4: Check sessionId
      if (authorization.sessionId !== sessionId) {
        console.warn(`❌ Session ID mismatch: expected ${sessionId}, got ${authorization.sessionId}`);
        return { success: false, error: 'Session ID mismatch' };
      }
      console.log('✅ Session ID matched');

      // Step 5: Check transactionId
      if (authorization.transactionId !== transactionId) {
        console.warn(`❌ Transaction ID mismatch: expected ${transactionId}, got ${authorization.transactionId}`);
        return { success: false, error: 'Transaction ID mismatch' };
      }
      console.log('✅ Transaction ID matched');

      // Step 6: Check amount (CRITICAL - prevents amount manipulation)
      if (authorization.amount !== expectedAmount) {
        console.warn(`❌ Amount mismatch: expected ₹${expectedAmount / 100}, got ₹${authorization.amount / 100}`);
        return { success: false, error: 'Payment amount mismatch' };
      }
      console.log(`✅ Amount verified: ₹${authorization.amount / 100}`);

      // Step 7: Check nonce not already used (replay attack prevention)
      const nonceUsed = await this.isNonceUsed(authorization.nonce);
      if (nonceUsed) {
        console.warn(`❌ Nonce already used (replay attack detected): ${authorization.nonce.substring(0, 16)}...`);
        return { success: false, error: 'Authorization already used' };
      }
      console.log('✅ Nonce not previously used');

      // Step 8: Store nonce to prevent future reuse
      await this.storeNonce(
        authorization.nonce,
        authorization.sessionId,
        authorization.transactionId,
        authorization.paymentId,
        authorization.amount
      );

      const duration = Date.now() - startTime;
      console.log(`✅ Payment authorization VERIFIED (${duration}ms)`);
      console.log(`   Payment ID: ${authorization.paymentId}`);
      console.log(`   Amount: ₹${authorization.amount / 100}`);
      console.log(`   Session: ${authorization.sessionId}`);

      return {
        success: true,
        paymentId: authorization.paymentId,
        orderId: authorization.orderId,
        amount: authorization.amount,
        currency: authorization.currency
      };

    } catch (error) {
      console.error('❌ Payment authorization verification error:', error);
      return { success: false, error: 'Verification failed' };
    }
  }
}

// Singleton instance
const verifier = new PaymentAuthorizationVerifier();

// Cleanup old nonces every 6 hours
setInterval(() => {
  verifier.cleanupOldNonces().catch(err => {
    console.error('Failed to cleanup old nonces:', err);
  });
}, 6 * 60 * 60 * 1000);

export default verifier;
