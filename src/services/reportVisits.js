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

// Ordinal of this visit, not the number of emails or records retained in a chart.
// This also works while the current paid report is still being generated.
export function getLocalReportScanNumber(db, sessionId, customer = {}) {
    const table=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='health_profile_sessions'").get();
    const link=table ? db.prepare('SELECT profile_id FROM health_profile_sessions WHERE session_id=?').get(sessionId) : null;
    if (!link) return getReportVisitSummary(db,sessionId,customer).scanCount;
    const row=db.prepare(`SELECT COUNT(*) AS total FROM sessions s JOIN health_profile_sessions p ON p.session_id=s.session_id
        WHERE p.profile_id=? AND s.rowid<(SELECT rowid FROM sessions WHERE session_id=?)
        AND s.service_type='HEALTH_CHECKUP' AND s.payment_status='VERIFIED' AND s.report_status IN ('READY','EMAILED')
        AND s.health_data IS NOT NULL`).get(link.profile_id,sessionId);
    return Number(row.total)+1;
}
