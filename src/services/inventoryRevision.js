// Persistent per-item revisions do not depend on Pi wall-clock time.
export function initInventoryRevisions(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS inventory_revisions (
        kit_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, relay_seq INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO inventory_revisions(kit_id,revision) SELECT kit_id,1 FROM inventory;
    CREATE TRIGGER IF NOT EXISTS inventory_revision_insert AFTER INSERT ON inventory BEGIN
        INSERT INTO inventory_revisions(kit_id,revision) VALUES (NEW.kit_id,1)
        ON CONFLICT(kit_id) DO UPDATE SET revision=revision+1,relay_seq=0;
    END;
    CREATE TRIGGER IF NOT EXISTS inventory_revision_update AFTER UPDATE OF quantity,price,name ON inventory
    WHEN OLD.quantity IS NOT NEW.quantity OR OLD.price IS NOT NEW.price OR OLD.name IS NOT NEW.name BEGIN
        UPDATE inventory_revisions SET revision=revision+1,relay_seq=0 WHERE kit_id=NEW.kit_id;
    END;
    CREATE TRIGGER IF NOT EXISTS inventory_revision_delete AFTER DELETE ON inventory BEGIN
        UPDATE inventory_revisions SET revision=revision+1,relay_seq=0 WHERE kit_id=OLD.kit_id;
    END;`);
}

export function recordStockRelay(db, items = []) {
    if (!items.length || !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='inventory_revisions'").get()) return;
    db.transaction(() => {
        const seq = db.prepare('SELECT COALESCE(MAX(relay_seq),0)+1 AS seq FROM inventory_revisions').get().seq;
        const update = db.prepare('UPDATE inventory_revisions SET relay_seq=? WHERE kit_id=? AND revision=?');
        for (const item of items) if (/^r\d+$/.test(item.revision)) update.run(seq,item.id,Number(item.revision.slice(1)));
    })();
}
