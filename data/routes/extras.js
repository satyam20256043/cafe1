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
  } = ctx;

// ══════════════════════════════════════════════════════════════════════════════
// MANAGER PORTAL — MISSING ROUTES (added by debugger)
// ══════════════════════════════════════════════════════════════════════════════

// ── Theme ────────────────────────────────────────────────────────────────────
app.post('/api/businesses/:id/theme', requireAuth, requireBranchAccess, (req, res) => {
  const { id } = req.params;
  const { theme } = req.body;
  if (!theme) return res.status(400).json({ error: 'Theme required' });
  const idx = businesses.findIndex(b => b.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Branch not found' });
  businesses[idx].theme = theme;
  fs.writeFileSync(BUSINESSES_FILE, JSON.stringify(businesses, null, 2));
  res.json({ success: true, theme });
});

// ── Walk-in Customer Registration ────────────────────────────────────────────
app.post('/api/businesses/:id/walkin', requireAuth, requireBranchAccess, (req, res) => {
  const { id } = req.params;
  const { name, phone, birthday, notes } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'Name and phone required' });

  const cleanPhone = phone.replace(/\D/g, '').slice(-10);
  const crmFile = path.join(DATA_DIR, id, 'crm.json');
  let crm = [];
  try { if (fs.existsSync(crmFile)) crm = JSON.parse(fs.readFileSync(crmFile, 'utf-8')); } catch(e) {}

  let customer = crm.find(c => c.phone === cleanPhone);
  const isNew = !customer;
  const now = new Date().toISOString();

  if (isNew) {
    customer = {
      id: 'cust_' + Date.now(),
      name, phone: cleanPhone, birthday: birthday || null, notes: notes || '',
      visits: 1, lastVisit: now, createdAt: now,
      loyaltyPoints: 10, loyaltyTier: 'Bronze', stamps: 0,
      tags: ['walk-in']
    };
    crm.push(customer);
  } else {
    customer.visits = (customer.visits || 0) + 1;
    customer.lastVisit = now;
    if (birthday && !customer.birthday) customer.birthday = birthday;
    if (notes) customer.notes = notes;
    if (!customer.tags) customer.tags = [];
    if (!customer.tags.includes('walk-in')) customer.tags.push('walk-in');
  }

  // Determine tier
  const visits = customer.visits;
  customer.loyaltyTier = visits >= 20 ? 'Gold' : visits >= 10 ? 'Silver' : 'Bronze';

  try {
    if (!fs.existsSync(path.join(DATA_DIR, id))) fs.mkdirSync(path.join(DATA_DIR, id), { recursive: true });
    fs.writeFileSync(crmFile, JSON.stringify(crm, null, 2));
  } catch(e) { return res.status(500).json({ error: 'Could not save customer' }); }

  const pointsAwarded = isNew ? 10 : 0;
  res.json({ success: true, isNew, customer, pointsAwarded });
});

// ── WhatsApp Cloud API Config ─────────────────────────────────────────────────
app.get('/api/businesses/:id/whatsapp/status', requireAuth, (req, res) => {
  const { id } = req.params;
  const cfgFile = path.join(DATA_DIR, id, 'whatsapp_config.json');
  if (!fs.existsSync(cfgFile)) {
    return res.json({ configured: false, valid: false, phone: null, verifyToken: null });
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf-8'));
    return res.json({
      configured: !!(cfg.phoneNumberId && cfg.accessToken),
      valid: !!(cfg.phoneNumberId && cfg.accessToken),
      phone: cfg.phoneNumber || null,
      verifyToken: cfg.verifyToken || null
    });
  } catch(e) {
    return res.json({ configured: false, valid: false, phone: null, verifyToken: null });
  }
});

app.post('/api/businesses/:id/whatsapp/setup', requireAuth, requireBranchAccess, (req, res) => {
  const { id } = req.params;
  const { phoneNumberId, accessToken, phoneNumber } = req.body;
  if (!phoneNumberId || !accessToken) {
    return res.status(400).json({ error: 'phoneNumberId and accessToken required' });
  }
  const branchDir = path.join(DATA_DIR, id);
  if (!fs.existsSync(branchDir)) fs.mkdirSync(branchDir, { recursive: true });

  const verifyToken = 'cafehq_' + id + '_' + Math.random().toString(36).slice(2, 10);
  const cfg = { phoneNumberId, accessToken, phoneNumber: phoneNumber || '', verifyToken, updatedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(branchDir, 'whatsapp_config.json'), JSON.stringify(cfg, null, 2));

  res.json({ success: true, verifyToken });
});

// ── First-run setup checklist (UI2) ───────────────────────────────────────────
function loadSetupFlags(id) {
  const file = path.join(DATA_DIR, id, 'setup.json');
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch(e) {}
  return { menuDone: false, qrDone: false, dismissed: false };
}
function saveSetupFlags(id, flags) {
  const dir = path.join(DATA_DIR, id);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'setup.json'), JSON.stringify(flags, null, 2));
}
// Exposed so other route modules (menu save) can mark a step done without
// duplicating the read/merge/write logic.
ctx.markSetupStepDone = function(id, key) {
  try {
    const flags = loadSetupFlags(id);
    if (!flags[key]) { flags[key] = true; saveSetupFlags(id, flags); }
  } catch(e) { console.error('[setup] markSetupStepDone failed:', e.message); }
};

app.get('/api/businesses/:id/setup-status', requireAuth, requireBranchAccess, (req, res) => {
  const { id } = req.params;
  const flags = loadSetupFlags(id);
  const waConfigured = fs.existsSync(path.join(DATA_DIR, id, 'whatsapp_config.json'));
  let whatsappConnected = false;
  if (waConfigured) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(DATA_DIR, id, 'whatsapp_config.json'), 'utf-8'));
      whatsappConnected = !!(cfg.phoneNumberId && cfg.accessToken);
    } catch(e) {}
  }
  let hasFirstOrder = false;
  if (db) {
    try { hasFirstOrder = db.raw().prepare('SELECT COUNT(*) c FROM orders WHERE business_id=?').get(id).c > 0; }
    catch(e) {}
  }
  res.json({
    menuDone: !!flags.menuDone,
    qrDone: !!flags.qrDone,
    dismissed: !!flags.dismissed,
    whatsappConnected,
    hasFirstOrder,
  });
});

app.post('/api/businesses/:id/setup-status', requireAuth, requireBranchAccess, (req, res) => {
  const { id } = req.params;
  const flags = loadSetupFlags(id);
  const { menuDone, qrDone, dismissed } = req.body;
  if (menuDone !== undefined) flags.menuDone = !!menuDone;
  if (qrDone !== undefined) flags.qrDone = !!qrDone;
  if (dismissed !== undefined) flags.dismissed = !!dismissed;
  saveSetupFlags(id, flags);
  res.json({ success: true, ...flags });
});

// ── Accounting / Expenses ─────────────────────────────────────────────────────
app.get('/api/businesses/:id/accounting/expenses', requireAuth, (req, res) => {
  const { id } = req.params;
  const { from, to, category } = req.query;
  const file = path.join(DATA_DIR, id, 'expenses.json');
  let expenses = [];
  try { if (fs.existsSync(file)) expenses = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch(e) {}

  // Normalise to snake_case so frontend template works regardless of storage format
  expenses = expenses.map(e => ({
    id:           e.id,
    category:     e.category || 'misc',
    amount:       e.amount || 0,
    gst_amount:   e.gst_amount ?? e.gstAmount ?? 0,
    description:  e.description || '',
    vendor:       e.vendor || '',
    receipt_no:   e.receipt_no ?? e.receiptNo ?? '',
    expense_date: e.expense_date ?? e.expenseDate ?? '',
    added_by:     e.added_by ?? e.addedBy ?? 'manager',
    created_at:   e.created_at ?? e.createdAt ?? ''
  }));

  let filtered = expenses;
  if (from) filtered = filtered.filter(e => e.expense_date >= from);
  if (to)   filtered = filtered.filter(e => e.expense_date <= to);
  if (category && category !== 'all') filtered = filtered.filter(e => e.category === category);

  // Return raw array — frontend does its own reduce for totals
  res.json(filtered);
});

app.post('/api/businesses/:id/accounting/expenses', requireAuth, requireBranchAccess, (req, res) => {
  const { id } = req.params;
  const { category, amount, description, vendor, expenseDate, gstAmount, receiptNo } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Valid amount required' });

  const branchDir = path.join(DATA_DIR, id);
  if (!fs.existsSync(branchDir)) fs.mkdirSync(branchDir, { recursive: true });

  const file = path.join(branchDir, 'expenses.json');
  let expenses = [];
  try { if (fs.existsSync(file)) expenses = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch(e) {}

  const entry = {
    id: 'exp_' + Date.now(),
    category: category || 'misc',
    amount: parseFloat(amount),
    gst_amount: parseFloat(gstAmount || 0),
    description: description || '',
    vendor: vendor || '',
    receipt_no: receiptNo || '',
    expense_date: expenseDate || new Date().toISOString().slice(0, 10),
    added_by: 'manager',
    created_at: new Date().toISOString()
  };
  expenses.push(entry);
  fs.writeFileSync(file, JSON.stringify(expenses, null, 2));
  res.json({ success: true, expense: entry });
});

app.delete('/api/businesses/:id/accounting/expenses/:expId', requireAuth, requireBranchAccess, (req, res) => {
  const { id, expId } = req.params;
  const file = path.join(DATA_DIR, id, 'expenses.json');
  let expenses = [];
  try { if (fs.existsSync(file)) expenses = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch(e) {}
  const before = expenses.length;
  expenses = expenses.filter(e => e.id !== expId);
  if (expenses.length === before) return res.status(404).json({ error: 'Expense not found' });
  fs.writeFileSync(file, JSON.stringify(expenses, null, 2));
  res.json({ success: true });
});

// ── At-Risk Customers ─────────────────────────────────────────────────────────
app.get('/api/businesses/:id/at-risk-customers', requireAuth, (req, res) => {
  const { id } = req.params;
  const crmFile = path.join(DATA_DIR, id, 'crm.json');
  let crm = [];
  try { if (fs.existsSync(crmFile)) crm = JSON.parse(fs.readFileSync(crmFile, 'utf-8')); } catch(e) {}

  const now = Date.now();
  const RISK_DAYS = 21; // customers who haven't visited in 21+ days

  const atRisk = crm
    .filter(c => {
      if (!c.lastVisit) return false;
      const daysSince = (now - new Date(c.lastVisit).getTime()) / 86400000;
      return daysSince >= RISK_DAYS && c.visits >= 2; // only regulars, not one-timers
    })
    .map(c => {
      const daysSince = Math.floor((now - new Date(c.lastVisit).getTime()) / 86400000);
      return { ...c, daysSince, daysSinceLastVisit: daysSince };
    })
    .sort((a, b) => b.daysSinceLastVisit - a.daysSinceLastVisit)
    .slice(0, 20);

  res.json(atRisk);
});

app.post('/api/businesses/:id/at-risk-customers/send-offer', async (req, res) => {
  const { id } = req.params;
  const { phone, name, offerText } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone required' });

  // Try to send via WhatsApp Cloud API if configured
  const cfgFile = path.join(DATA_DIR, id, 'whatsapp_config.json');
  let sent = false;
  if (fs.existsSync(cfgFile)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf-8'));
      if (cfg.phoneNumberId && cfg.accessToken) {
        const fetch = (...a) => import('node-fetch').then(m => m.default(...a)).catch(() => null);
        const msg = offerText || `Hi ${name || 'there'}! We miss you at our café ☕ Come back and enjoy a special 15% off on your next visit — just for you! 🎁`;
        const body = {
          messaging_product: 'whatsapp',
          to: '91' + phone.replace(/\D/g,'').slice(-10),
          type: 'text',
          text: { body: msg }
        };
        const r = await fetch('https://graph.facebook.com/v18.0/' + cfg.phoneNumberId + '/messages', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + cfg.accessToken, 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        if (r && r.ok) sent = true;
      }
    } catch(e) {}
  }

  res.json({ success: true, sent, message: sent ? 'WhatsApp message sent!' : 'Offer logged (WhatsApp not configured)' });
});

// ── AI Re-engagement Offer Generator ─────────────────────────────────────────
app.post('/api/businesses/:id/customers/:phone/ai-offer', (req, res) => {
  const { id, phone } = req.params;
  const cleanPhone = phone.replace(/\D/g, '').slice(-10);
  const crmFile = path.join(DATA_DIR, id, 'crm.json');
  let crm = [];
  try { if (fs.existsSync(crmFile)) crm = JSON.parse(fs.readFileSync(crmFile, 'utf-8')); } catch(e) {}

  const customer = crm.find(c => c.phone === cleanPhone || c.phone === phone);
  const name = customer ? customer.name : 'Valued Customer';
  const visits = customer ? (customer.visits || 1) : 1;

  // Generate a personalised offer based on visit count
  let offerText;
  if (visits >= 20) {
    offerText = `Hi ${name}! As one of our most loyal guests, enjoy a FREE coffee on us — just show this message on your next visit! ☕🎁`;
  } else if (visits >= 10) {
    offerText = `Hi ${name}! We miss you! Come back for 20% off your next order — valid this week only. Hope to see you soon! 😊`;
  } else if (visits >= 5) {
    offerText = `Hi ${name}! It's been a while ☕ Enjoy a flat 15% off your next visit — our way of saying we miss you!`;
  } else {
    offerText = `Hi ${name}! We haven't seen you lately. Come back and enjoy a special ₹50 off your next order — just for you! 🎉`;
  }

  res.json({ success: true, offerText, name, phone: cleanPhone });
});

// ── Customer Insights (for CRM panel) ────────────────────────────────────────
app.get('/api/businesses/:id/customers/:phone/insights', (req, res) => {
  const { id, phone } = req.params;
  const cleanPhone = phone.replace(/\D/g, '').slice(-10);
  const crmFile = path.join(DATA_DIR, id, 'crm.json');
  let crm = [];
  try { if (fs.existsSync(crmFile)) crm = JSON.parse(fs.readFileSync(crmFile, 'utf-8')); } catch(e) {}

  const customer = crm.find(c => c.phone === cleanPhone || c.phone === phone);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  // Build insights from order history
  const orderFile = path.join(DATA_DIR, id, 'orders.json');
  let orders = [];
  try { if (fs.existsSync(orderFile)) orders = JSON.parse(fs.readFileSync(orderFile, 'utf-8')); } catch(e) {}

  const custOrders = orders.filter(o => (o.phone || o.customerPhone || '').replace(/\D/g,'').slice(-10) === cleanPhone);
  const totalSpend = custOrders.reduce((s, o) => s + (o.total || 0), 0);
  const avgSpend   = custOrders.length ? Math.round(totalSpend / custOrders.length) : 0;
  const now = Date.now();
  const daysSince = customer.lastVisit ? Math.floor((now - new Date(customer.lastVisit).getTime()) / 86400000) : null;

  // Favourite items
  const itemCounts = {};
  custOrders.forEach(o => (o.items || []).forEach(i => { itemCounts[i.name] = (itemCounts[i.name] || 0) + (i.qty || 1); }));
  const favourites = Object.entries(itemCounts).map(([name, count]) => ({ name, count })).sort((a,b) => b.count - a.count);

  // Peak day/hour
  const dayCounts = {}, hourCounts = {};
  custOrders.forEach(o => {
    const d = new Date(o.created_at || o.createdAt);
    const day  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()];
    const hour = d.getHours();
    dayCounts[day]  = (dayCounts[day]  || 0) + 1;
    hourCounts[hour]= (hourCounts[hour]|| 0) + 1;
  });
  const peakDay  = Object.entries(dayCounts).sort((a,b)=>b[1]-a[1])[0]?.[0] || 'N/A';
  const peakHour = Object.entries(hourCounts).sort((a,b)=>b[1]-a[1])[0]
    ? (()=>{ const h=+Object.entries(hourCounts).sort((a,b)=>b[1]-a[1])[0][0]; return (h%12||12)+':00 '+(h<12?'AM':'PM'); })()
    : 'N/A';

  const totalVisits = customer.visits || custOrders.length || 1;
  const daysSinceLast = daysSince ?? (customer.lastVisit ? 0 : 99);
  const segment = daysSinceLast > 60 ? 'lost' : daysSinceLast > 30 ? 'at_risk' : totalVisits >= 10 ? 'loyal' : totalVisits >= 5 ? 'regular' : totalVisits >= 2 ? 'returning' : 'new';

  res.json({
    name: customer.name, phone: cleanPhone,
    totalVisits, totalSpend: Math.round(totalSpend), avgSpend,
    daysSinceLastVisit: daysSinceLast, lastVisit: customer.lastVisit,
    peakDay, peakHour, favourites, segment
  });
});


// ── Expense URL aliases (short form for manager portal) ──────────────────────
app.get('/api/businesses/:id/expenses', requireAuth, requireBranchAccess, (req, res) => {
  // proxy to full accounting path
  req.url = req.url.replace('/expenses', '/accounting/expenses');
  const id = req.params.id;
  const file = path.join(DATA_DIR, id, 'expenses.json');
  let expenses = [];
  try { if (fs.existsSync(file)) expenses = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch(e) {}
  const month = req.query.month;
  const cat   = req.query.category;
  if (month) expenses = expenses.filter(e => (e.expense_date||e.date||'').startsWith(month));
  if (cat)   expenses = expenses.filter(e => e.category === cat);
  res.json(expenses);
});

app.post('/api/businesses/:id/expenses', requireAuth, requireBranchAccess, (req, res) => {
  const id = req.params.id;
  const branchDir = path.join(DATA_DIR, id);
  if (!fs.existsSync(branchDir)) fs.mkdirSync(branchDir, { recursive: true });
  const file = path.join(branchDir, 'expenses.json');
  let expenses = [];
  try { if (fs.existsSync(file)) expenses = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch(e) {}
  const { category, amount, description, vendor, date, gst, receipt } = req.body;
  if (!category || !amount) return res.status(400).json({ error: 'category and amount required' });
  const entry = {
    id: 'exp_' + Date.now(),
    category, description: description||'', vendor: vendor||'', amount: parseFloat(amount)||0,
    expense_date: date || new Date().toISOString().slice(0,10),
    gst_amount: parseFloat(gst)||0, receipt_no: receipt||'',
    createdAt: new Date().toISOString()
  };
  expenses.unshift(entry);
  fs.writeFileSync(file, JSON.stringify(expenses, null, 2));
  res.json(entry);
});



// ─── Agency Settings (API keys manageable from HQ UI) ────────────────────────

const AGENCY_SETTINGS_FILE = path.join(DATA_DIR, 'agency-settings.json');

function loadAgencySettings() {
  try {
    if (fs.existsSync(AGENCY_SETTINGS_FILE))
      return JSON.parse(fs.readFileSync(AGENCY_SETTINGS_FILE, 'utf8'));
  } catch(e) {}
  return {};
}

function saveAgencySettings(data) {
  fs.writeFileSync(AGENCY_SETTINGS_FILE, JSON.stringify(data, null, 2));
}

// Helper: mask a secret string — show last 4 chars only
function maskSecret(val) {
  if (!val || val.length < 6) return val ? '••••' : '';
  return '••••••••' + val.slice(-4);
}

// GET /api/settings — admin only, returns masked values
app.get('/api/settings', requireAuth, requireRole('agency_admin'), (req, res) => {
  const s = loadAgencySettings();
  res.json({
    baseUrl: s.baseUrl || '',
    whatsapp: {
      phoneNumberId: s.whatsapp?.phoneNumberId || '',
      accessToken:   maskSecret(s.whatsapp?.accessToken),
      verifyToken:   s.whatsapp?.verifyToken   || '',
    },
    gemini: {
      apiKey: maskSecret(s.gemini?.apiKey),
    },
    vapid: {
      public:  s.vapid?.public  || '',
      private: maskSecret(s.vapid?.private),
      email:   s.vapid?.email   || '',
    },
    updatedAt: s.updatedAt || null,
    updatedBy: s.updatedBy || null,
  });
});

// PUT /api/settings — admin only, merges + saves
app.put('/api/settings', requireAuth, requireRole('agency_admin'), (req, res) => {
  const s = loadAgencySettings();
  const b = req.body;

  // Merge only provided non-masked values
  const isMasked = v => typeof v === 'string' && v.startsWith('••••');

  if (b.baseUrl !== undefined) s.baseUrl = b.baseUrl;

  if (b.whatsapp) {
    s.whatsapp = s.whatsapp || {};
    if (b.whatsapp.phoneNumberId !== undefined) s.whatsapp.phoneNumberId = b.whatsapp.phoneNumberId;
    if (b.whatsapp.accessToken   !== undefined && !isMasked(b.whatsapp.accessToken))
      s.whatsapp.accessToken = b.whatsapp.accessToken;
    if (b.whatsapp.verifyToken   !== undefined) s.whatsapp.verifyToken = b.whatsapp.verifyToken;
  }

  if (b.gemini) {
    s.gemini = s.gemini || {};
    if (b.gemini.apiKey !== undefined && !isMasked(b.gemini.apiKey))
      s.gemini.apiKey = b.gemini.apiKey;
  }

  if (b.vapid) {
    s.vapid = s.vapid || {};
    if (b.vapid.public  !== undefined) s.vapid.public  = b.vapid.public;
    if (b.vapid.private !== undefined && !isMasked(b.vapid.private))
      s.vapid.private = b.vapid.private;
    if (b.vapid.email   !== undefined) s.vapid.email   = b.vapid.email;
  }

  s.updatedAt = new Date().toISOString();
  s.updatedBy = req.user?.username || 'admin';

  // Sync live process.env so changes take effect without restart
  if (s.baseUrl)                 process.env.BASE_URL          = s.baseUrl;
  if (s.whatsapp?.phoneNumberId) process.env.WA_PHONE_NUMBER_ID = s.whatsapp.phoneNumberId;
  if (s.whatsapp?.accessToken)   process.env.WA_ACCESS_TOKEN   = s.whatsapp.accessToken;
  if (s.whatsapp?.verifyToken)   process.env.WA_VERIFY_TOKEN   = s.whatsapp.verifyToken;
  if (s.gemini?.apiKey)          process.env.GEMINI_API_KEY    = s.gemini.apiKey;
  if (s.vapid?.public)           process.env.VAPID_PUBLIC      = s.vapid.public;
  if (s.vapid?.private)          process.env.VAPID_PRIVATE     = s.vapid.private;
  if (s.vapid?.email)            process.env.VAPID_EMAIL       = s.vapid.email;

  saveAgencySettings(s);
  res.json({ success: true, updatedAt: s.updatedAt });
});

// ─── Branch Settings (Razorpay per branch) ───────────────────────────────────

const BRANCH_SETTINGS_FILE = 'branch-settings.json';

function loadBranchSettings(businessId) {
  try {
    const data = getBranchData(businessId, BRANCH_SETTINGS_FILE);
    // getBranchData returns [] when file is missing — we need {}
    if (!data || Array.isArray(data)) return {};
    return data;
  } catch(e) { return {}; }
}

function saveBranchSettings(businessId, data) {
  writeBranchData(businessId, BRANCH_SETTINGS_FILE, data);
}

// GET /api/businesses/:id/settings — manager/owner/admin
app.get('/api/businesses/:id/settings', requireAuth, requireBranchAccess, (req, res) => {
  const s = loadBranchSettings(req.params.id);
  res.json({
    razorpay: {
      keyId:     s.razorpay?.keyId     || '',
      keySecret: maskSecret(s.razorpay?.keySecret),
    },
    aiMaxDiscount: Number.isFinite(s.aiMaxDiscount) ? s.aiMaxDiscount : 0,
    updatedAt: s.updatedAt || null,
    updatedBy: s.updatedBy || null,
  });
});

// PUT /api/businesses/:id/settings — manager/owner/admin
app.put('/api/businesses/:id/settings', requireAuth, requireBranchAccess, (req, res) => {
  const s = loadBranchSettings(req.params.id);
  const b = req.body;
  const isMasked = v => typeof v === 'string' && v.startsWith('••••');

  if (b.razorpay) {
    s.razorpay = s.razorpay || {};
    if (b.razorpay.keyId     !== undefined) s.razorpay.keyId = b.razorpay.keyId;
    if (b.razorpay.keySecret !== undefined && !isMasked(b.razorpay.keySecret))
      s.razorpay.keySecret = b.razorpay.keySecret;
  }

  if (b.aiMaxDiscount !== undefined) {
    s.aiMaxDiscount = Math.max(0, Math.min(100, Math.round(Number(b.aiMaxDiscount) || 0)));
  }

  s.updatedAt = new Date().toISOString();
  s.updatedBy = req.user?.username || 'unknown';
  saveBranchSettings(req.params.id, s);
  res.json({ success: true, updatedAt: s.updatedAt });
});
};
