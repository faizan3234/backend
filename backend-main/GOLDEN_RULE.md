# 🔑 THE GOLDEN RULE: ONE QR, ONE SESSION

## Core Principle

```
ONE QR CODE
    ↓
ONE SCAN
    ↓
ONE SESSION
    ↓
EVERYTHING AUTOMATICALLY LINKED
```

## The Customer Journey

### Step 1: QR Scan (ONE TIME ONLY)
```
Customer scans: http://192.168.50.1/mobile/<session-token>
    ↓
Backend creates/retrieves: SESSION-123
    ↓
Phone opens mobile interface with session attached
```

### Step 2: Customer Details (ENTERED ONCE)
```
Customer enters:
- Name
- Phone  
- Email
- Other details
    ↓
Saved to: sessions.customer_data (SESSION-123)
    ↓
NEVER asked again for same session
```

### Step 3: Everything Else is AUTOMATIC
```
SESSION-123
    │
    ├── Measurements → Attached to SESSION-123
    │
    ├── Payment → transaction.session_id = SESSION-123
    │
    ├── Report → reports.session_id = SESSION-123
    │
    ├── Receipt → receipts.session_id = SESSION-123
    │
    ├── Dispense Job → dispense_jobs.session_id = SESSION-123
    │
    └── Email Queue → event_queue.session_id = SESSION-123
```

## What the Backend MUST Do

### ✅ Correct Implementation

```javascript
// Customer scans QR → Session created
POST /api/create-qr-session
Response: { path: "/mobile/abc123", sessionId: "SESSION-123" }

// Customer enters details → Saved to SESSION-123
POST /api/sessions/SESSION-123/customer
Body: { name, phone, email }
→ Updates sessions.customer_data

// Customer completes health measurements
POST /api/sessions/SESSION-123/measurements  
Body: { bp, spo2, temp, height, weight }
→ Session status: MEASUREMENTS_COMPLETE

// Payment created → Linked to SESSION-123
POST /api/sessions/SESSION-123/payment
→ Creates transaction with session_id = SESSION-123
→ No customer re-entry needed (already in session)

// Payment verified → Same session
POST /api/sessions/SESSION-123/payment/verify
→ Marks transaction.verified = 1
→ Updates sessions.payment_status = VERIFIED

// Report generated → Same session
POST /api/sessions/SESSION-123/report
→ Creates reports.session_id = SESSION-123
→ Auto-retrieves customer_data from session (no re-entry)
→ Auto-queues email using session.customer_data.email

// Receipt generated → Same session  
POST /api/sessions/SESSION-123/receipt
→ Creates receipts.session_id = SESSION-123
→ Auto-retrieves customer_data and transaction
→ Auto-queues email

// Dispense triggered → Same session
POST /api/sessions/SESSION-123/dispense
→ Creates dispense_jobs.session_id = SESSION-123
→ Links to existing transaction
```

### ❌ WRONG Implementation (DO NOT DO THIS)

```javascript
// ❌ Creating separate QR for payment
POST /api/create-payment-qr
→ WRONG: Customer shouldn't scan another QR

// ❌ Asking customer to re-enter email for report
POST /api/send-report
Body: { email: "customer@example.com" }
→ WRONG: Email already in sessions.customer_data

// ❌ Creating unlinked transaction
POST /api/create-order
Body: { amount: 100 }  
→ WRONG: No session_id linkage

// ❌ Manual transaction linking in frontend
Frontend: "Enter transaction ID to get receipt"
→ WRONG: Backend should auto-link via session_id
```

## Database Relationships

### All Tables Link to Session

```sql
-- Main session (the anchor)
sessions.session_id = 'SESSION-123'

-- Everything references it
transactions.session_id = 'SESSION-123'
reports.session_id = 'SESSION-123'
receipts.session_id = 'SESSION-123'
dispense_jobs.session_id = 'SESSION-123'
event_queue.session_id = 'SESSION-123'
```

### Query Example
```sql
-- Get EVERYTHING for a session in one query
SELECT 
    s.*,
    t.transaction_id,
    t.amount,
    t.status as payment_status,
    r.report_id,
    r.pdf_path as report_pdf,
    rc.receipt_id,
    rc.pdf_path as receipt_pdf,
    d.job_id,
    d.status as dispense_status
FROM sessions s
LEFT JOIN transactions t ON s.session_id = t.session_id
LEFT JOIN reports r ON s.session_id = r.session_id  
LEFT JOIN receipts rc ON s.session_id = rc.session_id
LEFT JOIN dispense_jobs d ON s.session_id = d.session_id
WHERE s.session_id = 'SESSION-123';
```

## Frontend Flow

### Initial Scan
```javascript
// Customer scans QR with session token
const url = new URL(window.location.href);
const sessionToken = url.pathname.split('/').pop();

// Store in app state (ONCE)
sessionStorage.setItem('sessionId', sessionToken);
```

### All Subsequent API Calls
```javascript
const sessionId = sessionStorage.getItem('sessionId');

// Customer details
await fetch(`/api/sessions/${sessionId}/customer`, {
    method: 'POST',
    body: JSON.stringify({ name, phone, email })
});

// Payment
await fetch(`/api/sessions/${sessionId}/payment`, {
    method: 'POST'
});

// Report
await fetch(`/api/sessions/${sessionId}/report`, {
    method: 'POST',
    body: JSON.stringify({ measurements })
});

// Receipt  
await fetch(`/api/sessions/${sessionId}/receipt`, {
    method: 'GET'
});
```

**NO QR RESCANNING NEEDED** - sessionId persists in sessionStorage

## Email Automation

### How Email Works
```javascript
// Customer enters email ONCE
POST /api/sessions/SESSION-123/customer
Body: { email: "customer@example.com" }

// Later: Report generated
POST /api/sessions/SESSION-123/report
→ Backend automatically:
  1. Retrieves session.customer_data.email
  2. Saves PDF locally  
  3. Creates event_queue entry:
     {
       type: 'EMAIL_PENDING',
       session_id: 'SESSION-123',
       payload: {
         to: session.customer_data.email,  // AUTO
         subject: 'Your Health Report',
         attachment: reportPath
       }
     }

// Background worker processes queue
→ Sends email when Internet available
→ Customer never asked to re-enter email
```

## Session Recovery After Restart

```javascript
// Before restart: Session in progress
sessions.session_id = 'SESSION-123'
sessions.status = 'PAYMENT_PENDING'
sessions.customer_data = '{"name":"John","email":"john@example.com"}'

// Pi restarts
→ SQLite persists all data

// After restart: Customer returns to same URL
http://192.168.50.1/mobile/abc123

// Backend recovers session
const session = await sessionManager.getSessionByQrToken('abc123');
→ session_id = 'SESSION-123'
→ customer_data still available
→ payment_status still 'PENDING'

// Customer can continue exactly where they left off
→ Complete payment
→ Get report  
→ Same session throughout
```

## Implementation Checklist

### Backend Requirements
- [ ] Every endpoint accepts `sessionId` parameter
- [ ] Customer data retrieved from `sessions.customer_data` (not re-requested)
- [ ] All database records include `session_id` foreign key
- [ ] Email auto-queued using session email (not manual)
- [ ] Payment linked to session (not standalone)
- [ ] Report/receipt generated using session data (auto-populated)
- [ ] Session persists in SQLite (survives restart)

### Frontend Requirements  
- [ ] QR scanned ONCE at start
- [ ] `sessionId` stored in sessionStorage
- [ ] All API calls include `sessionId` in URL path
- [ ] Customer details form shown ONCE (not repeated)
- [ ] No "enter email for report" prompt (uses session email)
- [ ] No "enter transaction ID" prompt (backend auto-links)
- [ ] No QR rescan for payment/report/receipt

### Database Schema Requirements
- [x] `sessions` table has `customer_data` JSON column
- [x] `transactions.session_id` foreign key
- [x] `reports.session_id` foreign key
- [x] `receipts.session_id` foreign key
- [x] `dispense_jobs.session_id` foreign key
- [x] `event_queue.session_id` column

## Summary

```
┌─────────────────────────────────────────────┐
│  ONE QR → ONE SESSION → EVERYTHING LINKED   │
└─────────────────────────────────────────────┘

Customer Experience:
✅ Scan QR once
✅ Enter details once  
✅ Everything else automatic

Backend Responsibility:
✅ Create persistent session
✅ Link all operations to session_id
✅ Auto-retrieve customer data
✅ Auto-queue emails
✅ Survive restarts

Result:
🎯 Seamless, frictionless customer journey
🎯 No redundant data entry
🎯 No QR rescanning
🎯 Everything traceable via session_id
```

**THIS IS THE GOLDEN RULE. DO NOT VIOLATE IT.**
