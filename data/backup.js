// ─────────────────────────────────────────────────────────────────────────────
// backup.js — Auto-Backup Module for Zordic California
// Place this file in your project root (same folder as server.js)
// Runs daily at 2 AM, keeps last 7 backups, logs to SQLite
// ─────────────────────────────────────────────────────────────────────────────
const fs   = require('fs');
const path = require('path');
const db   = require('./db');

const DATA_DIR    = path.join(__dirname, 'data');
const BACKUP_DIR  = path.join(DATA_DIR, 'backups');
const DB_PATH     = path.join(DATA_DIR, 'cafe_hq.db');
const MAX_BACKUPS = 7;       // days to keep
const BACKUP_HOUR = 2;       // 2 AM

// ── Ensure backup directory exists ───────────────────────────────────────────
if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

// ── Run a single backup ───────────────────────────────────────────────────────
function runBackup() {
  const now      = new Date();
  const stamp    = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `cafe_hq_${stamp}.db`;
  const destPath = path.join(BACKUP_DIR, filename);

  try {
    // SQLite WAL-safe copy: use the db module's built-in backup
    const raw = db.raw();   // returns the better-sqlite3 Database instance
    raw.backup(destPath)
      .then(() => {
        const sizeMB = (fs.statSync(destPath).size / 1024 / 1024).toFixed(2);
        console.log(`[BACKUP] ✓ Backup saved: ${filename} (${sizeMB} MB)`);

        // Log to SQLite backups table
        db.logBackup({
          filename,
          path: destPath,
          sizeMb: parseFloat(sizeMB),
          status: 'success',
        });

        pruneOldBackups();
      })
      .catch(err => {
        console.error('[BACKUP] ✗ Backup failed:', err.message);
        db.logBackup({ filename, path: destPath, sizeMb: 0, status: 'failed' });
      });
  } catch (err) {
    // Fallback: simple file copy if backup() not available
    try {
      fs.copyFileSync(DB_PATH, destPath);
      const sizeMB = (fs.statSync(destPath).size / 1024 / 1024).toFixed(2);
      console.log(`[BACKUP] ✓ Backup (copy) saved: ${filename} (${sizeMB} MB)`);
      db.logBackup({ filename, path: destPath, sizeMb: parseFloat(sizeMB), status: 'success' });
      pruneOldBackups();
    } catch (copyErr) {
      console.error('[BACKUP] ✗ Backup copy failed:', copyErr.message);
      db.logBackup({ filename, path: destPath, sizeMb: 0, status: 'failed' });
    }
  }
}

// ── Delete old backups beyond MAX_BACKUPS ─────────────────────────────────────
function pruneOldBackups() {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('cafe_hq_') && f.endsWith('.db'))
      .map(f => ({ name: f, time: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.time - a.time);   // newest first

    const toDelete = files.slice(MAX_BACKUPS);
    toDelete.forEach(f => {
      fs.unlinkSync(path.join(BACKUP_DIR, f.name));
      console.log(`[BACKUP] Pruned old backup: ${f.name}`);
    });
  } catch (err) {
    console.error('[BACKUP] Prune error:', err.message);
  }
}

// ── List recent backups (for dashboard API) ───────────────────────────────────
function listBackups() {
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('cafe_hq_') && f.endsWith('.db'))
      .map(f => {
        const stat = fs.statSync(path.join(BACKUP_DIR, f));
        return {
          filename: f,
          sizeMb:   parseFloat((stat.size / 1024 / 1024).toFixed(2)),
          createdAt: stat.mtime.toISOString(),
        };
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } catch {
    return [];
  }
}

// ── Schedule: fire at BACKUP_HOUR every day ───────────────────────────────────
function scheduleDaily() {
  function msUntilNext2AM() {
    const now  = new Date();
    const next = new Date(now);
    next.setHours(BACKUP_HOUR, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next - now;
  }

  function loop() {
    const wait = msUntilNext2AM();
    const hh   = Math.floor(wait / 3600000);
    const mm   = Math.floor((wait % 3600000) / 60000);
    console.log(`[BACKUP] Next backup in ${hh}h ${mm}m (at ${BACKUP_HOUR}:00 AM)`);
    setTimeout(() => {
      runBackup();
      setInterval(runBackup, 24 * 60 * 60 * 1000);  // then every 24h
    }, wait);
  }

  loop();
}

// ── Manual trigger (for API endpoint) ────────────────────────────────────────
function triggerManualBackup() {
  console.log('[BACKUP] Manual backup triggered');
  runBackup();
  return { triggered: true, timestamp: new Date().toISOString() };
}

module.exports = { scheduleDaily, runBackup, triggerManualBackup, listBackups };
