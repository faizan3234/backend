import Database from 'better-sqlite3';
import EmailQueueService from './src/services/emailQueue.js';
import sessionManager from './src/services/sessionManager.js';
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

        // 2. Queue email using canonical EMAIL_REPORT type
        console.log('2️⃣ Enqueuing email with type EMAIL_REPORT...');
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
            pdfPath: '/tmp/test.pdf',
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
        console.log('═══════════════════════════════════════════════════════════');
        console.log('🎉 REGRESSION TEST PASSED: EMAIL_REPORT is selected and processed!');
        console.log('═══════════════════════════════════════════════════════════');

    } catch (err) {
        console.error('❌ Regression test failed:', err.message);
        process.exit(1);
    }
}

testEmailWorkerRegression();
