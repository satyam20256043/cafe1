'use strict';
// Weekly growth & revenue report: the last full Monday–Sunday week vs the week before.
// India-local dates and the dashboard's revenue rule (cancelled / pending_approval orders don't count).

const TZ = '+330 minutes';
const NOT_COUNTED = "('cancelled','pending_approval')";
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const VIEW_METRICS = new Set(['BUSINESS_IMPRESSIONS_DESKTOP_MAPS', 'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
  'BUSINESS_IMPRESSIONS_MOBILE_MAPS', 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH']);

const shiftDay = (ymd, n) => new Date(Date.parse(ymd + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const localDate = ms => new Date(ms + 330 * 60 * 1000).toISOString().slice(0, 10);

// Last completed Monday–Sunday in India time, and the week before it.
function weekRange(now = Date.now()) {
  const today = localDate(now);
  const sinceMonday = (new Date(today + 'T00:00:00Z').getUTCDay() + 6) % 7;
  const thisMonday = shiftDay(today, -sinceMonday);
  const start = shiftDay(thisMonday, -7);
  return { start, end: shiftDay(thisMonday, -1), prevStart: shiftDay(start, -7), prevEnd: shiftDay(start, -1) };
}

function pctChange(cur, prev) {
  if (!prev) return null;
  return Math.round((cur - prev) / prev * 100);
}

function buildWeeklyReport({ db, getBranchData, computeGrowthSuggestion }, business, now = Date.now()) {
  const id = business.id;
  const w = weekRange(now);
  const raw = db.raw();
  const sum = (rows, k) => rows.reduce((s, r) => s + (r[k] || 0), 0);

  const cur = db.getDailyOrderSeries(id, w.start, w.end);
  const prev = db.getDailyOrderSeries(id, w.prevStart, w.prevEnd);
  const orders = sum(cur, 'orders'), revenue = Math.round(sum(cur, 'revenue'));
  const prevOrders = sum(prev, 'orders'), prevRevenue = Math.round(sum(prev, 'revenue'));
  const busiest = cur.length ? cur.reduce((a, b) => (b.revenue > a.revenue ? b : a)) : null;

  // Top sellers by quantity
  const itemRows = raw.prepare(`SELECT items FROM orders WHERE business_id = ? AND status NOT IN ${NOT_COUNTED}
    AND date(created_at, ?) BETWEEN ? AND ?`).all(id, TZ, w.start, w.end);
  const qty = {};
  for (const r of itemRows) {
    let items = [];
    try { items = JSON.parse(r.items || '[]'); } catch (_) {}
    for (const it of Array.isArray(items) ? items : []) {
      if (it && it.name) qty[it.name] = (qty[it.name] || 0) + (Number(it.qty) || 1);
    }
  }
  const topItems = Object.entries(qty).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([name, count]) => ({ name, count }));

  // Ordering customers this week: new (first order ever this week) vs returning
  const phones = raw.prepare(`SELECT DISTINCT customer_phone AS p FROM orders WHERE business_id = ? AND status NOT IN ${NOT_COUNTED}
    AND customer_phone IS NOT NULL AND customer_phone != '' AND date(created_at, ?) BETWEEN ? AND ?`).all(id, TZ, w.start, w.end).map(r => r.p);
  let newCustomers = 0;
  if (phones.length) {
    const firsts = raw.prepare(`SELECT customer_phone AS p, MIN(date(created_at, ?)) AS f FROM orders WHERE business_id = ? AND status NOT IN ${NOT_COUNTED}
      AND customer_phone IN (${phones.map(() => '?').join(',')}) GROUP BY customer_phone`).all(TZ, id, ...phones);
    newCustomers = firsts.filter(r => r.f >= w.start).length;
  }

  // People who messaged the café for the first time this week
  const profiles = (getBranchData && getBranchData(id, 'customer_profiles.json')) || [];
  const newContacts = (Array.isArray(profiles) ? profiles : Object.values(profiles))
    .filter(p => p && p.firstSeen && (d => d >= w.start && d <= w.end)(localDate(Date.parse(p.firstSeen)))).length;

  const bookings = raw.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(guests), 0) AS g FROM reservations WHERE business_id = ?
    AND status != 'rejected' AND date(created_at, ?) BETWEEN ? AND ?`).get(id, TZ, w.start, w.end);

  // Google, only when the café is connected
  let google = null;
  const conn = db.getGoogleConnection ? db.getGoogleConnection(id) : null;
  if (conn && conn.status === 'connected') {
    const metricRows = db.getGoogleMetricsBetween(id, w.prevStart, w.end).filter(r => VIEW_METRICS.has(r.metric));
    const views = metricRows.filter(r => r.date >= w.start).reduce((s, r) => s + r.value, 0);
    const prevViews = metricRows.filter(r => r.date < w.start).reduce((s, r) => s + r.value, 0);
    const reviews = raw.prepare(`SELECT COUNT(*) AS n, AVG(star_rating) AS avg FROM google_reviews WHERE business_id = ?
      AND substr(create_time, 1, 10) BETWEEN ? AND ?`).get(id, w.start, w.end);
    const summary = db.countGoogleReviewSummary(id);
    google = {
      views, viewsChange: metricRows.some(r => r.date < w.start) ? pctChange(views, prevViews) : null,
      newReviews: reviews.n, avgNewRating: reviews.avg ? Math.round(reviews.avg * 10) / 10 : null,
      needReply: summary.needsReply,
    };
  }

  let suggestion = null;
  try { suggestion = computeGrowthSuggestion ? computeGrowthSuggestion(id) : null; } catch (_) {}

  return {
    businessId: id, name: business.name, start: w.start, end: w.end,
    orders, revenue, ordersChange: pctChange(orders, prevOrders), revenueChange: pctChange(revenue, prevRevenue),
    avgOrderValue: orders ? Math.round(revenue / orders) : 0,
    busiestDay: busiest && busiest.revenue > 0 ? { day: WEEKDAYS[new Date(busiest.date + 'T00:00:00Z').getUTCDay()], revenue: Math.round(busiest.revenue) } : null,
    topItems, customers: phones.length, newCustomers, returningCustomers: phones.length - newCustomers,
    newContacts, bookings: bookings.n, guests: bookings.g,
    google, suggestion: suggestion ? suggestion.title : null,
    hasActivity: orders > 0 || newContacts > 0 || bookings.n > 0 || !!(google && (google.views || google.newReviews)),
  };
}

const inr = n => '₹' + Number(n || 0).toLocaleString('en-IN');
const arrow = p => (p == null ? '' : p === 0 ? ' (same as last week)' : ` (${p > 0 ? '▲' : '▼'} ${Math.abs(p)}% vs last week)`);
function dayLabel(ymd) {
  const d = new Date(ymd + 'T00:00:00Z');
  return `${d.getUTCDate()} ${d.toLocaleString('en-IN', { month: 'short', timeZone: 'UTC' })}`;
}

// WhatsApp text. Lines with nothing to say are left out.
function formatWeeklyReport(r, dashboardUrl) {
  const L = [`📊 *Weekly report — ${r.name}*`, `${dayLabel(r.start)} – ${dayLabel(r.end)}`, ''];
  L.push(`💰 Revenue: *${inr(r.revenue)}*${arrow(r.revenueChange)}`);
  L.push(`🧾 Orders: *${r.orders}*${r.orders ? ` · avg ${inr(r.avgOrderValue)}` : ''}${arrow(r.ordersChange)}`);
  if (r.customers) L.push(`👥 Customers who ordered: ${r.customers} (${r.newCustomers} new, ${r.returningCustomers} returning)`);
  if (r.busiestDay) L.push(`📅 Busiest day: ${r.busiestDay.day} (${inr(r.busiestDay.revenue)})`);
  if (r.topItems.length) L.push(`🍽 Top sellers: ${r.topItems.map(t => `${t.name} ×${t.count}`).join(', ')}`);
  if (r.newContacts) L.push(`💬 New people messaged you on WhatsApp: ${r.newContacts}`);
  if (r.bookings) L.push(`🪑 Table bookings: ${r.bookings} (${r.guests} guests)`);
  if (r.google) {
    const g = r.google, bits = [];
    if (g.views) bits.push(`${g.views.toLocaleString('en-IN')} views${g.viewsChange == null ? '' : ` (${g.viewsChange >= 0 ? '▲' : '▼'} ${Math.abs(g.viewsChange)}%)`}`);
    if (g.newReviews) bits.push(`${g.newReviews} new review${g.newReviews === 1 ? '' : 's'}${g.avgNewRating ? `, avg ${g.avgNewRating}★` : ''}`);
    if (g.needReply) bits.push(`${g.needReply} need${g.needReply === 1 ? 's' : ''} a reply`);
    if (bits.length) L.push('', `🔎 On Google: ${bits.join(' · ')}`, '(Google numbers can be a few days behind.)');
  }
  if (r.suggestion) L.push('', `💡 This week's idea: ${r.suggestion}. Open your dashboard to approve it.`);
  if (dashboardUrl) L.push('', `👉 ${dashboardUrl}`);
  return L.join('\n');
}

function weeklyReportEligible(sub) {
  return !!(sub && sub.ok && (sub.plan === 'pro' || sub.status === 'trial'));
}

module.exports = { weekRange, buildWeeklyReport, formatWeeklyReport, weeklyReportEligible };
