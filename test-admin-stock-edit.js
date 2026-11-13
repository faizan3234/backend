import test from 'node:test';
import assert from 'node:assert/strict';
import { assertExpectedStock, medicinePrice, medicineText } from './src/services/inventoryGuards.js';

test('stale absolute stock edits cannot undo a sale or a restock', () => {
    for (const quantity of [0,2]) {
        assert.throws(() => assertExpectedStock({quantity}, 1), error => error.status === 409);
    }
    assert.throws(() => assertExpectedStock({quantity:1}, undefined), error => error.status === 428);
    assert.doesNotThrow(() => assertExpectedStock({quantity:1}, 1));
    assert.doesNotThrow(() => assertExpectedStock({quantity:0}, 0));
});
test('admin rejects blank/object names and invalid prices instead of saving broken inventory', () => {
    for (const name of ['', '   ', {}, null, 'x'.repeat(101)]) assert.throws(() => medicineText(name,'Name',100));
    assert.equal(medicineText(' Paracetamol ','Name',100),'Paracetamol');
    for (const price of [null, true, {}, '', ' ', Infinity, -1, 1e300]) assert.throws(() => medicinePrice(price));
    assert.equal(medicinePrice('32.50'),32.5);
});
