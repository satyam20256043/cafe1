'use strict';
// Auth routes — JWT login, rate limiting, safe staff writes
module.exports = function register(ctx) {
  const {
    app, io, fs, path,
    DATA_DIR, BUSINESSES_FILE, businesses,
    getBranchData, writeBranchData,
    updateCustomerProfile, processCafeBotReply,
    waApi, genAI, razorpay, whatsappConnectionStatus,
    requireAuth, requireBranchAccess, requireRole,
    signToken, verifyToken, loadStaff, STAFF_FILE,
    getSubscriptionStatus, requireActiveSubscription,
    auth, db,
  } = ctx;

// ── Safe staff.json writer (backup → write) ───────────────────────────────────
function safeWriteStaff(staff) {
  try {
    if (fs.existsSync(STAFF_FILE)) {
      fs.writeFileSync(STAFF_FILE + '.bak', fs.readFileSync(STAFF_FILE));
    }
    fs.writeFileSync(STAFF_FILE, JSON.stringify(staff, null, 2));
  } catch(e) {
    console.error('[safeWriteStaff] Write failed:', e.message);
    throw e;
  }
}

// ── In-memory rate limiter (5 attempts / 15 min per IP) ───────────────────────
const _loginAttempts = new Map();
function checkLoginRate(ip) {
  const now  = Date.now();
  const WINDOW = 15 * 60 * 1000;
  let entry = _loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + WINDOW };
    _loginAttempts.set(ip, entry);
  }
  entry.count++;
  if (entry.count > 5) {
    const waitMin = Math.ceil((entry.resetAt - now) / 60000);
    return { allowed: false, waitMin };
  }
  return { allowed: true, remaining: 5 - entry.count };
}
function clearLoginRate(ip) { _loginAttempts.delete(ip); }

// ── Auth HTTP routes ────────────────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  if (auth) return auth.loginHandler(req, res);

  // Rate limit
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  const rl = checkLoginRate(ip);
  if (!rl.allowed) {
    return res.status(429).json({
      error: `Too many login attempts. Try again in ${rl.waitMin} minute(s).`
    });
  }

  const { businessId, username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'username and password required' });

  const staff = loadStaff();
  const member = staff.find(s => {
    if (s.username !== username) return false;
    if (s.role === 'agency_admin' || s.role === 'admin') return true;
    return businessId ? s.businessId === businessId : false;
  });
  if (!member) return res.status(401).json({ error: 'Invalid username, password, or branch' });

  let bcryptjs;
  try { bcryptjs = require('bcryptjs'); } catch(e) {
    return res.status(500).json({ error: 'bcryptjs not installed' });
  }
  if (!bcryptjs.compareSync(password, member.passwordHash))
    return res.status(401).json({ error: 'Invalid password' });

  clearLoginRate(ip); // reset counter on success
  if (ctx.logActivity) ctx.logActivity({ event: 'login', username: member.username, role: member.role, businessId: member.businessId||null, ip });
  const staffOut = { id: member.id, name: member.name, role: member.role,
    businessId: member.businessId, username: member.username };
  const token = signToken(staffOut);
  res.json({ success: true, staff: staffOut, token });
});

app.get('/api/auth/me', (req, res) => {
  if (auth) return auth.requireAuth(req, res, () => auth.meHandler(req, res));
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Invalid or expired token' });
  res.json({ ok: true, staff: payload });
});

app.post('/api/auth/logout', (req, res) => {
  if (auth) return auth.requireAuth(req, res, () => auth.logoutHandler(req, res));
  res.json({ success: true });
});

app.post('/api/auth/change-password', (req, res) => {
  if (auth) return auth.requireAuth(req, res, () => auth.changePasswordHandler(req, res));
  const { username, businessId, newPassword } = req.body;
  if (!username || !newPassword) return res.status(400).json({ error: 'Missing fields' });
  const staff = loadStaff();
  const member = staff.find(s => s.username === username && s.businessId === businessId);
  if (!member) return res.status(404).json({ error: 'Staff not found' });
  let bcryptjs;
  try { bcryptjs = require('bcryptjs'); } catch(e) { return res.status(500).json({ error: 'bcryptjs not installed' }); }
  member.passwordHash = bcryptjs.hashSync(newPassword, 10);
  safeWriteStaff(staff);
  res.json({ success: true });
});

// ── Staff Management Routes ────────────────────────────────────────────────────
app.get('/api/staff', (req, res) => {
  if (!auth) return res.status(503).json({ error: 'Auth module not loaded' });
  auth.requireAuth(req, res, () =>
    auth.requireRole('owner', 'manager')(req, res, () =>
      auth.listStaffHandler(req, res)));
});

app.post('/api/staff', (req, res) => {
  if (!auth) return res.status(503).json({ error: 'Auth module not loaded' });
  auth.requireAuth(req, res, () =>
    auth.requireRole('owner')(req, res, () =>
      auth.createStaffHandler(req, res)));
});

app.patch('/api/staff/:staffId', (req, res) => {
  if (!auth) return res.status(503).json({ error: 'Auth module not loaded' });
  auth.requireAuth(req, res, () =>
    auth.requireRole('owner')(req, res, () =>
      auth.updateStaffHandler(req, res)));
});

// ── Admin: view all staff ─────────────────────────────────────────────────────
// This app runs staff in SQLite when db.js loaded successfully (the normal
// case — see [Phase1] boot log), with data/staff.json as a JSON-mode
// fallback. These two endpoints used to only ever touch the JSON file, so a
// password "change" here silently did nothing for a real, SQLite-backed
// account (e.g. every seeded café owner) — the UI reported success but the
// old password kept working. Try SQLite first; fall back to JSON mode only
// when db isn't loaded.
app.get('/api/admin/staff', requireAuth, requireRole('agency_admin'), (req, res) => {
  if (db) {
    const all = businesses.flatMap(b => db.listStaff(b.id));
    return res.json(all.map(({ password_hash, ...s }) => s));
  }
  const staff = loadStaff();
  res.json(staff.map(({ passwordHash, ...s }) => s));
});

// ── Admin: change any staff password ─────────────────────────────────────────
app.put('/api/admin/staff/:id/password', requireAuth, requireRole('agency_admin'), (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 4)
    return res.status(400).json({ error: 'Password must be at least 4 characters' });

  if (db) {
    const member = db.getStaffById(req.params.id);
    if (!member) return res.status(404).json({ error: 'Staff not found' });
    const bcryptjs = require('bcryptjs');
    db.updateStaffPassword(req.params.id, bcryptjs.hashSync(newPassword, 10));
    return res.json({ success: true });
  }

  const staff = loadStaff();
  const member = staff.find(s => s.id === req.params.id);
  if (!member) return res.status(404).json({ error: 'Staff not found' });
  let bcryptjs;
  try { bcryptjs = require('bcryptjs'); } catch(e) { return res.status(500).json({ error: 'bcryptjs not installed' }); }
  member.passwordHash = bcryptjs.hashSync(newPassword, 10);
  safeWriteStaff(staff);
  res.json({ success: true });
});

};
