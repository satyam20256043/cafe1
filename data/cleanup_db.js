// Run this from your project root: node data/cleanup_db.js
// Removes all Coffee House Jayanagar test branches from the SQLite DB

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'cafe_hq.db');
if (!fs.existsSync(DB_PATH)) {
  console.log('No cafe_hq.db found — nothing to clean');
  process.exit(0);
}

const db = new Database(DB_PATH);

// Show what's there
const before = db.prepare('SELECT id, name FROM businesses').all();
console.log('\nBefore cleanup:');
before.forEach(b => console.log('  ', b.id, '—', b.name));

// Delete all junk branches (keep only indiranagar + koramangala)
const keepIds = ['indiranagar', 'koramangala'];
const junk = before.filter(b => !keepIds.includes(b.id));

if (!junk.length) {
  console.log('\n✓ DB already clean, nothing to remove');
  db.close();
  process.exit(0);
}

const deleteTx = db.transaction(() => {
  junk.forEach(b => {
    db.prepare('DELETE FROM menu_items    WHERE business_id=?').run(b.id);
    db.prepare('DELETE FROM customers     WHERE business_id=?').run(b.id);
    db.prepare('DELETE FROM reservations  WHERE business_id=?').run(b.id);
    db.prepare('DELETE FROM feedback      WHERE business_id=?').run(b.id);
    db.prepare('DELETE FROM orders        WHERE business_id=?').run(b.id).catch?.(() => {});
    db.prepare('DELETE FROM staff         WHERE business_id=?').run(b.id);
    db.prepare('DELETE FROM settings      WHERE business_id=?').run(b.id);
    db.prepare('DELETE FROM businesses    WHERE id=?').run(b.id);
    console.log('  Removed:', b.id);
  });
});

try {
  deleteTx();
} catch(e) {
  // orders table may not exist yet
  db.transaction(() => {
    junk.forEach(b => {
      ['menu_items','customers','reservations','feedback','staff','settings','businesses'].forEach(tbl => {
        try { db.prepare(`DELETE FROM ${tbl} WHERE ${tbl==='businesses'?'id':'business_id'}=?`).run(b.id); } catch {}
      });
      console.log('  Removed:', b.id);
    });
  })();
}

const after = db.prepare('SELECT id, name FROM businesses').all();
console.log('\nAfter cleanup:');
after.forEach(b => console.log('  ✓', b.id, '—', b.name));
console.log('\n✓ DB cleanup complete');
db.close();
