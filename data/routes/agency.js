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

// ── Agency Website — Contact / Lead Capture ──────────────────────────────────
const LEADS_FILE = path.join(DATA_DIR, 'agency_leads.json');

app.post('/api/contact', (req, res) => {
  const { name, cafe, phone, city, branches, challenge, submittedAt } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'Name and phone are required.' });

  let leads = [];
  if (fs.existsSync(LEADS_FILE)) {
    try { leads = JSON.parse(fs.readFileSync(LEADS_FILE, 'utf-8')); } catch(e) {}
  }

  const lead = {
    id: `lead_${Date.now()}`,
    name,
    cafe: cafe || '',
    phone,
    city: city || '',
    branches: branches || '',
    challenge: challenge || '',
    submittedAt: submittedAt || new Date().toISOString(),
    status: 'new'
  };

  leads.unshift(lead);
  fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2));
  console.log(`[Lead Capture] New lead: ${name} (${phone}) — ${cafe || 'unspecified cafe'}`);
  res.json({ success: true, id: lead.id });
});

// Sales leads contain prospect names + phone numbers — agency eyes only (SEC-4)
app.get('/api/leads', requireAuth, requireRole('agency_admin', 'admin'), (req, res) => {
  if (!fs.existsSync(LEADS_FILE)) return res.json([]);
  try {
    const leads = JSON.parse(fs.readFileSync(LEADS_FILE, 'utf-8'));
    res.json(leads);
  } catch(e) { res.status(500).json({ error: 'Could not read leads.' }); }
});

// Alias for HQ data sheet
app.get('/api/agency/leads', requireAuth, requireRole('agency_admin', 'admin'), (req, res) => {
  if (!fs.existsSync(LEADS_FILE)) return res.json([]);
  try {
    const leads = JSON.parse(fs.readFileSync(LEADS_FILE, 'utf-8'));
    res.json(leads);
  } catch(e) { res.status(500).json({ error: 'Could not read leads.' }); }
});

// Update lead status
app.patch('/api/agency/leads/:id', requireAuth, requireRole('agency_admin', 'admin'), (req, res) => {
  if (!fs.existsSync(LEADS_FILE)) return res.status(404).json({ error: 'No leads file' });
  try {
    const leads = JSON.parse(fs.readFileSync(LEADS_FILE, 'utf-8'));
    const idx = leads.findIndex(l => l.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Lead not found' });
    leads[idx] = { ...leads[idx], ...req.body, id: leads[idx].id };
    fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2));
    res.json(leads[idx]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Socket.io and server.listen are managed in server.js


};
