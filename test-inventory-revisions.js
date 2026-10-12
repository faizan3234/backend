import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {initInventoryRevisions,recordStockRelay} from './src/services/inventoryRevision.js';
import {lowStockSnapshot} from './src/services/lowStockSnapshot.js';
const fixture=()=>{const db=new Database(':memory:');db.exec("CREATE TABLE inventory(kit_id TEXT PRIMARY KEY,name TEXT,quantity INTEGER,price REAL,updated_at TEXT); INSERT INTO inventory VALUES ('a','A',1,10,'same-second');");initInventoryRevisions(db);return db;};
test('rapid restock, clock rollback, restart and delete/reinsert keep increasing revisions',()=>{
 const db=fixture();const first=lowStockSnapshot(db,100)[0].revision;
 db.exec("UPDATE inventory SET quantity=100; UPDATE inventory SET quantity=1,updated_at='old-time';");
 assert.equal(first,'r1');assert.equal(lowStockSnapshot(db,1)[0].revision,'r3');
 initInventoryRevisions(db); assert.equal(lowStockSnapshot(db,1)[0].revision,'r3');
 db.exec("DELETE FROM inventory; INSERT INTO inventory VALUES ('a','A',1,10,'old-time');");
 assert.equal(lowStockSnapshot(db,1)[0].revision,'r5');db.close();
});
test('only carried items move back in relay order; trimmed items get a later chance',()=>{
 const db=fixture();for(let i=0;i<10;i++)db.prepare('INSERT INTO inventory VALUES (?,?,1,10,?)').run(`b${i}`,`B${i}`,'same');
 const first=lowStockSnapshot(db,1);recordStockRelay(db,first.slice(0,2));
 const second=lowStockSnapshot(db,1);assert.equal(second[0].id,first[2].id);
 assert(!second.some(item=>item.id===first[0].id));
 db.exec("UPDATE inventory SET quantity=0 WHERE kit_id='a'");assert.equal(lowStockSnapshot(db,1)[0].id,'a');db.close();
});
