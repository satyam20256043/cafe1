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
    whatsappClient,
    emitToBranch,
  } = ctx;

// ════════════════════════════════════════════════════════════════════════════
// Phase 3 — Loyalty Points Routes
// ════════════════════════════════════════════════════════════════════════════

// [/:phone route moved below named routes]

// POST /api/businesses/:id/loyalty/lookup  — lookup or create card
// { phone, name }
app.post('/api/businesses/:id/loyalty/lookup', (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB not loaded' });
  const { phone, name } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  const card = db.getOrCreateCard(req.params.id, phone, name);
  const history = db.getLoyaltyHistory(req.params.id, phone, 5);
  res.json({ card, history });
});

// POST /api/businesses/:id/loyalty/award  — award points after order
// { phone, name, amountSpent, orderId }
app.post('/api/businesses/:id/loyalty/award', requireAuth, requireBranchAccess, (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB not loaded' });
  const { phone, name, amountSpent, orderId } = req.body;
  if (!phone || !amountSpent) return res.status(400).json({ error: 'phone and amountSpent required' });
  const card = db.awardPoints(req.params.id, phone, name, parseFloat(amountSpent), orderId);
  emitToBranch(req.params.id, 'loyalty_update', { businessId: req.params.id, card });
  res.json({ card });
});

// POST /api/businesses/:id/loyalty/redeem-stamps  — redeem 10 stamps
// { phone } — staff-only (SEC-7): redemption happens at the counter, otherwise
// anyone who knows a customer's phone number could drain their balance remotely.
app.post('/api/businesses/:id/loyalty/redeem-stamps', requireAuth, requireBranchAccess, (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB not loaded' });
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  const result = db.redeemStamps(req.params.id, phone);
  res.json(result);
});

// POST /api/businesses/:id/loyalty/redeem-points  — redeem points for discount
// { phone, points } — staff-only (SEC-7), same reasoning as redeem-stamps
app.post('/api/businesses/:id/loyalty/redeem-points', requireAuth, requireBranchAccess, (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB not loaded' });
  const { phone, points } = req.body;
  if (!phone || !points) return res.status(400).json({ error: 'phone and points required' });
  const result = db.redeemPoints(req.params.id, phone, parseInt(points));
  res.json(result);
});

// POST /api/businesses/:id/loyalty/birthday  — set birthday
// { phone, birthday }  birthday format: MM-DD or YYYY-MM-DD
app.post('/api/businesses/:id/loyalty/birthday', (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB not loaded' });
  const { phone, birthday } = req.body;
  if (!phone || !birthday) return res.status(400).json({ error: 'phone and birthday required' });
  db.updateBirthday(req.params.id, phone, birthday);
  res.json({ success: true });
});

// GET /api/businesses/:id/loyalty/leaderboard  — top customers
app.get('/api/businesses/:id/loyalty/leaderboard', requireAuth, requireBranchAccess, (req, res) => {
  if (db) return res.json(db.getLoyaltyLeaderboard(req.params.id, 20));
  // JSON mode: derive leaderboard from customer profiles
  const profiles = getBranchData(req.params.id, 'customer_profiles.json') || [];
  const board = profiles
    .map(p => ({
      id: p.phone, name: p.name || 'Guest', phone: p.phone,
      points: p.loyaltyPoints || p.points || 0,
      stamps: p.stamps || 0, visits: p.visits || 0,
      totalSpent: p.totalSpent || 0,
    }))
    .sort((a,b) => b.points - a.points)
    .slice(0, 20);
  res.json(board);
});

// GET /api/businesses/:id/loyalty/birthdays  — upcoming birthdays (7 days)
app.get('/api/businesses/:id/loyalty/birthdays', requireAuth, requireBranchAccess, (req, res) => {
  if (db) return res.json(db.getUpcomingBirthdays(req.params.id, 7));
  // JSON mode: find customers with birthdays in next 7 days
  const profiles = getBranchData(req.params.id, 'customer_profiles.json') || [];
  const today = new Date();
  const upcoming = profiles.filter(p => {
    if (!p.birthday) return false;
    try {
      const [, mm, dd] = p.birthday.match(/(\d{2})-(\d{2})/) || [];
      if (!mm) return false;
      const bday = new Date(today.getFullYear(), parseInt(mm)-1, parseInt(dd));
      if (bday < today) bday.setFullYear(today.getFullYear()+1);
      const diff = (bday - today) / 86400000;
      return diff >= 0 && diff <= 7;
    } catch { return false; }
  }).map(p => ({ name: p.name, phone: p.phone, birthday: p.birthday }));
  res.json(upcoming);
});

// GET /api/businesses/:id/loyalty/activity  — recent loyalty transactions
app.get('/api/businesses/:id/loyalty/activity', requireAuth, requireBranchAccess, (req, res) => {
  if (!db) return res.json([]);  // JSON mode: no transaction log available
  try {
    const rows = db.raw().prepare(`
      SELECT lt.*, lp.name AS customer_name, lp.phone
      FROM loyalty_transactions lt
      LEFT JOIN loyalty_points lp ON lt.card_id = lp.id
      WHERE lp.business_id = ?
      ORDER BY lt.created_at DESC LIMIT 50
    `).all(req.params.id);
    res.json(rows);
  } catch(e) {
    res.json([]);
  }
});

// GET /api/businesses/:id/loyalty/:phone  — get card by phone (MUST be after named routes)
app.get('/api/businesses/:id/loyalty/:phone', (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB not loaded' });
  const card = db.getLoyaltyCard(req.params.id, req.params.phone);
  if (!card) return res.status(404).json({ error: 'No loyalty card found' });
  const history = db.getLoyaltyHistory(req.params.id, req.params.phone, 5);
  res.json({ card, history });
});


// POST /api/businesses/:id/loyalty/birthday-campaign  — send WhatsApp birthday msg
// Body: { phone, name } for single, or {} for all upcoming birthdays
app.post('/api/businesses/:id/loyalty/birthday-campaign', requireAuth, requireBranchAccess, async (req, res) => {
  const { phone: singlePhone, name: singleName } = req.body;
  const business = businesses.find(b => b.id === req.params.id) || {};
  const bizName  = business.name || 'Café Team';

  const buildMsg = (name) =>
    `🎂 *Happy Birthday, ${name || 'dear friend'}!*\n\n` +
    `Wishing you a beautiful day from all of us at ${bizName}! 🎉\n\n` +
    `As a token of our appreciation:\n` +
    `🎁 *FREE Dessert* on your next visit today!\n\n` +
    `Just show this message at the counter. Valid today only!\n\n` +
    `With warmth & coffee, ${bizName} ☕`;

  const sendWA = async (phone, msg) => {
    if (whatsappClient && whatsappConnectionStatus === 'Connected') {
      const wid = phone.replace(/[^0-9]/g,'') + '@c.us';
      try { await whatsappClient.sendMessage(wid, msg); return true; }
      catch(e) { return false; }
    }
    return false;
  };

  if (singlePhone) {
    // Single recipient
    const msg = buildMsg(singleName);
    const sent = await sendWA(singlePhone, msg);
    return res.json({ success: true, sent, message: msg, note: sent ? undefined : 'WhatsApp not connected — copy message manually' });
  }

  // Bulk: all upcoming birthdays (next 7 days)
  if (!db) return res.status(503).json({ error: 'DB not loaded' });
  const upcoming = db.getUpcomingBirthdays(req.params.id, 7);
  if (!upcoming.length) return res.json({ success: true, sent: 0, message: 'No upcoming birthdays in the next 7 days' });

  let sentCount = 0;
  for (const c of upcoming) {
    const msg = buildMsg(c.name);
    const ok  = await sendWA(c.phone, msg);
    if (ok) sentCount++;
  }
  const waConnected = whatsappClient && whatsappConnectionStatus === 'Connected';
  res.json({
    success: true, sent: sentCount, total: upcoming.length,
    message: waConnected
      ? `Sent ${sentCount} of ${upcoming.length} birthday wishes via WhatsApp ✓`
      : `WhatsApp not connected. ${upcoming.length} customers have birthdays this week — connect WhatsApp to send wishes.`
  });
});


// ════════════════════════════════════════════════════════════════════════════
// Phase 5 — Push Notifications (web-push, optional)
// Install: npm install web-push  then set VAPID_PUBLIC/VAPID_PRIVATE in .env
// ════════════════════════════════════════════════════════════════════════════
let webPush = null;
const pushSubscriptions = new Map(); // phone -> [subscriptions]

try {
  webPush = require('web-push');
  const vapidPublic  = process.env.VAPID_PUBLIC;
  const vapidPrivate = process.env.VAPID_PRIVATE;
  const vapidEmail   = process.env.VAPID_EMAIL || 'mailto:admin@cafehq.com';
  if (vapidPublic && vapidPrivate) {
    webPush.setVapidDetails(vapidEmail, vapidPublic, vapidPrivate);
    console.log('[PWA] Push notifications enabled ✓');
  } else {
    console.log('[PWA] Push notifications: set VAPID_PUBLIC + VAPID_PRIVATE in .env to enable');
    webPush = null;
  }
} catch(e) {
  console.log('[PWA] web-push not installed — run: npm install web-push');
}

// GET /api/push/vapid-public — return public key for browser subscription
app.get('/api/push/vapid-public', (req, res) => {
  if (!webPush) return res.json({ enabled: false, key: null });
  res.json({ enabled: true, key: process.env.VAPID_PUBLIC });
});

// POST /api/push/subscribe — save browser push subscription
// Body: { subscription, phone, businessId }
app.post('/api/push/subscribe', (req, res) => {
  const { subscription, phone, businessId } = req.body;
  if (!subscription || !phone) return res.status(400).json({ error: 'subscription and phone required' });
  const key = `${businessId}:${phone.replace(/[^0-9]/g,'').slice(-10)}`;
  const existing = pushSubscriptions.get(key) || [];
  // Avoid duplicates by endpoint
  if (!existing.find(s => s.endpoint === subscription.endpoint)) {
    existing.push(subscription);
  }
  pushSubscriptions.set(key, existing);
  res.json({ success: true });
});

// Helper: send push to a phone number
async function sendPushToPhone(businessId, phone, payload) {
  if (!webPush) return;
  const key  = `${businessId}:${phone.replace(/[^0-9]/g,'').slice(-10)}`;
  const subs = pushSubscriptions.get(key) || [];
  const dead = [];
  for (const sub of subs) {
    try {
      await webPush.sendNotification(sub, JSON.stringify(payload));
    } catch(e) {
      if (e.statusCode === 410 || e.statusCode === 404) dead.push(sub.endpoint);
    }
  }
  if (dead.length) pushSubscriptions.set(key, subs.filter(s => !dead.includes(s.endpoint)));

};

// Share with other route modules (orders.js calls this on status changes)
ctx.sendPushToPhone = sendPushToPhone;

};
