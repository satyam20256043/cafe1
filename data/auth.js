// ─────────────────────────────────────────────────────────────────────────────
// auth.js — Authentication & Authorization Middleware for Zordic California
// Place this file in your project root (same folder as server.js)
// ─────────────────────────────────────────────────────────────────────────────
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const db        = require('./db');

const JWT_SECRET  = process.env.JWT_SECRET;
// Fail fast: refuse to run with a missing, short, or known-default secret (SEC-3).
// process.exit (not throw) so server.js's try/catch can't silently fall back to JSON mode.
if (!JWT_SECRET || JWT_SECRET.length < 32 || /change[-_]?in[-_]?prod|super[-_]?secret|dev[-_]?secret/i.test(JWT_SECRET)) {
  console.error('[FATAL] JWT_SECRET is missing, shorter than 32 chars, or a known default. Set a strong random secret in .env and restart.');
  process.exit(1);
}
const JWT_EXPIRES = process.env.JWT_EXPIRES || '8h';   // shift length

// ── Password Helpers ──────────────────────────────────────────────────────────
const hashPassword   = (plain)       => bcrypt.hashSync(plain, 10);
const checkPassword  = (plain, hash) => bcrypt.compareSync(plain, hash);

// ── Token Helpers ─────────────────────────────────────────────────────────────
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function verifyToken(token) {
  try {
    return { ok: true, payload: jwt.verify(token, JWT_SECRET) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Middleware: require valid JWT ─────────────────────────────────────────────
function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const result = verifyToken(token);
  if (!result.ok) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  req.staff = result.payload;   // { id, businessId, name, role }
  next();
}

// ── Middleware: require specific role(s) ─────────────────────────────────────
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.staff) return res.status(401).json({ error: 'Not authenticated' });
    if (!roles.includes(req.staff.role)) {
      return res.status(403).json({
        error: `Access denied. Required role: ${roles.join(' or ')}`
      });
    }
    next();
  };
}

// ── Login Handler ─────────────────────────────────────────────────────────────
// POST /api/auth/login  { businessId, username, password }
function loginHandler(req, res) {
  const { businessId, username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }
  if (!businessId && !req.body.adminLogin) {
    return res.status(400).json({ error: 'businessId, username and password required' });
  }

  // Agency admin login has no café to select — matched by username alone,
  // restricted to agency_admin/admin roles so café staff logins are unaffected.
  const staff = businessId
    ? db.getStaffByUsername(businessId, username)
    : db.getAdminStaffByUsername(username);
  if (!staff) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  if (!staff.active) {
    return res.status(403).json({ error: 'Account is deactivated' });
  }

  if (!checkPassword(password, staff.password_hash)) {
    db.audit(staff.business_id, staff.id, staff.name, 'login_failed',
      `Failed login attempt for ${username}`, req.ip);
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const token = signToken({
    id:         staff.id,
    businessId: staff.business_id,
    name:       staff.name,
    role:       staff.role,
  });

  db.audit(staff.business_id, staff.id, staff.name, 'login',
    `${staff.role} logged in`, req.ip);

  res.json({
    token,
    staff: {
      id:   staff.id,
      name: staff.name,
      role: staff.role,
      businessId: staff.business_id,
    }
  });
}

// ── Change Password Handler ───────────────────────────────────────────────────
function changePasswordHandler(req, res) {
  const { currentPassword, newPassword } = req.body;
  const { id, businessId, name } = req.staff;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'currentPassword and newPassword required' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }

  const staff = db.getStaffById(id);
  if (!staff || !checkPassword(currentPassword, staff.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  db.updateStaffPassword(id, hashPassword(newPassword));
  db.audit(businessId, id, name, 'password_changed', 'Password updated', req.ip);

  res.json({ success: true, message: 'Password changed successfully' });
}

// ── Staff Management Handlers ─────────────────────────────────────────────────
function listStaffHandler(req, res) {
  const { businessId } = req.staff;
  const staff = db.listStaff(businessId);
  res.json(staff.map(s => ({ ...s, password_hash: undefined })));
}

function createStaffHandler(req, res) {
  const { name, username, password, role } = req.body;
  const { businessId, id: creatorId, name: creatorName } = req.staff;

  if (!name || !username || !password) {
    return res.status(400).json({ error: 'name, username and password required' });
  }

  const validRoles = ['owner', 'manager', 'waiter', 'cashier'];
  if (role && !validRoles.includes(role)) {
    return res.status(400).json({ error: `Role must be one of: ${validRoles.join(', ')}` });
  }

  const existing = db.getStaffByUsername(businessId, username);
  if (existing) {
    return res.status(409).json({ error: 'Username already taken' });
  }

  const newStaff = db.createStaff({
    businessId,
    name,
    username,
    passwordHash: hashPassword(password),
    role: role || 'waiter',
  });

  db.audit(businessId, creatorId, creatorName, 'staff_created',
    `Created staff: ${name} (${role})`, req.ip);

  res.status(201).json({ ...newStaff, password_hash: undefined });
}

function updateStaffHandler(req, res) {
  const { staffId } = req.params;
  const { active }  = req.body;
  const { businessId, id: actorId, name: actorName } = req.staff;

  db.setStaffActive(staffId, active);
  db.audit(businessId, actorId, actorName, 'staff_updated',
    `Staff ${staffId} active=${active}`, req.ip);

  res.json({ success: true });
}

// ── Seed Default Owner Account ────────────────────────────────────────────────
function seedOwnerIfNeeded(businessId, ownerName) {
  const staff = db.listStaff(businessId);
  if (staff.length === 0) {
    const defaultPassword = 'cafe1234';
    db.createStaff({
      businessId,
      name:         ownerName || 'Owner',
      username:     'owner',
      passwordHash: hashPassword(defaultPassword),
      role:         'owner',
    });
    console.log(`[AUTH] Seeded default owner for ${businessId} — username: owner, password: ${defaultPassword}`);
    console.log(`[AUTH] ⚠️  Change this password immediately after first login!`);
  }
}

// ── Me & Logout Handlers ─────────────────────────────────────────────────────
function meHandler(req, res) {
  const { id, businessId, name, role } = req.staff;
  res.json({ id, businessId, name, role });
}

function logoutHandler(req, res) {
  const { id, businessId, name } = req.staff;
  db.audit(businessId, id, name, 'logout', `${name} logged out`, req.ip);
  res.json({ success: true });
}

module.exports = {
  hashPassword, checkPassword, signToken, verifyToken,
  requireAuth, requireRole,
  loginHandler, changePasswordHandler,
  listStaffHandler, createStaffHandler, updateStaffHandler,
  meHandler, logoutHandler,
  seedOwnerIfNeeded,
};
