/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RELIV KIOSK - PAYMENT COMPLETION ROUTE
 * Purpose: Handle payment authorization delivery from customer phone to Pi
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * ARCHITECTURE:
 * 1. Customer phone receives signed authorization from Payment Bridge
 * 2. Customer HTTPS site submits form POST to this endpoint
 * 3. Pi verifies authorization locally (RSA public key)
 * 4. Creates fulfillment job if valid
 * 5. Starts dispensing via local MQTT
 * 
 * TRANSPORT: Browser form POST (HTTPS → HTTP works for top-level navigation)
 */

import crypto from 'crypto';
import sessionManager from '../services/sessionManager.js';
import { transactionManager } from '../services/transactionManager.js';
import paymentAuthVerifier from '../services/paymentAuthVerifier.js';
import fulfillmentManager from '../services/fulfillmentManager.js';

/**
 * POST /payment-complete
 * 
 * Receives signed payment authorization from customer browser
 * 
 * Request Body:
 * {
 *   sessionId: string,
 *   authorization: string (JSON stringified),
 *   signature: string (base64),
 *   pairingToken: string
 * }
 * 
 * OR Form Data:
 * sessionId=...&authorization=...&signature=...&pairingToken=...
 */
export async function handlePaymentComplete(req, res) {
    const startTime = Date.now();
    
    try {
        // Extract from JSON body or form data
        const {
            sessionId,
            authorization: authorizationStr,
            signature,
            pairingToken
        } = req.body;
        
        console.log('\n═══════════════════════════════════════════════════════════');
        console.log('💳 PAYMENT COMPLETION REQUEST');
        console.log('═══════════════════════════════════════════════════════════');
        console.log(`Session: ${sessionId}`);
        console.log(`Pairing Token: ${pairingToken?.substring(0, 16)}...`);
        
        // ───────────────────────────────────────────────────────────────────
        // STEP 1: Validate input parameters
        // ───────────────────────────────────────────────────────────────────
        if (!sessionId || !authorizationStr || !signature || !pairingToken) {
            console.error('❌ Missing required parameters');
            return res.status(400).send(generateErrorPage('Missing required payment information.'));
        }
        
        // Parse authorization
        let authorization;
        try {
            authorization = JSON.parse(authorizationStr);
        } catch (err) {
            console.error('❌ Invalid authorization JSON:', err);
            return res.status(400).send(generateErrorPage('Invalid payment authorization format.'));
        }
        
        // ───────────────────────────────────────────────────────────────────
        // STEP 2: Get session (validate exists + not expired)
        // ───────────────────────────────────────────────────────────────────
        const session = sessionManager.getSession(sessionId);
        if (!session) {
            console.error('❌ Session not found:', sessionId);
            return res.status(404).send(generateErrorPage('Session not found.'));
        }
        
        // ───────────────────────────────────────────────────────────────────
        // STEP 3: Verify pairing token WITHOUT consuming it
        //         If someone submits a fake request, the token survives
        //         for the legitimate request to use later.
        // ───────────────────────────────────────────────────────────────────
        try {
            sessionManager.verifyPairingToken(sessionId, pairingToken);
            console.log('✅ Pairing token verified (not yet consumed)');
        } catch (err) {
            console.error('❌ Pairing token verification failed:', err.message);
            return res.status(403).send(generateErrorPage(
                'Invalid or expired session pairing.',
                'This payment authorization cannot be used with this kiosk session.'
            ));
        }
        
        // ───────────────────────────────────────────────────────────────────
        // STEP 4: Get transaction
        // ───────────────────────────────────────────────────────────────────
        const transaction = transactionManager.getTransactionBySession(sessionId);
        if (!transaction) {
            console.error('❌ Transaction not found for session:', sessionId);
            return res.status(404).send(generateErrorPage('Transaction not found.'));
        }
        
        console.log(`Transaction: ${transaction.transaction_id}`);
        console.log(`Expected Amount: ₹${transaction.amount / 100}`);
        
        // ───────────────────────────────────────────────────────────────────
        // STEP 5: Verify payment authorization (CRITICAL SECURITY)
        //         Uses correct object parameter signature.
        //         Checks: RSA signature, nonce, expiry, sessionId,
        //         transactionId, amount (backend-calculated)
        // ───────────────────────────────────────────────────────────────────
        try {
            const verificationResult = await paymentAuthVerifier.verifyPaymentAuthorization({
                authorization,
                signature,
                sessionId,
                transactionId: transaction.transaction_id,
                expectedAmount: transaction.amount  // Backend-calculated amount
            });
            
            if (!verificationResult.success) {
                console.error('❌ Payment authorization verification failed:', verificationResult.error);
                return res.status(403).send(generateErrorPage(
                    'Payment verification failed.',
                    verificationResult.error
                ));
            }
            
            console.log('✅ Payment authorization verified (RSA signature valid)');
            console.log(`   Payment ID: ${authorization.paymentId}`);
            console.log(`   Amount: ₹${authorization.amount / 100}`);
            console.log(`   Nonce: ${authorization.nonce.substring(0, 16)}...`);
            
        } catch (err) {
            console.error('❌ Payment verification error:', err);
            return res.status(500).send(generateErrorPage(
                'Payment verification failed.',
                err.message
            ));
        }
        
        // ───────────────────────────────────────────────────────────────────
        // STEP 6: ATOMICALLY consume pairing token
        //         Only NOW, after all cryptographic checks have passed.
        //         This prevents attackers from burning the token with
        //         fake/invalid authorizations.
        // ───────────────────────────────────────────────────────────────────
        try {
            sessionManager.consumePairingToken(sessionId, pairingToken);
            console.log('✅ Pairing token atomically consumed');
        } catch (err) {
            // Race condition: token was consumed between verify and consume
            console.error('❌ Failed to consume pairing token (race condition?):', err.message);
            return res.status(409).send(generateErrorPage(
                'Payment already processed.',
                'This session has already completed payment.'
            ));
        }
        
        // ───────────────────────────────────────────────────────────────────
        // STEP 7: Mark payment as verified in database
        //         CRITICAL: This MUST succeed before proceeding to
        //         fulfillment. Never dispense without DB persistence.
        // ───────────────────────────────────────────────────────────────────
        try {
            // Build proper paymentDetails object as expected by verifyPayment()
            const paymentDetails = {
                id: authorization.paymentId,
                amount: authorization.amount,
                status: 'captured',  // Payment Bridge already verified this with Razorpay API
                order_id: authorization.orderId
            };
            
            transactionManager.verifyPayment(
                transaction.transaction_id,
                authorization.paymentId,
                paymentDetails
            );
            
            sessionManager.markPaymentVerified(sessionId, authorization.paymentId);
            
            console.log('✅ Payment verified and recorded in SQLite');
            
        } catch (err) {
            console.error('❌ CRITICAL: Failed to persist payment verification:', err);
            console.error('   ⛔ REFUSING to proceed to fulfillment without DB persistence');
            return res.status(500).send(generateErrorPage(
                'Payment processing error.',
                'Your payment was verified but could not be recorded. Please contact support with your payment reference.'
            ));
        }
        
        // ───────────────────────────────────────────────────────────────────
        // STEP 8: Create fulfillment job (if applicable)
        //         Only for MEDICINE service type requiring physical dispensing
        // ───────────────────────────────────────────────────────────────────
        if (session.service_type === 'MEDICINE' || session.service_type === 'HEALTH_CHECKUP') {
            try {
                if (session.service_type === 'MEDICINE') {
                    // Parse cart to get kit_id and quantity
                    const cart = transaction.cart ? (typeof transaction.cart === 'string' ? JSON.parse(transaction.cart) : transaction.cart) : [];
                    
                    if (cart.length > 0) {
                        for (const item of cart) {
                            const { kit_id, quantity } = item;
                            
                            // Create fulfillment job (idempotent)
                            const job = await fulfillmentManager.createJob(
                                sessionId,
                                transaction.transaction_id,
                                kit_id,
                                quantity
                            );
                            
                            console.log(`✅ Fulfillment job created: ${job.job_id}`);
                            
                            // Start dispensing (only publishes if PENDING)
                            await fulfillmentManager.startDispensing(job.job_id);
                            
                            console.log(`✅ Dispensing started for job: ${job.job_id}`);
                        }
                        
                        sessionManager.markFulfillment(sessionId);
                        
                    } else {
                        console.warn('⚠️  No items in cart, skipping fulfillment');
                    }
                    
                } else if (session.service_type === 'HEALTH_CHECKUP') {
                    // Health checkup doesn't require physical dispensing
                    sessionManager.updateReportStatus(sessionId, 'GENERATING');
                    console.log('✅ Health checkup - generating report');
                }
                
            } catch (err) {
                console.error('❌ Fulfillment creation failed:', err);
                // Payment was verified and persisted. Fulfillment failure is logged
                // but does not undo payment. Job can be recovered on restart.
            }
        }
        
        // ───────────────────────────────────────────────────────────────────
        // STEP 9: Return success page to customer browser
        // ───────────────────────────────────────────────────────────────────
        const duration = Date.now() - startTime;
        console.log(`✅ Payment completion successful (${duration}ms)`);
        console.log('═══════════════════════════════════════════════════════════\n');
        
        res.send(generateSuccessPage(session, transaction));
        
    } catch (err) {
        console.error('❌ Payment completion error:', err);
        res.status(500).send(generateErrorPage(
            'Internal server error.',
            'Please contact support with your payment reference.'
        ));
    }
}

/**
 * Generate success HTML page
 */
function generateSuccessPage(session, transaction) {
    return `
        <!DOCTYPE html>
        <html>
        <head>
            <title>Payment Successful</title>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                body {
                    font-family: Arial, sans-serif;
                    text-align: center;
                    padding: 50px;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: white;
                }
                .success-box {
                    background: white;
                    color: #333;
                    padding: 40px;
                    border-radius: 12px;
                    margin: 20px auto;
                    max-width: 500px;
                    box-shadow: 0 8px 16px rgba(0,0,0,0.2);
                }
                h1 { color: #28a745; margin-bottom: 10px; }
                .checkmark {
                    font-size: 80px;
                    color: #28a745;
                    margin-bottom: 20px;
                }
                .detail { margin: 15px 0; font-size: 16px; }
                .detail strong { color: #667eea; }
                .footer {
                    margin-top: 30px;
                    font-size: 14px;
                    color: #666;
                }
                .instruction {
                    background: #f8f9fa;
                    padding: 15px;
                    border-radius: 8px;
                    margin-top: 20px;
                    font-size: 14px;
                }
            </style>
        </head>
        <body>
            <div class="success-box">
                <div class="checkmark">✓</div>
                <h1>Payment Successful!</h1>
                <p>Your payment has been verified.</p>
                
                <div class="detail">
                    <strong>Session:</strong> ${session.session_id}
                </div>
                <div class="detail">
                    <strong>Amount:</strong> ₹${(transaction.amount / 100).toFixed(2)}
                </div>
                <div class="detail">
                    <strong>Payment ID:</strong> ${transaction.provider_payment_id || 'Processing'}
                </div>
                
                ${session.service_type === 'MEDICINE' ? `
                    <div class="instruction">
                        <strong>📦 Your medicine is being dispensed</strong>
                        <p>Please collect it from the kiosk dispenser.</p>
                    </div>
                ` : ''}
                
                ${session.service_type === 'HEALTH_CHECKUP' ? `
                    <div class="instruction">
                        <strong>📊 Your health report is being generated</strong>
                        <p>It will be emailed to you shortly.</p>
                    </div>
                ` : ''}
                
                <div class="footer">
                    Thank you for using Reliv Kiosk!
                </div>
            </div>
        </body>
        </html>
    `;
}

/**
 * Generate error HTML page
 */
function generateErrorPage(title, detail = null) {
    return `
        <!DOCTYPE html>
        <html>
        <head>
            <title>Payment Error</title>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                body {
                    font-family: Arial, sans-serif;
                    text-align: center;
                    padding: 50px;
                    background: #fff3cd;
                }
                .error-box {
                    background: white;
                    padding: 40px;
                    border-radius: 12px;
                    margin: 20px auto;
                    max-width: 500px;
                    box-shadow: 0 8px 16px rgba(0,0,0,0.1);
                }
                h1 {color: #856404; margin-bottom: 10px; }
                .icon { font-size: 80px; margin-bottom: 20px; }
                p { color: #856404; font-size: 16px; }
                .detail { font-size: 14px; color: #666; margin-top: 20px; }
                .footer {
                    margin-top: 30px;
                    font-size: 14px;
                    color: #666;
                }
            </style>
        </head>
        <body>
            <div class="error-box">
                <div class="icon">⚠️</div>
                <h1>Payment Error</h1>
                <p>${title}</p>
                ${detail ? `<div class="detail">${detail}</div>` : ''}
                <div class="footer">
                    Please contact support if you need assistance.
                </div>
            </div>
        </body>
        </html>
    `;
}
