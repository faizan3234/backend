/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RELIV KIOSK - PAYMENT V2 CRYPTOGRAPHIC SERVICE
 * Purpose: Asymmetric Ed25519 signing, RSA-OAEP + AES-GCM hybrid encryption,
 *          HMAC pepper verification, and cryptographically secure code generation.
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
 * Generate a random 4-digit confirmation code [0000 - 9999]
 * @returns {string} 4-digit string
 */
export function generateConfirmationCode() {
    return crypto.randomInt(0, 10000).toString().padStart(4, '0');
}

/**
 * Generate a unique Request ID
 * @returns {string}
 */
export function generateRequestId() {
    return `REQ-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

/**
 * Generate a cryptographically secure random nonce
 * @returns {string}
 */
export function generateRequestNonce() {
    return crypto.randomBytes(16).toString('hex');
}

/**
 * Sign canonical payload with Kiosk Ed25519 private key
 * @param {Object} canonicalPayload - Payload object
 * @param {string|KeyObject} privateKeyPem - Ed25519 Private Key PEM
 * @returns {string} Base64URL signature
 */
export function signPayload(canonicalPayload, privateKeyPem) {
    if (!privateKeyPem) {
        throw new Error('Kiosk signing private key is required');
    }
    const dataBytes = Buffer.from(JSON.stringify(canonicalPayload), 'utf8');
    const signature = crypto.sign(null, dataBytes, privateKeyPem);
    return base64UrlEncode(signature);
}

/**
 * Verify payload signature with Kiosk Ed25519 public key
 * @param {Object} canonicalPayload - Payload object
 * @param {string} signatureBase64Url - Base64URL signature
 * @param {string|KeyObject} publicKeyPem - Ed25519 Public Key PEM
 * @returns {boolean}
 */
export function verifyPayloadSignature(canonicalPayload, signatureBase64Url, publicKeyPem) {
    if (!publicKeyPem || !signatureBase64Url) {
        return false;
    }
    try {
        const dataBytes = Buffer.from(JSON.stringify(canonicalPayload), 'utf8');
        const signatureBytes = base64UrlDecode(signatureBase64Url);
        return crypto.verify(null, dataBytes, publicKeyPem, signatureBytes);
    } catch {
        return false;
    }
}

/**
 * Encrypt inner envelope (payload + signature) using Hybrid AES-256-GCM + RSA-OAEP-SHA256
 * @param {Object} innerEnvelope - { payload, signature }
 * @param {string|KeyObject} cloudPublicKeyPem - Oracle Cloud RSA Public Key PEM
 * @returns {string} Base64URL encoded package string
 */
export function encryptPackage(innerEnvelope, cloudPublicKeyPem) {
    if (!cloudPublicKeyPem) {
        throw new Error('Cloud encryption public key is required');
    }

    const innerBytes = Buffer.from(JSON.stringify(innerEnvelope), 'utf8');

    // 1. Generate random 32-byte AES key & 12-byte GCM IV
    const aesKey = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);

    // 2. AES-256-GCM encrypt inner payload
    const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
    const ciphertext = Buffer.concat([cipher.update(innerBytes), cipher.final()]);
    const tag = cipher.getAuthTag();

    // 3. RSA-OAEP SHA-256 encrypt AES key with Cloud Public Key
    const encryptedKey = crypto.publicEncrypt({
        key: cloudPublicKeyPem,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256'
    }, aesKey);

    // 4. Compact outer envelope
    const envelope = {
        v: 2,
        kid: innerEnvelope?.payload?.kioskId || 'RELIV-001',
        ek: base64UrlEncode(encryptedKey),
        iv: base64UrlEncode(iv),
        ct: base64UrlEncode(ciphertext),
        tag: base64UrlEncode(tag)
    };

    return base64UrlEncode(Buffer.from(JSON.stringify(envelope), 'utf8'));
}

/**
 * Decrypt package using Cloud RSA Private Key (Used in tests and Oracle cloud)
 * @param {string} packageString - Base64URL encoded package
 * @param {string|KeyObject} cloudPrivateKeyPem - Oracle Cloud RSA Private Key PEM
 * @returns {Object} Inner envelope { payload, signature }
 */
export function decryptPackage(packageString, cloudPrivateKeyPem) {
    if (!cloudPrivateKeyPem) {
        throw new Error('Cloud private key is required for decryption');
    }

    const envelopeJson = base64UrlDecode(packageString).toString('utf8');
    const envelope = JSON.parse(envelopeJson);

    if (envelope.v !== 2 || !envelope.ek || !envelope.iv || !envelope.ct || !envelope.tag) {
        throw new Error('Invalid payment V2 envelope structure');
    }

    // 1. RSA-OAEP SHA-256 decrypt AES key
    const encryptedKey = base64UrlDecode(envelope.ek);
    const aesKey = crypto.privateDecrypt({
        key: cloudPrivateKeyPem,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256'
    }, encryptedKey);

    // 2. AES-256-GCM decrypt inner envelope
    const iv = base64UrlDecode(envelope.iv);
    const ciphertext = base64UrlDecode(envelope.ct);
    const tag = base64UrlDecode(envelope.tag);

    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
    decipher.setAuthTag(tag);
    const decryptedBytes = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    return JSON.parse(decryptedBytes.toString('utf8'));
}

/**
 * Calculate HMAC-SHA256 for code verifier
 * @param {string} pepper - Secret pepper
 * @param {Object} params
 * @param {number} [params.version] - Default 2
 * @param {string} params.requestId
 * @param {string} params.requestNonce
 * @param {string} params.sessionId
 * @param {string} params.transactionId
 * @param {number} params.amount
 * @param {string} params.confirmationCode
 * @returns {string} Hex HMAC
 */
export function calculateCodeHmac(pepper, {
    version = 2,
    requestId,
    requestNonce,
    sessionId,
    transactionId,
    amount,
    confirmationCode
}) {
    if (!pepper) {
        throw new Error('Pepper is required for code HMAC calculation');
    }
    const message = [
        version,
        requestId,
        requestNonce,
        sessionId,
        transactionId,
        amount,
        confirmationCode
    ].join('|');

    return crypto.createHmac('sha256', pepper).update(message).digest('hex');
}

/**
 * Timing-safe comparison of code HMAC
 * @param {string} expectedHmacHex - Stored HMAC in hex
 * @param {string} pepper - Secret pepper
 * @param {Object} params - Same params as calculateCodeHmac
 * @returns {boolean}
 */
export function verifyCodeHmac(expectedHmacHex, pepper, params) {
    if (!expectedHmacHex || !pepper || !params) {
        return false;
    }
    try {
        const calculatedHmacHex = calculateCodeHmac(pepper, params);
        const expectedBuf = Buffer.from(expectedHmacHex, 'hex');
        const calculatedBuf = Buffer.from(calculatedHmacHex, 'hex');

        if (expectedBuf.length !== calculatedBuf.length) {
            return false;
        }

        return crypto.timingSafeEqual(expectedBuf, calculatedBuf);
    } catch {
        return false;
    }
}
