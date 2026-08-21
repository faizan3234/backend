/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RELIV CLOUD PAYMENT BRIDGE - PAYMENT V2 CRYPTOGRAPHIC SERVICE
 * Purpose: Decrypt Pi hybrid packages, verify Ed25519 signatures,
 *          encrypt confirmation codes at rest, and verify Razorpay signatures.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import crypto from 'crypto';

/**
 * Encode Buffer or string to Base64URL (RFC 4648)
 * @param {Buffer|string} input
 * @returns {string} Base64URL string
 */
export function base64UrlEncode(input) {
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
    return buf.toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

/**
 * Decode Base64URL string to Buffer
 * @param {string} str
 * @returns {Buffer}
 */
export function base64UrlDecode(str) {
    let base64 = String(str)
        .replace(/-/g, '+')
        .replace(/_/g, '/');
    while (base64.length % 4 !== 0) {
        base64 += '=';
    }
    return Buffer.from(base64, 'base64');
}

/**
 * Compute SHA-256 fingerprint of canonical payload
 * @param {Object|string} payload
 * @returns {string} Hex SHA-256 hash
 */
export function computePayloadFingerprint(payload) {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

/**
 * Decrypt payment V2 package using Oracle Cloud RSA Private Key
 * @param {string} packageString - Base64URL encoded envelope
 * @param {string|KeyObject} cloudPrivateKeyPem - RSA Private Key PEM
 * @returns {Object} { envelope, payload, signature }
 */
export function decryptPackage(packageString, cloudPrivateKeyPem) {
    if (!cloudPrivateKeyPem) {
        throw new Error('Cloud private key is required for package decryption');
    }
    if (!packageString || typeof packageString !== 'string') {
        throw new Error('Invalid package string');
    }

    const envelopeJson = base64UrlDecode(packageString.trim()).toString('utf8');
    let envelope;
    try {
        envelope = JSON.parse(envelopeJson);
    } catch {
        throw new Error('Malformed package envelope JSON');
    }

    if (envelope.v !== 2 || !envelope.ek || !envelope.iv || !envelope.ct || !envelope.tag) {
        throw new Error('Invalid payment V2 envelope structure');
    }

    // 1. RSA-OAEP SHA-256 decrypt AES key
    const encryptedKey = base64UrlDecode(envelope.ek);
    let aesKey;
    try {
        aesKey = crypto.privateDecrypt({
            key: cloudPrivateKeyPem,
            padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: 'sha256'
        }, encryptedKey);
    } catch (e) {
        throw new Error(`RSA decryption of AES key failed: ${e.message}`);
    }

    // 2. AES-256-GCM decrypt inner envelope
    const iv = base64UrlDecode(envelope.iv);
    const ciphertext = base64UrlDecode(envelope.ct);
    const tag = base64UrlDecode(envelope.tag);

    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
    decipher.setAuthTag(tag);

    let decryptedBytes;
    try {
        decryptedBytes = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch (e) {
        throw new Error(`AES-GCM authentication or decryption failed: ${e.message}`);
    }

    const innerEnvelope = JSON.parse(decryptedBytes.toString('utf8'));
    if (!innerEnvelope.payload || !innerEnvelope.signature) {
        throw new Error('Inner envelope missing payload or signature');
    }

    return {
        envelope,
        payload: innerEnvelope.payload,
        signature: innerEnvelope.signature
    };
}

/**
 * Verify canonical payload signature with Kiosk Ed25519 public key
 * @param {Object} canonicalPayload - Inner payload object
 * @param {string} signatureBase64Url - Base64URL signature
 * @param {string|KeyObject} kioskPublicKeyPem - Ed25519 Public Key PEM
 * @returns {boolean}
 */
export function verifyKioskSignature(canonicalPayload, signatureBase64Url, kioskPublicKeyPem) {
    if (!kioskPublicKeyPem || !signatureBase64Url || !canonicalPayload) {
        return false;
    }
    try {
        const dataBytes = Buffer.from(JSON.stringify(canonicalPayload), 'utf8');
        const signatureBytes = base64UrlDecode(signatureBase64Url);
        return crypto.verify(null, dataBytes, kioskPublicKeyPem, signatureBytes);
    } catch {
        return false;
    }
}

/**
 * Encrypt confirmation code at rest using local secret (AES-256-GCM)
 * @param {string} code - 4-digit code
 * @param {string} secret - 32-byte secret (or string)
 * @returns {string} iv:tag:ciphertext (base64)
 */
export function encryptConfirmationCodeAtRest(code, secret) {
    const key = crypto.createHash('sha256').update(String(secret || 'reliv_default_cloud_secret_seed')).digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(String(code), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return `${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

/**
 * Decrypt confirmation code at rest using local secret (AES-256-GCM)
 * @param {string} encryptedStr - iv:tag:ciphertext (base64)
 * @param {string} secret - 32-byte secret
 * @returns {string} 4-digit plaintext code
 */
export function decryptConfirmationCodeAtRest(encryptedStr, secret) {
    if (!encryptedStr || !encryptedStr.includes(':')) {
        throw new Error('Invalid encrypted code format');
    }
    const [ivB64, tagB64, ctB64] = encryptedStr.split(':');
    const key = crypto.createHash('sha256').update(String(secret || 'reliv_default_cloud_secret_seed')).digest();
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const ct = Buffer.from(ctB64, 'base64');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
    return plain.toString('utf8');
}

/**
 * Verify Razorpay payment signature
 * @param {string} orderId
 * @param {string} paymentId
 * @param {string} signature
 * @param {string} secret - Razorpay key secret
 * @returns {boolean}
 */
export function verifyRazorpayPaymentSignature(orderId, paymentId, signature, secret) {
    if (!orderId || !paymentId || !signature || !secret) {
        return false;
    }
    try {
        const body = `${orderId}|${paymentId}`;
        const expectedSignature = crypto
            .createHmac('sha256', secret)
            .update(body)
            .digest('hex');

        const expectedBuf = Buffer.from(expectedSignature, 'utf8');
        const actualBuf = Buffer.from(signature, 'utf8');

        if (expectedBuf.length !== actualBuf.length) {
            return false;
        }

        return crypto.timingSafeEqual(expectedBuf, actualBuf);
    } catch {
        return false;
    }
}
