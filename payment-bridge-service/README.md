# 🔐 Reliv Payment Bridge Service

**Trusted payment verification service for offline Reliv health kiosk**

## Purpose

The Raspberry Pi kiosk has **ZERO Internet access** for security and reliability. The Payment Bridge Service is the **trusted intermediary** that:

1. Has Internet access to verify payments with Razorpay API
2. Cryptographically signs payment authorizations
3. Allows the offline Pi to verify payments using only the public key

## Architecture

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
│ PAYMENT BRIDGE │
│ │
│ ✓ Fetch payment │
│ ✓ Verify status │
│ ✓ Verify amount │
│ ✓ Sign with 🔐 │
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
│ RASPBERRY PI │
│ (offline) │
│ │
│ ✓ Verify with 🔓 │
│ ✓ Check nonce │
│ ✓ Check expiry │
│ ✓ Check amount │
│ ✓ Dispense │
└──────────────────┘
```

## Security Model

### Asymmetric Cryptography (RSA-4096)

- **Private key 🔐**: Stays on Payment Bridge only (signs authorizations)
- **Public key 🔓**: Deployed to Raspberry Pi (verifies authorizations)

**Why this is secure**:
- Compromising the Pi does NOT allow creating fake payment authorizations
- Only the Payment Bridge (which verifies with Razorpay) can create valid authorizations
- Pi verification is cryptographically sound without Internet access

### Authorization Token Contents

```json
{
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
}
```

### Pi Verification Steps

1. ✓ Verify RSA signature with public key
2. ✓ Check nonce not already used (replay protection)
3. ✓ Check token not expired (5-minute window)
4. ✓ Check sessionId matches
5. ✓ Check transactionId matches
6. ✓ Check amount matches backend-calculated amount
7. ✓ Store nonce to prevent reuse

## Setup

### 1. Generate Keys

```bash
cd payment-bridge-service
npm install
npm run generate-keys
```

This creates:
- `private-key.pem` (Payment Bridge only - NEVER commit)
- `public-key.pem` (Deploy to Raspberry Pi)
- `../config/payment-verification-public-key.pem` (auto-copied for Pi)

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env`:
```
RAZORPAY_KEY_ID=rzp_live_...
RAZORPAY_KEY_SECRET=your_secret_here
PORT=3001
```

### 3. Run Service

**Development**:
```bash
npm run dev
```

**Production**:
```bash
npm start
```

## Deployment Options

### Option 1: Cloud (Recommended)

Deploy to:
- **Vercel** (serverless)
- **AWS Lambda** (serverless)
- **Google Cloud Run** (containerized)
- **DigitalOcean App Platform**

Pros:
- High availability
- Managed infrastructure
- SSL/TLS automatic
- Separate from kiosk hardware

### Option 2: VPS

Deploy to a VPS with public IP:
- Configure firewall
- Setup SSL/TLS (Let's Encrypt)
- Use PM2 or systemd for process management

### Option 3: Same Raspberry Pi (Isolated Process)

Run on the same Pi BUT:
- Separate process with Internet access
- Only this service has Internet
- Main kiosk backend remains offline

**Important**: Still need public IP or ngrok/cloudflare tunnel for customer phones to reach it.

## API Endpoints

### POST /verify-payment

Verify payment and issue signed authorization.

**Request**:
```json
{
  "razorpay_payment_id": "pay_...",
  "razorpay_order_id": "order_...",
  "razorpay_signature": "...",
  "sessionId": "SESSION-123",
  "transactionId": "TXN-456"
}
```

**Response** (success):
```json
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
    "nonce": "a1b2c3...",
    "version": "1.0"
  },
  "signature": "base64-encoded-signature"
}
```

**Response** (failure):
```json
{
  "success": false,
  "error": "Payment not successful (status: failed)"
}
```

### GET /health

Health check.

**Response**:
```json
{
  "status": "healthy",
  "service": "Reliv Payment Bridge",
  "version": "1.0.0",
  "razorpay": true,
  "privateKey": true
}
```

## Customer Payment Flow

1. **Customer** selects service on kiosk
2. **Kiosk** creates transaction, calculates amount
3. **Customer** phone scans QR → Razorpay payment page
4. **Customer** pays via Razorpay (phone has Internet)
5. **Razorpay** callback → Customer phone
6. **Phone** → Payment Bridge `/verify-payment` (Internet)
7. **Payment Bridge** verifies with Razorpay API
8. **Payment Bridge** signs authorization → Phone
9. **Phone** → Raspberry Pi `/api/payment/verify` (local Wi-Fi)
10. **Pi** verifies signature (offline, using public key)
11. **Pi** dispenses medicine, generates receipt/report

## Security Considerations

### DO NOT

❌ Deploy private key to Raspberry Pi
❌ Commit private-key.pem to git
❌ Expose Razorpay secret in frontend
❌ Trust customer phone without cryptographic proof
❌ Allow replay attacks (check nonce)
❌ Accept expired tokens (check expiresAt)

### DO

✅ Keep private key on Payment Bridge only
✅ Deploy public key to Raspberry Pi
✅ Verify payment with Razorpay API before signing
✅ Use nonce for replay protection
✅ Use short expiry (5 minutes)
✅ Verify signature, amount, sessionId, transactionId on Pi
✅ Rate-limit endpoints
✅ Monitor for suspicious patterns

## Monitoring

Log all:
- Payment verification attempts
- Signature verification failures
- Razorpay API errors
- Suspicious patterns (same payment ID multiple times)

## Testing

### Test with Razorpay Sandbox

1. Use Razorpay test credentials
2. Create test payment
3. Verify authorization signing
4. Test Pi verification (see main backend)

### Security Tests

- ✓ Replay attack (reuse same authorization)
- ✓ Expired token
- ✓ Wrong signature
- ✓ Amount mismatch
- ✓ Wrong sessionId
- ✓ Fake payment ID

## License

Proprietary - Reliv Health Kiosk
