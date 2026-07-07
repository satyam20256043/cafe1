'use strict';
// Phase 3 — Post-order 1-tap Feedback (star rating stored per order)
module.exports = function register(ctx) {
  const { app, db, requireAuth, requireBranchAccess } = ctx;

  // POST /api/businesses/:id/orders/:orderId/feedback  { rating, comment, customerName, phone }
  app.post('/api/businesses/:id/orders/:orderId/feedback', (req, res) => {
    if (!db) return res.status(503).json({ error: 'DB not loaded' });
    const { rating, comment, customerName, phone } = req.body;
    const r = Math.max(1, Math.min(5, parseInt(rating) || 5));
    const order = db.getOrderById(req.params.orderId);
    const id = `fb_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
    db.raw().prepare(`
      INSERT INTO feedback (id,business_id,customer_name,phone,rating,comment,source,order_id)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(
      id, req.params.id,
      customerName || (order && order.customer_name) || 'Customer',
      phone || (order && order.customer_phone) || '',
      r, comment || '', 'manager', req.params.orderId
    );
    res.status(201).json({ success: true, id, rating: r });
  });

  // GET /api/businesses/:id/orders/:orderId/feedback — fetch feedback for one order
  app.get('/api/businesses/:id/orders/:orderId/feedback', requireAuth, requireBranchAccess, (req, res) => {
    if (!db) return res.json(null);
    const row = db.raw().prepare(
      'SELECT * FROM feedback WHERE business_id=? AND order_id=? ORDER BY created_at DESC LIMIT 1'
    ).get(req.params.id, req.params.orderId);
    res.json(row || null);
  });

  // GET /api/businesses/:id/feedback — list recent feedback for a branch
  app.get('/api/businesses/:id/feedback', requireAuth, requireBranchAccess, (req, res) => {
    if (!db) return res.json([]);
    const rows = db.raw().prepare(
      'SELECT * FROM feedback WHERE business_id=? ORDER BY created_at DESC LIMIT 50'
    ).all(req.params.id);
    res.json(rows);
  });
};
