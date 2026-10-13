import { randomUUID, timingSafeEqual } from 'node:crypto';

export function initializeSupport(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS support_cases (
    case_id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE REFERENCES sessions(session_id),
    kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'OPEN',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), evidence_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS support_notes (
    note_id INTEGER PRIMARY KEY AUTOINCREMENT, case_id TEXT NOT NULL REFERENCES support_cases(case_id),
    actor TEXT NOT NULL, status TEXT NOT NULL, note TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')));`);
}
const parse = value => { try { return JSON.parse(value); } catch { return null; } };
const fail = (status, message) => Object.assign(new Error(message), {status});

export function supportEvidence(db, sessionId) {
  const session = db.prepare(`SELECT session_id,kiosk_id,service_type,payment_status,report_status,
    dispense_status,created_at,updated_at FROM sessions WHERE session_id=?`).get(sessionId);
  if (!session) throw fail(404, 'Order reference not found on this kiosk.');
  const payments = db.prepare(`SELECT transaction_id,amount,status,verified_at,provider_payment_id,
    provider_order_id,cart,created_at FROM transactions WHERE session_id=? ORDER BY created_at`).all(sessionId)
    .map(t=>({...t,cart:parse(t.cart)}));
  const requests = db.prepare(`SELECT request_id,transaction_id,status,created_at,verified_at,consumed_at
    FROM payment_v2_requests WHERE session_id=? ORDER BY created_at`).all(sessionId);
  const jobs = db.prepare(`SELECT j.*,i.name AS item_name,i.quantity AS recorded_stock_now
    FROM fulfillment_jobs j LEFT JOIN inventory i ON i.kit_id=j.kit_id
    WHERE j.session_id=? ORDER BY j.created_at`).all(sessionId)
    .map(j=>({...j,mqtt_payload:parse(j.mqtt_payload),esp32_ack_payload:parse(j.esp32_ack_payload)}));
  const reports = db.prepare(`SELECT report_id,status,created_at,emailed_at FROM reports WHERE session_id=?`).all(sessionId);
  const restarts = db.prepare(`SELECT created_at FROM audit_log WHERE event_type='SUPPORT_BACKEND_START'
    AND created_at>=? ORDER BY log_id DESC LIMIT 30`).all(session.created_at);
  const failures=db.prepare("SELECT event_type,details,error_message,created_at FROM audit_log WHERE session_id=? AND event_type IN ('SUPPORT_JOB_FAILED','SUPPORT_REPORT_FAILED') ORDER BY log_id DESC LIMIT 100").all(sessionId);
  return {session,payments,requests,jobs,reports,restarts,failures,
    limitations:'A device acknowledgement, motor rotation, stock counter or generated report is not proof the customer received it. A restart does not prove a power cut. No independent collection evidence is available. Check the tray, stock, wiring and receipt before deciding.'};
}

export function createSupportCase(db, sessionId, token) {
  // Expired/consumed payment sessions can still report a problem, but require their original secret.
  const session = db.prepare('SELECT pairing_token,service_type FROM sessions WHERE session_id=?').get(sessionId);
  if (!session || typeof token!=='string' || !/^[a-f0-9]{64}$/i.test(token) ||
      typeof session.pairing_token!=='string' || Buffer.byteLength(session.pairing_token)!==64 ||
      !timingSafeEqual(Buffer.from(token),Buffer.from(session.pairing_token))) throw fail(403,'This kiosk session cannot file the request. Contact support with your receipt.');
  if (!['MEDICINE','HEALTH_CHECKUP'].includes(session.service_type)) throw fail(400,'Choose your service first.');
  return openSupportCase(db,sessionId,session.service_type);
}

export function openSupportCase(db,sessionId,kind) {
  return db.transaction(()=>{
    let row = db.prepare('SELECT case_id,status,created_at FROM support_cases WHERE session_id=?').get(sessionId);
    if (!row) {
      const id = `HELP-${randomUUID().toUpperCase()}`;
      db.prepare('INSERT INTO support_cases(case_id,session_id,kind,evidence_json) VALUES(?,?,?,?)')
        .run(id,sessionId,kind,JSON.stringify(supportEvidence(db,sessionId)));
      row=db.prepare('SELECT case_id,status,created_at FROM support_cases WHERE case_id=?').get(id);
    }
    return row;
  })();
}

export function registerSupportRoutes(app,{getDb,requireAdmin}) {
  const wrap = fn => (req,res) => {
    res.set('Cache-Control','private, no-store');
    try { const db=getDb(); initializeSupport(db); res.json({ok:true,...fn(db,req)}); }
    catch(e) { res.status(e.status||503).json({ok:false,error:e.status?e.message:'Support records unavailable. Keep your receipt and contact staff.'}); }
  };
  app.post('/api/sessions/:sessionId/support',wrap((db,req)=>({case:createSupportCase(db,req.params.sessionId,req.body?.pairingToken)})));
  app.post('/api/admin/support',requireAdmin,wrap((db,req)=>{
    const sessionId=req.body?.sessionId;
    if(typeof sessionId!=='string'||sessionId.length>120)throw fail(400,'Enter the session reference.');
    const session=supportEvidence(db,sessionId).session;
    if(!['MEDICINE','HEALTH_CHECKUP'].includes(session.service_type))throw fail(400,'No service selected for this session.');
    return {case:openSupportCase(db,sessionId,session.service_type)};
  }));
  app.get('/api/admin/support',requireAdmin,wrap((db,req)=>{
    const reference=String(req.query.reference||'').trim();
    if (!reference) return {cases:db.prepare(`SELECT c.case_id,c.session_id,c.kind,c.status,c.created_at,s.kiosk_id
      FROM support_cases c JOIN sessions s ON s.session_id=c.session_id ORDER BY c.created_at DESC LIMIT 100`).all()};
    if(reference.length>120) throw fail(400,'Reference is too long.');
    const found=db.prepare(`SELECT session_id FROM support_cases WHERE case_id=?
      UNION SELECT session_id FROM sessions WHERE session_id=?
      UNION SELECT session_id FROM transactions WHERE transaction_id=? OR provider_payment_id=? OR provider_order_id=?
      UNION SELECT session_id FROM payment_v2_requests WHERE request_id=?`).all(...Array(6).fill(reference));
    if(found.length!==1) throw fail(404,'No unique order found. Check the reference and that this is the correct kiosk.');
    const sessionId=found[0].session_id;
    const complaint=db.prepare('SELECT * FROM support_cases WHERE session_id=?').get(sessionId);
    return {evidence:supportEvidence(db,sessionId),complaint:complaint?{...complaint,evidence_json:parse(complaint.evidence_json)}:null,
      notes:complaint?db.prepare('SELECT * FROM support_notes WHERE case_id=? ORDER BY note_id').all(complaint.case_id):[]};
  }));
  app.post('/api/admin/support/:caseId/notes',requireAdmin,wrap((db,req)=>{
    const {status,note}=req.body||{};
    if(!['OPEN','INVESTIGATING','RESOLVED'].includes(status)||typeof note!=='string'||note.trim().length<5||note.length>1500)
      throw fail(400,'Choose a status and enter a review note (5–1500 characters).');
    db.transaction(()=>{
      const record=db.prepare('SELECT * FROM support_cases WHERE case_id=?').get(req.params.caseId);
      if(!record) throw fail(404,'Support case not found.');
      const previous=db.prepare('SELECT * FROM support_notes WHERE case_id=? ORDER BY note_id DESC LIMIT 1').get(record.case_id);
      if(previous?.status===status&&previous?.note===note.trim()&&previous?.actor===req.admin.email)return;
      db.prepare('INSERT INTO support_notes(case_id,actor,status,note) VALUES(?,?,?,?)').run(record.case_id,req.admin.email,status,note.trim());
      db.prepare('UPDATE support_cases SET status=? WHERE case_id=?').run(status,record.case_id);
    })();
    return {};
  }));
}
