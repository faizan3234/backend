import Database from 'better-sqlite3';
import { initPaymentV2Schema } from './paymentV2Db.js';
import {
    encryptConfirmationCodeAtRest
} from './paymentV2Crypto.js';
import {
    sendHealthReportEmail,
    generateHealthReportDownload
} from './services/healthReportEmailService.js';
import {
    buildHealthReportModel
} from './services/healthReportPdfBuilder.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
    if (condition) {
        passed++;
        console.log(`  âœ… ${message}`);
    } else {
        failed++;
        console.error(`  âŒ ${message}`);
    }
}

const db = new Database(':memory:');
initPaymentV2Schema(db);

const SECRET = 'health_report_test_secret_1234567890';

const snapshot1 = {
    version: 1,
    patient: { name: 'Progressive Test', age: 30, gender: 'male' },
    vitals: {
        systolic: 120,
        diastolic: 80,
        bpm: 72,
        oxygen: 98,
        temperature: 98.4,
        weight: 70,
        height: 180,
        bodyFat: 18,
        muscleMass: 53,
        bodyWater: 57
    }
};

const snapshot2 = {
    version: 1,
    patient: { name: 'Progressive Test', age: 30, gender: 'male' },
    vitals: {
        systolic: 118,
        diastolic: 78,
        bpm: 70,
        oxygen: 99,
        temperature: 98.2,
        weight: 69.5,
        height: 180,
        bodyFat: 17.5,
        muscleMass: 53.4,
        bodyWater: 57.8
    }
};

function insertPaidHealth({ requestId, orderId, txnId, paymentId, snapshot }) {
    db.prepare(`
        INSERT INTO payment_v2_orders (
            order_id, request_id, request_nonce, payload_fingerprint,
            session_id, transaction_id, kiosk_id, amount, currency,
            service_type, encrypted_code, status, razorpay_payment_id,
            encrypted_health_snapshot, created_at, expires_at, verified_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'INR', 'HEALTH_CHECKUP', ?, 'PAID', ?, ?, ?, ?, ?)
    `).run(
        orderId,
        requestId,
        `nonce_${requestId}`,
        `fp_${requestId}`,
        `session_${requestId}`,
        txnId,
        'RELIV-001',
        2700,
        encryptConfirmationCodeAtRest('1234', SECRET),
        paymentId,
        encryptConfirmationCodeAtRest(JSON.stringify(snapshot), SECRET),
        Date.now() - 10000,
        Date.now() + 300000,
        Date.now()
    );
}

insertPaidHealth({
    requestId: 'REQ-HR-1',
    orderId: 'order_hr_1',
    txnId: 'TXN-HR-1',
    paymentId: 'pay_hr_1',
    snapshot: snapshot1
});

const sent = [];
const transporter = {
    sendMail: async (opts) => {
        sent.push(opts);
        return { messageId: `<health-${sent.length}@test>` };
    }
};

console.log('\nâ•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•');
console.log(' RELIV CLOUD HEALTH REPORT TEST');
console.log('â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•');

const r1 = await sendHealthReportEmail({
    db,
    requestId: 'REQ-HR-1',
    email: ' Progressive.User@Example.com ',
    codeSecret: SECRET,
    transporter
});

assert(r1.ok === true && r1.sent === true, 'Scan 1 report email succeeds');
assert(r1.scanNumber === 1, 'First paid scan is Scan 1');
assert(sent.length === 1, 'One email sent');
assert(
    sent[0].attachments.some(a => a.filename.includes('Health-Report-Scan-1')),
    'Health report PDF attached'
);
assert(
    Buffer.isBuffer(sent[0].attachments[0].content) &&
    sent[0].attachments[0].content.length > 500,
    'Generated health PDF is a non-empty Buffer'
);

const dbScan1 = db.prepare(
    `SELECT * FROM payment_v2_health_scans WHERE request_id = 'REQ-HR-1'`
).get();

assert(dbScan1.delivery_status === 'SENT', 'Scan 1 delivery stored as SENT');
assert(!JSON.stringify(dbScan1).includes('progressive.user@example.com'), 'Plain email is not stored in health scan row');
assert(Boolean(dbScan1.email_key), 'HMAC email identity key stored');
assert(Boolean(dbScan1.encrypted_email), 'Email stored only as encrypted ciphertext');
assert(Boolean(r1.downloadToken), 'Short-lived report download token returned');

const dup = await sendHealthReportEmail({
    db,
    requestId: 'REQ-HR-1',
    email: 'progressive.user@example.com',
    codeSecret: SECRET,
    transporter
});

assert(dup.alreadySent === true, 'Duplicate same scan/email is idempotent');
assert(sent.length === 1, 'Duplicate does not send second email');

const download1 = await generateHealthReportDownload({
    db,
    requestId: 'REQ-HR-1',
    token: dup.downloadToken,
    codeSecret: SECRET
});

assert(Buffer.isBuffer(download1.pdf) && download1.pdf.length > 500, 'Tokenized phone download regenerates PDF');

insertPaidHealth({
    requestId: 'REQ-HR-2',
    orderId: 'order_hr_2',
    txnId: 'TXN-HR-2',
    paymentId: 'pay_hr_2',
    snapshot: snapshot2
});

const r2 = await sendHealthReportEmail({
    db,
    requestId: 'REQ-HR-2',
    email: 'progressive.user@example.com',
    codeSecret: SECRET,
    transporter
});

assert(r2.scanNumber === 2, 'Second paid scan for same email is Scan 2');
assert(r2.totalScans === 2, 'Scan 2 report loads both scans');
assert(sent.length === 2, 'Second scan sends exactly one new email');

const rows = db.prepare(`
    SELECT scan_number
    FROM payment_v2_health_scans
    ORDER BY scan_number
`).all();

assert(rows.length === 2 && rows[0].scan_number === 1 && rows[1].scan_number === 2, 'Progressive scan numbering persists in SQLite');

const model = buildHealthReportModel({
    scans: [
        { scanNumber: 1, createdAt: Date.now() - 86400000, snapshot: snapshot1 },
        { scanNumber: 2, createdAt: Date.now(), snapshot: snapshot2 }
    ],
    currentScanNumber: 2,
    recipientEmail: 'progressive.user@example.com'
});

assert(model.tier === 2, 'Scan 2 unlocks progressive comparison tier');

db.prepare(`
    INSERT INTO payment_v2_orders (
        order_id, request_id, request_nonce, payload_fingerprint,
        session_id, transaction_id, kiosk_id, amount, currency,
        service_type, encrypted_code, status, razorpay_payment_id,
        created_at, expires_at, verified_at
    ) VALUES (
        'order_med_hr', 'REQ-MED-HR', 'nonce_med_hr', 'fp_med_hr',
        'session_med_hr', 'TXN-MED-HR', 'RELIV-001', 5000, 'INR',
        'MEDICINE', ?, 'PAID', 'pay_med_hr', ?, ?, ?
    )
`).run(
    encryptConfirmationCodeAtRest('5555', SECRET),
    Date.now(),
    Date.now() + 300000,
    Date.now()
);

let medicineRejected = false;
try {
    await sendHealthReportEmail({
        db,
        requestId: 'REQ-MED-HR',
        email: 'progressive.user@example.com',
        codeSecret: SECRET,
        transporter
    });
} catch (e) {
    medicineRejected = e.code === 'NOT_HEALTH_CHECKUP';
}
assert(medicineRejected, 'Medicine payment cannot generate health report');

db.prepare(`
    INSERT INTO payment_v2_orders (
        order_id, request_id, request_nonce, payload_fingerprint,
        session_id, transaction_id, kiosk_id, amount, currency,
        service_type, encrypted_code, status,
        encrypted_health_snapshot, created_at, expires_at
    ) VALUES (
        'order_unpaid_hr', 'REQ-UNPAID-HR', 'nonce_unpaid_hr', 'fp_unpaid_hr',
        'session_unpaid_hr', 'TXN-UNPAID-HR', 'RELIV-001', 2700, 'INR',
        'HEALTH_CHECKUP', ?, 'CREATED', ?, ?, ?
    )
`).run(
    encryptConfirmationCodeAtRest('6666', SECRET),
    encryptConfirmationCodeAtRest(JSON.stringify(snapshot1), SECRET),
    Date.now(),
    Date.now() + 300000
);

let unpaidRejected = false;
try {
    await sendHealthReportEmail({
        db,
        requestId: 'REQ-UNPAID-HR',
        email: 'progressive.user@example.com',
        codeSecret: SECRET,
        transporter
    });
} catch (e) {
    unpaidRejected = e.code === 'ORDER_NOT_PAID';
}
assert(unpaidRejected, 'Unpaid order cannot generate or email report');

console.log('\nâ•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•');
console.log(` Passed: ${passed}`);
console.log(` Failed: ${failed}`);
console.log(` Total:  ${passed + failed}`);
console.log('â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•\n');

db.close();

if (failed > 0) process.exit(1);