'use strict';
// Auto-extracted from server.js — do not edit manually.
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
    db, toIsoZ,
    initializeBusinessFiles,
    whatsappClient,
    startKnowledgeInterview, SUGGESTED_KNOWLEDGE_QUESTIONS,
  } = ctx;
  const { rateLimit } = require('../rateLimit');
  // Self-serve signup is unauthenticated by necessity — no throttle at all
  // meant a scripted loop could spam the platform's own WhatsApp sender at any
  // phone number (the welcome message includes a real temp password) and
  // create unbounded junk business rows in the same breath.
  const onboardLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 5,
    message: 'Too many signup attempts from this connection. Please try again later or contact us directly.' });



// ── Public payload sanitizer ─────────────────────────────────────────────────
// Customer pages need branding/menu basics; owner PII, subscription state, and
// any stored credentials must never leave via the unauthenticated endpoints.
const PUBLIC_BUSINESS_FIELDS = [
  'id', 'name', 'location', 'timings', 'contact', 'map', 'wifi', 'review',
  'status', 'theme', 'brandColor', 'tables', 'heroImageUrl', 'galleryUrls',
  'platformLinks'
];

// Platform links (Zomato, Swiggy, Instagram, …) are rendered on public pages and
// fed into the AI prompt, so sanitize hard on save: array of {label, url}, http(s)
// URLs only, capped counts/lengths. Returns a clean array (possibly empty).
function sanitizePlatformLinks(input) {
  if (!Array.isArray(input)) return [];
  return input
    .filter(l => l && typeof l.label === 'string' && typeof l.url === 'string')
    .map(l => ({ label: l.label.trim().slice(0, 30), url: l.url.trim().slice(0, 300) }))
    .filter(l => l.label && /^https?:\/\//i.test(l.url))
    .slice(0, 8);
}

// What a café may change about itself through POST /api/businesses/:id — the fields
// the Settings forms edit. Everything else on the record (id, subscription status and
// plan, trial dates, owner contact, sales attribution, payment history) is set by the
// platform and must never be taken from that request body.
const EDITABLE_TEXT = { name: 120, location: 300, timings: 200, contact: 120, wifi: 200 };
const EDITABLE_LINKS = { map: 'Google Maps link', review: 'Review link', website: 'Website', heroImageUrl: 'Cover image link' };

// '' clears a link. Otherwise it must be an http(s) URL, or carry no scheme at all
// (older records hold bare hosts and Google place ids here) — never javascript:,
// data: or any other scheme. Returns null when the value has to be rejected.
function cleanLink(value) {
  if (typeof value !== 'string') return null;
  const s = value.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 500);
  if (!s) return '';
  try { return /^https?:$/.test(new URL(s).protocol) ? s : null; }
  catch (e) { return s; } // not an absolute URL, so there is no scheme to abuse
}

// Returns { edits } or { error }. Unknown keys are dropped rather than rejected, so
// a client that still posts extra fields keeps working.
function pickBusinessEdits(body) {
  const edits = {};
  if (!body || typeof body !== 'object') return { edits };
  for (const [key, max] of Object.entries(EDITABLE_TEXT)) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== 'string') return { error: `${key} must be text.` };
    edits[key] = body[key].trim().slice(0, max);
  }
  if (edits.name !== undefined && !edits.name) return { error: 'The café name cannot be empty.' };
  for (const [key, label] of Object.entries(EDITABLE_LINKS)) {
    if (body[key] === undefined) continue;
    const link = cleanLink(body[key]);
    if (link === null) return { error: `${label} must start with http:// or https://.` };
    edits[key] = link;
  }
  if (body.galleryUrls !== undefined) {
    if (!Array.isArray(body.galleryUrls)) return { error: 'Gallery images must be a list of links.' };
    const urls = body.galleryUrls.map(cleanLink);
    if (urls.includes(null)) return { error: 'Gallery image links must start with http:// or https://.' };
    edits.galleryUrls = urls.filter(Boolean).slice(0, 24);
  }
  if (body.platformLinks !== undefined) edits.platformLinks = sanitizePlatformLinks(body.platformLinks);
  return { edits };
}
function publicBusinessView(b) {
  const out = {};
  PUBLIC_BUSINESS_FIELDS.forEach(k => { if (b[k] !== undefined) out[k] = b[k]; });
  return out;
}
// Returns the verified payload of the request's staff JWT, or null.
// verifyToken has two shapes across this codebase ({ok,payload} vs. a bare
// payload), so both are unwrapped here — same handling hasStaffToken uses.
function staffPayload(req) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  const v = verifyToken(token);
  if (!v) return null;
  const p = (v.ok === undefined) ? v : (v.ok ? v.payload : null);
  return p || null;
}
// Returns the caller's role, or null when there's no valid token.
function staffRoleFromToken(req) {
  const p = staffPayload(req);
  return p ? p.role : null;
}
// Returns true when the request carries a valid staff JWT (any role)
function hasStaffToken(req) {
  return !!staffPayload(req);
}

// ── Update franchiseGroupId ───────────────────────────────────────────────────
app.post('/api/businesses/:id/franchise-group', requireAuth, requireRole('agency_admin', 'admin'), (req, res) => {
  const { franchiseGroupId } = req.body;
  const b = businesses.find(x => x.id === req.params.id);
  if (!b) return res.status(404).json({ error: 'Not found' });
  b.franchiseGroupId = franchiseGroupId;
  fs.writeFileSync(BUSINESSES_FILE, JSON.stringify(businesses, null, 2));
  res.json({ success: true, business: b });
});

// ── Table QR URLs for a branch ────────────────────────────────────────────────
app.get('/api/businesses/:id/qr-tables', (req, res) => {
  const count = parseInt(req.query.count) || 10;
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const tables = [];
  for (let i = 1; i <= count; i++) {
    tables.push({ tableNo: i, url: `${baseUrl}/table-order.html?branch=${req.params.id}&table=${i}` });
  }
  res.json(tables);
});

// ── Franchise group: get all branches sharing same owner ──────────────────────
// Full records (owner PII, subscription state, payment history) — only for
// staff who already have legitimate access to :id itself (or a platform
// admin), same trust tier as the full-roster GET /api/businesses above.
app.get('/api/businesses/:id/franchise-group', requireAuth, requireBranchAccess, (req, res) => {
  const b = businesses.find(x => x.id === req.params.id);
  if (!b) return res.status(404).json({ error: 'Not found' });
  const groupId = b.franchiseGroupId || b.ownerPhone;
  const group = businesses.filter(x => x.franchiseGroupId === groupId || x.ownerPhone === groupId);
  res.json(group);
});

// No public café directory (UI1b) — an unauthenticated caller gets an empty
// list, not the full tenant roster. Anyone who needs one café's public info
// (login page, café site, table ordering) already knows its id and uses
// GET /api/businesses/:id below, which is unauthenticated but scoped to one
// business via publicBusinessView.
//
// The full, unredacted roster (owner name/email/phone, subscription state for
// every café on the platform) is an agency-level view — admin.html's
// franchise grid and HQ-wide stats are the only real caller. It used to be
// gated on "any valid staff token," so a single café's own waiter or cashier
// login could pull every OTHER business's owner contact info too. Any other
// authenticated role gets an empty list, same as unauthenticated — nothing in
// the app expects "my own business" back from this specific endpoint.
// Deliberately NOT behind requireAuth: the established contract here is
// "unauthorized callers get an empty list, not an error" — several callers
// (client.js's franchise grid) call this with no header and .map() the result
// directly, so a 401 body would throw on them instead of degrading quietly.
// The fix for the leak is narrowing WHO counts as authorized, not changing
// the response shape.
app.get('/api/businesses', (req, res) => {
  const role = staffRoleFromToken(req);
  if (role && ['agency_admin','admin'].includes(role)) return res.json(businesses);
  res.json([]);
});

// 2. Add dynamic new business (quick-add from HQ panel)
app.post('/api/businesses', requireAuth, requireRole('agency_admin', 'admin'), (req, res) => {
  const { name, location, timings, contact, wifi, map, review,
          ownerName, ownerEmail, ownerPhone, brandColor } = req.body;
  if (!name || !location) {
    return res.status(400).json({ error: 'Name and Location are required' });
  }

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g,'').slice(0, 20);
  const id   = slug + '_' + Date.now().toString(36);
  const trialEnds = new Date(Date.now() + 30*24*60*60*1000).toISOString().slice(0,10);

  const newBiz = {
    id, name, location,
    timings:  timings  || '9:00 AM - 10:00 PM',
    contact:  contact  || ownerPhone || '',
    map:      map      || `https://maps.google.com/?q=${encodeURIComponent(name)}`,
    wifi:     wifi     || '',
    review:   review   || '',
    status:   'online',
    ownerName:   ownerName   || '',
    ownerEmail:  ownerEmail  || '',
    ownerPhone:  ownerPhone  || '',
    brandColor:  brandColor  || '#C9A84C',
    subscriptionStatus: 'trial',
    trialEndsAt:  trialEnds,
    onboardedAt:  new Date().toISOString(),
  };

  businesses.push(newBiz);
  fs.writeFileSync(BUSINESSES_FILE, JSON.stringify(businesses, null, 2));
  initializeBusinessFiles(id);
  if (db) { try { db.upsertBusinessRow(newBiz); } catch(e) { console.error('[QuickAdd] SQLite business sync failed:', e.message); } }

  res.json({ success: true, businessId: id, ...newBiz,
    managerUrl: `/manager/${id}`, cafeUrl: `/cafe/${id}`,
    portalUrl:  `/portal/${id}`, trialEndsAt: trialEnds });
});

// 3. Update business details — name, contact, WiFi password, platform links,
// GBP review link, brand color. Owner/manager only: this is café configuration,
// not something a waiter or cashier account should be able to change.
app.post('/api/businesses/:id', requireAuth, requireBranchAccess, requireRole('owner','manager','agency_admin','admin'), (req, res) => {
  const { id } = req.params;
  const index = businesses.findIndex(b => b.id === id);
  if (index === -1) return res.status(404).json({ error: 'Business not found' });

  // Café configuration is for owners and managers (and the agency), not waiter or kitchen logins.
  if (!['owner', 'manager', 'agency_admin', 'admin'].includes(req.staff && req.staff.role)) {
    return res.status(403).json({ error: 'Only an owner or manager can change café details.' });
  }
  const { edits, error } = pickBusinessEdits(req.body);
  if (error) return res.status(400).json({ error });
  businesses[index] = { ...businesses[index], ...edits };
  fs.writeFileSync(BUSINESSES_FILE, JSON.stringify(businesses, null, 2));
  if (db) { try { db.upsertBusinessRow(businesses[index]); } catch(e) { console.error('[UpdateBusiness] SQLite business sync failed:', e.message); } }

  // Sync with settings.json for Google Business Profile
  try {
    const settingsFile = path.join(DATA_DIR, id, 'settings.json');
    if (edits.review !== undefined && fs.existsSync(settingsFile)) {
      const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
      if (edits.review) {
        settings.gbpLinked = true;
        settings.gbpLocationId = edits.review;
      } else {
        settings.gbpLinked = false;
        settings.gbpLocationId = '';
      }
      fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
    }
  } catch (err) {
    console.error('Error syncing review URL with settings.json:', err);
  }

  res.json(businesses[index]);
});

// GET /api/manifest/manager/:id — per-café PWA manifest. The shared
// /manifest.json has start_url:"/", so "Add to Home Screen" from a manager
// dashboard would reopen to the public marketing site, not that café's own
// dashboard — this per-branch manifest fixes start_url/scope so the installed
// icon goes straight back to /manager/:id. Unauthenticated on purpose: browsers
// fetch a manifest as a plain resource during install, with no auth header.
app.get('/api/manifest/manager/:id', (req, res) => {
  const biz = businesses.find(b => b.id === req.params.id);
  const name = biz ? biz.name : 'Zordical';
  res.json({
    name: `${name} — Manager`,
    short_name: 'Manager',
    description: `Manage ${name} on Zordical`,
    start_url: `/manager/${req.params.id}`,
    scope: `/manager/${req.params.id}`,
    display: 'standalone',
    orientation: 'portrait-primary',
    background_color: '#1a1a2e',
    theme_color: '#C9A84C',
    icons: [
      { src: '/logo-mark.svg', type: 'image/svg+xml', sizes: 'any', purpose: 'any maskable' },
      { src: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 192 192'><rect width='192' height='192' fill='%230D0705'/><text y='130' x='30' font-size='120' font-family='serif'>%E2%98%95</text></svg>", sizes: '192x192', type: 'image/svg+xml', purpose: 'any maskable' },
      { src: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 512 512'><rect width='512' height='512' fill='%230D0705'/><text y='360' x='60' font-size='340' font-family='serif'>%E2%98%95</text></svg>", sizes: '512x512', type: 'image/svg+xml', purpose: 'any maskable' },
    ],
  });
});


// ════════════════════════════════════════════════════════════════════════════
// Phase 6 — Client Onboarding & Agency Management
// ════════════════════════════════════════════════════════════════════════════

// GET /api/businesses/:id — single business details (includes brand fields)
// Unauthenticated callers (customer pages) get the sanitized public view.
app.get('/api/businesses/:id', (req, res) => {
  const biz = businesses.find(b => b.id === req.params.id);
  if (!biz) return res.status(404).json({ error: 'Business not found' });
  res.json(hasStaffToken(req) ? biz : publicBusinessView(biz));
});

// POST /api/onboard — self-serve client registration
// Creates business + default manager staff account
app.post('/api/onboard', onboardLimit, async (req, res) => {
  const {
    businessName, ownerName, ownerEmail, ownerPhone,
    location, city, timings, brandColor, theme
  } = req.body;

  if (!businessName || !ownerName || !ownerPhone) {
    return res.status(400).json({ error: 'Business name, owner name, and phone are required' });
  }
  // This number is where the account's own login credentials get sent, and
  // it becomes the café's WhatsApp contact for every future order/status
  // notification — a value that doesn't even look like a phone number was
  // previously accepted and silently collapsed to '' downstream.
  const cleanPhone = ownerPhone.replace(/\D/g,'').slice(-10);
  if (!/^[6-9]\d{9}$/.test(cleanPhone)) {
    return res.status(400).json({ error: 'Please enter a valid 10-digit mobile number.' });
  }

  // Generate a clean branch ID
  const slug = businessName.toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 20);
  const id = slug + '_' + Date.now().toString(36);

  // Build business record with onboarding metadata
  const trialEnds = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0,10);
  const newBiz = {
    id,
    name: businessName,
    location: location || (city ? city : 'India'),
    timings: timings || '9:00 AM - 10:00 PM',
    contact: ownerPhone,
    map: `https://maps.google.com/?q=${encodeURIComponent(businessName)}`,
    wifi: '',
    review: '',
    status: 'online',
    // Onboarding fields
    ownerName,
    ownerEmail: ownerEmail || '',
    ownerPhone: cleanPhone,
    theme: theme || 'espresso',
    brandColor: brandColor || '#C9A84C',
    subscriptionStatus: 'trial',
    trialEndsAt: trialEnds,
    onboardedAt: new Date().toISOString()
  };

  businesses.push(newBiz);
  fs.writeFileSync(BUSINESSES_FILE, JSON.stringify(businesses, null, 2));
  initializeBusinessFiles(id);
  // Without this, every order for this café crashes — orders.business_id has
  // a FOREIGN KEY to SQLite's businesses(id), which only businesses.json knew
  // about until now.
  if (db) { try { db.upsertBusinessRow(newBiz); } catch(e) { console.error('[Onboard] SQLite business sync failed:', e.message); } }

  // Create manager staff account — SQLite if available, else JSON fallback
  let staffCreds = null;
  try {
    const bcrypt = require('bcryptjs');
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const tempPassword = 'Cafe' + Array.from({length:5}, ()=>chars[Math.floor(Math.random()*chars.length)]).join('');
    const username = slug.replace(/_[a-z0-9]+$/, '').replace(/_+$/,'').slice(0, 15) || slug.slice(0,12);
    const passwordHash = await bcrypt.hash(tempPassword, 10);

    if (db) {
      // SQLite path
      const staff = db.createStaff({ businessId: id, name: ownerName, username, passwordHash, role: 'manager', phone: newBiz.ownerPhone });
      staffCreds = { username, tempPassword, staffId: staff ? staff.id : null };
    } else {
      // JSON fallback — write to staff.json
      const staffArr = loadStaff();
      // Deduplicate username
      let finalUser = username;
      let suffix = 1;
      while (staffArr.find(s => s.username === finalUser)) { finalUser = username + suffix++; }
      const newStaff = {
        id: 'staff_' + id + '_mgr',
        username: finalUser, passwordHash, role: 'manager',
        businessId: id, name: ownerName,
        createdAt: new Date().toISOString()
      };
      staffArr.push(newStaff);
      fs.writeFileSync(STAFF_FILE, JSON.stringify(staffArr, null, 2));
      staffCreds = { username: finalUser, tempPassword, staffId: newStaff.id };
    }
  } catch(e) {
    console.error('[Onboard] Staff creation error:', e.message);
  }

  // The business record above was created successfully even if this failed —
  // don't tell the customer everything worked when there's no account they
  // can actually log into. The business isn't rolled back (that's a rarer,
  // recoverable failure a human can fix by adding a staff account manually);
  // what must not happen is a celebratory "you're live!" screen with a
  // manager URL that leads nowhere.
  if (!staffCreds) {
    return res.status(500).json({
      error: 'Your café was created, but we could not set up your login automatically. Please contact us with this reference so we can finish setup.',
      businessId: id,
    });
  }

  // Send welcome WhatsApp if connected
  const BASE_URL = process.env.BASE_URL || 'http://localhost:3010';
  if (whatsappClient) {
    try {
      const chatId = '91' + cleanPhone + '@c.us';
      const welcomeMsg =
        `☕ *Welcome to Zordical!*\n\n` +
        `Hi ${ownerName}! Your café *${businessName}* is now live.\n\n` +
        `🔗 Customer page: ${BASE_URL}/cafe/${id}\n` +
        `🛠 Manager dashboard: ${BASE_URL}/manager/${id}\n` +
        `🔑 Login: ${BASE_URL}/login/${id}\n` +
        (staffCreds ? `👤 Username: ${staffCreds.username}\n🔑 Password: ${staffCreds.tempPassword}\n` : '') +
        `\n📅 Trial ends: ${trialEnds}\n\nReply HELP for support. ☕`;
      await whatsappClient.sendMessage(chatId, welcomeMsg);
    } catch(e) { console.warn('[Onboard] WhatsApp welcome failed:', e.message); }
  }

  res.json({
    success: true,
    businessId: id,
    cafeUrl:    `/cafe/${id}`,
    managerUrl: `/manager/${id}`,
    portalUrl:  `/portal/${id}`,
    orderUrl:   `/order/${id}`,
    kitchenUrl: `/kitchen/${id}`,
    trialEndsAt: trialEnds,
    staff: staffCreds
  });
});

// GET /api/agency/clients — all clients with stats (agency admin)
app.get('/api/agency/clients', requireAuth, requireRole('agency_admin', 'admin'), (req, res) => {
  const clients = businesses.map(b => {
    // Pull revenue from SQLite if available
    let revenue = 0, orders = 0;
    if (db) {
      try {
        // db.raw() is a zero-arg accessor for the underlying better-sqlite3
        // handle, not a query runner — db.raw(sql, params) silently ignored
        // both arguments and returned the handle itself, so this never ran.
        // Also total_amount doesn't exist on orders; the real column is total.
        const row = db.raw().prepare('SELECT COUNT(*) as cnt, COALESCE(SUM(total),0) as rev FROM orders WHERE business_id=?').get(b.id);
        if (row) { orders = row.cnt; revenue = row.rev; }
      } catch(e) {}
    }
    const daysLeft = b.trialEndsAt
      ? Math.max(0, Math.ceil((new Date(b.trialEndsAt) - Date.now()) / 86400000))
      : null;
    return {
      id: b.id,
      name: b.name,
      ownerName: b.ownerName || '—',
      ownerPhone: b.ownerPhone || b.contact || '—',
      ownerEmail: b.ownerEmail || '—',
      location: b.location,
      status: b.status,
      subscriptionStatus: b.subscriptionStatus || 'active',
      subscriptionPlan: b.subscriptionPlan || null,
      trialEndsAt: b.trialEndsAt || null,
      daysLeft,
      onboardedAt: b.onboardedAt || null,
      brandColor: b.brandColor || '#C9A84C',
      waMode: ((getBranchData(b.id, 'whatsapp_config.json') || {}).mode) || null,
      revenue,
      orders
    };
  });
  res.json(clients);
});

// PATCH /api/agency/clients/:id/status — update subscription status and/or plan
// (agency only: this is the tenant activation/suspension switch, also used to
// manually mark a client active after an offline/out-of-band payment)
app.post('/api/agency/clients/:id/status', requireAuth, requireRole('agency_admin', 'admin'), (req, res) => {
  const { id } = req.params;
  const { subscriptionStatus, subscriptionPlan } = req.body;
  const validStatus = ['trial','active','paused','cancelled'];
  if (subscriptionStatus !== undefined && !validStatus.includes(subscriptionStatus)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  if (subscriptionPlan !== undefined) {
    let planIds = [];
    try { planIds = (JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'plans.json'), 'utf-8')).plans || []).map(p => p.id); } catch(e) {}
    if (subscriptionPlan && !planIds.includes(subscriptionPlan)) {
      return res.status(400).json({ error: 'Invalid plan' });
    }
  }
  if (subscriptionStatus === undefined && subscriptionPlan === undefined) {
    return res.status(400).json({ error: 'Nothing to update' });
  }
  const idx = businesses.findIndex(b => b.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  if (subscriptionStatus !== undefined) businesses[idx].subscriptionStatus = subscriptionStatus;
  if (subscriptionPlan !== undefined) {
    // Keep both historical plan fields in sync: `plan` is what the AI-tier
    // dispatch and Razorpay flow read/write, `subscriptionPlan` is what the HQ
    // billing UI reads. Writing only one silently broke premium AI for
    // manually-assigned plans.
    businesses[idx].subscriptionPlan = subscriptionPlan;
    businesses[idx].plan = subscriptionPlan;
  }
  fs.writeFileSync(BUSINESSES_FILE, JSON.stringify(businesses, null, 2));
  res.json({ success: true, id, subscriptionStatus: businesses[idx].subscriptionStatus, subscriptionPlan: businesses[idx].subscriptionPlan });
});

// POST /api/agency/clients/:id/payments — operator logs a real payment received;
// commission is computed and frozen automatically (10% first payment, 5% after,
// per the café's linked sales rep if any — SF2). Admin-only: reps never record
// their own payments. Does NOT flip subscription status/active state — that
// stays a deliberate, separate action via the status endpoint above.
app.post('/api/agency/clients/:id/payments', requireAuth, requireRole('agency_admin', 'admin'), (req, res) => {
  if (!db) return res.status(503).json({ error: 'Not available in this server mode' });
  const { id } = req.params;
  const { amount, plan, paidAt, reference } = req.body;
  const business = businesses.find(b => b.id === id);
  if (!business) return res.status(404).json({ error: 'Business not found' });

  const amountNum = Number(amount);
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }
  let planIds = [];
  try { planIds = (JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'plans.json'), 'utf-8')).plans || []).map(p => p.id); } catch(e) {}
  if (!plan || !planIds.includes(plan)) {
    return res.status(400).json({ error: 'Invalid plan' });
  }

  const row = db.recordPayment({
    businessId: id, amount: amountNum, plan, paidAt: paidAt || undefined,
    recordedBy: req.staff.id, reference: reference || null,
    salesRepId: business.salesRepId || null,
  });
  db.logEvent(id, 'payment.recorded', {
    actor: 'staff:' + req.staff.id,
    metadata: { amount: amountNum, plan, commission: row.commission_amount },
  });
  res.json({
    ...row,
    paid_at: toIsoZ(row.paid_at),
    created_at: toIsoZ(row.created_at),
  });
});

// GET /api/agency/clients/:id/payments — that café's payment history
app.get('/api/agency/clients/:id/payments', requireAuth, requireRole('agency_admin', 'admin'), (req, res) => {
  if (!db) return res.status(503).json({ error: 'Not available in this server mode' });
  const rows = db.listPaymentsForBusiness(req.params.id);
  res.json(rows.map(r => ({ ...r, paid_at: toIsoZ(r.paid_at), created_at: toIsoZ(r.created_at) })));
});

// ── AI3: "Teach your AI" knowledge base ──────────────────────────────────────
// Owner-authored café facts (parking, veg/non-veg, pets…). The AI answers ONLY
// from these; the suggested-question list seeds the Settings form.
app.get('/api/businesses/:id/knowledge', requireAuth, requireBranchAccess, (req, res) => {
  res.json({
    knowledge: getBranchData(req.params.id, 'knowledge.json'),
    suggested: SUGGESTED_KNOWLEDGE_QUESTIONS,
  });
});

app.put('/api/businesses/:id/knowledge', requireAuth, requireBranchAccess, (req, res) => {
  const { knowledge } = req.body;
  if (!Array.isArray(knowledge)) return res.status(400).json({ error: 'knowledge must be an array' });
  const clean = knowledge
    .filter(k => k && typeof k.q === 'string' && typeof k.a === 'string')
    .map(k => ({
      id: (typeof k.id === 'string' && k.id) ? k.id.slice(0, 40)
        : 'k_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      q: k.q.trim().slice(0, 200),
      a: k.a.trim().slice(0, 600),
      updatedAt: new Date().toISOString(),
    }))
    .filter(k => k.q && k.a)
    .slice(0, 60);
  writeBranchData(req.params.id, 'knowledge.json', clean);
  res.json({ success: true, count: clean.length });
});

// Starts the WhatsApp owner interview (state machine lives in server.js).
app.post('/api/businesses/:id/knowledge/interview', requireAuth, requireBranchAccess, (req, res) => {
  const result = startKnowledgeInterview(req.params.id);
  if (!result.success) return res.status(400).json({ error: result.error });
  res.json(result);
});

};
