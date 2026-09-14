// Read-only SMTP authentication check. Does not send mail or print credentials.
import 'dotenv/config';
import { createReceiptTransporter, isReceiptEmailConfigured } from './services/receiptEmailService.js';
import { emailFailure } from './services/emailFailure.js';
if (!isReceiptEmailConfigured()) {
  console.error('Set RECEIPT_GMAIL_USER and RECEIPT_GMAIL_APP_PASSWORD on this payment bridge host.');
  process.exitCode = 1;
} else {
  const transporter = createReceiptTransporter();
  try { await transporter.verify(); console.log('SMTP login accepted. No email was sent.'); }
  catch (cause) { const error = emailFailure(cause); console.error(`${error.code}: ${error.message}`); process.exitCode = 1; }
  finally { transporter.close(); }
}
