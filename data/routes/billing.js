'use strict';
// Billing & Subscription routes — Razorpay integration
module.exports = function register(ctx) {
  const {
    app, fs, path,
    DATA_DIR, BUSINESSES_FILE, businesses,
    razorpay,
    requireAuth, requireRole,
    getSubscriptionStatus,
  } = ctx;

  const PLANS_FILE = path.join(DATA_DIR, 'plans.json');

  function loadPlans() {
    try { return JSON.parse(fs.readFileSync(PLANS_FILE, 'utf-8')).plans; }
    catch(e) { return []; }
  }

  function saveBusinesses() {
    fs.writeFileSync(BUSINESSES_FILE, JSON.stringify(businesses, null, 2));
  }

  // ── GET /api/plans ────────────────────────────────────────────────────────────
  app.get('/api/plans', (req, res) => {
    res.json({ plans: loadPlans() });
  });

  // ── GET /api/businesses/:id/billing/status ────────────────────────────────────
  app.get('/api/businesses/:id/billing/status', requireAuth, (req, res) => {
    const biz = businesses.find(b => b.id === req.params.id);
    if (!biz) return res.status(404).json({ error: 'Business not found' });
    const sub = getSubscriptionStatus(biz);
    res.json({
      ...sub,
      business: {
        id: biz.id, name: biz.name, plan: biz.plan,
        subscriptionEnd: biz.subscriptionEnd,
        lastPayment: biz.lastPayment || null
      }
    });
  });

  // ── POST /api/businesses/:id/billing/create-order ─────────────────────────────
  // Owner initiates a subscription payment
  app.post('/api/businesses/:id/billing/create-order', requireAuth, async (req, res) => {
    if (!razorpay) {
      return res.status(503).json({
        error: 'Razorpay not configured. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to .env and restart.'
      });
    }
    const { planId } = req.body;
    const plans = loadPlans();
    const plan = plans.find(p => p.id === planId);
    if (!plan) return res.status(400).json({ error: 'Invalid plan ID' });

    const biz = businesses.find(b => b.id === req.params.id);
    if (!biz) return res.status(404).json({ error: 'Business not found' });

    try {
      const order = await razorpay.orders.create({
        amount: plan.price * 100, // paise
        currency: 'INR',
        receipt: `sub_${biz.id}_${Date.now()}`,
        notes: {
          businessId: biz.id,
          businessName: biz.name,
          planId: plan.id,
          planName: plan.name
        }
      });
      res.json({
        orderId: order.id,
        amount: order.amount,
        currency: order.currency,
        keyId: process.env.RAZORPAY_KEY_ID,
        plan,
        business: { name: biz.name }
      });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/businesses/:id/billing/verify-payment ──────────────────────────
  // Verify Razorpay payment signature and activate subscription
  app.post('/api/businesses/:id/billing/verify-payment', requireAuth, (req, res) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, planId } = req.body;
    if (!razorpay) return res.status(503).json({ error: 'Razorpay not configured' });

    const crypto = require('crypto');
    const expectedSig = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + '|' + razorpay_payment_id)
      .digest('hex');

    if (expectedSig !== razorpay_signature) {
      return res.status(400).json({ error: 'Payment verification failed — signature mismatch' });
    }

    const plans = loadPlans();
    const plan = plans.find(p => p.id === planId);
    if (!plan) return res.status(400).json({ error: 'Invalid plan' });

    const biz = businesses.find(b => b.id === req.params.id);
    if (!biz) return res.status(404).json({ error: 'Business not found' });

    // Activate subscription
    const now = new Date();
    const end = new Date(now);
    end.setDate(end.getDate() + plan.duration_days);

    biz.plan = plan.id;
    biz.subscriptionStatus = plan.id === 'trial' ? 'trial' : 'active';
    biz.subscriptionEnd = end.toISOString();
    biz.lastPayment = {
      amount: plan.price,
      planId: plan.id,
      planName: plan.name,
      razorpayOrderId: razorpay_order_id,
      razorpayPaymentId: razorpay_payment_id,
      paidAt: now.toISOString()
    };
    saveBusinesses();

    res.json({
      success: true,
      plan: plan.name,
      subscriptionEnd: biz.subscriptionEnd,
      status: biz.subscriptionStatus
    });
  });

  // ── POST /api/admin/billing/generate-link ─────────────────────────────────────
  // Admin generates a Razorpay payment link to send to a café owner
  app.post('/api/admin/billing/generate-link', requireAuth, requireRole('agency_admin'), async (req, res) => {
    if (!razorpay) return res.status(503).json({ error: 'Razorpay not configured' });
    const { businessId, planId, customAmount } = req.body;

    const plans = loadPlans();
    const plan = planId ? plans.find(p => p.id === planId) : null;
    if (!plan && !customAmount) {
      return res.status(400).json({ error: 'Provide planId or customAmount' });
    }

    const biz = businesses.find(b => b.id === businessId);
    if (!biz) return res.status(404).json({ error: 'Business not found' });

    const amountPaise = customAmount
      ? parseInt(customAmount) * 100
      : plan.price * 100;
    const description = plan
      ? `${plan.name} Plan (${plan.duration_days} days) — ${biz.name}`
      : `Custom Payment — ${biz.name}`;

    try {
      const link = await razorpay.paymentLink.create({
        amount: amountPaise,
        currency: 'INR',
        description,
        customer: {
          name:    biz.ownerName  || biz.name,
          email:   biz.ownerEmail || '',
          contact: (biz.contact || '').replace(/\D/g, '').slice(-10)
        },
        notify:          { sms: false, email: !!biz.ownerEmail },
        reminder_enable: true,
        notes: {
          businessId: biz.id,
          planId:     plan ? plan.id : 'custom'
        }
      });
      res.json({
        success:     true,
        paymentLink: link.short_url,
        linkId:      link.id,
        amount:      amountPaise / 100,
        description
      });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/admin/billing/history ────────────────────────────────────────────
  app.get('/api/admin/billing/history', requireAuth, requireRole('agency_admin'), (req, res) => {
    const history = businesses
      .filter(b => b.lastPayment)
      .map(b => ({
        businessId:      b.id,
        businessName:    b.name,
        plan:            b.plan,
        subscriptionEnd: b.subscriptionEnd,
        status:          b.subscriptionStatus,
        ...b.lastPayment
      }))
      .sort((a, b) => new Date(b.paidAt) - new Date(a.paidAt));
    res.json({ history, total: history.length });
  });

  // ── POST /api/billing/webhook ─────────────────────────────────────────────────
  // Configure this URL in your Razorpay Dashboard → Webhooks
  app.post('/api/billing/webhook', (req, res) => {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (webhookSecret) {
      const crypto = require('crypto');
      const sig  = req.headers['x-razorpay-signature'];
      const body = JSON.stringify(req.body);
      const expected = crypto.createHmac('sha256', webhookSecret).update(body).digest('hex');
      if (sig !== expected) return res.status(400).json({ error: 'Invalid webhook signature' });
    }

    const event = req.body;
    if (event && event.event === 'payment.captured') {
      const entity = event.payload && event.payload.payment && event.payload.payment.entity;
      const notes  = entity && entity.notes;
      if (notes && notes.businessId) {
        const biz = businesses.find(b => b.id === notes.businessId);
        if (biz && notes.planId) {
          const plans = loadPlans();
          const plan  = plans.find(p => p.id === notes.planId);
          if (plan) {
            const end = new Date();
            end.setDate(end.getDate() + plan.duration_days);
            biz.plan               = plan.id;
            biz.subscriptionStatus = plan.id === 'trial' ? 'trial' : 'active';
            biz.subscriptionEnd    = end.toISOString();
            biz.lastPayment        = {
              amount:            entity.amount / 100,
              planId:            plan.id,
              planName:          plan.name,
              razorpayPaymentId: entity.id,
              paidAt:            new Date().toISOString()
            };
            saveBusinesses();
            console.log(`[Billing Webhook] Activated ${plan.name} for ${biz.name}`);
          }
        }
      }
    }
    res.json({ received: true });
  });

};