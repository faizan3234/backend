// Count local completed paid sessions, not reloads, page changes or cloud sync.
// Email links visit counts only: it is not proof of identity and must never
// authorize disclosure of earlier health readings.
export function getReportVisitSummary(db, sessionId, customer) {
    const email = typeof customer?.email === 'string' ? customer.email.trim().toLowerCase() : '';
    if (!email) return { scanCount: 1, identityLinked: false };
    const current = db.prepare('SELECT rowid AS sequence FROM sessions WHERE session_id = ?').get(sessionId);
    if (!current) return { scanCount: 1, identityLinked: true };
    const { count } = db.prepare(`
        SELECT COUNT(*) AS count FROM sessions
        WHERE rowid <= ? AND service_type = 'HEALTH_CHECKUP'
          AND payment_status = 'VERIFIED' AND report_status IN ('READY', 'EMAILED')
          AND lower(trim(json_extract(CASE WHEN json_valid(customer_data) THEN customer_data ELSE '{}' END, '$.email'))) = ?
    `).get(current.sequence, email);
    return { scanCount: Math.max(1, count), identityLinked: true };
}
