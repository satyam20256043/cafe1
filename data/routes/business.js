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
    db,
    initializeBusinessFiles,
    whatsappClient,
    startKnowledgeInterview, SUGGESTED_KNOWLEDGE_QUESTIONS,
  } = ctx;



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
function publicBusinessView(b) {
  const out = {};
  PUBLIC_BUSINESS_FIELDS.forEach(k => { if (b[k] !== undefined) out[k] = b[k]; });
  return out;
}
// Returns true when the request carries a valid staff JWT (any role)
function hasStaffToken(req) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return false;
  const v = verifyToken(token);
  return !!(v && (v.ok === undefined ? v : v.payload));
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
app.get('/api/businesses/:id/franchise-group', (req, res) => {
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
app.get('/api/businesses', (req, res) => {
  if (hasStaffToken(req)) return res.json(businesses);
  res.json([]);
});

// 2. Add dynamic new business (quick-add from HQ panel)
app.post('/api/businesses', requireAuth, (req, res) => {
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

// 3. Update business details
app.post('/api/businesses/:id', requireAuth, requireBranchAccess, (req, res) => {
  const { id } = req.params;
  const index = businesses.findIndex(b => b.id === id);
  if (index === -1) return res.status(404).json({ error: 'Business not found' });

  if (req.body.platformLinks !== undefined) {
    req.body.platformLinks = sanitizePlatformLinks(req.body.platformLinks);
  }
  businesses[index] = { ...businesses[index], ...req.body };
  fs.writeFileSync(BUSINESSES_FILE, JSON.stringify(businesses, null, 2));
  if (db) { try { db.upsertBusinessRow(businesses[index]); } catch(e) { console.error('[UpdateBusiness] SQLite business sync failed:', e.message); } }

  // Sync with settings.json for Google Business Profile
  try {
    const settingsFile = path.join(DATA_DIR, id, 'settings.json');
    if (fs.existsSync(settingsFile)) {
      const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
      if (req.body.review && req.body.review.trim() !== '') {
        settings.gbpLinked = true;
        settings.gbpLocationId = req.body.review.trim();
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
app.post('/api/onboard', async (req, res) => {
  const {
    businessName, ownerName, ownerEmail, ownerPhone,
    location, city, timings, brandColor
  } = req.body;

  if (!businessName || !ownerName || !ownerPhone) {
    return res.status(400).json({ error: 'Business name, owner name, and phone are required' });
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
    ownerPhone: ownerPhone.replace(/\D/g,'').slice(-10),
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

  // Send welcome WhatsApp if connected
  const BASE_URL = process.env.BASE_URL || 'http://localhost:3010';
  if (whatsappClient) {
    try {
      const phone = ownerPhone.replace(/\D/g,'').slice(-10);
      const chatId = '91' + phone + '@c.us';
      const welcomeMsg =
        `☕ *Welcome to Zordic California!*\n\n` +
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
        const rows = db.raw
          ? db.raw('SELECT COUNT(*) as cnt, COALESCE(SUM(total_amount),0) as rev FROM orders WHERE business_id=?', [b.id])
          : null;
        if (rows && rows[0]) { orders = rows[0].cnt; revenue = rows[0].rev; }
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
