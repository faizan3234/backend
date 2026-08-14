// Add sample inventory data for testing
import Database from 'better-sqlite3';

const db = new Database('./data/kiosk.db');

console.log('Adding sample inventory...');

const stmt = db.prepare(`
    INSERT OR REPLACE INTO inventory (
        kit_id, name, description, 
        price, quantity, motor_id,
        updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
`);

// Add 3 sample medicines (prices in paise)
stmt.run('KIT-ASPIRIN', 'Aspirin 500mg', 'Pain relief', 50.00, 100, 1);
stmt.run('KIT-PARACETAMOL', 'Paracetamol 650mg', 'Fever & pain relief', 30.00, 150, 2);
stmt.run('KIT-VITAMIND', 'Vitamin D 2000IU', 'Vitamin supplement', 150.00, 50, 3);

console.log('✅ Added 3 medicines to inventory');

// Verify
const medicines = db.prepare('SELECT kit_id, name, price, quantity FROM inventory').all();
console.log('\nInventory:');
medicines.forEach(m => {
    console.log(`  - ${m.name}: ₹${m.price} (stock: ${m.quantity})`);
});

db.close();
console.log('\n✅ Sample data loaded successfully');
