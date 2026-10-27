import {randomUUID} from 'node:crypto';
const bad=message=>Object.assign(new Error(message),{status:400});
function text(value,max) {
    if(value==null)return '';
    if(typeof value!=='string'||value.length>max)throw bad('Feedback text is too long or invalid.');
    return value.trim();
}
function initialize(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS kiosk_feedback (id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), payload TEXT NOT NULL)`);
}
export function saveFeedback(db,input) {
    if(!input||typeof input!=='object')throw bad('Invalid feedback.');
    const id=input.feedbackId??randomUUID();
    if(typeof id!=='string'||!/^[a-zA-Z0-9_-]{8,100}$/.test(id))throw bad('Invalid feedback reference.');
    if(![1,2,3,4,5,6].includes(input.mood))throw bad('Choose a rating first.');
    const positives=input.positives??[];
    if(!Array.isArray(positives)||positives.length>6)throw bad('Invalid feedback choices.');
    const payload={name:text(input.name,120),role:text(input.role,80),stream:text(input.stream,80),mood:input.mood,
        positives:positives.map(v=>text(v,100)),comment:text(input.comment,2000)};
    if(input.collaboration!=null)payload.collaboration={email:text(input.collaboration.email,254),phone:text(input.collaboration.phone,40)};
    initialize(db);
    const saved=db.prepare('INSERT OR IGNORE INTO kiosk_feedback(id,payload) VALUES(?,?)').run(id,JSON.stringify(payload));
    return {id,created:saved.changes===1,payload:JSON.parse(db.prepare('SELECT payload FROM kiosk_feedback WHERE id=?').get(id).payload)};
}
export function listFeedback(db,before=Number.MAX_SAFE_INTEGER) {
    initialize(db);
    if(!Number.isSafeInteger(before)||before<1)throw bad('Invalid feedback page.');
    return db.prepare('SELECT rowid AS cursor,id,created_at,payload FROM kiosk_feedback WHERE rowid < ? ORDER BY rowid DESC LIMIT 50').all(before)
        .map(row=>({...row,payload:JSON.parse(row.payload)}));
}
