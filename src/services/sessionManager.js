/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RELIV KIOSK - SESSION MANAGER
 * Purpose: Manage kiosk session lifecycle with proper state machine
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { getDb } from '../database/db.js';
import crypto from 'crypto';

// ───────────────────────────────────────────────────────────────────────────
// Session State Machine
// ───────────────────────────────────────────────────────────────────────────
const SESSION_STATES = {
    CREATED: 'CREATED',
    CUSTOMER_ATTACHED: 'CUSTOMER_ATTACHED',
    SERVICE_SELECTED: 'SERVICE_SELECTED',
    MEASUREMENTS_COMPLETE: 'MEASUREMENTS_COMPLETE',
    PAYMENT_REQUIRED: 'PAYMENT_REQUIRED',
    PAYMENT_PENDING: 'PAYMENT_PENDING',
    PAYMENT_VERIFIED: 'PAYMENT_VERIFIED',
    FULFILLMENT: 'FULFILLMENT',
    COMPLETED: 'COMPLETED'
};

// Valid state transitions
const VALID_TRANSITIONS = {
    [SESSION_STATES.CREATED]: [SESSION_STATES.CUSTOMER_ATTACHED],
    [SESSION_STATES.CUSTOMER_ATTACHED]: [SESSION_STATES.SERVICE_SELECTED],
    [SESSION_STATES.SERVICE_SELECTED]: [SESSION_STATES.MEASUREMENTS_COMPLETE, SESSION_STATES.PAYMENT_REQUIRED],
    [SESSION_STATES.MEASUREMENTS_COMPLETE]: [SESSION_STATES.PAYMENT_REQUIRED],
    [SESSION_STATES.PAYMENT_REQUIRED]: [SESSION_STATES.PAYMENT_PENDING],
    [SESSION_STATES.PAYMENT_PENDING]: [SESSION_STATES.PAYMENT_VERIFIED, SESSION_STATES.PAYMENT_REQUIRED], // Allow retry
    [SESSION_STATES.PAYMENT_VERIFIED]: [SESSION_STATES.FULFILLMENT],
    [SESSION_STATES.FULFILLMENT]: [SESSION_STATES.COMPLETED],
    [SESSION_STATES.COMPLETED]: [] // Terminal state
};

// ───────────────────────────────────────────────────────────────────────────
// Session Manager Class
// ───────────────────────────────────────────────────────────────────────────
class SessionManager {
    constructor() {
        this._db = null;
    }

    get db() {
        if (!this._db) {
            this._db = getDb();
        }
        return this._db;
    }
    
    /**
     * Initialize the session manager with database connection
     */
    initialize() {
        this._db = getDb();
        console.log('[SessionManager] Initialized');
    }
    
    /**
     * Create a new session
     * @param {string} kioskId - Kiosk identifier
     * @param {string} serviceType - 'HEALTH_CHECKUP' or 'MEDICINE' (optional)
     * @returns {Object} Created session
     */
    createSession(kioskId = 'RELIV-001', serviceType = null) {
        const sessionId = `KSK-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes
        
        const stmt = this.db.prepare(`
            INSERT INTO sessions (session_id, kiosk_id, service_type, expires_at)
            VALUES (?, ?, ?, ?)
        `);
        
        stmt.run(sessionId, kioskId, serviceType, expiresAt);
        
        console.log(`[SessionManager] ✅ Created session: ${sessionId}`);
        
        return this.getSession(sessionId);
    }
    
    /**
     * Get session by ID
     * @param {string} sessionId
     * @returns {Object|null} Session object or null
     */
    getSession(sessionId) {
        const stmt = this.db.prepare('SELECT * FROM sessions WHERE session_id = ?');
        const session = stmt.get(sessionId);
        
        if (session && session.customer_data) {
            session.customer_data = JSON.parse(session.customer_data);
        }
        
        return session;
    }
    
    /**
     * Get session by QR token
     * @param {string} qrToken
     * @returns {Object|null} Session object or null
     */
    getSessionByQrToken(qrToken) {
        const stmt = this.db.prepare('SELECT * FROM sessions WHERE qr_token = ?');
        const session = stmt.get(qrToken);
        
        if (session && session.customer_data) {
            session.customer_data = JSON.parse(session.customer_data);
        }
        
        return session;
    }
    
    /**
     * Get session by QR path
     * @param {string} qrPath
     * @returns {Object|null} Session object or null
     */
    getSessionByQrPath(qrPath) {
        const stmt = this.db.prepare('SELECT * FROM sessions WHERE qr_path = ?');
        const session = stmt.get(qrPath);
        
        if (session && session.customer_data) {
            session.customer_data = JSON.parse(session.customer_data);
        }
        
        return session;
    }
    
    /**
     * Set QR token and path for a session
     * @param {string} sessionId
     * @param {string} qrToken
     * @param {string} qrPath
     */
    setQrPath(sessionId, qrToken, qrPath) {
        const stmt = this.db.prepare(`
            UPDATE sessions 
            SET qr_token = ?, qr_path = ?, updated_at = datetime('now')
            WHERE session_id = ?
        `);
        
        stmt.run(qrToken, qrPath, sessionId);
        console.log(`[SessionManager] QR path set for session: ${sessionId}`);
    }
    
    /**
     * Mark QR as used
     * @param {string} sessionId
     */
    markQrUsed(sessionId) {
        const stmt = this.db.prepare(`
            UPDATE sessions 
            SET qr_used = 1, updated_at = datetime('now')
            WHERE session_id = ?
        `);
        
        stmt.run(sessionId);
    }
    
    /**
     * Attach customer data to session
     * @param {string} sessionId
     * @param {Object} customerData
     */
    attachCustomer(sessionId, customerData) {
        this._validateTransition(sessionId, SESSION_STATES.CUSTOMER_ATTACHED);
        
        const stmt = this.db.prepare(`
            UPDATE sessions 
            SET customer_data = ?, 
                status = ?, 
                updated_at = datetime('now')
            WHERE session_id = ?
        `);
        
        stmt.run(JSON.stringify(customerData), SESSION_STATES.CUSTOMER_ATTACHED, sessionId);
        console.log(`[SessionManager] Customer attached to session: ${sessionId}`);
    }
    
    /**
     * Select service type
     * @param {string} sessionId
     * @param {string} serviceType - 'HEALTH_CHECKUP' or 'MEDICINE'
     */
    selectService(sessionId, serviceType) {
        this._validateTransition(sessionId, SESSION_STATES.SERVICE_SELECTED);
        
        const stmt = this.db.prepare(`
            UPDATE sessions 
            SET service_type = ?, 
                status = ?, 
                updated_at = datetime('now')
            WHERE session_id = ?
        `);
        
        stmt.run(serviceType, SESSION_STATES.SERVICE_SELECTED, sessionId);
        console.log(`[SessionManager] Service selected: ${serviceType} for session: ${sessionId}`);
    }
    
    /**
     * Mark measurements complete (for health checkups)
     * @param {string} sessionId
     */
    markMeasurementsComplete(sessionId) {
        this._validateTransition(sessionId, SESSION_STATES.MEASUREMENTS_COMPLETE);
        
        const stmt = this.db.prepare(`
            UPDATE sessions 
            SET status = ?, 
                updated_at = datetime('now')
            WHERE session_id = ?
        `);
        
        stmt.run(SESSION_STATES.MEASUREMENTS_COMPLETE, sessionId);
        console.log(`[SessionManager] Measurements complete for session: ${sessionId}`);
    }
    
    /**
     * Set payment required
     * @param {string} sessionId
     * @param {number} amount
     */
    setPaymentRequired(sessionId, amount) {
        this._validateTransition(sessionId, SESSION_STATES.PAYMENT_REQUIRED);
        
        const stmt = this.db.prepare(`
            UPDATE sessions 
            SET amount = ?,
                status = ?, 
                payment_status = 'PENDING',
                updated_at = datetime('now')
            WHERE session_id = ?
        `);
        
        stmt.run(amount, SESSION_STATES.PAYMENT_REQUIRED, sessionId);
        console.log(`[SessionManager] Payment required: ₹${amount} for session: ${sessionId}`);
    }
    
    /**
     * Mark payment pending
     * @param {string} sessionId
     * @param {string} paymentId
     */
    markPaymentPending(sessionId, paymentId) {
        this._validateTransition(sessionId, SESSION_STATES.PAYMENT_PENDING);
        
        const stmt = this.db.prepare(`
            UPDATE sessions 
            SET payment_id = ?,
                status = ?, 
                payment_status = 'PENDING',
                updated_at = datetime('now')
            WHERE session_id = ?
        `);
        
        stmt.run(paymentId, SESSION_STATES.PAYMENT_PENDING, sessionId);
        console.log(`[SessionManager] Payment pending for session: ${sessionId}`);
    }
    
    /**
     * Mark payment verified
     * @param {string} sessionId
     * @param {string} paymentId
     */
    markPaymentVerified(sessionId, paymentId) {
        this._validateTransition(sessionId, SESSION_STATES.PAYMENT_VERIFIED);
        
        const stmt = this.db.prepare(`
            UPDATE sessions 
            SET payment_id = ?,
                status = ?, 
                payment_status = 'VERIFIED',
                updated_at = datetime('now')
            WHERE session_id = ?
        `);
        
        stmt.run(paymentId, SESSION_STATES.PAYMENT_VERIFIED, sessionId);
        console.log(`[SessionManager] ✅ Payment verified for session: ${sessionId}`);
    }
    
    /**
     * Mark fulfillment in progress
     * @param {string} sessionId
     */
    markFulfillment(sessionId) {
        this._validateTransition(sessionId, SESSION_STATES.FULFILLMENT);
        
        const stmt = this.db.prepare(`
            UPDATE sessions 
            SET status = ?, 
                updated_at = datetime('now')
            WHERE session_id = ?
        `);
        
        stmt.run(SESSION_STATES.FULFILLMENT, sessionId);
        console.log(`[SessionManager] Fulfillment started for session: ${sessionId}`);
    }
    
    /**
     * Mark session completed
     * @param {string} sessionId
     */
    markCompleted(sessionId) {
        this._validateTransition(sessionId, SESSION_STATES.COMPLETED);
        
        const stmt = this.db.prepare(`
            UPDATE sessions 
            SET status = ?, 
                updated_at = datetime('now')
            WHERE session_id = ?
        `);
        
        stmt.run(SESSION_STATES.COMPLETED, sessionId);
        console.log(`[SessionManager] ✅ Session completed: ${sessionId}`);
    }
    
    /**
     * Update report status
     * @param {string} sessionId
     * @param {string} status - 'GENERATING', 'READY', 'EMAILED'
     */
    updateReportStatus(sessionId, status) {
        const stmt = this.db.prepare(`
            UPDATE sessions 
            SET report_status = ?, 
                updated_at = datetime('now')
            WHERE session_id = ?
        `);
        
        stmt.run(status, sessionId);
    }
    
    /**
     * Update receipt status
     * @param {string} sessionId
     * @param {string} status - 'GENERATING', 'READY', 'EMAILED'
     */
    updateReceiptStatus(sessionId, status) {
        const stmt = this.db.prepare(`
            UPDATE sessions 
            SET receipt_status = ?, 
                updated_at = datetime('now')
            WHERE session_id = ?
        `);
        
        stmt.run(status, sessionId);
    }
    
    /**
     * Update dispense status
     * @param {string} sessionId
     * @param {string} status - 'PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED'
     */
    updateDispenseStatus(sessionId, status) {
        const stmt = this.db.prepare(`
            UPDATE sessions 
            SET dispense_status = ?, 
                updated_at = datetime('now')
            WHERE session_id = ?
        `);
        
        stmt.run(status, sessionId);
    }
    
    /**
     * Set pairing token for session (ONE-QR pairing)
     * @param {string} sessionId
     * @param {string} pairingToken
     */
    setPairingToken(sessionId, pairingToken) {
        const stmt = this.db.prepare(`
            UPDATE sessions 
            SET pairing_token = ?, updated_at = datetime('now')
            WHERE session_id = ?
        `);
        
        stmt.run(pairingToken, sessionId);
        console.log(`[SessionManager] Pairing token set for session: ${sessionId}`);
    }
    
    /**
     * Get session by pairing token
     * @param {string} pairingToken
     * @returns {Object|null} Session object or null
     */
    getSessionByPairingToken(pairingToken) {
        const stmt = this.db.prepare('SELECT * FROM sessions WHERE pairing_token = ?');
        const session = stmt.get(pairingToken);
        
        if (session && session.customer_data) {
            session.customer_data = JSON.parse(session.customer_data);
        }
        
        return session;
    }
    
    /**
     * Verify pairing token WITHOUT consuming it
     * Use this before RSA verification to avoid burning the token on invalid requests
     * @param {string} sessionId
     * @param {string} pairingToken
     * @throws {Error} If token invalid or already used
     * @returns {boolean} True if valid
     */
    verifyPairingToken(sessionId, pairingToken) {
        const session = this.getSession(sessionId);
        
        if (!session) {
            throw new Error('Session not found');
        }
        
        if (!session.pairing_token) {
            throw new Error('No pairing token set for this session');
        }
        
        if (session.pairing_token !== pairingToken) {
            throw new Error('Invalid pairing token');
        }
        
        if (session.pairing_used) {
            throw new Error('Pairing token already used');
        }
        
        return true;
    }
    
    /**
     * Verify and consume pairing token (one-time use)
     * IMPORTANT: Only call this AFTER all security checks (RSA, nonce, amount) have passed
     * @param {string} sessionId
     * @param {string} pairingToken
     * @throws {Error} If token invalid or already used
     */
    consumePairingToken(sessionId, pairingToken) {
        const session = this.getSession(sessionId);
        
        if (!session) {
            throw new Error('Session not found');
        }
        
        if (session.pairing_token !== pairingToken) {
            throw new Error('Invalid pairing token');
        }
        
        if (session.pairing_used) {
            throw new Error('Pairing token already used');
        }
        
        // Mark as used (prevents replay)
        const stmt = this.db.prepare(`
            UPDATE sessions 
            SET pairing_used = 1, updated_at = datetime('now')
            WHERE session_id = ?
        `);
        
        stmt.run(sessionId);
        console.log(`[SessionManager] ✅ Pairing token consumed for session: ${sessionId}`);
        
        return true;
    }
    
    /**
     * Update a specific session field (generic update)
     * @param {string} sessionId
     * @param {string} fieldName
     * @param {any} value
     */
    updateSessionField(sessionId, fieldName, value) {
        // Whitelist of allowed fields to prevent SQL injection
        const allowedFields = [
            'report_status', 'receipt_status', 'dispense_status',
            'payment_status', 'status', 'qr_path', 'qr_token', 'pairing_token'
        ];
        
        if (!allowedFields.includes(fieldName)) {
            throw new Error(`Invalid field name: ${fieldName}`);
        }
        
        const stmt = this.db.prepare(`
            UPDATE sessions 
            SET ${fieldName} = ?, 
                updated_at = datetime('now')
            WHERE session_id = ?
        `);
        
        stmt.run(value, sessionId);
    }
    
    /**
     * Expire old sessions
     * @returns {number} Number of expired sessions
     */
    expireOldSessions() {
        const stmt = this.db.prepare(`
            UPDATE sessions 
            SET status = 'COMPLETED'
            WHERE expires_at < datetime('now') 
            AND status NOT IN ('COMPLETED', 'PAYMENT_VERIFIED', 'FULFILLMENT')
        `);
        
        const result = stmt.run();
        
        if (result.changes > 0) {
            console.log(`[SessionManager] Expired ${result.changes} old session(s)`);
        }
        
        return result.changes;
    }
    
    /**
     * Validate state transition
     * @private
     * @param {string} sessionId
     * @param {string} newState
     * @throws {Error} If transition is invalid
     */
    _validateTransition(sessionId, newState) {
        const session = this.getSession(sessionId);
        
        if (!session) {
            throw new Error(`Session not found: ${sessionId}`);
        }
        
        // Check if session expired
        if (new Date(session.expires_at) < new Date()) {
            throw new Error(`Session expired: ${sessionId}`);
        }
        
        const currentState = session.status;
        const validNextStates = VALID_TRANSITIONS[currentState] || [];
        
        if (!validNextStates.includes(newState)) {
            throw new Error(
                `Invalid state transition: ${currentState} → ${newState} for session ${sessionId}`
            );
        }
    }
}

// ───────────────────────────────────────────────────────────────────────────
// Export singleton instance
// ───────────────────────────────────────────────────────────────────────────
const sessionManager = new SessionManager();
export default sessionManager;
export { SESSION_STATES };
