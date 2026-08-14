import Database from 'better-sqlite3';
import EmailQueueService from './src/services/emailQueue.js';
import { initializeDatabase } from './src/database/db.js';

async function testEmailWorkerRegression() {
    console.log('═══════════════════════════════════════════════════════════');
    console.log('🧪 EMAIL QUEUE WORKER REGRESSION TEST');
    console.log('═══════════════════════════════════════════════════════════\n');

    try {
        const db = initializeDatabase();
        const testSessionId = `KSK-TEST-${Date.now()}`;

        // 1. Create a dummy session with customer data
        console.log('1️⃣ Creating test session in SQLite...');
        const customerData = { name: 'Regression User', email: 'regression@example.com', phone: '9999999999' };
        db.prepare(`
            INSERT INTO sessions (
                session_id, kiosk_id, status, customer_data, service_type, expires_at, created_at
            ) VALUES (?, 'RELIV-001', 'COMPLETED', ?, 'HEALTH_CHECKUP', datetime('now', '+30 minutes'), datetime('now'))
        `).run(testSessionId, JSON.stringify(customerData));

        // 2. Queue email using canonical EMAIL_REPORT type with valid PDF buffer
        console.log('2️⃣ Enqueuing email with type EMAIL_REPORT (valid PDF buffer)...');
        let sentEvent = null;
        const mockTransporter = {
            sendMail: async (options) => {
                console.log(`   MockTransporter: Sent email to ${options.to} with subject "${options.subject}"`);
                sentEvent = options;
                return { messageId: 'MOCK-12345' };
            }
        };

        const emailQueue = new EmailQueueService(db, mockTransporter);
        const eventId = emailQueue.queueEmail(testSessionId, 'EMAIL_REPORT', {
            pdfBuffer: Buffer.from('%PDF-1.4 Mock Real Report Buffer Content'),
            reportId: 'RPT-REG-001'
        });

        console.log(`   Queued event_id: ${eventId}`);

        // 3. Verify event is stored in event_queue table with type EMAIL_REPORT
        const eventRow = db.prepare('SELECT * FROM event_queue WHERE event_id = ?').get(eventId);
        console.log(`   SQLite event_queue record: type=${eventRow.type}, status=${eventRow.status}`);
        if (eventRow.type !== 'EMAIL_REPORT') {
            throw new Error(`Expected event type EMAIL_REPORT, got '${eventRow.type}'`);
        }
        console.log('   ✅ EMAIL_REPORT correctly inserted into event_queue table!');

        // 4. Run EmailQueueService.processQueue() and verify worker selects & processes EMAIL_REPORT
        console.log('\n3️⃣ Running EmailQueueService.processQueue()...');
        await emailQueue.processQueue();

        const processedRow = db.prepare('SELECT * FROM event_queue WHERE event_id = ?').get(eventId);
        console.log(`   SQLite event_queue record after processing: status=${processedRow.status}`);

        if (processedRow.status !== 'COMPLETED') {
            throw new Error(`Expected event status COMPLETED, got '${processedRow.status}'`);
        }
        if (!sentEvent) {
            throw new Error('Email worker failed to select and send the EMAIL_REPORT event');
        }

        console.log('   ✅ EmailQueueWorker selected and successfully processed the EMAIL_REPORT event!\n');

        // 5. Test missing PDF attachment behavior (NO FAKE PDF FALLBACK)
        console.log('4️⃣ Testing Missing PDF Attachment Behavior (No Fake Fallback)...');
        const missingPdfSessionId = `KSK-TEST-MISSING-${Date.now()}`;
        db.prepare(`
            INSERT INTO sessions (
                session_id, kiosk_id, status, customer_data, service_type, expires_at, created_at
            ) VALUES (?, 'RELIV-001', 'COMPLETED', ?, 'HEALTH_CHECKUP', datetime('now', '+30 minutes'), datetime('now'))
        `).run(missingPdfSessionId, JSON.stringify(customerData));

        let mockSentOnMissing = false;
        const strictTransporter = {
            sendMail: async () => {
                mockSentOnMissing = true;
                return { messageId: 'BAD-SENT' };
            }
        };

        const missingQueue = new EmailQueueService(db, strictTransporter);
        const missingEventId = missingQueue.queueEmail(missingPdfSessionId, 'EMAIL_REPORT', {
            pdfPath: '/nonexistent/invalid_path/report.pdf',
            reportId: 'RPT-MISSING-001'
            // pdfBuffer intentionally omitted
        });

        await missingQueue.processQueue();

        const missingEventRow = db.prepare('SELECT * FROM event_queue WHERE event_id = ?').get(missingEventId);
        console.log(`   Missing PDF event record: attempts=${missingEventRow.attempts}, status=${missingEventRow.status}, last_error="${missingEventRow.last_error}"`);

        if (mockSentOnMissing) {
            throw new Error('Security/Quality flaw: Fake email was sent when real PDF was missing!');
        }
        if (missingEventRow.status !== 'PENDING') {
            throw new Error(`Expected event status PENDING for retry, got ${missingEventRow.status}`);
        }
        if (missingEventRow.attempts !== 1) {
            throw new Error(`Expected attempt count 1, got ${missingEventRow.attempts}`);
        }
        if (!missingEventRow.last_error || !missingEventRow.last_error.includes('attachment file not found')) {
            throw new Error(`Expected last_error to mention missing attachment file, got: ${missingEventRow.last_error}`);
        }

        console.log('   ✅ Missing PDF correctly caused attempt failure, logged error, kept email queued for retry, and NEVER sent fake PDF content!\n');

        console.log('═══════════════════════════════════════════════════════════');
        console.log('🎉 ALL EMAIL WORKER REGRESSION TESTS PASSED SUCCESSFULLY!');
        console.log('═══════════════════════════════════════════════════════════');

    } catch (err) {
        console.error('❌ Regression test failed:', err.message);
        process.exit(1);
    }
}

testEmailWorkerRegression();
