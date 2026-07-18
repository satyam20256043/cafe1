require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
// ROOT_DIR works whether run as `node server.js` (from root) or `node data/server.js`
const ROOT_DIR = path.basename(__dirname) === 'data' ? path.join(__dirname, '..') : __dirname;
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ── WhatsApp Cloud API (lightweight, no Chromium) ─────────────────────────────
let waApi = null;
try {
  waApi = require('./whatsapp-api');
  console.log('[WhatsApp] Cloud API module loaded ✓');
} catch(e) {
  console.warn('[WhatsApp] Cloud API not available:', e.message);
}
// Legacy stubs (kept for compatibility — all null, not used)
let Client = null, LocalAuth = null, qrcode = null, whatsappClient = null;
// ── Phase 1 modules (SQLite + Auth + Backup) ─────────────────────────────────
let db, auth, backup;
try {
  db     = require('./db');
  auth   = require('./auth');
  backup = require('./backup');
  console.log('[Phase1] ✓ SQLite + Auth + Backup modules loaded');
} catch(e) {
  console.warn('[Phase1] ⚠ Modules not found, running in legacy JSON mode:', e.message);
}


// Initialize Gemini API client if API key is provided.
// GEMINI_MODEL env var switches models without a code change (pulled forward
// from AI5 of docs/ZORDIC_AI_RECEPTIONIST_GUIDE.md — free-tier quotas are
// per-model, so the ability to switch matters even while dogfooding).
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;
if (genAI) {
  console.log(`[AI Engine] Google Gemini LLM Mode Active 🚀 (model: ${GEMINI_MODEL})`);
} else {
  console.log('[AI Engine] Local Conversational NLP Mode Active (Fallback) 🤖');
}

// Premium AI tier (user decision 2026-07-11, extended 2026-07-12): cafés on
// growth/pro plans get Claude Haiku as the receptionist brain with no cap.
// Starter cafés ALSO get Claude Haiku, but only STARTER_CLAUDE_DAILY_LIMIT
// replies per day — Haiku only, no Gemini fallback; once the day's cap is spent
// the AI stays silent (deliberate nudge to upgrade). Trial cafés (no plan yet)
// and everyone else use Gemini. Requires ANTHROPIC_API_KEY in .env — without it
// everything silently stays on Gemini (ground rule: every AI feature has a fallback).
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
const PREMIUM_AI_PLANS = ['growth', 'pro'];
const STARTER_CLAUDE_DAILY_LIMIT = parseInt(process.env.STARTER_CLAUDE_DAILY_LIMIT, 10) || 30;
let anthropic = null;
if (process.env.ANTHROPIC_API_KEY) {
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    console.log(`[AI Engine] Claude premium tier active ✨ (model: ${CLAUDE_MODEL}, unlimited: ${PREMIUM_AI_PLANS.join('/')}, starter cap: ${STARTER_CLAUDE_DAILY_LIMIT}/day)`);
  } catch (e) {
    console.error('[AI Engine] Claude SDK init failed, premium tier disabled:', e.message);
  }
}

// Local date key (YYYY-MM-DD) for the daily Starter Haiku quota; resets at the
// server's local midnight.
function aiUsageDateKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Which LLM answers for this branch on THIS message:
//   'claude'        → growth/pro: Claude Haiku, unlimited (Gemini safety-net on failure)
//   'claude_capped' → starter:    Claude Haiku, up to STARTER_CLAUDE_DAILY_LIMIT/day
//   'silent'        → starter over today's cap: send nothing (no Gemini, no local reply)
//   'gemini'        → trial / no Claude key / anything else
function aiDecisionForBranch(branchId) {
  const business = businesses.find(b => b.id === branchId);
  // Two plan fields exist historically: Razorpay checkout writes `plan`, the HQ
  // manual assignment endpoint writes `subscriptionPlan`. Read both (writers now
  // keep them in sync, but old records may have only one).
  const plan = business && (business.plan || business.subscriptionPlan);
  if (anthropic && PREMIUM_AI_PLANS.includes(plan)) return 'claude';
  if (anthropic && plan === 'starter') {
    if (!db) return 'gemini'; // no meter available → stay on Gemini rather than bill Claude uncapped
    const used = db.getClaudeUsageToday(branchId, aiUsageDateKey());
    return used < STARTER_CLAUDE_DAILY_LIMIT ? 'claude_capped' : 'silent';
  }
  return 'gemini';
}


const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3080;

// ── Tenant-scoped realtime rooms (Phase 0 fix for cross-tenant broadcasting) ──
// biz:<id>:public — events safe for unauthenticated customer pages (order status)
// biz:<id>:staff  — CRM/chat/feedback/loyalty events; requires a branch JWT to join
// agency          — agency_admin/admin dashboards; receives every branch's events
function emitToBranch(branchId, event, payload, opts = {}) {
  let op = io.to(`biz:${branchId}:staff`).to('agency');
  if (opts.public) op = op.to(`biz:${branchId}:public`);
  op.emit(event, payload);
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(ROOT_DIR, 'public')));

// Serve custom isolated branch microsites

// Staff login page
app.get('/login', (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'public', 'login.html'));
});

// Per-café login page — locks the branch, no dropdown (see UI1)
app.get('/login/:branchId', (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'public', 'login.html'));
});

// Agency admin login (platform operator only — no branch selector)
app.get('/admin-login', (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'public', 'admin-login.html'));
});

app.get('/cafe/:id', (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'public', 'cafe.html'));
});

// Serve branch manager dashboards
app.get('/manager/:id', (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'public', 'manager.html'));
});
// ── Table QR Ordering — Customer menu page ───────────────────────────────────
app.get('/order/:id', (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'public', 'table-order.html'));
});

// ── Kitchen Display System ────────────────────────────────────────────────────
app.get('/kitchen/:id', (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'public', 'kitchen.html'));
});

// ── Café Owner Portal ─────────────────────────────────────────────────────────
app.get('/portal', (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'public', 'portal.html'));
});
app.get('/portal/:id', (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'public', 'portal.html'));
});

// ── Franchise HQ (Agency / Admin view) ───────────────────────────────────────
app.get('/onboard', (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'public', 'onboard.html'));
});

// ── Sales pitch deck (share with prospective café owners) ────────────────────
app.get('/pitch', (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'public', 'pitch.html'));
});

app.get('/hq', (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'public', 'hq.html'));
});

// ── Owner portal legacy route ─────────────────────────────────────────────────
app.get('/owner/:id', (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'public', 'owner.html'));
});


// Directories setup
const DATA_DIR = path.join(ROOT_DIR, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// Load or Seed Businesses
const BUSINESSES_FILE = path.join(DATA_DIR, 'businesses.json');
let businesses = [];

function loadBusinesses() {
  if (fs.existsSync(BUSINESSES_FILE)) {
    businesses = JSON.parse(fs.readFileSync(BUSINESSES_FILE, 'utf-8'));
  } else {
    businesses = [
      {
        id: 'indiranagar',
        name: 'The Roasted Bean',
        location: '12th Main Road, Indiranagar, Bengaluru',
        timings: '9:00 AM - 11:00 PM',
        contact: '+91 98765 43210',
        map: 'https://maps.google.com/?q=Roasted+Bean+Indiranagar',
        wifi: 'RoastedBean_Guest / Coffee123',
        review: 'https://g.page/r/roasted-bean-indira',
        status: 'online'
      },
      {
        id: 'koramangala',
        name: 'Mocha & Co.',
        location: '5th Block, Koramangala, Bengaluru',
        timings: '10:00 AM - 12:00 AM',
        contact: '+91 87654 32109',
        map: 'https://maps.google.com/?q=Mocha+Koramangala',
        wifi: 'Mocha_Kora_5G / EspressoHigh',
        review: 'https://g.page/r/mocha-kora',
        status: 'offline'
      }
    ];
    fs.writeFileSync(BUSINESSES_FILE, JSON.stringify(businesses, null, 2));
  }
  // Initialize data folders for each business
  businesses.forEach(b => initializeBusinessFiles(b.id));
}

// Initialize specific branch folders and seed files
function initializeBusinessFiles(id) {
  const branchDir = path.join(DATA_DIR, id);
  if (!fs.existsSync(branchDir)) fs.mkdirSync(branchDir);

  const menuFile = path.join(branchDir, 'menu.json');
  if (!fs.existsSync(menuFile)) {
    const defaultMenu = [
      { id: '1', name: 'Cold Coffee', category: 'Coffee', price: 149, discount: 0, description: 'Signature rich cold coffee blended with vanilla ice cream and topped with cocoa powder.' },
      { id: '2', name: 'Peri Peri Fries', category: 'Fries', price: 119, discount: 10, description: 'Crispy golden fries tossed in our signature spicy peri peri seasoning.' },
      { id: '3', name: 'Alfredo Pasta', category: 'Pasta', price: 229, discount: 0, description: 'Rich and creamy penne pasta tossed in garlic parmesan white sauce with mushrooms.' },
      { id: '4', name: 'Classic Cheese Burger', category: 'Burgers', price: 179, discount: 20, description: "Juicy flame-grilled burger patty topped with cheddar cheese, lettuce, tomatoes, and chef's special burger sauce." },
      { id: '5', name: 'Virgin Mojito', category: 'Mocktails', price: 139, discount: 0, description: 'Refreshing summer cooler made with fresh mint leaves, lime wedges, simple syrup, and sparkling soda.' },
      { id: '6', name: 'Coffee & Burger Combo', category: 'Combo', price: 299, discount: 15, description: 'Classic Cheese Burger paired with our signature Cold Coffee. The ultimate pick-me-up meal.' },
      { id: '7', name: 'Pasta & Mojito Combo', category: 'Combo', price: 349, discount: 10, description: 'Alfredo Pasta served with a refreshing glass of Virgin Mojito. Complete delicious lunch combo.' }
    ];
    fs.writeFileSync(menuFile, JSON.stringify(defaultMenu, null, 2));
  }

  const reservationsFile = path.join(branchDir, 'reservations.json');
  if (!fs.existsSync(reservationsFile)) {
    const defaultReservations = [
      { id: 'r1', name: 'Rahul Sharma', phone: '9876543210', guests: 4, datetime: 'Friday 7:30 PM', status: 'approved' },
      { id: 'r2', name: 'Priya Patel', phone: '8765432109', guests: 2, datetime: 'Saturday 8:00 PM', status: 'pending' }
    ];
    fs.writeFileSync(reservationsFile, JSON.stringify(defaultReservations, null, 2));
  }

  const customerProfilesFile = path.join(branchDir, 'customer_profiles.json');
  if (!fs.existsSync(customerProfilesFile)) {
    const defaultProfiles = [
      { phone: '9876543210', name: 'Rahul Sharma', visits: 3, tags: ['interested_in_coffee', 'frequent_booker'] },
      { phone: '8765432109', name: 'Priya Patel', visits: 1, tags: ['asked_for_offers', 'interested_in_burgers'] }
    ];
    fs.writeFileSync(customerProfilesFile, JSON.stringify(defaultProfiles, null, 2));
  }

  const trafficStatsFile = path.join(branchDir, 'traffic_stats.json');
  if (!fs.existsSync(trafficStatsFile)) {
    // Generate realistic multi-day hourly traffic
    const defaultTraffic = {
      Monday: [5, 3, 2, 4, 8, 12, 10, 5],
      Tuesday: [4, 2, 3, 5, 7, 10, 9, 4],
      Wednesday: [6, 4, 3, 5, 8, 11, 12, 6],
      Thursday: [5, 4, 4, 6, 9, 13, 11, 7],
      Friday: [12, 9, 8, 15, 22, 28, 30, 24],
      Saturday: [18, 14, 15, 20, 32, 45, 42, 35],
      Sunday: [15, 12, 11, 18, 28, 38, 35, 28]
    };
    fs.writeFileSync(trafficStatsFile, JSON.stringify(defaultTraffic, null, 2));
  }

  const settingsFile = path.join(branchDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    const defaultSettings = {
      autoPilotActive: true,
      lowTrafficCampaigns: [
        { day: 'Tuesday', offer: 'Tuesday Coffee Bonanza - Free Cookie with any Hot Coffee! 🍪☕' },
        { day: 'Wednesday', offer: 'Midweek Pasta Madness - Buy 1 Get 1 50% Off on Alfredo Pasta! 🍝' }
      ]
    };
    fs.writeFileSync(settingsFile, JSON.stringify(defaultSettings, null, 2));
  }

  const offerRequestsFile = path.join(branchDir, 'offer_requests.json');
  if (!fs.existsSync(offerRequestsFile)) {
    const defaultOffers = [];
    fs.writeFileSync(offerRequestsFile, JSON.stringify(defaultOffers, null, 2));
  }

  const reviewClaimsFile = path.join(branchDir, 'google_review_claims.json');
  if (!fs.existsSync(reviewClaimsFile)) {
    fs.writeFileSync(reviewClaimsFile, JSON.stringify([], null, 2));
  }

  const feedbackFile = path.join(branchDir, 'feedback.json');
  if (!fs.existsSync(feedbackFile)) {
    const defaultFeedback = [
      { id: 'f1', customerName: 'Rohan Mehta', rating: 5, comment: 'Bhai, cold coffee ekdum lajawab thi! Aur staff bhi bohot friendly hai. Will visit again! ☕😊', timestamp: 'Friday 9:00 PM' },
      { id: 'f2', customerName: 'Sneha Sen', rating: 3, comment: 'Alfredo Pasta was a bit dry, but the burger and mojito were great! Nice vibe.', timestamp: 'Saturday 7:30 PM' }
    ];
    fs.writeFileSync(feedbackFile, JSON.stringify(defaultFeedback, null, 2));
  }
}

loadBusinesses();


// ── Phase 1 Boot: Auth seeds + Backup scheduler ───────────────────────────────
if (db && auth) {
  try {
    db.migrateFromJSON();   // JSON → SQLite on first run
    businesses.forEach(b => {
      auth.seedOwnerIfNeeded(b.id, b.name);
    });
    console.log('[Phase1] ✓ Auth seeds complete');
  } catch(e) {
    console.warn('[Phase1] Auth seed error:', e.message);
  }
}
if (backup) {
  backup.scheduleDaily();
}

// Shared active business for the real WhatsApp Web bot instance
let activeRealBotBusinessId = 'indiranagar';
// whatsappClient already declared above in optional deps block
let whatsappQrCodeDataUrl = null;
let whatsappConnectionStatus = 'Disconnected';

// Chat state memory: per business ID -> per sender number
const userStates = {};

// Get business details helper
function getBranchData(id, filename) {
  const filepath = path.join(DATA_DIR, id, filename);
  if (fs.existsSync(filepath)) {
    return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
  }
  return [];
}

// Write business details helper
function writeBranchData(id, filename, data) {
  const filepath = path.join(DATA_DIR, id, filename);
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
  return data;
}

// ── Subscription enforcement ──────────────────────────────────────────────────
const PLAN_FEATURES = {
  starter:    { tables: 5,  menu_items: 20, staff: 3,  analytics: false, whatsapp: false },
  pro:        { tables: 20, menu_items: 100,staff: 10, analytics: true,  whatsapp: true  },
  enterprise: { tables: 999,menu_items: 999,staff: 999,analytics: true,  whatsapp: true  },
};

function getSubscriptionStatus(business) {
  if (!business) return { ok: false, reason: 'Business not found' };
  const status = business.subscriptionStatus || 'trial';
  const end    = business.subscriptionEnd ? new Date(business.subscriptionEnd) : null;
  const now    = new Date();
  // `plan` (Razorpay checkout) and `subscriptionPlan` (HQ manual assignment) are
  // kept in sync by writers now, but read both for old records.
  const plan   = business.plan || business.subscriptionPlan || 'starter';
  if (status === 'active') return { ok: true, status: 'active', plan };
  if (status === 'trial') {
    if (!end || now < end) {
      const daysLeft = end ? Math.ceil((end - now) / 86400000) : 30;
      return { ok: true, status: 'trial', daysLeft, plan };
    }
    return { ok: false, status: 'expired', reason: 'Trial expired. Please upgrade to continue.' };
  }
  if (status === 'expired') return { ok: false, status: 'expired', reason: 'Subscription expired.' };
  return { ok: true, status, plan };
}

function requireActiveSubscription(req, res, next) {
  const biz = businesses.find(b => b.id === req.params.id);
  const sub = getSubscriptionStatus(biz);
  if (!sub.ok) return res.status(402).json({ error: sub.reason, subscriptionRequired: true, status: sub.status });
  req.subscription = sub;
  next();
}

// ── API: get subscription status ──────────────────────────────────────────────
app.get('/api/businesses/:id/subscription', (req, res) => {
  const biz = businesses.find(b => b.id === req.params.id);
  if (!biz) return res.status(404).json({ error: 'Not found' });
  const sub = getSubscriptionStatus(biz);
  res.json({ ...sub, business: { name: biz.name, plan: biz.plan, ownerName: biz.ownerName } });
});

// ── API: upgrade plan (admin only) ────────────────────────────────────────────
app.post('/api/businesses/:id/subscription', requireAuth, requireRole('agency_admin', 'admin'), (req, res) => {
  const { plan, status, durationDays } = req.body;
  const biz = businesses.find(b => b.id === req.params.id);
  if (!biz) return res.status(404).json({ error: 'Not found' });
  if (plan) biz.plan = plan;
  if (status) biz.subscriptionStatus = status;
  if (durationDays) {
    const end = new Date();
    end.setDate(end.getDate() + parseInt(durationDays));
    biz.subscriptionEnd = end.toISOString();
  }
  fs.writeFileSync(BUSINESSES_FILE, JSON.stringify(businesses, null, 2));
  res.json({ success: true, business: biz, subscription: getSubscriptionStatus(biz) });
});


// -------------------------------------------------------------
// 🧠 AI Chatbot NLP Engine (Language, Dynamic Pricing & State)
// -------------------------------------------------------------
function detectLanguage(text) {
  const hindiRegex = /[\u0900-\u097F]/;
  if (hindiRegex.test(text)) return 'hindi';

  const hinglishWords = [
    'hai', 'kaha', 'kya', 'kab', 'bhai', 'batao', 'lo', 'timing', 'address', 'sasta', 
    'discount', 'kardo', 'milega', 'de do', 'achha', 'helo', 'namaste', 'shukriya', 'karna', 
    'humare', 'bestsellers', 'kitne', 'paise', 'bhejo', 'dikhao', 'kya hai', 'boliye', 'bataiye'
  ];
  const lowercaseText = text.toLowerCase();
  const words = lowercaseText.split(/\s+/);
  const hinglishCount = words.filter(w => hinglishWords.includes(w)).length;

  if (hinglishCount >= 1) return 'hinglish';
  return 'english';
}

function updateTrafficStats(branchId) {
  const stats = getBranchData(branchId, 'traffic_stats.json');
  const now = new Date();
  const day = now.toLocaleDateString('en-US', { weekday: 'long' });
  const hour = now.getHours();
  // Map 24h into our 8 buckets: [9-11am, 11am-1pm, 1-3pm, 3-5pm, 5-7pm, 7-9pm, 9-11pm, 11pm-1am]
  let bucket = 0;
  if (hour >= 9 && hour < 11) bucket = 0;
  else if (hour >= 11 && hour < 13) bucket = 1;
  else if (hour >= 13 && hour < 15) bucket = 2;
  else if (hour >= 15 && hour < 17) bucket = 3;
  else if (hour >= 17 && hour < 19) bucket = 4;
  else if (hour >= 19 && hour < 21) bucket = 5;
  else if (hour >= 21 && hour < 23) bucket = 6;
  else bucket = 7;

  if (stats[day]) {
    stats[day][bucket] = (stats[day][bucket] || 0) + 1;
    writeBranchData(branchId, 'traffic_stats.json', stats);
    emitToBranch(branchId, 'traffic_update', { branchId, stats });
  }
}

function getLoyaltyTier(visits) {
  if (visits >= 10) return 'Elite';
  if (visits >= 5) return 'VIP';
  if (visits >= 2) return 'Regular';
  return 'New Customer';
}

function updateCustomerProfile(branchId, phone, name, lastIntent, additionalFields = {}) {
  const profiles = getBranchData(branchId, 'customer_profiles.json');
  let profile = profiles.find(p => p.phone === phone);
  const isNewCustomer = !profile;
  if (!profile) {
    profile = {
      phone,
      name: name || 'Customer',
      visits: 0,
      tags: [],
      lastActive: new Date().toLocaleString(),
      averageRating: 0,
      feedbackCount: 0,
      offersReceived: []
    };
    profiles.push(profile);
  }

  profile.visits += 1;
  if (db) db.logEvent(branchId, isNewCustomer ? 'customer.new' : 'customer.repeat',
    { customerPhone: phone, actor: 'system', metadata: { visits: profile.visits, lastIntent: lastIntent || null } });
  profile.lastActive = new Date().toLocaleString();
  
  if (name) profile.name = name;
  
  // Merge any additional fields
  for (const [key, value] of Object.entries(additionalFields)) {
    profile[key] = value;
  }
  
  // Compute loyalty tier
  profile.loyaltyTier = getLoyaltyTier(profile.visits);
  
  if (lastIntent && !profile.tags.includes(lastIntent)) {
    profile.tags.push(lastIntent);
  }
  writeBranchData(branchId, 'customer_profiles.json', profiles);
  emitToBranch(branchId, 'crm_update', { branchId, profiles });
}

// AI Helper: receptionist prompt builder (Phase 4 — Loyalty Aware) — shared by
// every provider so Gemini and Claude answer from identical context, including
// the INTENT protocol rules.
// ── AI3: Café knowledge base ("Teach your AI") ────────────────────────────────
// Owner-authored Q&A facts stored in data/<branchId>/knowledge.json. The AI
// answers ONLY from these (never guesses café facts); unanswered topics keep
// escalating. Two ways to teach: the Settings form, and a WhatsApp interview
// that asks the owner each unanswered suggested question one at a time.
const SUGGESTED_KNOWLEDGE_QUESTIONS = [
  'Is parking available? Where?',
  'Is the café pure-veg, or veg + non-veg?',
  'Do you deliver? (Zomato / Swiggy / own delivery)',
  'Which payment methods do you accept?',
  'Is there outdoor seating?',
  'Is the café air-conditioned?',
  'Is it kids-friendly?',
  'Are pets allowed?',
  'Do you do birthday / event decorations?',
  'How big a group can you seat together?',
  'Do you serve alcohol?',
  'How long is the typical wait at peak hours?',
];

const knowledgeInterviews = {}; // branchId -> { phone10, queue, idx, savedCount }

function startKnowledgeInterview(branchId) {
  const business = businesses.find(b => b.id === branchId);
  if (!business) return { success: false, error: 'Business not found' };
  const ownerPhone10 = String(business.ownerPhone || '').replace(/[^0-9]/g, '').slice(-10);
  if (!ownerPhone10) return { success: false, error: "No owner phone saved for this café — add it in Settings first" };
  const cfg = getWaConfig(branchId);
  if (!cfg?.phoneNumberId || !cfg?.accessToken) {
    return { success: false, error: "Connect WhatsApp first (Settings → WhatsApp) — the interview happens on the owner's WhatsApp" };
  }
  const knowledge = getBranchData(branchId, 'knowledge.json');
  const answered = new Set(knowledge.filter(k => k && k.a && String(k.a).trim()).map(k => k.q));
  const queue = SUGGESTED_KNOWLEDGE_QUESTIONS.filter(q => !answered.has(q));
  if (!queue.length) return { success: false, error: 'All suggested questions already have answers — add custom ones in the form' };
  knowledgeInterviews[branchId] = { phone10: ownerPhone10, queue, idx: 0, savedCount: 0 };
  const intro = `📚 *Teach your AI* — I'll ask ${queue.length} quick questions about your café. Reply with the answer, or "skip" to skip one, or "stop" to finish anytime.\n\nQ1: ${queue[0]}`;
  sendWhatsAppToCustomer(branchId, business.ownerPhone, intro).catch(() => {});
  return { success: true, questions: queue.length };
}

// Returns the next interview message when this inbound message IS the owner
// answering an active interview; null otherwise (normal customer processing).
function handleKnowledgeInterviewReply(branchId, fromPhone, text) {
  const iv = knowledgeInterviews[branchId];
  if (!iv) return null;
  const phone10 = String(fromPhone || '').replace(/[^0-9]/g, '').slice(-10);
  if (phone10 !== iv.phone10) return null; // customers are never affected
  const t = String(text || '').trim();
  if (/^(stop|end|done|bas|khatam)$/i.test(t)) {
    const saved = iv.savedCount;
    delete knowledgeInterviews[branchId];
    return `👍 Done! Saved ${saved} answer(s). Your AI already knows them — add or edit facts anytime in Manager → Settings → Teach your AI.`;
  }
  if (!/^skip$/i.test(t)) {
    const knowledge = getBranchData(branchId, 'knowledge.json');
    knowledge.push({
      id: 'k_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      q: iv.queue[iv.idx], a: t, updatedAt: new Date().toISOString(),
    });
    writeBranchData(branchId, 'knowledge.json', knowledge);
    iv.savedCount++;
  }
  iv.idx++;
  if (iv.idx >= iv.queue.length) {
    const saved = iv.savedCount, total = iv.queue.length;
    delete knowledgeInterviews[branchId];
    return `🎉 That's all ${total} questions — ${saved} answer(s) saved. Your AI receptionist now answers these instantly, day and night!`;
  }
  return `Q${iv.idx + 1}: ${iv.queue[iv.idx]}`;
}

function buildReceptionistPrompt(branchId, text, fromPhone) {
  try {
    const business = businesses.find(b => b.id === branchId) || businesses[0];
    const menu = getBranchData(branchId, 'menu.json');
    // ── Pull real loyalty data from SQLite ──────────────────────────────────
    let customerName = 'Valued Customer';
    let customerTier = 'New';
    let customerVisits = 0;
    let loyaltyPoints = 0;
    let loyaltyStamps = 0;
    let stampsToFree = 10;
    let loyaltyCard = null;

    if (fromPhone && db) {
      try {
        const phone = fromPhone.replace(/[^0-9]/g, '').slice(-10);
        loyaltyCard = db.getLoyaltyCard(branchId, phone);
        if (loyaltyCard) {
          customerName   = loyaltyCard.customer_name || loyaltyCard.name || 'Customer';
          customerTier   = loyaltyCard.tier   || 'New';
          customerVisits = loyaltyCard.visits  || 0;
          loyaltyPoints  = loyaltyCard.points  || 0;
          loyaltyStamps  = loyaltyCard.stamps  || 0;
          stampsToFree   = Math.max(0, 10 - loyaltyStamps);
        } else {
          // Fall back to JSON profile
          const profiles = getBranchData(branchId, 'customer_profiles.json');
          const profile = profiles.find(p => p.phone === fromPhone);
          if (profile) {
            customerName  = profile.name || 'Customer';
            customerVisits = profile.visits || 0;
            customerTier  = profile.loyaltyTier || getLoyaltyTier(customerVisits);
          }
        }
      } catch(e) { /* loyalty lookup failed — proceed without it */ }
    }
    
    let menuStr = menu.map(item => {
      let finalPrice = item.price;
      if (item.discount > 0) {
        finalPrice = Math.round(item.price * (1 - item.discount / 100));
        return `- ${item.name} (${item.category}): ₹${finalPrice} (standard price was ₹${item.price}, today ${item.discount}% off)`;
      }
      return `- ${item.name} (${item.category}): ₹${finalPrice}`;
    }).join('\n');

    const loyaltyContext = loyaltyCard
      ? `- Loyalty Points: ${loyaltyPoints} pts (${customerTier} tier)
- Stamp Card: ${loyaltyStamps}/10 stamps collected (${stampsToFree} more for a FREE item!)
- Total Visits: ${customerVisits}`
      : `- New customer (no loyalty card yet — invite them to register!)`;

    // Delivery/social platform links (Zomato, Swiggy, Instagram, …) the owner
    // saved in Settings. When present, the AI shares them for delivery/online-
    // ordering questions instead of escalating; when absent the prompt is
    // unchanged and such questions still escalate to the owner.
    const platformLinks = Array.isArray(business.platformLinks) ? business.platformLinks : [];
    const platformsContext = platformLinks.length
      ? `\n- Order online / find us on: ${platformLinks.map(l => `${l.label}: ${l.url}`).join(' | ')}
  (If the customer asks about delivery, ordering online, or one of these platforms by name, warmly share the matching link(s) from the line above.)`
      : '';
    const platformsTopic = platformLinks.length ? ' delivery/online ordering,' : '';

    // AI3: owner-authored café facts. Injected verbatim; the workflow rules pin
    // the AI to answer ONLY from them so it never invents facts about the café.
    const knowledgePairs = (getBranchData(branchId, 'knowledge.json') || [])
      .filter(k => k && k.q && k.a && String(k.a).trim());
    const knowledgeContext = knowledgePairs.length
      ? `\n- Café facts from the owner (answer these EXACTLY from the fact given — never add to or guess beyond them):\n${knowledgePairs.map(k => `  • ${k.q} → ${k.a}`).join('\n')}`
      : '';
    const knowledgeTopic = knowledgePairs.length ? ' the café facts listed above,' : '';

    const prompt = `You are a warm, helpful, and natural human customer support assistant for "${business.name}" café.
Your role is to:
- Reply instantly, naturally, and warmly in a human-like host tone.
- Adapt to the customer's language automatically (English, Hindi, or Hinglish). Reply in the exact style and language of the customer query.
- Maintain a cozy, welcoming café vibe.

Customer Context:
- Name: ${customerName}
- Loyalty Tier: ${customerTier} (${customerVisits} visits)
${loyaltyContext}

Personalization Instructions:
- Greet returning customers (Regular/VIP/Elite) warmly by name.
- Mention their points/stamps when relevant (e.g., if they ask about rewards or are close to a free item).
- If they have 10+ stamps, remind them they have a FREE item waiting!
- If they have 500+ points, mention they can redeem for a discount.
- Treat VIP/Elite members with premium hospitality.

Café Context:
- Name: ${business.name}
- Location: ${business.location} (Maps: ${business.map})
- Timings: ${business.timings}
- Contact: ${business.contact}
- WiFi: ${business.wifi}
- Google Review Link: ${business.review}
- Menu:\n${menuStr}
- Standard offers: Students 10% off with ID 🎓 | Loyalty: earn 1 point per ₹1 spent ☕${platformsContext}${knowledgeContext}

CRITICAL WORKFLOW RULES (check rule 1 first, before anything else):
1. If the question is NOT about this café's menu, prices, timings, location, WiFi,
   reviews, loyalty points,${platformsTopic}${knowledgeTopic} or booking a table — for example: job applications/hiring,
   catering or events outside this café, franchise/business enquiries, questions about
   a completely different topic, or anything else you don't have real information about
   above — you MUST NOT answer it yourself and MUST NOT apologize or deflect in your own
   words. Instead your ENTIRE response must be exactly this and nothing else:
   INTENT:ESCALATE|unanswerable|<one short sentence summarising their question>
2. Table booking → output exactly: INTENT:RESERVATION
3. Custom/special discount request (customer asks for a deal, a coupon, or a lower price) → output exactly: INTENT:OFFER_REQUEST [details]
4. Feedback/review/rating → output exactly: INTENT:FEEDBACK
5. Customer asks "what are my points", "how many stamps", "mera balance", "my rewards", "loyalty card" → output exactly: INTENT:LOYALTY_QUERY
6. Customer wants to redeem stamps/points ("redeem", "free item", "use points") → output exactly: INTENT:LOYALTY_REDEEM
7. Otherwise, keep replies concise (max 3 sentences) and conversational.

Customer query: "${text}"
Your Response:`;

    return prompt;
  } catch (error) {
    console.error('[AI Prompt Build Error]', error);
    return null;
  }
}

async function callGemini(prompt) {
  if (!genAI) return null;
  try {
    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
    const result = await model.generateContent(prompt);
    const response = await result.response;
    return response.text().trim();
  } catch (error) {
    console.error('[Gemini API Error]', error);
    return null;
  }
}

async function callClaude(prompt) {
  if (!anthropic) return null;
  try {
    const msg = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });
    const textOut = (msg.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
    return textOut || null;
  } catch (error) {
    console.error('[Claude API Error]', error.message || error);
    return null;
  }
}

// Provider dispatch (see aiDecisionForBranch): growth/pro → unlimited Claude
// Haiku with Gemini safety net; starter → Claude Haiku metered per day, no
// Gemini fallback (null on failure drops to the local keyword tier); over-cap
// starter → 'silent' (handled by the caller BEFORE the local fallback);
// trial/others → Gemini. Gemini failures return null and the caller falls
// through to the local keyword tier — the pipeline never hard-fails because a
// model is down.
async function generateAIReply(branchId, text, fromPhone, decision) {
  decision = decision || aiDecisionForBranch(branchId);
  if (decision === 'silent') return null; // caller handles this before the local fallback
  const prompt = buildReceptionistPrompt(branchId, text, fromPhone);
  if (!prompt) return null;
  if (decision === 'claude') {
    const claudeReply = await callClaude(prompt);
    if (claudeReply) return claudeReply;
    return callGemini(prompt); // growth/pro keep the Gemini safety net
  }
  if (decision === 'claude_capped') {
    const claudeReply = await callClaude(prompt);
    if (claudeReply) {
      if (db) db.bumpClaudeUsage(branchId, aiUsageDateKey()); // count answered messages only
      return claudeReply;
    }
    return null; // Starter is Haiku-only; a transient Claude miss drops to the local keyword tier
  }
  return callGemini(prompt);
}

// AI Helper: Local Conversational Responder (Fallback)
function generateLocalConversationalReply(branchId, text, lang, fromPhone) {
  const business = businesses.find(b => b.id === branchId) || businesses[0];
  const lowercaseText = text.toLowerCase();

  let customerName = '';
  let customerTier = 'New Customer';
  if (fromPhone) {
    const profiles = getBranchData(branchId, 'customer_profiles.json');
    const profile = profiles.find(p => p.phone === fromPhone);
    if (profile) {
      customerName = profile.name || '';
      customerTier = profile.loyaltyTier || getLoyaltyTier(profile.visits);
    }
  }

  // Greetings & Small talk
  if (['hello', 'hey', 'hi', 'hola', 'helo', 'namaste', 'namaskar', 'pranam'].some(kw => lowercaseText.includes(kw))) {
    let greetingPrefix = '';
    if (customerTier === 'Elite') {
      greetingPrefix = customerName ? `Welcome back, our Elite guest ${customerName}! 🌟 ` : `Welcome back, our Elite guest! 🌟 `;
    } else if (customerTier === 'VIP') {
      greetingPrefix = customerName ? `Welcome back, our VIP guest ${customerName}! ✨ ` : `Welcome back, our VIP guest! ✨ `;
    } else if (customerTier === 'Regular') {
      greetingPrefix = customerName ? `Welcome back, ${customerName}! 😊 ` : `Welcome back! 😊 `;
    } else {
      greetingPrefix = customerName ? `Hello ${customerName}! 😊 ` : `Hello! 😊 `;
    }

    if (lang === 'hinglish') {
      return `${greetingPrefix}${business.name} par aapka swagat hai. Main aapki kya help karoon? Aap menu dekh sakte hain ya table book kar sakte hain! ☕`;
    } else if (lang === 'hindi') {
      return `${greetingPrefix}${business.name} में आपका स्वागत है। मैं आपकी क्या मदद करूँ? आप हमारा मेनू देख सकते हैं या टेबल बुक कर सकते हैं! ☕`;
    } else {
      return `${greetingPrefix}Welcome to ${business.name}. How can I assist you today? You can check our Menu, Location, or Book a Table! ☕`;
    }
  }

  // How are you
  if (['how are you', 'how is it going', 'kaise ho', 'sab badhiya', 'kya haal'].some(kw => lowercaseText.includes(kw))) {
    if (lang === 'hinglish') {
      return `Main bilkul badhiya hoon, aap bataiye! Aapke liye kya special coffee order karoon aaj? ☕😊`;
    } else if (lang === 'hindi') {
      return `मैं बिल्कुल ठीक हूँ, आप बताएं! आज आपके लिए क्या खास कॉफ़ी आर्डर करूँ? ☕😊`;
    } else {
      return `I'm doing great, thank you for asking! How are you doing? Ready to order some fresh coffee today? ☕😊`;
    }
  }

  // Recommendations
  if (['recommend', 'suggest', 'bestseller', 'special', 'tasty', 'popular', 'what should i'].some(kw => lowercaseText.includes(kw))) {
    if (lang === 'hinglish') {
      return `Humara *Cold Coffee* (₹149) aur *Peri Peri Fries* (₹107 - today 10% off!) bohot hi bestselling aur tasty combo hai! Aapko zaroor try karna chahiye! 🍔🥤`;
    } else if (lang === 'hindi') {
      return `हमारा *कोल्ड कॉफ़ी* (₹149) और *पेरी पेरी फ्राइज़* (₹107 - आज 10% छूट!) बहुत लोकप्रिय और स्वादिष्ट कॉम्बो हैं! आपको ज़रूर आज़माना चाहिए! 🍔🥤`;
    } else {
      return `I highly recommend our signature *Cold Coffee* (₹149) paired with *Peri Peri Fries* (which are only ₹107 today with 10% discount). They are absolute customer favorites! 🍔🥤`;
    }
  }

  // Amenities / Charging
  if (['charging', 'socket', 'plug', 'laptop', 'work', 'wifi', 'internet'].some(kw => lowercaseText.includes(kw))) {
    if (lang === 'hinglish') {
      return `Haan ji, café me tables ke paas free high-speed WiFi aur charging sockets/plugs standard available hain, toh aap yahan aaram se laptop par kaam kar sakte hain! 📶🔌`;
    } else {
      return `Yes! We have plenty of charging sockets/plugs near our tables and free high-speed WiFi (${business.wifi}), making it the perfect spot to work on your laptop! 📶🔌`;
    }
  }

  // Appreciation / Thanks
  if (['thank', 'thanks', 'shukriya', 'dhanyawad', 'nice', 'great', 'awesome', 'accha'].some(kw => lowercaseText.includes(kw))) {
    if (lang === 'hinglish') {
      return `Aapka bohot bohot shukriya! 😊 Hum aasha karte hain ki aapko humare services pasand aaye. Jaldi hi café visit kijiye! ☕✨`;
    } else if (lang === 'hindi') {
      return `आपका बहुत-बहुत धन्यवाद! 😊 हमें खुशी है कि आपको हमारी सेवाएँ पसंद आईं। जल्द ही कैफ़े आएं! ☕✨`;
    } else {
      return `You are most welcome! 😊 We are always happy to help. Hope to see you at the café soon! ☕✨`;
    }
  }

  // Default conversational fallback
  if (lang === 'hinglish') {
    return `Hello! 😊 ${business.name} par aapka swagat hai. Aap menu, timing, location, ya table booking ke baare me pooch sakte hain. Main aapki kya help karoon? ☕`;
  } else if (lang === 'hindi') {
    return `नमस्ते! 😊 ${business.name} सहायता लाइन पर आपका स्वागत है। आप मेन्यू, समय, स्थान या टेबल बुकिंग के बारे में पूछ सकते हैं। मैं आपकी क्या मदद करूँ? ☕`;
  } else {
    return `Welcome to ${business.name}! 😊 How can I help you today? You can ask about our Menu, Location, Timings, Active Offers, or Book a Table! ☕`;
  }
}

// ── AI escalation engine ──────────────────────────────────────────────────────
// Deterministic-first: keyword nets + a guest-count threshold decide what
// counts as an escalation, so this all works even with Gemini disabled. Gemini
// (when active) can additionally flag INTENT:ESCALATE for cases the keyword
// nets miss, or for genuinely unanswerable questions (see generateAIReply).
const LARGE_BOOKING_GUESTS = 8; // TODO: could become a per-café Settings value later

const PAYMENT_DISPUTE_KEYWORDS = [
  'wrong charge', 'double payment', 'charged twice', 'overcharged', 'over charged',
  'money deducted', 'payment failed', 'transaction fail', 'paisa kat gaya',
  'paise kat gaye', 'do baar charge', 'galat bill', 'bill galat', 'payment nahi hua',
  'paise nahi mile', 'amount deduct'
];
const COMPLAINT_REFUND_KEYWORDS = [
  'complaint', 'bad', 'worst', 'hair', 'dirty', 'rude', 'cold food', 'late', 'delay',
  'unhygienic', 'spoiled', 'vomit', 'stomach', 'refund', 'ganda', 'kharab', 'cheated',
  'disgusting', 'terrible', 'awful', 'paise wapas', 'shikayat', 'manager bulao', 'thag'
];

function detectEscalationCategory(lowercaseText) {
  if (PAYMENT_DISPUTE_KEYWORDS.some(kw => lowercaseText.includes(kw))) return 'payment_dispute';
  if (COMPLAINT_REFUND_KEYWORDS.some(kw => lowercaseText.includes(kw))) return 'complaint_refund';
  return null;
}

// Deterministic, revenue/retention-framed suggestion shown to the owner —
// Gemini never decides this, it's a plain template per category.
function buildEscalationSuggestion(category, detail) {
  switch (category) {
    case 'complaint_refund':
      return 'Offer an apology + a make-good (free dessert coupon on next visit). Why: winning back an unhappy regular is far cheaper than finding a new customer.';
    case 'large_booking':
      return `Confirm you can seat ${detail?.guests || 'the group'} at ${detail?.datetime || 'the requested time'}; consider a fixed menu for the group. Why: large groups raise the average ticket — worth prioritising.`;
    case 'payment_dispute':
      return 'Check the order and payment record before replying. Why: fast, factual responses on money issues protect your reviews.';
    case 'unanswerable':
      return `Customer asked: "${detail?.question || ''}". Add this to your café details in Settings so the AI can answer it next time.`;
    default:
      return 'Please follow up with this customer directly.';
  }
}

function escalationHoldingReply(category, lang) {
  const hinglishOrHindi = lang === 'hinglish' || lang === 'hindi';
  switch (category) {
    case 'complaint_refund':
      return hinglishOrHindi
        ? 'Bohot afsos hai aapko yeh experience hua. 🙏 Humne owner ko inform kar diya hai, woh jaldi hi aapse contact karenge.'
        : "We're truly sorry you had this experience. 🙏 I've let the owner know, and they'll reach out to you shortly.";
    case 'payment_dispute':
      return hinglishOrHindi
        ? 'Samajh gaya. Hamari team payment verify karke jald hi aapse contact karegi. 🙏'
        : "Understood — our team will verify this and get back to you quickly. 🙏";
    case 'large_booking':
      return hinglishOrHindi
        ? 'Itne bade group ke liye main team se confirm kar leta hoon — hum aapko turant message karenge! 😊'
        : "Let me confirm that with the team for a group this size — we'll message you right back! 😊";
    case 'unanswerable':
    default:
      return hinglishOrHindi
        ? 'Yeh main café team se check karke aapko bataunga. 😊'
        : "Let me check that with the café team and get back to you. 😊";
  }
}

// Creates the escalation row, notifies the dashboard (socket) and the owner
// (WhatsApp, if connected — degrades silently otherwise), and returns the
// holding reply to send back to the customer.
async function triggerEscalation(branchId, fromPhone, category, customerMessage, lang, detail) {
  const business = businesses.find(b => b.id === branchId) || businesses[0];
  const suggestion = buildEscalationSuggestion(category, detail);

  let escalation = null;
  if (db) {
    escalation = db.createEscalation({
      businessId: branchId, customerPhone: fromPhone, customerName: detail?.name || null,
      category, customerMessage, aiSuggestion: suggestion,
    });
    emitToBranch(branchId, 'escalation_new', { branchId, escalation });
  }

  if (business?.ownerPhone) {
    const categoryLabel = {
      complaint_refund: '😟 Complaint / Refund Request',
      large_booking: '👥 Large Group Booking',
      payment_dispute: '💳 Payment Dispute',
      unanswerable: '❓ Question The AI Couldn\'t Answer',
    }[category] || 'Needs Your Attention';
    const alertText = `${categoryLabel}\n\nCafé: ${business.name}\nCustomer: ${fromPhone}\nMessage: "${customerMessage}"\n\n💡 Suggestion: ${suggestion}\n\nOpen your dashboard: ${(process.env.BASE_URL || 'http://localhost:3010')}/manager/${branchId}`;
    sendWhatsAppToCustomer(branchId, business.ownerPhone, alertText).catch(() => {});
  }

  return escalationHoldingReply(category, lang);
}

// ── Weekly growth suggestions (G4) ────────────────────────────────────────────
// One concrete, deterministic, revenue-framed suggestion per café per week —
// no Gemini involved in the numbers or the decision, same INTENT discipline
// as everywhere else in this file.
const GROWTH_SLOW_DAY_RATIO = 0.7; // slowest weekday must be under 70% of the daily average to suggest

// Minimal, read-only reuse of the same at-risk filter the CRM tab's
// /at-risk-customers endpoint uses (21+ days since last visit, 2+ visits —
// regulars only, not one-timers). Kept as its own tiny check here rather
// than importing the route handler, so this stays a pure read with no
// route/response coupling.
function getAtRiskCount(branchId) {
  try {
    const crmFile = path.join(DATA_DIR, branchId, 'crm.json');
    if (!fs.existsSync(crmFile)) return 0;
    const crm = JSON.parse(fs.readFileSync(crmFile, 'utf-8'));
    const now = Date.now();
    return crm.filter(c => {
      if (!c.lastVisit) return false;
      const daysSince = (now - new Date(c.lastVisit).getTime()) / 86400000;
      return daysSince >= 21 && c.visits >= 2;
    }).length;
  } catch (e) { return 0; }
}

function loadGrowthSuggestion(branchId) {
  try {
    const f = path.join(DATA_DIR, branchId, 'growth_suggestions.json');
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, 'utf-8'));
  } catch (e) { return null; }
}

function saveGrowthSuggestion(branchId, suggestion) {
  const dir = path.join(DATA_DIR, branchId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'growth_suggestions.json'), JSON.stringify(suggestion, null, 2));
}

// Deterministic decision chain: slow weekday -> at-risk customers -> upcoming
// birthdays -> nothing this week. Returns null when there's nothing worth
// suggesting (not enough data, nothing at risk, no birthdays) rather than
// forcing a suggestion every week.
function computeGrowthSuggestion(branchId) {
  if (!db) return null;

  const { byWeekday, overallDailyAvg } = db.getWeekdayRevenue(branchId, 28);
  const hasOrderData = byWeekday.some(w => w.totalRevenue > 0);
  if (hasOrderData && overallDailyAvg > 0) {
    const slowest = byWeekday.reduce((a, b) => (a.avgRevenue < b.avgRevenue ? a : b));
    if (slowest.avgRevenue < overallDailyAvg * GROWTH_SLOW_DAY_RATIO) {
      return {
        type: 'slow_day',
        title: `Run a ${slowest.name} offer`,
        reason: `${slowest.name}s average ₹${Math.round(slowest.avgRevenue).toLocaleString('en-IN')} vs ₹${Math.round(overallDailyAvg).toLocaleString('en-IN')} overall — filling your quietest day is the cheapest revenue you can add.`,
        detail: { weekday: slowest.name },
      };
    }
  }

  const atRiskCount = getAtRiskCount(branchId);
  if (atRiskCount > 0) {
    return {
      type: 'winback',
      title: `Send a win-back offer to ${atRiskCount} lapsed customer${atRiskCount === 1 ? '' : 's'}`,
      reason: `${atRiskCount} regular${atRiskCount === 1 ? ' hasn\'t' : 's haven\'t'} visited in 3+ weeks. Reaching out now costs far less than replacing that customer.`,
      detail: { count: atRiskCount },
    };
  }

  const upcomingBirthdays = db.getUpcomingBirthdays(branchId, 7);
  if (upcomingBirthdays.length > 0) {
    return {
      type: 'birthday',
      title: `Send birthday wishes to ${upcomingBirthdays.length} customer${upcomingBirthdays.length === 1 ? '' : 's'}`,
      reason: `${upcomingBirthdays.length} customer${upcomingBirthdays.length === 1 ? ' has' : 's have'} a birthday in the next 7 days — a birthday offer is one of the highest-response campaigns you can run.`,
      detail: { count: upcomingBirthdays.length },
    };
  }

  return null; // nothing worth suggesting this week
}

async function runWeeklyGrowthSuggestions() {
  for (const b of businesses) {
    try {
      const suggestion = computeGrowthSuggestion(b.id);
      if (!suggestion) continue;
      const record = { ...suggestion, status: 'suggested', computedAt: new Date().toISOString() };
      saveGrowthSuggestion(b.id, record);
      emitToBranch(b.id, 'growth_suggestion_new', { branchId: b.id, suggestion: record });
      if (b.ownerPhone) {
        const msg = `📈 *Weekly Growth Suggestion*\n\nCafé: ${b.name}\n\n${suggestion.title}\n\n💡 ${suggestion.reason}\n\nOpen your dashboard to approve: ${(process.env.BASE_URL || 'http://localhost:3010')}/manager/${b.id}`;
        sendWhatsAppToCustomer(b.id, b.ownerPhone, msg).catch(() => {});
      }
    } catch (e) {
      console.error(`[Growth Suggestions] Failed for branch ${b.id}:`, e.message);
    }
  }
}

// Find the menu item a customer is referring to in free text (name, a significant
// word of the name, or the category). Returns the item or null.
function findMentionedMenuItem(menu, lowercaseText) {
  if (!Array.isArray(menu)) return null;
  for (const item of menu) {
    const name = (item.name || '').toLowerCase();
    if (name && lowercaseText.includes(name)) return item;
    const words = name.split(/\s+/).filter(w => w.length > 3);
    if (words.some(w => lowercaseText.includes(w))) return item;
    const cat = (item.category || '').toLowerCase();
    if (cat.length > 3 && lowercaseText.includes(cat)) return item;
  }
  return null;
}

// AI instant discount: when the owner has authorised the AI to give a discount on
// its own, issue a tracked coupon for the allowed ceiling and return the warm reply.
// The ceiling is the per-item aiMaxDiscount when the customer is asking about a
// specific item that has one set; otherwise the café-wide default (branch-settings
// aiMaxDiscount). Returns null if neither is authorised (caller then escalates).
function aiInstantDiscountReply(branchId, fromPhone, lang, text) {
  const branchSettings = getBranchData(branchId, 'branch-settings.json');
  const globalMax = Array.isArray(branchSettings) ? 0
    : Math.max(0, Math.min(100, Math.round(Number(branchSettings.aiMaxDiscount) || 0)));

  const menu = getBranchData(branchId, 'menu.json');
  const matchedItem = findMentionedMenuItem(menu, (text || '').toLowerCase());
  const itemMax = matchedItem
    ? Math.max(0, Math.min(100, Math.round(Number(matchedItem.aiMaxDiscount) || 0))) : 0;

  // A per-item limit takes precedence for that item (even if the global is 0);
  // otherwise fall back to the café-wide default.
  const effectiveMax = itemMax > 0 ? itemMax : globalMax;
  const scopeItem = itemMax > 0 ? matchedItem : null;
  if (effectiveMax <= 0) return null;

  let couponCode = null;
  if (db) {
    try {
      const c = db.issueCoupon({ businessId: branchId, sourceType: 'ai_instant',
        sourceId: scopeItem ? scopeItem.id : null,
        customerPhone: fromPhone, discountType: 'percent', discountValue: effectiveMax, expiresInDays: 7 });
      couponCode = c.code;
    } catch (e) { console.error('[AI instant discount] coupon issue failed:', e.message); }
  }
  updateCustomerProfile(branchId, fromPhone, null, 'requested_offer');

  const codeEn = couponCode ? ` Just show code *${couponCode}* at billing (valid 7 days).` : '';
  const codeHi = couponCode ? ` Billing par code *${couponCode}* batayein (7 din valid).` : '';
  const codeHin = couponCode ? ` बिलिंग पर कोड *${couponCode}* बताएं (7 दिन मान्य)।` : '';
  if (lang === 'hinglish') {
    return `Great news! 😊 Main aapko${scopeItem ? ` *${scopeItem.name}* par` : ''} *${effectiveMax}% off* de sakta hoon!${codeHi} 🎉`;
  } else if (lang === 'hindi') {
    return `खुशखबरी! 😊 मैं आपको${scopeItem ? ` *${scopeItem.name}* पर` : ' आपके अगले ऑर्डर पर'} *${effectiveMax}% छूट* दे सकता हूँ!${codeHin} 🎉`;
  }
  return `Good news! 😊 I can offer you *${effectiveMax}% off*${scopeItem ? ` on *${scopeItem.name}*` : ' your next order'}!${codeEn} 🎉`;
}

// AI response brain
// Thin wrapper: logs inbound/outbound chat events AND persists both messages to
// chat_messages around the real dispatcher below, so every channel (webhook,
// chat simulator, /chat endpoint) gets logging + history for free without
// threading it through every return branch.
async function processCafeBotReply(branchId, fromPhone, incomingMessage, opts = {}) {
  const channel = opts.channel || 'web';
  const customerName = opts.customerName || null;
  if (db) {
    db.logEvent(branchId, 'chat.inbound', { customerPhone: fromPhone, actor: 'customer', metadata: { text: incomingMessage } });
    db.saveChatMessage(branchId, fromPhone, customerName, 'in', incomingMessage, channel);
  }
  const reply = await processCafeBotReplyInner(branchId, fromPhone, incomingMessage);
  // reply may be null when a Starter café is over its daily Haiku cap (stay silent) —
  // don't log or persist an empty outbound in that case.
  if (db && reply) {
    db.logEvent(branchId, 'chat.outbound', { customerPhone: fromPhone, actor: 'ai', metadata: { text: reply } });
    db.saveChatMessage(branchId, fromPhone, customerName, 'out', reply, channel);
  }
  return reply;
}

async function processCafeBotReplyInner(branchId, fromPhone, incomingMessage) {
  updateTrafficStats(branchId);

  // AI3: while a "Teach your AI" interview is active, the OWNER's messages are
  // interview answers — handle them before any customer flow. Returns null for
  // everyone else (and for the owner when no interview is running).
  const interviewReply = handleKnowledgeInterviewReply(branchId, fromPhone, incomingMessage);
  if (interviewReply) return interviewReply;

  const business = businesses.find(b => b.id === branchId) || businesses[0];
  const menu = getBranchData(branchId, 'menu.json');
  const settings = getBranchData(branchId, 'settings.json');
  
  const text = incomingMessage.trim();
  const lowercaseText = text.toLowerCase();
  const lang = detectLanguage(text);

  // Initialize state memory for user
  if (!userStates[branchId]) userStates[branchId] = {};
  if (!userStates[branchId][fromPhone]) {
    userStates[branchId][fromPhone] = { 
      state: 'IDLE', 
      reservationData: { name: null, guests: null, datetime: null },
      feedbackData: { rating: null, comment: null },
      googleReviewData: { reviewerName: null }
    };
  }
  const userState = userStates[branchId][fromPhone];

  // 1. COMPLAINT / PAYMENT-DISPUTE DETECTOR — deterministic, works with Gemini
  // on or off. Escalates to the owner (WhatsApp + dashboard) instead of just
  // saying "our team will contact you" into the void.
  const deterministicCategory = detectEscalationCategory(lowercaseText);
  if (deterministicCategory) {
    updateCustomerProfile(branchId, fromPhone, null, 'complained');
    return await triggerEscalation(branchId, fromPhone, deterministicCategory, text, lang,
      { name: userState.reservationData.name || null });
  }

  // 1.5 ACTIVE FEEDBACK FLOW STATE MACHINE
  // ── Google Review Reward ─────────────────────────────────────────────────
  // ── GOOGLE_REVIEW_PENDING: customer says Done → ask reviewer name ─────────
  if (userState.state === 'GOOGLE_REVIEW_PENDING') {
    const confirmWords = ['done', 'haan', 'han', 'yes', 'reviewed', 'posted',
      'kar diya', 'ho gaya', 'review diya', 'review kar diya', 'ok', 'okay',
      'completed', 'submit', 'submitted', 'diya', 'ho gayi'];
    const confirmed = confirmWords.some(w => lowercaseText.includes(w));

    if (confirmed) {
      userState.state = 'GOOGLE_REVIEW_NAME_PENDING';
      userState.googleReviewData = { reviewerName: null };
      if (lang === 'hinglish') {
        return '✅ Shukriya! Verification ke liye aapka *Google par naam* batayein jo review mein dikhta hai. 📝\n(Jaise: "Rahul M." ya "Priya Singh")';
      } else if (lang === 'hindi') {
        return '✅ धन्यवाद! Verification के लिए वो *नाम बताएं जो Google review में दिखता है*। 📝';
      } else {
        return '✅ Great! To verify your review, please share the *name shown on your Google review*. 📝\n(e.g. "Rahul M." or "Priya Singh")';
      }
    } else {
      if (lang === 'hinglish') {
        return `Google review dene ke baad *Done* type karein aur *+100 points* paayein! 😊\n👉 ${business.review}`;
      } else if (lang === 'hindi') {
        return `Google review देने के बाद *Done* लिखें और *+100 points* पाएं! 😊\n👉 ${business.review}`;
      } else {
        return `Just reply *Done* after leaving your Google review to claim *+100 points*! 😊\n👉 ${business.review}`;
      }
    }
  }

  // ── GOOGLE_REVIEW_NAME_PENDING: collect reviewer name → save pending claim ─
  if (userState.state === 'GOOGLE_REVIEW_NAME_PENDING') {
    const reviewerName = text.trim();
    if (reviewerName.length < 2) {
      return lang === 'hinglish' || lang === 'hindi'
        ? 'Kripya apna poora naam batayein jo Google review mein dikh raha hai. 📝'
        : 'Please share the name as it appears on your Google review. 📝';
    }

    userState.state = 'IDLE';
    userState.googleReviewData = { reviewerName: null };

    // Save pending claim
    const phone = fromPhone.replace(/[^0-9]/g,'').slice(-10);
    let custName = userState.reservationData.name;
    if (!custName) {
      const profiles = getBranchData(branchId, 'customer_profiles.json');
      const profile = profiles.find(p => p.phone === fromPhone);
      if (profile && profile.name) custName = profile.name;
    }
    custName = custName || 'Customer';

    // Check for duplicate pending claim
    const claims = getBranchData(branchId, 'google_review_claims.json') || [];
    const alreadyPending = claims.some(c => c.phone === phone && c.status === 'pending');
    if (alreadyPending) {
      return lang === 'hinglish' || lang === 'hindi'
        ? 'Aapka review claim already pending hai! Manager jald verify karenge. 🙏'
        : 'Your review claim is already pending verification. We will process it soon! 🙏';
    }

    // Check if already approved before
    const txHistory = db ? (db.getLoyaltyTransactions(branchId, phone, 10)) : [];
    const alreadyRewarded = txHistory.some(t => t.description && t.description.includes('Google review reward'));
    if (alreadyRewarded) {
      return lang === 'hinglish' || lang === 'hindi'
        ? 'Aapko Google review reward pehle hi mil chuka hai! 😊 Aapke points safe hain. ☕'
        : 'You have already received your Google review reward! Your points are safe. ☕';
    }

    const claim = {
      id: 'grc_' + Date.now(),
      phone,
      customerName: custName,
      reviewerName,
      submittedAt: new Date().toISOString(),
      status: 'pending'
    };
    claims.push(claim);
    writeBranchData(branchId, 'google_review_claims.json', claims);
    emitToBranch(branchId, 'google_review_claim', { branchId, claim });

    // Notify manager via WhatsApp if connected
    if (whatsappClient) {
      try {
        const mgr = getBranchData(branchId, 'settings.json');
        if (mgr && mgr.managerPhone) {
          const mgrId = '91' + mgr.managerPhone.replace(/\D/g,'').slice(-10) + '@c.us';
          await whatsappClient.sendMessage(mgrId,
            `🔔 *New Google Review Claim*\n\nCafé: ${business.name}\nCustomer: ${custName} (+91${phone})\nReviewer Name on Google: *${reviewerName}*\n\nCheck & verify at:\n${business.review}\n\nApprove in Manager Dashboard → Loyalty tab.`
          );
        }
      } catch(e) {}
    }

    if (lang === 'hinglish') {
      return `🎉 Shukriya, *${reviewerName}*! Aapka claim submit ho gaya.\n\n⏳ Manager 24 ghante mein Google par verify karenge aur aapko *+100 points* mil jayenge!\n\nVerification complete hone par aapko yahan notification milega. ☕`;
    } else if (lang === 'hindi') {
      return `🎉 धन्यवाद, *${reviewerName}*! आपका claim submit हो गया।\n\n⏳ Manager 24 घंटे में Google पर verify करेंगे और आपको *+100 points* मिलेंगे!\n\nVerification पूरी होने पर यहाँ notification मिलेगा। ☕`;
    } else {
      return `🎉 Thanks, *${reviewerName}*! Your claim has been submitted.\n\n⏳ Our manager will verify your Google review within 24 hours and credit *+100 points* to your account!\n\nYou'll receive a notification here once verified. ☕`;
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  if (userState.state === 'FEEDBACK') {
    const data = userState.feedbackData;
    
    if (!data.rating) {
      const ratingMatch = text.match(/[1-5]/);
      if (ratingMatch) {
        data.rating = parseInt(ratingMatch[0]);
      } else {
        const ratingWords = { 'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5, 'ek': 1, 'do': 2, 'teen': 3, 'char': 4, 'panch': 5, 'best': 5, 'good': 4, 'bad': 1 };
        const found = Object.keys(ratingWords).find(w => lowercaseText.includes(w));
        if (found) {
          data.rating = ratingWords[found];
        } else {
          return lang === 'hinglish' || lang === 'hindi'
            ? 'Kripya 1 se 5 ke beech koi number share karein! (1: Worst, 5: Best) ⭐'
            : 'Please share a rating between 1 and 5 stars! (1: Worst, 5: Best) ⭐';
        }
      }
      
      return lang === 'hinglish' || lang === 'hindi'
        ? 'Bohot achha! Kripya apna comment ya suggestion type karke share karein. ✍️'
        : 'Thank you! Please type and share your comment or suggestion with us. ✍️';
    } else if (!data.comment) {
      data.comment = text;
      
      // Save feedback
      const feedback = getBranchData(branchId, 'feedback.json');
      let custName = userState.reservationData.name;
      if (!custName) {
        const profiles = getBranchData(branchId, 'customer_profiles.json');
        const profile = profiles.find(p => p.phone === fromPhone);
        if (profile && profile.name) {
          custName = profile.name;
        }
      }
      custName = custName || 'Valued Customer';

      const newFb = {
        id: 'f_' + Date.now(),
        customerName: custName,
        rating: data.rating,
        comment: data.comment,
        timestamp: new Date().toLocaleString()
      };
      feedback.push(newFb);
      writeBranchData(branchId, 'feedback.json', feedback);
      if (db) db.logEvent(branchId, 'feedback.submitted',
        { customerPhone: fromPhone, actor: 'customer', metadata: { rating: newFb.rating, channel: 'chat' } });

      // Keep in GOOGLE_REVIEW_PENDING for 5-star so we can reward Google review confirmation
      userState.state = data.rating === 5 ? 'GOOGLE_REVIEW_PENDING' : 'IDLE';
      userState.feedbackData = { rating: null, comment: null };
      
      emitToBranch(branchId, 'feedback_update', { branchId, feedback });
      
      // Compute new average rating in CRM
      const reviews = feedback.filter(f => f.customerName === newFb.customerName);
      const totalStars = reviews.reduce((sum, r) => sum + r.rating, 0);
      const avg = reviews.length > 0 ? parseFloat((totalStars / reviews.length).toFixed(1)) : newFb.rating;
      
      updateCustomerProfile(branchId, fromPhone, newFb.customerName, 'gave_feedback', {
        averageRating: avg,
        feedbackCount: reviews.length || 1
      });

      // ── 5-Star Review Reward: +100 Loyalty Points ───────────────────────
      if (newFb.rating === 5 && db) {
        try {
          const phone = fromPhone.replace(/[^0-9]/g,'').slice(-10);
          const card = db.awardBonusPoints(branchId, phone, custName, 30, '5-star review reward');
          emitToBranch(branchId, 'loyalty_update', { businessId: branchId, card });
          console.log(`[Loyalty] +100 bonus pts → ${phone} (5-star review)`);
        } catch(e) { console.warn('[Loyalty] 5-star bonus failed:', e.message); }
      }
      // ─────────────────────────────────────────────────────────────────────

      // Save coupon in customer profile if rating is 5
      let couponCode = null;
      if (newFb.rating === 5) {
        if (db) {
          const issued = db.issueCoupon({ businessId: branchId, sourceType: 'feedback5', sourceId: newFb.id,
            customerPhone: fromPhone, discountType: 'percent', discountValue: 15 });
          couponCode = issued.code;
        } else {
          couponCode = 'THANKYOU15'; // no DB — fall back to the old static code
        }
        newFb.couponCode = couponCode;
        // Re-write updated feedback with couponCode
        writeBranchData(branchId, 'feedback.json', feedback);

        const profiles = getBranchData(branchId, 'customer_profiles.json');
        const profile = profiles.find(p => p.phone === fromPhone);
        if (profile) {
          profile.offersReceived = profile.offersReceived || [];
          if (!profile.offersReceived.some(o => o.offer.includes(couponCode))) {
            profile.offersReceived.push({
              offer: `Feedback Reward: Coupon ${couponCode} (15% Off)`,
              timestamp: new Date().toISOString()
            });
            writeBranchData(branchId, 'customer_profiles.json', profiles);
            emitToBranch(branchId, 'crm_update', { branchId, profiles });
          }
        }
      }

      if (newFb.rating === 5) {
        if (lang === 'hinglish') {
          return `Aapka bohot bohot shukriya! ❤️ 5-star dene ke liye:\n\n🎁 *+30 Loyalty Points* aapke account mein add ho gaye!\n🎟 Coupon: *${couponCode}* (15% Off next visit)\n\n⭐ *Google Review ka bonus!*\nHumein Google par bhi review dein aur *+100 aur points* pao!\n👉 ${business.review}\n\nReview karne ke baad yahan *Done* type karein. 😊`;
        } else if (lang === 'hindi') {
          return `बहुत-बहुत धन्यवाद! ❤️ 5-स्टार देने के लिए:\n\n🎁 *+30 Loyalty Points* आपके खाते में जुड़ गए!\n🎟 कूपन: *${couponCode}* (अगली बार 15% छूट)\n\n⭐ *Google Review बोनस!*\nGoogle पर भी समीक्षा दें और *+100 और Points* पाएं!\n👉 ${business.review}\n\nReview करने के बाद यहाँ *Done* लिखें। 😊`;
        } else {
          return `Thank you so much! ❤️ For the 5-star rating:\n\n🎁 *+30 Loyalty Points* added to your account!\n🎟 Coupon: *${couponCode}* (15% Off your next visit)\n\n⭐ *Bonus Google Review Reward!*\nLeave us a Google review and earn *+100 more Points*!\n👉 ${business.review}\n\nAfter reviewing, reply *Done* here to claim your points. 😊`;
        }
      } else if (newFb.rating >= 4) {
        if (lang === 'hinglish') {
          return `Aapka bohot bohot shukriya! ❤️ Aapka feedback humare liye bohot valuable hai.\n\nAgar aapko café pasand aaya, toh kripya 1 minute nikal kar humein Google par bhi review dein: ${business.review} \nIsse humein bohot help milegi! 😊⭐`;
        } else if (lang === 'hindi') {
          return `आपका बहुत-बहुत धन्यवाद! ❤️ आपकी प्रतिक्रिया हमारे लिए बहुत मूल्यवान है।\n\nयदि आपको कैफ़े पसंद आया, तो कृपया Google पर भी अपनी समीक्षा साझा करें: ${business.review} \nइससे हमें बहुत मदद मिलेगी! 😊⭐`;
        } else {
          return `Thank you so much! ❤️ Your feedback is highly valuable to us.\n\nIf you enjoyed your experience, please take a moment to leave us a Google review here: ${business.review} \nIt helps our local business grow! 😊⭐`;
        }
      } else {
        if (lang === 'hinglish') {
          return `Feedback share karne ke liye shukriya! Hum isse behtar karne ke liye poori koshish karenge. Have a nice day! 😊`;
        } else {
          return `Thank you for sharing your feedback! We will use this to improve our service. Have a wonderful day! 😊`;
        }
      }
    }
  }

  // 2. ACTIVE RESERVATION FLOW STATE MACHINE
  if (userState.state === 'RESERVATION') {
    const data = userState.reservationData;
    
    // Parse response
    if (!data.name) {
      data.name = text;
      updateCustomerProfile(branchId, fromPhone, data.name, 'table_booking_flow');
    } else if (!data.guests) {
      const numMatch = text.match(/\d+/);
      if (numMatch) {
        data.guests = parseInt(numMatch[0]);
      } else {
        const words = { 'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5, 'ek': 1, 'do': 2, 'teen': 3, 'char': 4, 'panch': 5 };
        const found = Object.keys(words).find(w => lowercaseText.includes(w));
        data.guests = found ? words[found] : 2;
      }
    } else if (!data.datetime) {
      data.datetime = text;
    }

    // Next step prompt or completion
    if (!data.name) {
      return lang === 'hinglish' || lang === 'hindi'
        ? 'Bataiye, reservation kis naam par karni hai? 😊'
        : 'Could you please share the name for the booking? 😊';
    } else if (!data.guests) {
      return lang === 'hinglish' || lang === 'hindi'
        ? 'Kitne log aane wale hain? (No. of guests) 👥'
        : 'How many guests will be joining? 👥';
    } else if (!data.datetime) {
      return lang === 'hinglish' || lang === 'hindi'
        ? 'Aap kis date aur time par aana chahte hain? (Date & Time) 📅⏰'
        : 'What date and time would you like to book for? 📅⏰';
    } else {
      // Completion! Save reservation
      const reservations = getBranchData(branchId, 'reservations.json');
      const newRes = {
        id: 'r_' + Date.now(),
        name: data.name,
        phone: fromPhone,
        guests: data.guests,
        datetime: data.datetime,
        status: 'pending'
      };
      reservations.push(newRes);
      writeBranchData(branchId, 'reservations.json', reservations);
      if (db) db.logEvent(branchId, 'reservation.created',
        { customerPhone: fromPhone, actor: 'customer', metadata: { guests: data.guests, datetime: data.datetime, channel: 'chat' } });

      userState.state = 'IDLE';
      userState.reservationData = { name: null, guests: null, datetime: null };

      emitToBranch(branchId, 'reservation_update', { branchId, reservations });
      updateCustomerProfile(branchId, fromPhone, data.name, 'made_booking');

      // Large groups need the owner's OK before the AI promises a table —
      // the reservation is still logged (status 'pending' either way), but
      // the customer gets a holding reply instead of an outright confirmation.
      if (data.guests >= LARGE_BOOKING_GUESTS) {
        const bookingSummary = `${data.name} wants a table for ${data.guests} guests on ${data.datetime}`;
        return await triggerEscalation(branchId, fromPhone, 'large_booking', bookingSummary, lang,
          { name: data.name, guests: data.guests, datetime: data.datetime });
      }

      if (lang === 'hinglish') {
        return `Aapki table successfully book ho gayi hai, ${data.name}! 🎉\n👥 Guests: ${data.guests}\n📅 Time: ${data.datetime}\n\nHum aapka wait karenge, see you soon! 😊☕`;
      } else if (lang === 'hindi') {
        return `आपका टेबल सफलतापूर्वक बुक हो गया है, ${data.name}! 🎉\n👥 मेहमान: ${data.guests}\n📅 समय: ${data.datetime}\n\nहम आपका इंतजार करेंगे! 😊☕`;
      } else {
        return `Perfect! Your table has been successfully booked, ${data.name}! 🎉\n👥 Guests: ${data.guests}\n📅 Schedule: ${data.datetime}\n\nWe look forward to hosting you soon! 😊☕`;
      }
    }
  }

  // 3. DETECT CUSTOM OFFER / DISCOUNT REQUESTS (RULE-BASED OVERRIDE FOR LOCAL FLOWS)
  const customOfferKeywords = [
    'special discount', 'give me discount', 'party discount', 'group discount',
    'extra discount', 'personal offer', 'discount kardo', 'discount milega',
    'discount de do', 'deal milegi', 'coupon code',
    // item-directed / explicit requests so per-item and global AI limits can apply
    'discount on', 'discount for', 'discount pe', 'discount par', 'discount do',
    'give discount', 'discount chahiye', 'kitna discount', 'koi discount'
  ];
  const containsCustomOfferRequest = customOfferKeywords.some(kw => lowercaseText.includes(kw));
  if (containsCustomOfferRequest) {
    // If the owner authorised the AI to grant discounts on its own, do so directly
    // (tracked coupon, no manager approval). Otherwise fall through to escalation.
    const instant = aiInstantDiscountReply(branchId, fromPhone, lang, text);
    if (instant) return instant;
    const offerRequests = getBranchData(branchId, 'offer_requests.json');
    const newRequest = {
      id: 'o_' + Date.now(),
      phone: fromPhone,
      customerName: userState.reservationData.name || 'Valued Customer',
      requestText: text,
      status: 'pending',
      suggestedOffer: '15% Off bill',
      timestamp: new Date().toLocaleString()
    };
    offerRequests.push(newRequest);
    writeBranchData(branchId, 'offer_requests.json', offerRequests);
    
    emitToBranch(branchId, 'new_offer_request', { branchId, request: newRequest });
    updateCustomerProfile(branchId, fromPhone, null, 'requested_offer');

    if (lang === 'hinglish') {
      return `Humne aapki request manager ke pass approval ke liye bhej di hai! Jaise hi manager ise approve karenge, main aapko yahan inform karunga. Tab tak aap menu check kar sakte hain! 😊`;
    } else if (lang === 'hindi') {
      return `मैंने आपका अनुरोध प्रबंधक को अनुमोदन के लिए भेज दिया है! जैसे ही यह स्वीकृत होगा, मैं आपको सूचित करूँगा। तब तक आप हमारा मेनू देख सकते हैं! 😊`;
    } else {
      return `I have forwarded your request to the café manager for approval. I will notify you here as soon as it is approved! In the meantime, feel free to browse our menu! 😊`;
    }
  }

  // 4. CALL DYNAMIC LLM IF ACTIVE (Claude Haiku for growth/pro & starter; Gemini for trial/others)
  const aiDecision = aiDecisionForBranch(branchId);
  if (aiDecision === 'silent') {
    // Starter café has spent its daily Haiku allowance — go quiet. No Gemini and
    // no local keyword reply: silence is the deliberate nudge to upgrade to Growth.
    if (db) db.logEvent(branchId, 'ai.daily_cap_reached',
      { customerPhone: fromPhone, actor: 'system', metadata: { plan: 'starter', limit: STARTER_CLAUDE_DAILY_LIMIT } });
    return null;
  }
  if (genAI || anthropic) {
    const geminiReply = await generateAIReply(branchId, text, fromPhone, aiDecision);
    if (geminiReply) {
      if (geminiReply.includes('INTENT:ESCALATE')) {
        const parts = geminiReply.split('|');
        const category = (parts[1] || 'unanswerable').trim();
        const summary = (parts[2] || text).trim();
        return await triggerEscalation(branchId, fromPhone, category, text, lang,
          { name: userState.reservationData.name || null, question: summary });
      }
      if (geminiReply.includes('INTENT:RESERVATION')) {
        userState.state = 'RESERVATION';
        userState.reservationData = { name: null, guests: null, datetime: null };
        return lang === 'hinglish' || lang === 'hindi'
          ? 'Bilkul! 😊 Table book karne me hum aapki help karenge. \nKripya share karein:\n1. Aapka Naam (Name)'
          : 'Sure! Let\'s get your table reserved. \nPlease share:\n1. Your Name';
      }
      if (geminiReply.includes('INTENT:OFFER_REQUEST')) {
        // Owner-authorised AI discount grants directly; otherwise escalate for approval.
        const instant = aiInstantDiscountReply(branchId, fromPhone, lang, text);
        if (instant) return instant;
        const details = geminiReply.split('INTENT:OFFER_REQUEST')[1] || text;
        const offerRequests = getBranchData(branchId, 'offer_requests.json');
        const newRequest = {
          id: 'o_' + Date.now(),
          phone: fromPhone,
          customerName: userState.reservationData.name || 'Valued Customer',
          requestText: details.trim() || text,
          status: 'pending',
          suggestedOffer: '15% Off bill',
          timestamp: new Date().toLocaleString()
        };
        offerRequests.push(newRequest);
        writeBranchData(branchId, 'offer_requests.json', offerRequests);
        
        emitToBranch(branchId, 'new_offer_request', { branchId, request: newRequest });
        updateCustomerProfile(branchId, fromPhone, null, 'requested_offer');
        
        return lang === 'hinglish' || lang === 'hindi'
          ? `Humne aapki request manager ke pass approval ke liye bhej di hai! Jaise hi manager ise approve karenge, main aapko yahan inform karunga. Tab tak aap menu check kar sakte hain! 😊`
          : `I have forwarded your request to the café manager for approval. I will notify you here as soon as it is approved! In the meantime, feel free to browse our menu! 😊`;
      }
      if (geminiReply.includes('INTENT:FEEDBACK')) {
        userState.state = 'FEEDBACK';
        userState.feedbackData = { rating: null, comment: null };
        return lang === 'hinglish' || lang === 'hindi'
          ? 'Bilkul! 😊 Aapka feedback humare liye bohot valuable hai. \nKripya humein 1 se 5 stars me rate karein (1: Sabse ganda, 5: Sabse behtar) ⭐'
          : 'Sure! 😊 Your feedback is highly valuable to us. \nPlease rate your experience from 1 to 5 stars (1: Worst, 5: Best) ⭐';
      }

      // ── Phase 4: Loyalty intents ───────────────────────────────────────────
      if (geminiReply.includes('INTENT:LOYALTY_QUERY')) {
        if (!db) return lang === 'hinglish' ? 'Abhi loyalty system available nahi hai, baad mein try karein! 😊' : 'Loyalty system is currently unavailable. Please try again shortly!';
        try {
          const phone = fromPhone.replace(/[^0-9]/g,'').slice(-10);
          const card = db.getOrCreateCard(branchId, phone, userState.customerName || 'Customer');
          const stampsLeft = Math.max(0, 10 - (card.stamps||0));
          const business = businesses.find(b=>b.id===branchId)||businesses[0];
          if (lang === 'hinglish') {
            return `*${card.customer_name||'Aap'}* ka loyalty card! 🌟\n\n☕ Stamps: *${card.stamps||0}/10* (${stampsLeft} aur chahiye free item ke liye!)\n💰 Points: *${card.points||0} pts*\n🏅 Tier: *${card.tier||'New'}*\n\n${(card.stamps||0)>=10?'🎁 Aapka FREE item redeem karne ke liye café mein aaiye!':stampsLeft+' aur visits mein ek free item milega! 😊'}`;
          }
          return `Here's your loyalty card, *${card.customer_name||'friend'}*! 🌟\n\n☕ Stamps: *${card.stamps||0}/10* (${stampsLeft} more for a FREE item!)\n💰 Points: *${card.points||0} pts*\n🏅 Tier: *${card.tier||'New'}*\n\n${(card.stamps||0)>=10?'🎁 You have a FREE item waiting — visit us to redeem!':'Visit '+stampsLeft+' more times to earn your free item! 😊'}`;
        } catch(e) {
          return lang==='hinglish' ? 'Aapka loyalty card abhi check nahi ho pa raha, sorry! 😊' : 'Unable to fetch your loyalty card right now. Please try again!';
        }
      }

      if (geminiReply.includes('INTENT:LOYALTY_REDEEM')) {
        if (!db) return 'Loyalty system unavailable. Please visit us at the café to redeem!';
        try {
          const phone = fromPhone.replace(/[^0-9]/g,'').slice(-10);
          const card = db.getLoyaltyCard(branchId, phone);
          if (!card) return lang==='hinglish' ? 'Aapka loyalty card nahi mila! Pehle ek visit karein. 😊' : 'No loyalty card found! Visit us to start earning stamps.';
          const stamps = card.stamps||0;
          const points = card.points||0;
          if (stamps >= 10) {
            return lang==='hinglish'
              ? `🎁 Aapke paas *${stamps} stamps* hain aur aap ek *FREE item* ke liye eligible hain! Café mein aaiye aur staff ko yeh message dikhayein. Hum khushi se redeem karenge! ☕`
              : `🎁 You have *${stamps} stamps* and qualify for a *FREE item*! Visit the café and show this message to our team — we'll redeem it with a smile! ☕`;
          } else if (points >= 500) {
            return lang==='hinglish'
              ? `💰 Aapke paas *${points} points* hain! 500 points = ₹50 discount. Café mein aaiye aur staff ko batayein aap points redeem karna chahte hain! 😊`
              : `💰 You have *${points} points*! 500 points = ₹50 off your bill. Visit the café and let our team know you'd like to redeem — easy as that! 😊`;
          } else {
            return lang==='hinglish'
              ? `Abhi redeem karne ke liye stamps/points kam hain! Aapke paas ${stamps}/10 stamps aur ${points} points hain. Jaldi ho jayega! ☕`
              : `Not quite there yet! You have ${stamps}/10 stamps and ${points} points. Keep visiting — you're on your way! ☕`;
          }
        } catch(e) {
          return 'Please visit the café to redeem your rewards — our team will be happy to help!';
        }
      }
      // ─────────────────────────────────────────────────────────────────────
      return geminiReply;
    }
  }

  // 5. LOCAL RULE-BASED NLP FALLBACK (Run when Gemini is offline or not configured)
  
  // AA. FEEDBACK FLOW INITIATION
  if (['feedback', 'rating', 'review', 'sugges', 'compliment', 'रेटिंग', 'फीडबैक', 'feed back'].some(kw => lowercaseText.includes(kw))) {
    userState.state = 'FEEDBACK';
    userState.feedbackData = { rating: null, comment: null };
    
    if (lang === 'hinglish') {
      return 'Bilkul! 😊 Aapka feedback humare liye bohot valuable hai. \nKripya humein 1 se 5 stars me rate karein (1: Sabse ganda, 5: Sabse behtar) ⭐';
    } else if (lang === 'hindi') {
      return 'बिल्कुल! 😊 आपकी प्रतिक्रिया हमारे लिए बहुत मूल्यवान है। \nकृपया हमें 1 से 5 स्टार में रेट करें (1: सबसे खराब, 5: सबसे अच्छा) ⭐';
    } else {
      return 'Sure! 😊 Your feedback is highly valuable to us. \nPlease rate your experience from 1 to 5 stars (1: Worst, 5: Best) ⭐';
    }
  }

  // A. BOOKING FLOW INITIATION
  if (['book', 'reservation', 'table', 'seat', 'टेबल बुक', 'booking', 'reserve'].some(kw => lowercaseText.includes(kw))) {
    userState.state = 'RESERVATION';
    userState.reservationData = { name: null, guests: null, datetime: null };
    
    if (lang === 'hinglish') {
      return 'Bilkul! 😊 Table book karne me hum aapki help karenge. \nKripya share karein:\n1. Aapka Naam (Name)';
    } else if (lang === 'hindi') {
      return 'बिल्कुल! 😊 टेबल बुक करने में हम आपकी मदद करेंगे। \nकृपया शेयर करें:\n1. आपका नाम (Name)';
    } else {
      return 'Sure! 😊 Let\'s get your table reserved. \nPlease share:\n1. Your Name';
    }
  }

  // B. MENU QUERY
  if (['menu', 'मेन्यू', '메뉴', 'food', 'khana', 'bestseller', 'popular'].some(kw => lowercaseText.includes(kw))) {
    updateCustomerProfile(branchId, fromPhone, null, 'asked_menu');
    
    let menuStr = '';
    menu.forEach(item => {
      let finalPrice = item.price;
      let discStr = '';
      if (item.discount > 0) {
        finalPrice = Math.round(item.price * (1 - item.discount / 100));
        discStr = ` (${item.discount}% OFF - was ₹${item.price})`;
      }
      menuStr += `• ${item.name} (${item.category}): ₹${finalPrice}${discStr}\n`;
    });

    if (lang === 'hinglish') {
      return `Yeh raha humara delicious menu! 😋\n\n${menuStr}\nHumara Cold Coffee, Peri Peri Fries, aur Alfredo Pasta bestselling items hain. Kya mangwana chahenge? 😊`;
    } else if (lang === 'hindi') {
      return `यह रहा हमारा स्वादिष्ट मेन्यू! 😋\n\n${menuStr}\nहमारे सबसे लोकप्रिय आइटम्स कोल्ड कॉफ़ी, पेरी पेरी फ्राइज़, और अल्फ्रेडो पास्ता हैं। आप क्या पसंद करेंगे? 😊`;
    } else {
      return `Here is our delicious menu! 😋\n\n${menuStr}\nOur bestsellers are Cold Coffee, Peri Peri Fries, and Alfredo Pasta. What can I get for you today? 😊`;
    }
  }

  // C. OFFERS QUERY
  if (['offer', 'offers', 'ऑफर', 'discount', 'coupon', 'deal'].some(kw => lowercaseText.includes(kw))) {
    updateCustomerProfile(branchId, fromPhone, null, 'asked_offers');
    
    let baseOffers = '1. Students get 10% discount with a valid ID card! 🎓\n2. Buy 5 coffees, get 1 free! ☕';
    
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long' });
    const lowTrafficCampaign = settings.lowTrafficCampaigns.find(c => c.day.toLowerCase() === today.toLowerCase());
    
    let promoPrefix = '';
    if (lowTrafficCampaign) {
      promoPrefix = `🔥 *SPECIAL TODAY* (${today} Exclusive): ${lowTrafficCampaign.offer}\n\n`;
    }

    if (lang === 'hinglish') {
      return `${promoPrefix}Humare exciting offers kuch is tarah hain: 😊\n${baseOffers}\n\nAap humari regular schemes ka fayda bhi utha sakte hain!`;
    } else if (lang === 'hindi') {
      return `${promoPrefix}हमारे शानदार ऑफर्स इस प्रकार हैं: 😊\n${baseOffers}\n\nआप हमारे रेगुलर स्कीम्स का लाभ उठा सकते हैं!`;
    } else {
      return `${promoPrefix}Here are our special offers: 😊\n${baseOffers}\n\nEnjoy our regular rewards program!`;
    }
  }

  // D. LOCATION / ADDRESS
  if (['location', 'address', 'kaha', 'lohegaon', 'indiranagar', 'address', 'लोकेशन', 'rasta', 'direction', 'map'].some(kw => lowercaseText.includes(kw))) {
    updateCustomerProfile(branchId, fromPhone, null, 'asked_location');
    
    if (lang === 'hinglish') {
      return `Hum ${business.location} par located hain! 📍\nYeh raha map link: ${business.map} 😊`;
    } else if (lang === 'hindi') {
      return `हम ${business.location} पर स्थित हैं! 📍\nयह रहा हमारा मैप लिंक: ${business.map} 😊`;
    } else {
      return `We are located at ${business.location}! 📍\nHere is our Google Maps link: ${business.map} 😊`;
    }
  }

  // E. TIMING
  if (['timing', 'open', 'timings', 'hours', 'kab', 'baje', 'timing?'].some(kw => lowercaseText.includes(kw))) {
    updateCustomerProfile(branchId, fromPhone, null, 'asked_timing');
    
    if (lang === 'hinglish') {
      return `Hum har roz timings: ${business.timings} tak open rehte hain! ⏰\nAap jab chahein aa sakte hain 😊`;
    } else if (lang === 'hindi') {
      return `हम हर दिन: ${business.timings} तक खुले रहते हैं! ⏰\nआपका जब मन करे आप आ सकते हैं 😊`;
    } else {
      return `We are open daily from ${business.timings}! ⏰\nFeel free to drop by anytime 😊`;
    }
  }

  // F. WIFI
  if (['wifi', 'wi-fi', 'password', 'internet', 'net'].some(kw => lowercaseText.includes(kw))) {
    if (lang === 'hinglish') {
      return `Haan ji, café me free WiFi available hai! 📶\nSSID / Password: ${business.wifi} 😊`;
    } else {
      return `Yes, we have free high-speed WiFi for all customers! 📶\nSSID / Password: ${business.wifi} 😊`;
    }
  }

  // G. REVIEW
  if (['review', 'rating', 'feedback', 'stars', 'google review'].some(kw => lowercaseText.includes(kw))) {
    if (lang === 'hinglish') {
      return `Aapka review humare liye bohot valuable hai! ⭐\nApna feedback yahan share karein: ${business.review} 😊`;
    } else {
      return `We would love to hear about your experience! ⭐\nPlease leave us a Google review here: ${business.review} 😊`;
    }
  }

  // H. CONTACT
  if (['contact', 'phone', 'number', 'call', 'mobile'].some(kw => lowercaseText.includes(kw))) {
    if (lang === 'hinglish') {
      return `Aap humein call kar sakte hain is number par: ${business.contact} 📞`;
    } else {
      return `You can reach out to our front desk directly at: ${business.contact} 📞`;
    }
  }

  // I. STUDENT OFFER
  if (['student', 'college', 'school', 'id card', 'student offer', 'student discount'].some(kw => lowercaseText.includes(kw))) {
    updateCustomerProfile(branchId, fromPhone, null, 'is_student');
    
    if (lang === 'hinglish') {
      return 'Haan ji! Students ko valid college ID card dikhane par flat 10% discount milta hai! 🎓😊';
    } else {
      return 'Yes! We offer a flat 10% discount to all students. Just present a valid Student ID card at checkout! 🎓😊';
    }
  }

  // J. SPECIFIC PRICING REASONING ENGINE (DYNAMIC PRODUCT SEARCH)
  let matchedItem = null;
  for (const item of menu) {
    if (lowercaseText.includes(item.name.toLowerCase()) || 
        (item.name.toLowerCase().includes('coffee') && lowercaseText.includes('coffee')) || 
        (item.name.toLowerCase().includes('pasta') && lowercaseText.includes('pasta')) || 
        (item.name.toLowerCase().includes('fries') && lowercaseText.includes('fries')) || 
        (item.name.toLowerCase().includes('burger') && lowercaseText.includes('burger')) || 
        (item.name.toLowerCase().includes('mojito') && lowercaseText.includes('mojito'))) {
      matchedItem = item;
      break;
    }
  }

  if (matchedItem && (lowercaseText.includes('price') || lowercaseText.includes('rate') || 
                      lowercaseText.includes('kitne') || lowercaseText.includes('rupay') || 
                      lowercaseText.includes('cost') || lowercaseText.includes('charge') || 
                      lowercaseText.includes('milt')) || lowercaseText.includes('paise')) {
    
    updateCustomerProfile(branchId, fromPhone, null, 'interested_in_' + matchedItem.category.toLowerCase());
    
    let finalPrice = matchedItem.price;
    let discMessage = '';
    if (matchedItem.discount > 0) {
      finalPrice = Math.round(matchedItem.price * (1 - matchedItem.discount / 100));
      if (lang === 'hinglish') {
        discMessage = `, par aaj ${matchedItem.discount}% discount ke sath yeh aapko sirf ₹${finalPrice} me milega! 😍`;
      } else if (lang === 'hindi') {
        discMessage = `, पर आज ${matchedItem.discount}% छूट के साथ यह आपको सिर्फ ₹${finalPrice} में मिलेगा! 😍`;
      } else {
        discMessage = `, but with today's special ${matchedItem.discount}% off, it is yours for only ₹${finalPrice}! 😍`;
      }
    }

    if (lang === 'hinglish') {
      return `Humara *${matchedItem.name}* standard price ₹${matchedItem.price} ka hai${discMessage || '!'} 😊`;
    } else if (lang === 'hindi') {
      return `हमारा *${matchedItem.name}* मानक मूल्य ₹${matchedItem.price} का है${discMessage || '!'} 😊`;
    } else {
      return `Our *${matchedItem.name}* standard price is ₹${matchedItem.price}${discMessage || '!'} 😊`;
    }
  }

  // K. BUDGET / CHEAPEST SEARCH ("Sasta kya hai?")
  if (['sasta', 'cheapest', 'cheap', 'budget', 'under'].some(kw => lowercaseText.includes(kw))) {
    const sortedMenu = [...menu].sort((a, b) => {
      const aReal = a.price * (1 - a.discount / 100);
      const bReal = b.price * (1 - b.discount / 100);
      return aReal - bReal;
    });

    const cheapest1 = sortedMenu[0];
    const cheapest2 = sortedMenu[1];
    
    const c1Price = Math.round(cheapest1.price * (1 - cheapest1.discount / 100));
    const c2Price = Math.round(cheapest2.price * (1 - cheapest2.discount / 100));

    if (lang === 'hinglish') {
      return `Humare menu me sabse budget-friendly items *${cheapest1.name}* (₹${c1Price}) aur *${cheapest2.name}* (₹${c2Price}) hain! 🤑\nDono bohot hi tasty aur bestselling hain! Try kijiye! 😊`;
    } else if (lang === 'hindi') {
      return `हमारे मेन्यू में सबसे कम दाम वाले स्वादिष्ट आइटम्स *${cheapest1.name}* (₹${c1Price}) और *${cheapest2.name}* (₹${c2Price}) हैं! 🤑\nदोनों बेहतरीन स्वाद वाले हैं! ज़रूर ट्राय करें! 😊`;
    } else {
      return `Our most budget-friendly choices are the *${cheapest1.name}* (₹${c1Price}) and *${cheapest2.name}* (₹${c2Price})! 🤑\nBoth are super popular and absolutely delicious! 😊`;
    }
  }

  // L. GENERAL SMALL TALK AND MISCELLANEOUS TOPICS
  return generateLocalConversationalReply(branchId, text, lang);
}

// Auto-Pilot Low-Traffic Campaign Engine
function runAutoPilotCampaign(branchId, forceDay = null) {
  const settings = getBranchData(branchId, 'settings.json');
  if (!settings.autoPilotActive && !forceDay) {
    console.log(`[Auto-Pilot Campaign] Skipped for branch ${branchId} - Auto-Pilot is disabled.`);
    return { success: false, reason: 'Auto-Pilot is disabled' };
  }

  const now = new Date();
  const today = forceDay || now.toLocaleDateString('en-US', { weekday: 'long' });
  const campaign = settings.lowTrafficCampaigns.find(c => c.day.toLowerCase() === today.toLowerCase());

  if (!campaign) {
    console.log(`[Auto-Pilot Campaign] No campaign configured for ${today} in branch ${branchId}.`);
    return { success: false, reason: `No campaign for ${today}` };
  }

  const campaignText = campaign.offer;
  const profiles = getBranchData(branchId, 'customer_profiles.json');
  
  // Select target customers who:
  // 1. Have not received an offer in the last 48 hours
  // 2. Have appropriate tag matches (e.g. coffee tag for coffee offer) or are tagged as 'Offer Seekers' (or asked_for_offers)
  const targetCustomers = profiles.filter(cust => {
    // 1. Check 48h limit
    const lastOffer = cust.offersReceived && cust.offersReceived.length > 0 
      ? cust.offersReceived[cust.offersReceived.length - 1] 
      : null;
    if (lastOffer) {
      const lastTime = new Date(lastOffer.timestamp);
      const diffMs = Date.now() - lastTime.getTime();
      const diffHours = diffMs / (1000 * 60 * 60);
      if (diffHours < 48) {
        return false; // received too recently
      }
    }

    // 2. Tag matches
    const offerLower = campaignText.toLowerCase();
    const hasOfferTag = (cust.tags || []).some(t => 
      t.toLowerCase().includes('offer') || 
      t.toLowerCase().includes('seek')
    );
    if (hasOfferTag) return true;

    // Check category keywords
    const keywords = ['coffee', 'burger', 'pasta', 'fries', 'mojito'];
    for (const kw of keywords) {
      if (offerLower.includes(kw)) {
        const hasKwTag = (cust.tags || []).some(t => t.toLowerCase().includes(kw));
        if (hasKwTag) return true;
      }
    }

    return false; // does not match target tags
  });

  if (targetCustomers.length === 0) {
    console.log(`[Auto-Pilot Campaign] No target customers matched for today's campaign in branch ${branchId}.`);
    return { success: true, count: 0, logs: [] };
  }

  const logs = [];
  targetCustomers.forEach(cust => {
    let msgText = campaignText;
    if (db) {
      const issued = db.issueCoupon({ businessId: branchId, sourceType: 'autopilot', sourceId: today,
        customerPhone: cust.phone, discountType: 'percent', discountValue: 15 });
      msgText += `\n\n🎟 Use code *${issued.code}* at checkout!`;
    }

    // Send message (console log + live chat simulator stream + real WhatsApp if connected)
    const msgLog = `[Auto-Pilot Broadcast] Sent to ${cust.name || 'Customer'} (${cust.phone}): "${msgText}"`;
    console.log(msgLog);
    logs.push({ phone: cust.phone, name: cust.name, status: 'Sent Successfully' });

    // Save offer in customer profile
    cust.offersReceived = cust.offersReceived || [];
    cust.offersReceived.push({
      offer: msgText,
      timestamp: new Date().toISOString()
    });

    // Send via WhatsApp if connected
    if (whatsappClient && whatsappConnectionStatus === 'Connected') {
      const wid = cust.phone.includes('@') ? cust.phone : `${cust.phone}@c.us`;
      whatsappClient.sendMessage(wid, msgText).catch(e => console.error('[WhatsApp Autopilot Error]', e));
    }

    // Emit live chat simulator log (branch staff + agency only)
    emitToBranch(branchId, 'inbound_chat', {
      branchId,
      phone: cust.phone,
      text: `📢 *[AUTOPILOT CAMPAIGN]*: ${msgText}`,
      sender: 'ai',
      timestamp: new Date().toLocaleTimeString()
    });

    if (db) db.logEvent(branchId, 'campaign.sent',
      { customerPhone: cust.phone, actor: 'system', metadata: { source: 'autopilot', day: today, offer: campaignText } });
  });

  // Write profiles back
  writeBranchData(branchId, 'customer_profiles.json', profiles);
  // Emit updates
  emitToBranch(branchId, 'crm_update', { branchId, profiles });

  return { success: true, count: targetCustomers.length, logs };
}

// -------------------------------------------------------------
// Express REST API
// -------------------------------------------------------------

// 1. Get businesses list

// ── Auth Routes ────────────────────────────────────────────────────────────────
// ── Auth Routes — with JSON fallback when SQLite unavailable ─────────────────
const STAFF_FILE = path.join(DATA_DIR, 'staff.json');
function loadStaff() {
  try { return fs.existsSync(STAFF_FILE) ? JSON.parse(fs.readFileSync(STAFF_FILE,'utf-8')) : []; }
  catch(e) { return []; }
}


// ── JWT + Auth Middleware ─────────────────────────────────────────────────────
let jwt = null;
try { jwt = require('jsonwebtoken'); } catch(e) {
  console.warn('[Auth] jsonwebtoken not installed — run: npm install jsonwebtoken');
}
const JWT_SECRET  = process.env.JWT_SECRET;  // validated at boot in auth.js — no fallback
const JWT_EXPIRES = '24h';

function signToken(payload) {
  if (!jwt) return 'json_mode_' + Date.now();
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}
function verifyToken(token) {
  if (!jwt) return null;
  try { return jwt.verify(token, JWT_SECRET); }
  catch(e) { return null; }
}
function requireAuth(req, res, next) {
  if (auth) return auth.requireAuth(req, res, next);
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token provided' });
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Invalid or expired token' });
  req.staff = payload;
  next();
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.staff) return res.status(401).json({ error: 'Not authenticated' });
    if (!roles.includes(req.staff.role))
      return res.status(403).json({ error: 'Insufficient permissions' });
    next();
  };
}
function requireBranchAccess(req, res, next) {
  if (!req.staff) return res.status(401).json({ error: 'Not authenticated' });
  const { role, businessId } = req.staff;
  const targetBranch = req.params.id || req.params.branchId;
  if (['agency_admin', 'admin'].includes(role)) return next();
  if (!targetBranch || businessId === targetBranch) return next();
  return res.status(403).json({ error: 'Access denied — this is not your branch' });
}


// ── Route modules ────────────────────────────────────────────────────────────
// Shared context passed to every route module
const routeCtx = {
  app, io, fs, path,
  DATA_DIR, BUSINESSES_FILE, businesses,
  getBranchData, writeBranchData,
  updateCustomerProfile, processCafeBotReply,
  initializeBusinessFiles,
  emitToBranch, runAutoPilotCampaign, getLoyaltyTier,
  loadGrowthSuggestion, saveGrowthSuggestion, computeGrowthSuggestion, runWeeklyGrowthSuggestions,
  sendWhatsAppToCustomer, getWaConfig, GEMINI_MODEL,
  startKnowledgeInterview, SUGGESTED_KNOWLEDGE_QUESTIONS,
  normalizePhone: (db && db.normalizePhone) || ((p) => (p ? String(p).replace(/[^0-9]/g, '').slice(-10) : '')),
  logEvent: (db && db.logEvent) || (() => {}),
  waApi, genAI, razorpay: (() => { try { return new (require('razorpay'))({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET }); } catch(e){ return null; } })(),
  whatsappConnectionStatus: 'Disconnected',
  requireAuth, requireBranchAccess, requireRole,
  signToken, verifyToken, loadStaff, STAFF_FILE,
  getSubscriptionStatus, requireActiveSubscription,
  auth,
  db,   // null in JSON mode; SQLite handle when available
  get whatsappClient() { return whatsappClient; }, // live reference
};

// whatsappConnectionStatus is a mutable string — keep it live via property
Object.defineProperty(routeCtx, 'whatsappConnectionStatus', {
  get: () => whatsappConnectionStatus, configurable: true
});

require('./routes/auth')(routeCtx);
require('./routes/orders')(routeCtx);
require('./routes/loyalty')(routeCtx);
require('./routes/business')(routeCtx);
require('./routes/marketing')(routeCtx);
require('./routes/extras')(routeCtx);
require('./routes/agency')(routeCtx);
require('./routes/billing')(routeCtx);
require('./routes/activity')(routeCtx);
require('./routes/feedback')(routeCtx);
require('./routes/leads')(routeCtx);

// Socket.io Real-time Event Handling
// -------------------------------------------------------------
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
  if (db) db.logEvent(id, 'walkin.registered',
    { customerPhone: cleanPhone, actor: req.staff ? `staff:${req.staff.id}` : 'staff', metadata: { isNew, visits: customer.visits } });
  res.json({ success: true, isNew, customer, pointsAwarded });
});

// ── WhatsApp Cloud API Config ─────────────────────────────────────────────────
app.get('/api/businesses/:id/whatsapp/status', requireAuth, requireBranchAccess, (req, res) => {
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

// ── WhatsApp Cloud API — inbound receptionist (Level 1: auto-reply only) ─────
// Each branch's phoneNumberId/accessToken live in data/<branchId>/whatsapp_config.json
// (saved above). Meta's webhook is registered ONCE for the whole app (not per
// branch), so a single WHATSAPP_VERIFY_TOKEN is used for verification and
// inbound messages are routed to a branch by matching phone_number_id.
function getWaConfig(branchId) {
  try {
    const cfgFile = path.join(DATA_DIR, branchId, 'whatsapp_config.json');
    if (!fs.existsSync(cfgFile)) return null;
    return JSON.parse(fs.readFileSync(cfgFile, 'utf-8'));
  } catch (e) { return null; }
}

function findBranchByPhoneNumberId(phoneNumberId) {
  for (const b of businesses) {
    const cfg = getWaConfig(b.id);
    if (cfg && cfg.phoneNumberId === phoneNumberId) return b.id;
  }
  return null;
}

async function sendWhatsAppToCustomer(branchId, phone, text) {
  const cfg = getWaConfig(branchId);
  if (!cfg?.phoneNumberId || !cfg?.accessToken) {
    console.warn('[WA Cloud API] No credentials for branch:', branchId);
    return false;
  }
  try {
    await waApi.sendMessage(cfg.phoneNumberId, cfg.accessToken, phone, text);
    return true;
  } catch (e) {
    console.error('[WA Cloud API] Send error for', branchId, ':', e.message);
    return false;
  }
}

// ── Forgot password via WhatsApp OTP ─────────────────────────────────────────
// Only works once a café has connected its own WhatsApp (Settings tab) — there
// is no agency-wide sender number configured, so this can't fall back to one.
const _otpRequestLog = new Map(); // staffId -> [timestamps] — basic abuse guard
function otpRateLimited(staffId) {
  const now = Date.now();
  const WINDOW = 15 * 60 * 1000;
  const hits = (_otpRequestLog.get(staffId) || []).filter(t => now - t < WINDOW);
  hits.push(now);
  _otpRequestLog.set(staffId, hits);
  return hits.length > 3;
}

app.post('/api/auth/forgot-password', async (req, res) => {
  const { businessId, username } = req.body;
  if (!businessId || !username) {
    return res.status(400).json({ error: 'businessId and username required' });
  }
  if (!db) return res.status(503).json({ error: 'Not available in this server mode' });

  const staff = db.getStaffByUsername(businessId, username);
  if (!staff) return res.status(404).json({ error: 'No account found for that username on this branch' });
  if (!staff.phone) {
    return res.status(400).json({ error: 'No phone number on file for this account — ask your café admin to reset your password instead.' });
  }
  const cfg = getWaConfig(businessId);
  if (!cfg?.phoneNumberId || !cfg?.accessToken) {
    return res.status(400).json({ error: 'This café has not connected WhatsApp yet, so OTP reset isn\'t available. Ask your café admin to reset your password instead.' });
  }
  if (otpRateLimited(staff.id)) {
    return res.status(429).json({ error: 'Too many reset attempts. Try again in a few minutes.' });
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = new Date(Date.now() + 10 * 60000).toISOString().slice(0, 19).replace('T', ' ');
  db.createPasswordResetOtp(staff.id, code, expiresAt);

  const sent = await sendWhatsAppToCustomer(businessId, staff.phone,
    `🔐 Your Zordic California password reset code is: *${code}*\n\nThis code expires in 10 minutes. If you didn't request this, you can ignore this message.`);
  if (!sent) return res.status(500).json({ error: 'Failed to send the WhatsApp message. Try again shortly.' });

  res.json({ success: true, message: 'Code sent via WhatsApp' });
});

app.post('/api/auth/reset-password', (req, res) => {
  const { businessId, username, otp, newPassword } = req.body;
  if (!businessId || !username || !otp || !newPassword) {
    return res.status(400).json({ error: 'All fields are required' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  if (!db) return res.status(503).json({ error: 'Not available in this server mode' });

  const staff = db.getStaffByUsername(businessId, username);
  if (!staff) return res.status(401).json({ error: 'Invalid request' });

  const validOtp = db.getValidPasswordResetOtp(staff.id, otp);
  if (!validOtp) return res.status(400).json({ error: 'Invalid or expired code' });

  const bcrypt = require('bcryptjs');
  db.updateStaffPassword(staff.id, bcrypt.hashSync(newPassword, 10));
  db.consumePasswordResetOtp(validOtp.id);
  db.audit(businessId, staff.id, staff.name, 'password_reset_otp', 'Password reset via WhatsApp OTP', req.ip);

  res.json({ success: true });
});

// De-dupe inbound message ids (Meta can redeliver on a slow/failed 200).
// Bounded so this can't leak memory over a long-running process.
const processedWaMessageIds = new Set();
function markWaMessageProcessed(id) {
  processedWaMessageIds.add(id);
  if (processedWaMessageIds.size > 2000) {
    const first = processedWaMessageIds.values().next().value;
    processedWaMessageIds.delete(first);
  }
}

// GET — Meta calls this once when the webhook is registered in the App Dashboard
app.get('/api/webhook/whatsapp', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && process.env.WHATSAPP_VERIFY_TOKEN && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log('[WA Webhook] Verification successful');
    return res.status(200).send(challenge);
  }
  console.warn('[WA Webhook] Verification failed — check WHATSAPP_VERIFY_TOKEN matches the Meta App Dashboard');
  res.sendStatus(403);
});

// POST — incoming customer messages. Always ack 200 fast so Meta doesn't retry;
// do the real work after responding.
app.post('/api/webhook/whatsapp', (req, res) => {
  res.sendStatus(200);

  (async () => {
    try {
      const body = req.body;
      if (body.object !== 'whatsapp_business_account') return;

      for (const entry of (body.entry || [])) {
        for (const change of (entry.changes || [])) {
          const value = change.value;
          if (!value?.messages?.length) continue; // ignore status callbacks (sent/delivered/read)

          const phoneNumberId = value.metadata?.phone_number_id;
          const branchId = findBranchByPhoneNumberId(phoneNumberId);
          if (!branchId) {
            console.warn('[WA Webhook] No branch configured for phone_number_id:', phoneNumberId);
            continue;
          }
          const cfg = getWaConfig(branchId);

          for (const message of value.messages) {
            if (message.type !== 'text') continue; // images/audio/etc. not handled yet
            if (processedWaMessageIds.has(message.id)) continue; // de-dupe redelivery
            markWaMessageProcessed(message.id);

            const fromPhone = message.from; // e.g. "919876543210"
            const incomingText = message.text?.body || '';

            waApi.markAsRead(cfg.phoneNumberId, cfg.accessToken, message.id).catch(() => {});

            // processCafeBotReply already logs chat.inbound/outbound (LP1),
            // persists both messages to chat_messages, and runs the full
            // reservation/feedback/loyalty state machine — identical behavior
            // to the web chat widget and the simulator.
            const reply = await processCafeBotReply(branchId, fromPhone, incomingText, { channel: 'whatsapp' });

            emitToBranch(branchId, 'inbound_chat', {
              branchId, phone: fromPhone, text: incomingText, sender: 'customer',
              timestamp: new Date().toLocaleTimeString(),
            });
            // reply is null when a Starter café is over its daily Haiku cap — stay
            // silent: send nothing to the customer and don't stream an AI bubble.
            if (reply) {
              await sendWhatsAppToCustomer(branchId, fromPhone, reply);
              emitToBranch(branchId, 'inbound_chat', {
                branchId, phone: fromPhone, text: reply, sender: 'ai',
                timestamp: new Date().toLocaleTimeString(),
              });
            }
          }
        }
      }
    } catch (e) {
      console.error('[WA Webhook] Processing error:', e.message);
    }
  })();
});

// ── Accounting / Expenses ─────────────────────────────────────────────────────
app.get('/api/businesses/:id/accounting/expenses', requireAuth, requireBranchAccess, (req, res) => {
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
app.get('/api/businesses/:id/at-risk-customers', requireAuth, requireBranchAccess, (req, res) => {
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

// ── Analytics (owner portal stats card) ──────────────────────────────────────
// Ported back from an orphaned data/.fuse_hidden* crash-artifact file — this
// route was never actually present in server.js, so portal.html's calls to it
// have been silently 404ing since launch.
app.get('/api/businesses/:id/analytics-v2', requireAuth, requireBranchAccess, (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB module not loaded' });
  try {
    const analytics = db.getAnalytics(req.params.id);
    const revenue    = db.getRevenueStats(req.params.id);
    res.json({
      ...analytics,
      todayOrders:  revenue.today_orders,
      todayRevenue: revenue.today_revenue,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Business Intelligence event log — read endpoints ─────────────────────────
app.get('/api/businesses/:id/events', requireAuth, requireBranchAccess, (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB not loaded' });
  const { type, from, to, limit } = req.query;
  res.json(db.getEvents(req.params.id, { type, from, to, limit: limit ? parseInt(limit) : undefined }));
});

// Agency-wide roll-up across all tenants (for HQ)
app.get('/api/admin/events', requireAuth, requireRole('agency_admin', 'admin'), (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB not loaded' });
  const { type, from, to, limit } = req.query;
  res.json(db.getAllEvents({ type, from, to, limit: limit ? parseInt(limit) : undefined }));
});

app.post('/api/businesses/:id/at-risk-customers/send-offer', requireAuth, requireBranchAccess, async (req, res) => {
  const { id } = req.params;
  const { phone, name, offerText } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone required' });

  let winbackCoupon = null;
  if (db) {
    const issued = db.issueCoupon({ businessId: id, sourceType: 'winback', customerPhone: phone,
      discountType: 'percent', discountValue: 15 });
    winbackCoupon = issued.code;
  }

  // Try to send via WhatsApp Cloud API if configured
  const cfgFile = path.join(DATA_DIR, id, 'whatsapp_config.json');
  let sent = false;
  if (fs.existsSync(cfgFile)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf-8'));
      if (cfg.phoneNumberId && cfg.accessToken) {
        const fetch = (...a) => import('node-fetch').then(m => m.default(...a)).catch(() => null);
        const msg = (offerText || `Hi ${name || 'there'}! We miss you at our café ☕ Come back and enjoy a special 15% off on your next visit — just for you! 🎁`)
          + (winbackCoupon ? `\n\n🎟 Use code *${winbackCoupon}* at checkout!` : '');
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

  if (db) db.logEvent(id, 'campaign.sent',
    { customerPhone: phone, actor: req.staff ? `staff:${req.staff.id}` : 'staff', metadata: { source: 'winback', sent, offerText: offerText || null } });
  res.json({ success: true, sent, message: sent ? 'WhatsApp message sent!' : 'Offer logged (WhatsApp not configured)' });
});

// ── AI Re-engagement Offer Generator ─────────────────────────────────────────
app.post('/api/businesses/:id/customers/:phone/ai-offer', requireAuth, requireBranchAccess, (req, res) => {
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
app.get('/api/businesses/:id/customers/:phone/insights', requireAuth, requireBranchAccess, (req, res) => {
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

// Lead capture (/api/contact) and lead listing (/api/leads) live in routes/agency.js.
// The duplicate inline copies that used to sit here were dead code (agency.js registers
// first and wins) and the GET was unauthenticated — removed in Phase 0 (SEC-4).

io.on('connection', (socket) => {
  console.log(`[Socket.io] Client connected: ${socket.id}`);

  // Room membership: pages call socket.emit('join_business', { businessId, token }).
  // Customer pages (no token) get the public room only; staff tokens matching the
  // branch (or agency admins) get the staff room; agency admins also join 'agency'.
  socket.on('join_business', (data = {}) => {
    try {
      const businessId = typeof data === 'string' ? data : (data.businessId || '');
      const token      = (data && data.token) || null;
      if (businessId && typeof businessId === 'string' && businessId.length <= 80) {
        socket.join(`biz:${businessId}:public`);
      }
      const payload = token ? verifyToken(token) : null;
      if (payload) {
        if (['agency_admin', 'admin'].includes(payload.role)) {
          socket.join('agency');
        } else if (payload.businessId && payload.businessId === businessId) {
          socket.join(`biz:${businessId}:staff`);
        }
      }
    } catch (e) { /* invalid join payload — ignore */ }
  });

  // Emit current WhatsApp linking state immediately on load
  socket.emit('whatsapp_state', {
    status: whatsappConnectionStatus,
    qr: whatsappQrCodeDataUrl,
    activeBusinessId: activeRealBotBusinessId,
    number: whatsappClient && whatsappClient.info ? whatsappClient.info.wid.user : null,
    geminiActive: !!genAI
  });

  // Handle manual chatbot simulator triggers
  socket.on('simulate_chat', async (data) => {
    const { branchId, phone, text, customerName } = data;

    // Log message on dashboard
    emitToBranch(branchId, 'inbound_chat', {
      branchId,
      phone,
      text,
      sender: 'customer',
      customerName,
      timestamp: new Date().toLocaleTimeString()
    });

    // Run pricing reasoning / reservation engine on the server
    const aiReply = await processCafeBotReply(branchId, phone, text, { channel: 'simulator', customerName });

    // Simulate thinking delay (aiReply is null when a Starter café is over its
    // daily Haiku cap — stay silent rather than emit an empty AI bubble).
    if (aiReply) {
      setTimeout(() => {
        emitToBranch(branchId, 'inbound_chat', {
          branchId,
          phone,
          text: aiReply,
          sender: 'ai',
          timestamp: new Date().toLocaleTimeString()
        });
      }, 1200);
    }
  });

  // Legacy WhatsApp Web (Puppeteer/QR) mode is retired — Cloud API is the only
  // supported channel (Manager → Settings → WhatsApp). The old handler called an
  // undefined initializeWhatsAppClient() and crashed the process on click.
  socket.on('start_whatsapp', () => {
    socket.emit('whatsapp_state', {
      status: 'Use WhatsApp Cloud API — Manager Dashboard → Settings → WhatsApp',
      qr: null,
      activeBusinessId: activeRealBotBusinessId,
      geminiActive: !!genAI
    });
  });

  // Handle dynamic campaign triggers — requires a staff token for the branch,
  // otherwise any visitor could broadcast WhatsApp messages to all customers.
  socket.on('trigger_campaign_broadcast', (data) => {
    const { branchId, campaignText, targetTag, token } = data;
    const staff = token ? verifyToken(token) : null;
    const allowed = staff && (
      ['agency_admin', 'admin'].includes(staff.role) || staff.businessId === branchId
    );
    if (!allowed) {
      socket.emit('campaign_broadcast_result', { success: false, error: 'Not authorized for this branch' });
      return;
    }
    const profiles = getBranchData(branchId, 'customer_profiles.json');
    
    // Filter profiles by tag
    const targetCustomers = profiles.filter(p => targetTag === 'all' || p.tags.includes(targetTag));
    
    let logs = [];
    targetCustomers.forEach(cust => {
      const msgLog = `[SaaS Promo Broadcast] Sent to ${cust.name || 'Customer'} (${cust.phone}): "${campaignText}"`;
      console.log(msgLog);
      logs.push({ phone: cust.phone, name: cust.name, status: 'Sent Successfully' });
      
      // If WhatsApp is active, actually send it!
      if (whatsappClient && whatsappConnectionStatus === 'Connected') {
        const wid = cust.phone.includes('@') ? cust.phone : `${cust.phone}@c.us`;
        whatsappClient.sendMessage(wid, campaignText).catch(e => console.error('Send error', e));
      }
    });

    socket.emit('campaign_broadcast_result', { success: true, logs });
  });

  socket.on('disconnect', () => {
    console.log(`[Socket.io] Client disconnected: ${socket.id}`);
  });
});

// ── Crash-proofing (multi-tenant safety net) ─────────────────────────────────
// This is a shared process serving every café on the platform. A single bad
// request (e.g. a synchronous DB error thrown inside an async route handler,
// which Express 4 does not catch) must never crash the process and take down
// every other tenant. Log and keep running rather than exit.
process.on('uncaughtException', (err) => {
  console.error('[FATAL — uncaughtException, process kept alive]', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL — unhandledRejection, process kept alive]', reason);
});

server.listen(PORT, () => {
  console.log(`☕ Zordic California running on http://localhost:${PORT}`);
  
  // Set up daily Auto-Pilot scheduler (check once a day at 10 AM, simulated as every 12 hours for demo/safety)
  setInterval(() => {
    console.log('[Auto-Pilot Scheduler] Running daily checks for all branches...');
    businesses.forEach(b => {
      try {
        const settings = getBranchData(b.id, 'settings.json');
        if (settings && settings.autoPilotActive) {
          runAutoPilotCampaign(b.id);
        }
      } catch (err) {
        console.error(`[Auto-Pilot Scheduler Error] Failed for branch ${b.id}:`, err);
      }
    });
  }, 1000 * 60 * 60 * 12); // Check every 12 hours

  // Weekly growth suggestions (G4) — Mondays ~10:00 server time, then every 7
  // days after that. Server runs in UTC; the exact hour isn't critical since
  // this is a once-a-week nudge, not a time-sensitive alert.
  (function scheduleWeeklyGrowthSuggestions() {
    function msUntilNextMonday10AM() {
      const now = new Date();
      const next = new Date(now);
      next.setHours(10, 0, 0, 0);
      const daysUntilMonday = (1 - next.getDay() + 7) % 7;
      next.setDate(next.getDate() + daysUntilMonday);
      if (next <= now) next.setDate(next.getDate() + 7);
      return next - now;
    }
    const wait = msUntilNextMonday10AM();
    console.log(`[Growth Suggestions] Next run in ${Math.floor(wait / 3600000)}h (Monday 10:00)`);
    setTimeout(() => {
      runWeeklyGrowthSuggestions();
      setInterval(runWeeklyGrowthSuggestions, 7 * 24 * 60 * 60 * 1000); // then every 7 days
    }, wait);
  })();
});
