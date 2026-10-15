'use strict';
// Weekly growth & revenue report: dashboard preview, "send now", and the Monday WhatsApp send.

const fs = require('fs');
const path = require('path');
const { rateLimit } = require('../rateLimit');
const { weekRange, buildWeeklyReport, formatWeeklyReport, weeklyReportEligible } = require('../weekly-report');

const MANAGE_ROLES = ['owner', 'manager', 'admin', 'agency_admin'];
const RETRY_GAP_MS = 6 * 60 * 60 * 1000;

module.exports = function reportRoutes(ctx) {
  const { app, db, requireAuth, requireBranchAccess, requireRole, DATA_DIR, logEvent } = ctx;
  const STATE_FILE = path.join(DATA_DIR, 'weekly_reports_sent.json');

  const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) { return {}; } };
  const saveState = s => { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch (e) { console.error('[weekly-report] state save failed:', e.message); } };
  const dashboardUrl = id => `${process.env.BASE_URL || 'http://localhost:3010'}/manager/${id}`;
  const deps = () => ({ db, getBranchData: ctx.getBranchData, computeGrowthSuggestion: ctx.computeGrowthSuggestion });

  async function sendReport(business, report) {
    const ok = await ctx.sendWhatsAppToCustomer(business.id, business.ownerPhone, formatWeeklyReport(report, dashboardUrl(business.id)));
    if (ok && logEvent) logEvent(business.id, 'report.weekly_sent', { metadata: { week: report.start, revenue: report.revenue, orders: report.orders } });
    return ok;
  }

  // Hourly sweep. Sends each eligible café's report once per week, from Monday 09:30 India time
  // until Wednesday, so a restart on Monday morning neither skips nor duplicates it.
  async function runWeeklyReports(now = Date.now()) {
    if (!db) return;
    const local = new Date(now + 330 * 60 * 1000);
    const dow = local.getUTCDay(), minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
    if (dow < 1 || dow > 3 || (dow === 1 && minutes < 9 * 60 + 30)) return;
    const week = weekRange(now).start;
    const state = loadState();
    for (const b of ctx.businesses || []) {
      try {
        if (!b.ownerPhone || !weeklyReportEligible(ctx.getSubscriptionStatus(b))) continue;
        const st = state[b.id] || {};
        if (st.week === week && (st.sentAt || st.skipped)) continue;
        if (st.week === week && st.lastAttemptAt && now - Date.parse(st.lastAttemptAt) < RETRY_GAP_MS) continue;
        const report = buildWeeklyReport(deps(), b, now);
        if (!report.hasActivity) { state[b.id] = { week, skipped: 'no_activity' }; saveState(state); continue; }
        const ok = await sendReport(b, report);
        state[b.id] = ok ? { week, sentAt: new Date(now).toISOString() } : { week, lastAttemptAt: new Date(now).toISOString() };
        saveState(state);
        console.log(`[weekly-report] ${b.id}: ${ok ? 'sent' : 'send failed (WhatsApp not connected?)'}`);
        await new Promise(r => setTimeout(r, 2000));
      } catch (e) {
        console.error(`[weekly-report] ${b.id}:`, e.message);
      }
    }
  }

  const findBiz = id => (ctx.businesses || []).find(b => b.id === id);

  app.get('/api/businesses/:id/weekly-report', requireAuth, requireBranchAccess, requireRole(...MANAGE_ROLES), (req, res) => {
    const b = findBiz(req.params.id);
    if (!b || !db) return res.status(404).json({ error: 'Business not found' });
    const sub = ctx.getSubscriptionStatus(b);
    const report = buildWeeklyReport(deps(), b);
    const st = loadState()[b.id] || {};
    res.json({
      eligible: weeklyReportEligible(sub), plan: sub.plan || null, status: sub.status || null,
      hasOwnerPhone: !!b.ownerPhone, sentThisWeek: st.week === report.start && !!st.sentAt,
      report, text: formatWeeklyReport(report, dashboardUrl(b.id)),
    });
  });

  const sendLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 3, keyFn: req => `weekly_report:${req.params.id}`,
    message: 'You can send the report 3 times an hour. Please try again later.' });

  app.post('/api/businesses/:id/weekly-report/send', requireAuth, requireBranchAccess, requireRole(...MANAGE_ROLES), sendLimit, async (req, res) => {
    const b = findBiz(req.params.id);
    if (!b || !db) return res.status(404).json({ error: 'Business not found' });
    if (!weeklyReportEligible(ctx.getSubscriptionStatus(b))) {
      return res.status(403).json({ error: 'The weekly WhatsApp report is part of the Pro plan.', code: 'NOT_ON_PLAN' });
    }
    if (!b.ownerPhone) return res.status(409).json({ error: 'Add the owner phone number in Settings first.', code: 'NO_OWNER_PHONE' });
    const report = buildWeeklyReport(deps(), b);
    const ok = await sendReport(b, report);
    if (!ok) return res.status(409).json({ error: "Couldn't send — connect your café's WhatsApp in Settings first.", code: 'WHATSAPP_NOT_CONNECTED' });
    const state = loadState();
    state[b.id] = { week: report.start, sentAt: new Date().toISOString() };
    saveState(state);
    res.json({ ok: true });
  });

  ctx.runWeeklyReports = runWeeklyReports;
};
