import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initPaymentV2Schema } from './paymentV2Db.js';
import { validateLowStock, sendLowStockAlerts } from './services/lowStockAlerts.js';
import { lowStockSnapshot } from '../src/services/lowStockSnapshot.js';

const item = { id:'MED-1',name:'Medicine A',quantity:2,unitPricePaise:1234,revision:'2026-10-11 12:00:00',observedAt:1791720000000 };
function fixture() {
    const db=new Database(':memory:'); initPaymentV2Schema(db);
    db.prepare(`INSERT INTO payment_v2_orders(order_id,request_id,request_nonce,payload_fingerprint,session_id,transaction_id,kiosk_id,amount,service_type,encrypted_code,status,razorpay_payment_id,created_at,expires_at,low_stock_json)
        VALUES ('o','r','n','f','s','t','k',1700,'HEALTH_CHECKUP','x','PAID','pay',1,2,?)`).run(JSON.stringify([item]));
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
    assert.match(sent[0].text,/12.34/); assert.match(sent[0].text,/predates dispensing/);
    db.prepare('UPDATE payment_v2_orders SET low_stock_json=?').run(JSON.stringify([{...item,quantity:1}]));
    await sendLowStockAlerts({db,requestId:'r',transporter}); assert.equal(sent.length,2);
    db.prepare("UPDATE payment_v2_orders SET status='CREATED',low_stock_json=?").run(JSON.stringify([{...item,quantity:0}]));
    await sendLowStockAlerts({db,requestId:'r',transporter}); assert.equal(sent.length,2); db.close();
});
test('failed SMTP is retryable after cooldown, sent alerts persist across schema initialization', async () => {
    const db=fixture();
    await assert.rejects(sendLowStockAlerts({db,requestId:'r',transporter:{sendMail:async()=>{throw new Error('offline');}}}));
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
