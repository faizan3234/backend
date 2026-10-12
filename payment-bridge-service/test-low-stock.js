import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initPaymentV2Schema } from './paymentV2Db.js';
import { validateLowStock, sendLowStockAlerts } from './services/lowStockAlerts.js';
import { createStockAlertWorker, processStockAlertRequest } from './services/stockAlertWorker.js';
import { lowStockSnapshot } from '../src/services/lowStockSnapshot.js';

const item = { id:'MED-1',name:'Medicine A',quantity:2,unitPricePaise:1234,revision:'2026-10-11 12:00:00',observedAt:1791720000000 };
function fixture() {
    const db=new Database(':memory:'); initPaymentV2Schema(db);
    db.prepare(`INSERT INTO payment_v2_orders(order_id,request_id,request_nonce,payload_fingerprint,session_id,transaction_id,kiosk_id,amount,service_type,encrypted_code,status,razorpay_payment_id,created_at,expires_at,low_stock_json)
        VALUES ('o','r','n','f','s','t','k',1700,'HEALTH_CHECKUP','x','PAID','pay',1,2,?)`).run(JSON.stringify([item]));
    db.prepare('UPDATE payment_v2_orders SET created_at=?').run(Date.now());
    return db;
}
test('snapshot uses physical stock and excludes healthy inventory', () => {
    const db=new Database(':memory:');
    assert.deepEqual(lowStockSnapshot(db,123),[]);
    db.exec(`CREATE TABLE inventory(kit_id TEXT,name TEXT,quantity INTEGER,price REAL,updated_at TEXT);
        INSERT INTO inventory VALUES ('a','A',2,12.34,'rev'),('b','B',1,2,'rev'),('c','C',100,3,'rev'),('d','D',0,4,'rev');`);
    const stock=lowStockSnapshot(db,123);
    assert.deepEqual(stock.map(s=>s.quantity),[0,1,2]);
    assert.equal(stock[2].unitPricePaise,1234);
    assert.equal(stock[2].observedAt,123); db.close();
});
test('paid relay sends internal mail once across retries; qty1 creates next alert', async () => {
    const db=fixture(), sent=[];
    const transporter={sendMail:async message=>{sent.push(message); return {};}};
    await Promise.all([sendLowStockAlerts({db,requestId:'r',transporter}),sendLowStockAlerts({db,requestId:'r',transporter})]);
    await sendLowStockAlerts({db,requestId:'r',transporter});
    assert.equal(sent.length,1);
    assert.equal(sent[0].to,'khanfaizan3234@gmail.com');
    assert.match(sent[0].from,/relivcustomercare.in@gmail.com/);
    assert.match(sent[0].text,/12.34/); assert.match(sent[0].text,/before this customer's order was dispensed/);
    db.prepare('UPDATE payment_v2_orders SET low_stock_json=?').run(JSON.stringify([{...item,quantity:1}]));
    await sendLowStockAlerts({db,requestId:'r',transporter}); assert.equal(sent.length,2);
    db.prepare("UPDATE payment_v2_orders SET status='CREATED',low_stock_json=?").run(JSON.stringify([{...item,quantity:0}]));
    await sendLowStockAlerts({db,requestId:'r',transporter}); assert.equal(sent.length,2); db.close();
});
test('failed SMTP is retryable after cooldown, sent alerts persist across schema initialization', async () => {
    const db=fixture();
    await assert.rejects(sendLowStockAlerts({db,requestId:'r',transporter:{sendMail:async()=>{throw Object.assign(new Error('offline'),{code:'ECONNECTION'});}}}));
    assert.equal(db.prepare('SELECT status FROM low_stock_alerts').get().status,'FAILED');
    db.exec('UPDATE low_stock_alerts SET updated_at=0');
    let sent=0; const transporter={sendMail:async()=>{sent++;}};
    await sendLowStockAlerts({db,requestId:'r',transporter});
    initPaymentV2Schema(db); await sendLowStockAlerts({db,requestId:'r',transporter});
    assert.equal(sent,1); db.close();
});
test('reject invalid telemetry, allow legacy QRs without it', () => {
    assert.deepEqual(validateLowStock(undefined),[]);
    for(const invalid of [{...item,quantity:100},{...item,unitPricePaise:-1},{...item,observedAt:'now'}]) assert.throws(()=>validateLowStock([invalid]));
});

test('worker sends without customer email and resumes durable paid orders after restart', async () => {
    const db=fixture(); let sent=0;
    const transporter={sendMail:async()=>{sent++;return {accepted:['admin']};}};
    const first=createStockAlertWorker({db,transporter});
    await Promise.all([first.runOnce(),first.runOnce()]); await first.stop();
    const restarted=createStockAlertWorker({db,transporter}); await restarted.runOnce();
    assert.equal(sent,1); assert.equal(db.prepare('SELECT status FROM low_stock_dispatch').get().status,'DONE');
    await restarted.stop(); db.close();
});
test('worker retries known failure with no further phone request', async () => {
    const db=fixture(); let attempts=0;
    const transporter={sendMail:async()=>{ if(++attempts===1) throw Object.assign(new Error('offline'),{code:'ECONNECTION'}); return {}; }};
    const worker=createStockAlertWorker({db,transporter}); await worker.runOnce();
    assert.equal(db.prepare('SELECT status FROM low_stock_dispatch').get().status,'RETRY');
    db.exec('UPDATE low_stock_dispatch SET next_attempt_at=0; UPDATE low_stock_alerts SET updated_at=0;');
    await worker.runOnce(); assert.equal(attempts,2);
    assert.equal(db.prepare('SELECT status FROM low_stock_dispatch').get().status,'DONE');
    await worker.stop(); db.close();
});
test('ambiguous SMTP timeout goes to review instead of duplicate mail', async () => {
    const db=fixture(); let attempts=0;
    const transporter={sendMail:async()=>{ attempts++; throw Object.assign(new Error('ack lost'),{code:'ETIMEDOUT'}); }};
    await processStockAlertRequest({db,requestId:'r',transporter});
    assert.equal(db.prepare('SELECT status FROM low_stock_alerts').get().status,'UNKNOWN');
    db.exec('UPDATE low_stock_dispatch SET next_attempt_at=0');
    await processStockAlertRequest({db,requestId:'r',transporter});
    assert.equal(attempts,1); assert.equal(db.prepare('SELECT status FROM low_stock_dispatch').get().status,'REVIEW'); db.close();
});
test('worker recovers an interrupted claim without blindly replaying SMTP', async () => {
    const db=fixture();
    await sendLowStockAlerts({db,requestId:'r',transporter:{sendMail:async()=>({})}});
    db.exec("UPDATE low_stock_alerts SET status='SENDING',updated_at=0; INSERT INTO low_stock_dispatch(request_id,status,next_attempt_at) VALUES ('r','WORKING',0)");
    let sends=0; const worker=createStockAlertWorker({db,transporter:{sendMail:async()=>{sends++;}}});
    await worker.runOnce(); assert.equal(sends,0);
    assert.equal(db.prepare('SELECT status FROM low_stock_dispatch').get().status,'REVIEW'); await worker.stop(); db.close();
});
test('unpaid, old and superseded inventory cannot generate current alerts', async () => {
    const db=fixture(); let sends=0; const transporter={sendMail:async()=>{sends++;}};
    db.exec("UPDATE payment_v2_orders SET status='CREATED'");
    await processStockAlertRequest({db,requestId:'r',transporter}); assert.equal(sends,0);
    db.exec("UPDATE payment_v2_orders SET status='PAID',created_at=1");
    await processStockAlertRequest({db,requestId:'r',transporter}); assert.equal(sends,0);
    assert.equal(db.prepare('SELECT status FROM low_stock_dispatch').get().status,'EXPIRED');
    db.exec('DELETE FROM low_stock_dispatch');
    db.prepare('UPDATE payment_v2_orders SET created_at=?').run(Date.now());
    db.prepare(`INSERT INTO payment_v2_orders(order_id,request_id,request_nonce,payload_fingerprint,session_id,transaction_id,kiosk_id,amount,service_type,encrypted_code,status,razorpay_payment_id,created_at,expires_at,low_stock_json)
        VALUES ('o2','r2','n2','f2','s2','t2','k',1700,'HEALTH_CHECKUP','x','PAID','pay2',?,2,?)`)
        .run(Date.now(),JSON.stringify([{...item,quantity:1,observedAt:item.observedAt+1}]));
    await processStockAlertRequest({db,requestId:'r',transporter}); assert.equal(sends,0); db.close();
});
test('rejected recipient is a failed delivery, not SENT', async () => {
    const db=fixture();
    await assert.rejects(sendLowStockAlerts({db,requestId:'r',transporter:{sendMail:async()=>({accepted:[],rejected:['admin']})}}));
    assert.equal(db.prepare('SELECT status FROM low_stock_alerts').get().status,'FAILED'); db.close();
});
test('out of range timestamps are rejected before formatting', () => {
    assert.throws(()=>validateLowStock([{...item,observedAt:Number.MAX_SAFE_INTEGER}]));
});

test('new numeric inventory revision supersedes old stock even if Pi clock rolls back', async () => {
    const db=fixture();
    db.prepare('UPDATE payment_v2_orders SET low_stock_json=?').run(JSON.stringify([{...item,revision:'r2',observedAt:1000}]));
    db.prepare(`INSERT INTO payment_v2_orders(order_id,request_id,request_nonce,payload_fingerprint,session_id,transaction_id,kiosk_id,amount,service_type,encrypted_code,status,razorpay_payment_id,created_at,expires_at,low_stock_json)
        VALUES ('o3','r3','n3','f3','s3','t3','k',1700,'MEDICINE','x','PAID','pay3',?,2,?)`)
        .run(Date.now(),JSON.stringify([{...item,revision:'r3',quantity:1,observedAt:500}]));
    let sends=0;const transporter={sendMail:async()=>{sends++;return {};}};
    await sendLowStockAlerts({db,requestId:'r',transporter});assert.equal(sends,0);
    await sendLowStockAlerts({db,requestId:'r3',transporter});assert.equal(sends,1);db.close();
});
test('repeated known failures back off while remaining visible', async () => {
    const db=fixture();const transporter={sendMail:async()=>{throw Object.assign(new Error('quota'),{responseCode:421});}};
    for(let attempt=1;attempt<=3;attempt++) {
        db.exec('UPDATE low_stock_dispatch SET next_attempt_at=0; UPDATE low_stock_alerts SET updated_at=0;');
        const before=Date.now();await processStockAlertRequest({db,requestId:'r',transporter});
        const state=db.prepare('SELECT * FROM low_stock_dispatch').get();
        assert.equal(state.status,'RETRY');assert.equal(state.attempts,attempt);
        assert.ok(state.next_attempt_at-before >= 60000*2**(attempt-1));
    }
    db.close();
});
