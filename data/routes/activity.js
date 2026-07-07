'use strict';
// Phase 4 — Activity Logs & Weekly Report
module.exports = function register(ctx) {
  const { app, fs, path, DATA_DIR, businesses, requireAuth, requireRole, db } = ctx;

  const LOG_FILE = path.join(DATA_DIR, 'activity_log.json');

  function loadLog() {
    try { return JSON.parse(fs.readFileSync(LOG_FILE, 'utf-8')); }
    catch (e) { return []; }
  }

  function appendLog(entry) {
    const log = loadLog();
    log.unshift({ ...entry, timestamp: new Date().toISOString() });
    if (log.length > 1000) log.splice(1000);
    try { fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2)); } catch (e) {}
  }

  // Expose logger so other route modules (e.g. auth.js) can record events
  ctx.logActivity = appendLog;

  // GET /api/admin/activity-log?page=0&size=50 — paginated activity log
  app.get('/api/admin/activity-log', requireAuth, requireRole('agency_admin'), (req, res) => {
    const log = loadLog();
    const page = parseInt(req.query.page) || 0;
    const size = Math.min(parseInt(req.query.size) || 50, 200);
    res.json({ total: log.length, entries: log.slice(page * size, page * size + size) });
  });

  // GET /api/admin/weekly-report — orders, revenue & top items per branch over the last 7 days
  app.get('/api/admin/weekly-report', requireAuth, requireRole('agency_admin'), (req, res) => {
    const now = new Date();
    const weekAgo = new Date(now - 7 * 86400000);
    const log = loadLog();
    const weekLog = log.filter(e => new Date(e.timestamp) >= weekAgo);
    const loginCount = weekLog.filter(e => e.event === 'login').length;

    const branches = businesses.map(b => {
      const stats   = db ? db.getRevenueStats(b.id) : {};
      const daily   = db ? db.getDailyRevenue(b.id, 7) : [];
      const topItems = db ? db.getTopItems(b.id, 5) : [];
      const weekRevenue = daily.reduce((sum, d) => sum + (d.revenue || 0), 0);
      const weekOrders  = daily.reduce((sum, d) => sum + (d.orders || 0), 0);
      return {
        id: b.id,
        name: b.name,
        plan: b.plan || 'trial',
        status: b.subscriptionStatus || 'trial',
        weekRevenue,
        weekOrders,
        topItems,
        daily,
      };
    });

    res.json({
      generatedAt: now.toISOString(),
      period: { from: weekAgo.toISOString(), to: now.toISOString() },
      activity: { totalEvents: weekLog.length, logins: loginCount },
      branches,
    });
  });
};
