'use strict';
// Auto-extracted from server.js — do not edit manually.
module.exports = function register(ctx) {
  const {
    app, io, fs, path,
    DATA_DIR, BUSINESSES_FILE, businesses,
    getBranchData, writeBranchData,
    updateCustomerProfile, processCafeBotReply, toIsoZ,
    waApi, genAI, razorpay, getLoyaltySettings, whatsappConnectionStatus,
    requireAuth, requireBranchAccess, requireRole,
    signToken, verifyToken, loadStaff, STAFF_FILE,
    getSubscriptionStatus, requireActiveSubscription,
    db,
    emitToBranch, messageCustomer, qrBulkBlocked,
  } = ctx;
  const { rateLimit } = require('../rateLimit');
  // This is the one place a customer's full card (spend, visits, birthday,
  // transaction history) is reachable with just a phone number and no login
  // — by design, so a customer can check their own balance without a staff
  // account. That same design means anyone who knows/guesses a number gets
  // the same data, so it's throttled rather than left wide open.
  // Deliberately loose: mobile carriers NAT many real customers behind one
  // public IP, so this is sized to stop a scripted enumeration run, not to
  // throttle a busy café's genuine traffic.
  const loyaltyLookupLimit = rateLimit({ windowMs: 60000, max: 40,
    message: 'Too many lookups. Please wait a moment and try again.' });

// ════════════════════════════════════════════════════════════════════════════
// Phase 3 — Loyalty Points Routes
// ════════════════════════════════════════════════════════════════════════════

// [/:phone route moved below named routes]

// POST /api/businesses/:id/loyalty/lookup  — lookup or create card
// { phone, name }
app.post('/api/businesses/:id/loyalty/lookup', loyaltyLookupLimit, (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB not loaded' });
  const { phone, name } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  db.expireStalePointsIfDue(req.params.id, phone, getLoyaltySettings(req.params.id).loyalty);
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
  const card = db.awardPoints(req.params.id, phone, name, parseFloat(amountSpent), orderId, getLoyaltySettings(req.params.id).loyalty);
  db.logEvent(req.params.id, 'loyalty.earned', { customerPhone: phone, actor: 'system', metadata: { amountSpent: parseFloat(amountSpent), orderId, points: card.points } });
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
  if (result.success) db.logEvent(req.params.id, 'loyalty.redeemed', { customerPhone: phone, actor: req.staff ? `staff:${req.staff.id}` : 'staff', metadata: { type: 'stamps' } });
  res.json(result);
});

// POST /api/businesses/:id/loyalty/redeem-points  — redeem points for discount
// { phone, points } — staff-only (SEC-7), same reasoning as redeem-stamps
app.post('/api/businesses/:id/loyalty/redeem-points', requireAuth, requireBranchAccess, (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB not loaded' });
  const { phone, points } = req.body;
  if (!phone || !points) return res.status(400).json({ error: 'phone and points required' });
  const result = db.redeemPoints(req.params.id, phone, parseInt(points), getLoyaltySettings(req.params.id).loyalty);
  if (result.success) db.logEvent(req.params.id, 'loyalty.redeemed', { customerPhone: phone, actor: req.staff ? `staff:${req.staff.id}` : 'staff', metadata: { type: 'points', points: parseInt(points) } });
  res.json(result);
});

// POST /api/businesses/:id/loyalty/birthday  — set birthday
// { phone, birthday }  birthday format: MM-DD or YYYY-MM-DD
app.post('/api/businesses/:id/loyalty/birthday', (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB not loaded' });
  const { phone, birthday } = req.body;
  if (!phone || !birthday) return res.status(400).json({ error: 'phone and birthday required' });
  const result = db.updateBirthday(req.params.id, phone, birthday);
  res.json(result);
});

// GET /api/businesses/:id/loyalty/leaderboard  — top customers
app.get('/api/businesses/:id/loyalty/leaderboard', requireAuth, requireBranchAccess, (req, res) => {
  if (db) return res.json(db.getLoyaltyLeaderboard(req.params.id, 20, getLoyaltySettings(req.params.id).loyalty).map(r => ({ ...r, last_visit: toIsoZ(r.last_visit) })));
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
    // loyalty_transactions has no card_id column (it keys by business_id+phone
    // directly, not a card-id FK) and loyalty_points has no name column (real
    // column is customer_name) — the original query referenced both, so it
    // threw on every call and the catch below silently returned [].
    const rows = db.raw().prepare(`
      SELECT lt.*, lp.customer_name AS customer_name
      FROM loyalty_transactions lt
      LEFT JOIN loyalty_points lp ON lp.business_id = lt.business_id AND lp.phone = lt.phone
      WHERE lt.business_id = ?
      ORDER BY lt.created_at DESC LIMIT 50
    `).all(req.params.id);
    res.json(rows.map(r => ({ ...r, created_at: toIsoZ(r.created_at) })));
  } catch(e) {
    res.json([]);
  }
});

// GET /api/businesses/:id/loyalty/:phone  — get card by phone (MUST be after named routes)
// Staff-only: full card + recent transaction history is more than a customer
// checking their own points needs (that's /loyalty/lookup, POST, by design
// unauthenticated) — no frontend calls this GET today, but it was reachable
// by anyone who knew a businessId+phone pair with zero auth.
app.get('/api/businesses/:id/loyalty/:phone', requireAuth, requireBranchAccess, (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB not loaded' });
  db.expireStalePointsIfDue(req.params.id, req.params.phone, getLoyaltySettings(req.params.id).loyalty);
  const card = db.getLoyaltyCard(req.params.id, req.params.phone);
  if (!card) return res.status(404).json({ error: 'No loyalty card found' });
  const history = db.getLoyaltyHistory(req.params.id, req.params.phone, 5);
  res.json({
    card: { ...card, last_visit: toIsoZ(card.last_visit) },
    history: history.map(h => ({ ...h, created_at: toIsoZ(h.created_at) })),
  });
});


// POST /api/businesses/:id/loyalty/birthday-campaign  — send WhatsApp birthday msg
// Body: { phone, name } for single, or {} for all upcoming birthdays
app.post('/api/businesses/:id/loyalty/birthday-campaign', requireAuth, requireBranchAccess, requireActiveSubscription, async (req, res) => {
  const { phone: singlePhone, name: singleName } = req.body;
  const business = businesses.find(b => b.id === req.params.id) || {};
  const bizName  = business.name || 'Café Team';

  const buildMsg = (name, code) =>
    `🎂 *Happy Birthday, ${name || 'dear friend'}!*\n\n` +
    `Wishing you a beautiful day from all of us at ${bizName}! 🎉\n\n` +
    `As a token of our appreciation:\n` +
    `🎁 *FREE Dessert* on your next visit today!${code ? `\n🎟 Show code *${code}* at the counter.` : ''}\n\n` +
    `Just show this message at the counter. Valid today only!\n\n` +
    `With warmth & coffee, ${bizName} ☕`;

  // Through the café's own WhatsApp. One wish the owner picked is like a personal message;
  // "send to everyone" is a campaign, so it follows the campaign rules (Business API only).
  const sendWA = (phone, name, msg, bulk) => messageCustomer(req.params.id, phone, name, msg, bulk ? { bulk: true } : {});
  const notSentHelp = "Couldn't send on WhatsApp. Check your WhatsApp connection in Settings and try again.";

  if (singlePhone) {
    // Single recipient
    const code = db ? db.issueCoupon({ businessId: req.params.id, sourceType: 'birthday',
      customerPhone: singlePhone, discountType: 'free_item', discountValue: 0 }).code : null;
    const msg = buildMsg(singleName, code);
    const sent = await sendWA(singlePhone, singleName, msg, false);
    if (db) db.logEvent(req.params.id, 'campaign.sent', { customerPhone: singlePhone, actor: req.staff ? `staff:${req.staff.id}` : 'staff', metadata: { source: 'birthday', sent } });
    return res.json({ success: true, sent, text: msg,
      message: sent ? `Birthday wish sent to ${singleName || singlePhone} ✓` : notSentHelp });
  }

  // Bulk: all upcoming birthdays (next 7 days)
  if (!db) return res.status(503).json({ error: 'DB not loaded' });
  const upcoming = db.getUpcomingBirthdays(req.params.id, 7);
  if (!upcoming.length) return res.json({ success: true, sent: 0, message: 'No upcoming birthdays in the next 7 days' });
  if (qrBulkBlocked && qrBulkBlocked(req.params.id)) {
    return res.json({ success: false, sent: 0, total: upcoming.length,
      message: 'Sending to everyone at once needs the WhatsApp Business API. On quick connect (QR), use the Wish button next to each customer instead.' });
  }

  let sentCount = 0;
  for (const c of upcoming) {
    const code = db.issueCoupon({ businessId: req.params.id, sourceType: 'birthday',
      customerPhone: c.phone, discountType: 'free_item', discountValue: 0 }).code;
    const name = c.customer_name || c.name;
    const msg = buildMsg(name, code);
    const ok  = await sendWA(c.phone, name, msg, true);
    if (ok) sentCount++;
    db.logEvent(req.params.id, 'campaign.sent', { customerPhone: c.phone, actor: 'system', metadata: { source: 'birthday', sent: ok } });
  }
  res.json({
    success: sentCount > 0, sent: sentCount, total: upcoming.length,
    message: sentCount ? `Sent ${sentCount} of ${upcoming.length} birthday wishes via WhatsApp ✓` : notSentHelp,
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
