# 🔐 STAGE I: SECURE PAYMENT ARCHITECTURE

**Date**: 2026-08-14  
**Status**: ✅ IMPLEMENTED  
**Critical Security Fix**: Payment fraud prevention via asymmetric cryptography

---

## 🚨 Problem Identified

**Previous Architecture (INSECURE)**:
```
Customer Phone → Razorpay → Claims "payment success" → Pi trusts it → DISPENSES ❌
```

**Attack Vector**:
- Pi has NO Internet access
- Pi CANNOT verify with Razorpay API
- Customer phone input is NOT trustworthy
- Malicious customer sends fake `{ "payment_status": "success" }`
- Pi dispenses medicine for free → FRAUD

**Root Cause**: No cryptographic trust chain between Razorpay verification and Pi authorization

---

## ✅ Solution Implemented

**New Architecture (SECURE)**:
```
 INTERNET
 │
 ▼
┌─────────────────┐
│ RAZORPAY API │
└────────┬────────┘
 │
 ▼
┌─────────────────┐
│ PAYMENT BRIDGE │  🔐 PRIVATE KEY (signs)
│ (cloud service) │
│ │
│ ✓ Fetch payment │
│ ✓ Verify status │
│ ✓ Verify amount │
│ ✓ Sign auth │
└────────┬────────┘
 │
 signed authorization
 │
 ▼
CUSTOMER PHONE
 │
 local Wi-Fi
 │
 ▼
┌──────────────────┐
│ RASPBERRY PI │  🔓 PUBLIC KEY (verifies)
│ (offline) │
│ │
│ ✓ Verify sig │
│ ✓ Check nonce │
│ ✓ Check expiry │
│ ✓ Check amount │
│ ✓ DISPENSE │
└──────────────────┘
```

---

## 🔑 Asymmetric Cryptography

### Why NOT Shared Secret (JWT)?

❌ **Shared Secret Problem**:
- Same secret on Payment Bridge AND Pi
- Compromising Pi = can create fake authorizations
- Circular trust dependency

✅ **Asymmetric Crypto Solution**:
- **Private key 🔐**: Payment Bridge only (signs)
- **Public key 🔓**: Raspberry Pi only (verifies)
- Compromising Pi does NOT allow creating fake authorizations
- One-way trust: Payment Bridge → Pi

### RSA-4096 Key Pair

- **Algorithm**: RSA with SHA-256
- **Key Size**: 4096 bits (very strong)
- **Private Key**: Stays on Payment Bridge (NEVER deployed to Pi)
- **Public Key**: Deployed to Pi for verification

**Generate Keys**:
```bash
cd payment-bridge-service
npm install
npm run generate-keys
```

Creates:
- `private-key.pem` (Payment Bridge only)
- `public-key.pem` (deploy to Pi)
- `config/payment-verification-public-key.pem` (auto-copied)

---

## 🏗️ Components

### 1. Payment Bridge Service (NEW)

**Location**: `payment-bridge-service/`

**Purpose**: Trusted intermediary with Internet access

**Files**:
- `index.js` - Express server with Razorpay verification
- `generate-keys.js` - RSA key pair generator
- `package.json` - Dependencies
- `.env.example` - Configuration template
- `README.md` - Complete setup guide

**API Endpoint**:
```
POST /verify-payment

Request:
{
  "razorpay_payment_id": "pay_...",
  "razorpay_order_id": "order_...",
  "razorpay_signature": "...",
  "sessionId": "SESSION-123",
  "transactionId": "TXN-456"
}

Response:
{
  "success": true,
  "authorization": {
    "sessionId": "SESSION-123",
    "transactionId": "TXN-456",
    "amount": 2700,
    "currency": "INR",
    "paymentId": "pay_...",
    "orderId": "order_...",
    "issuedAt": 1692012345678,
    "expiresAt": 1692012645678,
    "nonce": "64-char-random-hex",
    "version": "1.0"
  },
  "signature": "base64-encoded-RSA-signature"
}
```

**Verification Steps** (Payment Bridge):
1. ✓ Verify Razorpay signature (HMAC-SHA256)
2. ✓ Fetch payment from Razorpay API (requires Internet)
3. ✓ Check `payment.status === 'captured'`
4. ✓ Check `payment.order_id` matches
5. ✓ Create authorization object
6. ✓ Sign with RSA private key
7. ✓ Return signed authorization to phone

**Deployment Options**:
- **Cloud** (recommended): Vercel, AWS Lambda, Google Cloud Run
- **VPS**: DigitalOcean, Linode with public IP + SSL
- **Same Pi**: Isolated process with Internet access (requires public IP/tunnel)

### 2. Raspberry Pi Updates

#### A. Database Schema

**Added Table**: `payment_nonces` (replay protection)

```sql
CREATE TABLE IF NOT EXISTS payment_nonces (
    nonce TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    transaction_id TEXT NOT NULL,
    payment_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    used_at TEXT NOT NULL DEFAULT (datetime('now')),
    
    FOREIGN KEY (session_id) REFERENCES sessions(session_id),
    FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id)
);
```

**Purpose**: Prevent replay attacks (reusing same authorization)

#### B. Payment Authorization Verifier

**File**: `src/services/paymentAuthVerifier.js`

**Class**: `PaymentAuthorizationVerifier`

**Methods**:
- `verifySignature(authorization, signature)` - RSA signature verification
- `isNonceUsed(nonce)` - Check nonce reuse
- `storeNonce(...)` - Store nonce after use
- `verifyPaymentAuthorization(...)` - Main verification entry point

**Verification Steps** (Pi):
1. ✓ Verify RSA signature with public key
2. ✓ Check authorization version === '1.0'
3. ✓ Check not expired (5-minute window)
4. ✓ Check sessionId matches
5. ✓ Check transactionId matches
6. ✓ Check amount matches backend-calculated amount
7. ✓ Check nonce not already used
8. ✓ Store nonce to prevent future reuse

**Security Properties**:
- ✅ Offline verification (no Internet required)
- ✅ Cryptographically secure (RSA-4096)
- ✅ Replay attack prevention (nonce tracking)
- ✅ Time-bound (5-minute expiry)
- ✅ Amount verification (prevents price manipulation)
- ✅ Idempotent (same authorization can't be used twice)

#### C. Updated Payment Verification Endpoint

**Endpoint**: `POST /api/sessions/:sessionId/payment/verify`

**Old (Insecure)**:
```javascript
// Trusted customer phone input directly ❌
const { razorpay_payment_id, razorpay_signature } = req.body;
```

**New (Secure)**:
```javascript
// Verify cryptographically signed authorization ✅
const { authorization, signature } = req.body;

const result = await paymentAuthVerifier.verifyPaymentAuthorization({
    authorization,
    signature,
    sessionId,
    transactionId,
    expectedAmount
});
```

---

## 🔄 Complete Payment Flow

### Customer Journey

1. **Customer** scans ONE QR code (establishes session)
2. **Kiosk** creates transaction with backend-calculated amount
3. **Customer** phone opens Razorpay payment page
4. **Customer** pays via Razorpay (phone has Internet)
5. **Razorpay** webhook → Customer phone
6. **Phone** calls Payment Bridge: `POST /verify-payment`
7. **Payment Bridge** verifies with Razorpay API (has Internet)
8. **Payment Bridge** signs authorization with private key
9. **Payment Bridge** returns signed authorization to phone
10. **Phone** calls Pi: `POST /api/sessions/:sessionId/payment/verify`
11. **Pi** verifies signature with public key (offline)
12. **Pi** checks nonce, expiry, sessionId, transactionId, amount
13. **Pi** stores nonce, marks transaction VERIFIED
14. **Pi** dispenses medicine, generates receipt/report

### Trust Chain

```
Razorpay
 ↓ (verified by Payment Bridge with Internet)
Payment Bridge
 ↓ (signs with private key 🔐)
Signed Authorization
 ↓ (delivered via customer phone)
Raspberry Pi
 ↓ (verifies with public key 🔓)
DISPENSE
```

**Key Point**: Customer phone is UNTRUSTED transport only.  
Trust comes from cryptographic signature, not phone.

---

## 🛡️ Security Guarantees

### Attack Scenarios

| Attack | Protection |
|--------|-----------|
| Fake payment claim | ❌ Fails signature verification |
| Replay attack (reuse authorization) | ❌ Nonce already used |
| Expired authorization | ❌ Expiry check fails |
| Wrong amount | ❌ Amount mismatch detected |
| Wrong session/transaction | ❌ ID mismatch detected |
| Compromised Pi | ✅ Cannot create fake authorizations (no private key) |
| Man-in-the-middle | ✅ Signature tampering detected |
| Double-spend | ✅ Nonce prevents reuse |

### What Happens If...

**Pi is stolen/compromised**:
- ✅ Public key is public anyway (no secret leaked)
- ✅ Attacker cannot create valid authorizations (needs private key)
- ✅ Payment Bridge private key remains safe

**Payment Bridge is compromised**:
- ⚠️ Attacker can create valid authorizations
- 🔒 Mitigate: Rotate keys immediately, monitor logs

**Customer phone is malicious**:
- ✅ Cannot create valid authorization without Payment Bridge
- ✅ Cannot reuse authorization (nonce check)
- ✅ Cannot modify amount (signature verification fails)

---

## 📋 Deployment Checklist

### Payment Bridge Service

- [ ] Generate RSA-4096 key pair
- [ ] Configure Razorpay credentials in `.env`
- [ ] Deploy to cloud platform (Vercel/AWS/GCP)
- [ ] Test with Razorpay sandbox
- [ ] Setup monitoring/logging
- [ ] Configure rate limiting
- [ ] Add SSL/TLS (automatic on most platforms)

### Raspberry Pi

- [ ] Copy `public-key.pem` to Pi `config/` directory
- [ ] Verify public key loaded (check logs on startup)
- [ ] Test signature verification locally
- [ ] Test nonce replay protection
- [ ] Test expired authorization rejection
- [ ] Test amount mismatch detection

### Integration Testing

- [ ] Real Razorpay payment → Payment Bridge → Pi
- [ ] Replay attack prevention (reuse same authorization)
- [ ] Expired token rejection
- [ ] Amount manipulation detection
- [ ] Wrong sessionId/transactionId rejection
- [ ] Offline Pi verification (disable Internet)

---

## 📊 Files Changed

### Created

1. `payment-bridge-service/index.js` - Payment Bridge server
2. `payment-bridge-service/generate-keys.js` - Key generation
3. `payment-bridge-service/package.json` - Dependencies
4. `payment-bridge-service/.env.example` - Config template
5. `payment-bridge-service/.gitignore` - Excludes private key
6. `payment-bridge-service/README.md` - Setup guide
7. `src/services/paymentAuthVerifier.js` - Pi verification service
8. `docs/STAGE_I_PAYMENT_SECURITY.md` - This document

### Modified

1. `src/database/schema.sql` - Added `payment_nonces` table
2. `server.js` - Updated `/api/sessions/:sessionId/payment/verify` endpoint
3. `server.js` - Added `import paymentAuthVerifier`

---

## 🧪 Testing

### Unit Tests (To Be Added)

```javascript
// Test signature verification
test('verifySignature with valid signature', async () => {
  const auth = { sessionId: 'S1', amount: 2700 };
  const sig = signWithPrivateKey(auth);
  expect(verifier.verifySignature(auth, sig)).toBe(true);
});

// Test nonce replay
test('nonce cannot be reused', async () => {
  const nonce = 'test-nonce';
  await verifier.storeNonce(nonce, 'S1', 'T1', 'pay_1', 2700);
  expect(await verifier.isNonceUsed(nonce)).toBe(true);
});

// Test expiry
test('expired authorization rejected', async () => {
  const auth = { expiresAt: Date.now() - 1000 };
  const result = await verifier.verifyPaymentAuthorization({...});
  expect(result.success).toBe(false);
});
```

### Manual Testing

```bash
# 1. Generate keys
cd payment-bridge-service
npm run generate-keys

# 2. Start Payment Bridge
npm run dev

# 3. Test verification
curl -X POST http://localhost:3001/verify-payment \
  -H "Content-Type: application/json" \
  -d '{
    "razorpay_payment_id": "pay_test",
    "razorpay_order_id": "order_test",
    "razorpay_signature": "...",
    "sessionId": "SESSION-123",
    "transactionId": "TXN-456"
  }'

# 4. Test Pi verification
curl -X POST http://192.168.50.1/api/sessions/SESSION-123/payment/verify \
  -H "Content-Type: application/json" \
  -d '{
    "authorization": {...},
    "signature": "..."
  }'
```

---

## 🎯 Production Readiness

| Component | Status |
|-----------|--------|
| Payment Bridge Service | ✅ Implemented |
| RSA key generation | ✅ Implemented |
| Pi signature verification | ✅ Implemented |
| Replay attack prevention | ✅ Implemented |
| Nonce tracking | ✅ Implemented |
| Expiry validation | ✅ Implemented |
| Amount verification | ✅ Implemented |
| Session/transaction validation | ✅ Implemented |
| Documentation | ✅ Complete |
| Unit tests | ⏳ TODO |
| Integration tests | ⏳ TODO |
| Security audit | ⏳ TODO |
| Payment Bridge deployment | ⏳ TODO |
| Public key deployment to Pi | ⏳ TODO |

**Status**: 🟡 CODE COMPLETE - TESTING & DEPLOYMENT PENDING

---

## 🔜 Next Steps

1. **Deploy Payment Bridge** to cloud platform (1 day)
2. **Generate production keys** (DO NOT use dev keys)
3. **Deploy public key to Pi** (copy to `config/` directory)
4. **Integration testing** with real Razorpay payments (1 day)
5. **Security audit** of complete payment flow (1 day)
6. **Unit tests** for signature verification and nonce tracking
7. **ESP32 firmware update** to local MQTT (separate task)
8. **Full offline testing** with Pi Internet disabled

**Estimated Timeline**: 3-4 days for complete testing and deployment

---

## 📞 Support

**Security Questions**: Review `payment-bridge-service/README.md`  
**Deployment Guide**: See Payment Bridge README  
**Testing Guide**: See Integration Testing section above

---

**Stage I Complete**: Payment fraud vulnerability FIXED via asymmetric cryptography ✅
