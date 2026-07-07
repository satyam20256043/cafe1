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

// ── Place a new order ─────────────────────────────────────────────────────────
// POST /api/businesses/:id/orders
app.post('/api/businesses/:id/orders', async (req, res) => {
  const businessId = req.params.id;
  const { customerName, customerPhone, tableNo, orderType, items, notes, paymentMethod } = req.body;

  if (!customerName || !items || !items.length) {
    return res.status(400).json({ error: 'customerName and items are required' });
  }

  try {
    // Fetch live prices from menu to prevent tampering
    const menu = getBranchData(businessId, 'menu.json');
    let subtotal = 0, discount = 0;
    const validatedItems = items.map(item => {
      const menuItem = menu.find(m => String(m.id) === String(item.id));
      const price    = menuItem ? menuItem.price : (item.price || 0);
      const disc     = menuItem ? (menuItem.discount || 0) : 0;
      const qty      = Math.max(1, parseInt(item.qty) || 1);
      const lineTotal = price * qty * (1 - disc / 100);
      subtotal  += price * qty;
      discount  += price * qty * (disc / 100);
      return { id: item.id, name: menuItem?.name || item.name, price, discount: disc, qty, lineTotal };
    });

    const tax   = parseFloat(((subtotal - discount) * 0.05).toFixed(2));  // 5% GST
    const total = parseFloat((subtotal - discount + tax).toFixed(2));

    let order;
    if (db) {
      order = db.createOrder({ businessId, customerName, customerPhone, tableNo,
        orderType: orderType || 'dine_in', items: validatedItems,
        subtotal, discount, tax, total, notes, paymentMethod: paymentMethod || 'cash' });
    } else {
      // Legacy JSON fallback
      const orders = getBranchData(businessId, 'orders.json') || [];
      order = { id: `ord_${Date.now()}`, businessId, customerName, customerPhone, tableNo,
        orderType: orderType||'dine_in', items: validatedItems, subtotal, discount, tax, total,
        notes, paymentMethod: paymentMethod||'cash', status: 'pending', payment_status: 'pending',
        created_at: new Date().toISOString() };
      orders.push(order);
      writeBranchData(businessId, 'orders.json', orders);
    }

    if (db) db.logEvent(businessId, 'order.placed',
      { customerPhone: customerPhone, actor: 'customer', metadata: { orderId: order.id, total, itemCount: validatedItems.length, orderType: orderType || 'dine_in' } });
    emitToBranch(businessId, 'new_order', { businessId, order });
    res.status(201).json(order);
  } catch (err) {
    console.error('[orders] Failed to create order:', err.message);
    res.status(500).json({ error: 'Could not place order. Please try again or ask staff for help.' });
  }
});

// ── List orders ───────────────────────────────────────────────────────────────
// GET /api/businesses/:id/orders?status=pending&limit=50
app.get('/api/businesses/:id/orders', requireAuth, requireBranchAccess, (req, res) => {
  const { status, limit, offset } = req.query;
  if (db) {
    return res.json(db.listOrders(req.params.id, {
      status, limit: parseInt(limit)||50, offset: parseInt(offset)||0
    }));
  }
  const orders = getBranchData(req.params.id, 'orders.json') || [];
  res.json(status ? orders.filter(o => o.status === status) : orders);
});

// ── Update order status ───────────────────────────────────────────────────────
// POST /api/businesses/:id/orders/:orderId/status  { status }
app.post('/api/businesses/:id/orders/:orderId/status', requireAuth, requireBranchAccess, (req, res) => {
  const { orderId } = req.params;
  const { status }  = req.body;
  const validStatuses = ['pending','confirmed','preparing','ready','served','cancelled'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  let order;
  if (db) {
    order = db.updateOrderStatus(orderId, status);
  } else {
    const orders = getBranchData(req.params.id, 'orders.json') || [];
    order = orders.find(o => o.id === orderId);
    if (order) { order.status = status; writeBranchData(req.params.id, 'orders.json', orders); }
  }
  if (!order) return res.status(404).json({ error: 'Order not found' });
  // Phase 4B: Auto-award loyalty stamp + points on order completion
  const bizId = req.params.id;
  const customerPhone = order.customer_phone || order.phone;
  const customerName  = order.customer_name  || order.name || 'Customer';
  const orderTotal    = parseFloat(order.total || 0);

  if (db) db.logEvent(bizId, 'order.status',
    { customerPhone, actor: req.staff ? `staff:${req.staff.id}` : 'staff', metadata: { orderId, status, total: orderTotal } });

  // public: the customer's table-order tracking page needs this event too
  emitToBranch(req.params.id, 'order_status_update', { businessId: req.params.id, orderId, status }, { public: true });

  // Push notification to customer browser on key status changes
  if (customerPhone && (status === 'ready' || status === 'preparing' || status === 'cancelled')) {
    const pushPayload = {
      title: status === 'ready' ? '🔔 Order Ready!' : status === 'preparing' ? '👨‍🍳 Being Prepared' : '❌ Order Cancelled',
      body: status === 'ready' ? 'Your order is ready for pickup at the counter!' : status === 'preparing' ? 'Your order is being freshly made right now!' : 'Your order was cancelled. Please contact us for help.',
      tag: 'order-' + orderId,
      url: '/cafe/' + req.params.id
    };
    // sendPushToPhone lives in loyalty.js and is shared via ctx (was a ReferenceError here)
    if (ctx.sendPushToPhone) ctx.sendPushToPhone(req.params.id, customerPhone, pushPayload).catch(()=>{});
  }

  if (db && customerPhone && (status === 'served' || status === 'delivered')) {
    try {
      const phone = customerPhone.replace(/[^0-9]/g,'').slice(-10);
      const card  = db.awardPoints(bizId, phone, customerName, orderTotal, orderId);
      emitToBranch(bizId, 'loyalty_update', { businessId: bizId, card });

      // Send WhatsApp confirmation with updated card
      if (whatsappClient && whatsappConnectionStatus === 'Connected') {
        const business = businesses.find(b=>b.id===bizId)||{name:'Café'};
        const stampsLeft = Math.max(0, 10-(card.stamps||0));
        const waMsg = `✅ *Order Served!* Thank you, ${customerName}! 🙏\n\n` +
          `Your loyalty card has been updated:\n` +
          `☕ Stamps: *${card.stamps||0}/10*${(card.stamps||0)>=10?' 🎁 FREE item ready!':'('+stampsLeft+' more for a free item!)'}\n` +
          `💰 Points: *${card.points||0} pts* (+${Math.round(orderTotal)} earned today)\n` +
          `🏅 Tier: *${card.tier||'New'}*\n\n` +
          `See you soon at ${business.name}! ☕✨`;
        const wid = phone + '@c.us';
        whatsappClient.sendMessage(wid, waMsg).catch(e=>console.error('[WA loyalty notify]',e.message));
      }
    } catch(e) { console.error('[Phase4 auto-stamp error]', e.message); }
  }

  // ── Phase 4C: WhatsApp order status notification ──────────────────────────
  if (whatsappClient && whatsappConnectionStatus === 'Connected' && customerPhone && status !== 'served' && status !== 'delivered') {
    try {
      const phone = customerPhone.replace(/[^0-9]/g,'').slice(-10);
      const business = businesses.find(b=>b.id===bizId)||{name:'Café'};
      const statusEmoji = { pending:'⏳', confirmed:'✅', preparing:'👨‍🍳', ready:'🔔', cancelled:'❌' };
      const statusMsg   = {
        pending:   'Your order has been received and is pending confirmation.',
        confirmed: "Your order is confirmed! We're getting started.",
        preparing: 'Your order is being freshly prepared right now! 👨‍🍳',
        ready:     '🔔 Your order is READY! Please collect it from the counter.',
        cancelled: 'Your order has been cancelled. Please contact us if this was a mistake.'
      };
      const waMsg = `${statusEmoji[status]||'📋'} *Order Update — ${business.name}*\n\n` +
        `${statusMsg[status]||'Status: '+status}\n\n` +
        `Order: *#${orderId.slice(-6).toUpperCase()}* | ₹${orderTotal.toFixed(0)}\n` +
        `For help: ${business.contact||'contact us'}`;
      whatsappClient.sendMessage(phone+'@c.us', waMsg).catch(e=>console.error('[WA status notify]',e.message));
    } catch(e) { console.error('[Phase4 status notify error]', e.message); }
  }
  // ─────────────────────────────────────────────────────────────────────────

  res.json(order);
});

// ── Create Razorpay order ─────────────────────────────────────────────────────
// POST /api/businesses/:id/orders/:orderId/razorpay
app.post('/api/businesses/:id/orders/:orderId/razorpay', async (req, res) => {
  if (!razorpay) {
    return res.status(503).json({ error: 'Razorpay not configured', cashOnly: true });
  }
  const order = db ? db.getOrderById(req.params.orderId) : null;
  if (!order) return res.status(404).json({ error: 'Order not found' });

  try {
    const rzpOrder = await razorpay.orders.create({
      amount:   Math.round(order.total * 100),   // paise
      currency: 'INR',
      receipt:  req.params.orderId,
      notes:    { businessId: req.params.id, customerName: order.customer_name },
    });
    if (db) db.updateOrderPayment(req.params.orderId, {
      paymentStatus: 'pending', paymentMethod: 'razorpay', razorpayOrderId: rzpOrder.id
    });
    res.json({ razorpayOrderId: rzpOrder.id, amount: rzpOrder.amount, currency: rzpOrder.currency,
      keyId: process.env.RAZORPAY_KEY_ID });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Verify Razorpay payment ───────────────────────────────────────────────────
// POST /api/businesses/:id/orders/:orderId/verify-payment
app.post('/api/businesses/:id/orders/:orderId/verify-payment', (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  if (!razorpay) return res.status(503).json({ error: 'Razorpay not configured' });

  const crypto = require('crypto');
  const expectedSig = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(razorpay_order_id + '|' + razorpay_payment_id)
    .digest('hex');

  if (expectedSig !== razorpay_signature) {
    return res.status(400).json({ error: 'Payment signature mismatch' });
  }

  if (db) {
    db.updateOrderPayment(req.params.orderId, {
      paymentStatus: 'paid', paymentMethod: 'razorpay',
      razorpayOrderId: razorpay_order_id, razorpayPaymentId: razorpay_payment_id
    });
    db.updateOrderStatus(req.params.orderId, 'confirmed');
    const paidOrder = db.getOrderById(req.params.orderId);
    db.logEvent(req.params.id, 'payment.paid', {
      customerPhone: paidOrder?.customer_phone, actor: 'customer',
      metadata: { orderId: req.params.orderId, total: paidOrder?.total, method: 'razorpay' },
    });
  }

  emitToBranch(req.params.id, 'payment_confirmed', { businessId: req.params.id, orderId: req.params.orderId }, { public: true });
  res.json({ success: true });
});

// ── Revenue stats ─────────────────────────────────────────────────────────────
// GET /api/businesses/:id/revenue
app.get('/api/businesses/:id/revenue', requireAuth, (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB not loaded' });
  const stats  = db.getRevenueStats(req.params.id);
  const daily  = db.getDailyRevenue(req.params.id, 14);
  const topItems = db.getTopItems(req.params.id, 5);
  res.json({ stats, daily, topItems });
});

// ── Razorpay config (for frontend) ───────────────────────────────────────────
// GET /api/razorpay-config
app.get('/api/razorpay-config', (req, res) => {
  res.json({
    enabled: !!razorpay,
    keyId: process.env.RAZORPAY_KEY_ID || null,
  });
});


// The unauthenticated GET /api/setup/seed-owner endpoint that used to live here
// was removed in Phase 0: it reset every owner password to a known default
// ("cafe1234") for anyone who requested the URL. Owner seeding happens safely at
// boot via auth.seedOwnerIfNeeded(); password resets go through
// PUT /api/admin/staff/:id/password (agency_admin only).

};
