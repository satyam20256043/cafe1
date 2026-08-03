'use strict';
// Sales pipeline — tracks prospective cafés the operator is pitching, before they
// sign up. Global (no business_id), admin-only, forever. Never reachable by a
// café owner/manager — same requireRole('agency_admin', 'admin') guard as /api/settings.
module.exports = function register(ctx) {
  const { app, db, requireAuth, requireRole, fs, businesses, BUSINESSES_FILE, signToken, toIsoZ } = ctx;

  const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
  const AGENCY_BUSINESS_ID = '_agency'; // convention confirmed against the one existing agency_admin row

  // ── Sales reps (agency-level staff, role='sales') ──────────────────────────
  // POST /api/admin/sales-reps — operator creates a rep login
  app.post('/api/admin/sales-reps', requireAuth, requireRole('agency_admin', 'admin'), (req, res) => {
    if (!db) return res.status(503).json({ error: 'Not available in this server mode' });
    const { name, username, password, phone } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
    if (!username || !String(username).trim()) return res.status(400).json({ error: 'username is required' });
    if (!password || String(password).length < 4) return res.status(400).json({ error: 'password must be at least 4 characters' });

    // createStaff's duplicate-username fallback path uses INSERT OR IGNORE and
    // silently returns the EXISTING row instead of erroring — without this
    // check, "creating" a rep with a taken username would silently hand back
    // someone else's staff record instead of failing.
    const clash = db.listAgencyStaff().some(s => s.username === username.trim());
    if (clash) return res.status(409).json({ error: 'Username already taken' });

    const bcryptjs = require('bcryptjs');
    const passwordHash = bcryptjs.hashSync(String(password), 10);
    const rep = db.createStaff({
      businessId: AGENCY_BUSINESS_ID, name: name.trim(), username: username.trim(),
      passwordHash, role: 'sales', phone: phone || null,
    });
    if (!rep) return res.status(500).json({ error: 'Could not create sales rep' });
    const { password_hash, ...safe } = rep;
    res.status(201).json(safe);
  });

  // GET /api/admin/sales-reps — list reps for dropdowns / admin views
  app.get('/api/admin/sales-reps', requireAuth, requireRole('agency_admin', 'admin'), (req, res) => {
    if (!db) return res.status(503).json({ error: 'Not available in this server mode' });
    const reps = db.listAgencyStaff().filter(s => s.role === 'sales');
    res.json(reps.map(({ password_hash, ...s }) => s));
  });

  // GET /api/admin/sales-performance — per-rep leaderboard for the operator.
  // cafesSigned/conversionRate need the in-memory businesses array (salesRepId
  // lives in businesses.json, not SQLite), so they're resolved here rather
  // than in db.js's getSalesPerformance().
  app.get('/api/admin/sales-performance', requireAuth, requireRole('agency_admin', 'admin'), (req, res) => {
    if (!db) return res.status(503).json({ error: 'Not available in this server mode' });
    const perf = db.getSalesPerformance();
    const rows = perf.map(rep => {
      const cafesSigned = businesses.filter(b => b.salesRepId === rep.repId).length;
      const conversionRate = rep.leadsTotal > 0 ? Math.round((cafesSigned / rep.leadsTotal) * 1000) / 1000 : null;
      return { ...rep, cafesSigned, conversionRate };
    });
    res.json(rows);
  });

  // POST /api/admin/sales-reps/:id/impersonate — admin views the app as a rep.
  // Narrow and one-directional (S8): refuses anything but an exact role match
  // on 'sales', so this can never be used to mint a token for another admin.
  app.post('/api/admin/sales-reps/:id/impersonate', requireAuth, requireRole('agency_admin', 'admin'), (req, res) => {
    if (!db) return res.status(503).json({ error: 'Not available in this server mode' });
    const target = db.getStaffById(req.params.id);
    if (!target) return res.status(404).json({ error: 'Staff not found' });
    if (target.role !== 'sales') {
      return res.status(403).json({ error: 'Can only log in as a sales rep' });
    }
    const token = signToken({
      id: target.id, businessId: target.business_id, name: target.name,
      role: 'sales', impersonatedBy: req.staff.id,
    });
    // An impersonation that isn't recorded anywhere is not acceptable (S8).
    // events.business_id is NOT NULL, and this action has no business id, so
    // it goes to the agency activity log instead of db.logEvent.
    if (ctx.logActivity) {
      ctx.logActivity({
        event: 'admin.impersonate', actor: req.staff.id, actorName: req.staff.name,
        targetRepId: target.id, targetName: target.name,
      });
    }
    res.json({ token, rep: { id: target.id, name: target.name, username: target.username } });
  });

  // GET /api/sales/me/earnings — a rep's own commission summary + line items (SD4)
  // Rep id comes from req.staff.id ONLY (S1) — never from a query param/body.
  app.get('/api/sales/me/earnings', requireAuth, requireRole('sales'), (req, res) => {
    if (!db) return res.status(503).json({ error: 'Not available in this server mode' });
    const repId = req.staff.id;
    const summary = db.getRepCommissionSummary(repId);
    const payments = db.listPaymentsForRep(repId).map(p => {
      const biz = businesses.find(b => b.id === p.business_id);
      return {
        businessId: p.business_id,
        businessName: biz ? (biz.name || biz.id) : p.business_id,
        amount: p.amount,
        plan: p.plan,
        paidAt: toIsoZ(p.paid_at),
        commissionRate: p.commission_rate,
        commissionAmount: p.commission_amount,
        isFirstPayment: !!p.is_first_payment,
      };
    });
    res.json({ summary, payments });
  });

  // GET /api/sales/me/cafes — a rep's own signed cafés, setup + trial status
  // only (SD5). S2/S3: never requireBranchAccess, never customer/revenue data.
  app.get('/api/sales/me/cafes', requireAuth, requireRole('sales'), (req, res) => {
    if (!db) return res.status(503).json({ error: 'Not available in this server mode' });
    const repId = req.staff.id;
    const payingBizIds = new Set(db.listPaymentsForRep(repId).map(p => p.business_id));
    const mine = businesses.filter(b => b.salesRepId === repId).map(b => {
      // ctx.getSetupStatus is set by routes/extras.js — read lazily at request
      // time (same pattern as ctx.logActivity), not destructured at module
      // load, since require() order between route files isn't guaranteed.
      const setup = ctx.getSetupStatus ? ctx.getSetupStatus(b.id) : {};
      return {
        id: b.id,
        name: b.name,
        location: b.location || null,
        subscriptionStatus: b.subscriptionStatus || 'trial',
        plan: b.subscriptionPlan || b.plan || null,
        trialEndsAt: b.trialEndsAt || null,
        trialDaysLeft: b.trialEndsAt ? Math.max(0, Math.ceil((new Date(b.trialEndsAt) - Date.now()) / 86400000)) : null,
        menuDone: !!setup.menuDone,
        qrDone: !!setup.qrDone,
        whatsappConnected: !!setup.whatsappConnected,
        hasFirstOrder: !!setup.hasFirstOrder,
        hasPayments: payingBizIds.has(b.id),
      };
    });
    res.json(mine);
  });

  // GET /api/crm-leads — list every prospect
  // NOTE: intentionally NOT /api/leads — routes/agency.js already owns that whole
  // namespace for the unrelated website-contact-form lead capture feature, and
  // since it's require()d earlier in server.js its routes would silently shadow
  // these (Express matches the first-registered handler for a given path+method).
  app.get('/api/crm-leads', requireAuth, requireRole('agency_admin', 'admin', 'sales'), (req, res) => {
    if (!db) return res.status(503).json({ error: 'Not available in this server mode' });
    // Server-side scoping (S3/S1): a rep only ever sees leads assigned to
    // them. Admin/agency_admin see everything, unfiltered.
    const isRep = req.staff.role === 'sales';
    res.json(db.listLeads(isRep ? { assignedTo: req.staff.id } : {}));
  });

  // POST /api/crm-leads — create a new prospect
  app.post('/api/crm-leads', requireAuth, requireRole('agency_admin', 'admin', 'sales'), (req, res) => {
    if (!db) return res.status(503).json({ error: 'Not available in this server mode' });
    const { cafe_name, phone, owner_name, location, status, follow_up_date, notes, assigned_to } = req.body;
    if (!cafe_name || !String(cafe_name).trim()) {
      return res.status(400).json({ error: 'cafe_name is required' });
    }
    const isRep = req.staff.role === 'sales';
    // A rep may not assign a lead to anyone but themselves; admins may
    // optionally hand a lead straight to a rep at creation time.
    const assignedTo = isRep ? req.staff.id : (assigned_to || null);
    const lead = db.createLead({ cafeName: cafe_name.trim(), phone, ownerName: owner_name, location, status, followUpDate: follow_up_date, notes, assignedTo });
    res.json(lead);
  });

  // PUT /api/crm-leads/:id — partial update (inline cell auto-save)
  app.put('/api/crm-leads/:id', requireAuth, requireRole('agency_admin', 'admin', 'sales'), (req, res) => {
    if (!db) return res.status(503).json({ error: 'Not available in this server mode' });
    const isRep = req.staff.role === 'sales';
    if (isRep) {
      // 404, not 403 (S3) — a rep must not learn a lead id exists if it isn't
      // theirs.
      const existing = db.raw().prepare('SELECT assigned_to FROM crm_leads WHERE id = ?').get(req.params.id);
      if (!existing || existing.assigned_to !== req.staff.id) {
        return res.status(404).json({ error: 'Lead not found' });
      }
    }
    const { cafe_name, phone, owner_name, location, status, follow_up_date, notes, assigned_to } = req.body;
    const fields = {};
    if (cafe_name !== undefined) fields.cafeName = cafe_name;
    if (phone !== undefined) fields.phone = phone;
    if (owner_name !== undefined) fields.ownerName = owner_name;
    if (location !== undefined) fields.location = location;
    if (status !== undefined) fields.status = status;
    if (follow_up_date !== undefined) fields.followUpDate = follow_up_date;
    if (notes !== undefined) fields.notes = notes;
    // A rep may not reassign a lead away from themselves; admins may.
    if (assigned_to !== undefined && !isRep) fields.assignedTo = assigned_to;
    const updated = db.updateLead(req.params.id, fields);
    if (!updated) return res.status(404).json({ error: 'Lead not found' });
    res.json(updated);
  });

  // DELETE /api/crm-leads/:id
  app.delete('/api/crm-leads/:id', requireAuth, requireRole('agency_admin', 'admin', 'sales'), (req, res) => {
    if (!db) return res.status(503).json({ error: 'Not available in this server mode' });
    const isRep = req.staff.role === 'sales';
    if (isRep) {
      const existing = db.raw().prepare('SELECT assigned_to FROM crm_leads WHERE id = ?').get(req.params.id);
      if (!existing || existing.assigned_to !== req.staff.id) {
        return res.status(404).json({ error: 'Lead not found' });
      }
    }
    const result = db.deleteLead(req.params.id);
    res.json(result);
  });

  // POST /api/crm-leads/:id/link-business — permanent rep-attribution link,
  // called once a lead's café actually signs up. Without this, a payment
  // recorded later (SF3/SF4) has no way to find the rep who earned it.
  app.post('/api/crm-leads/:id/link-business', requireAuth, requireRole('agency_admin', 'admin', 'sales'), (req, res) => {
    if (!db) return res.status(503).json({ error: 'Not available in this server mode' });
    const { businessId } = req.body;
    if (!businessId || !String(businessId).trim()) {
      return res.status(400).json({ error: 'businessId is required' });
    }
    const isRep = req.staff.role === 'sales';
    const lead = db.raw().prepare('SELECT * FROM crm_leads WHERE id = ?').get(req.params.id);
    // Same 404-not-403 rule as SF1: a rep must not learn a lead id exists if
    // it isn't theirs.
    if (!lead || (isRep && lead.assigned_to !== req.staff.id)) {
      return res.status(404).json({ error: 'Lead not found' });
    }
    const idx = businesses.findIndex(b => b.id === businessId);
    if (idx === -1) return res.status(404).json({ error: 'Business not found' });
    // Reassignment is an admin-only concern, out of scope here — refuse to
    // silently move a café from one rep's book to another's.
    if (businesses[idx].salesRepId) {
      return res.status(409).json({ error: 'Business already linked to a sales rep' });
    }
    businesses[idx].salesRepId = lead.assigned_to || null;
    businesses[idx].salesLeadId = lead.id;
    fs.writeFileSync(BUSINESSES_FILE, JSON.stringify(businesses, null, 2));
    res.json({ success: true, businessId, salesRepId: businesses[idx].salesRepId, salesLeadId: lead.id });
  });

  // GET /api/lead-statuses — dropdown options (defaults + custom)
  app.get('/api/lead-statuses', requireAuth, requireRole('agency_admin', 'admin'), (req, res) => {
    if (!db) return res.status(503).json({ error: 'Not available in this server mode' });
    res.json(db.listLeadStatuses());
  });

  // POST /api/lead-statuses — add a custom status
  app.post('/api/lead-statuses', requireAuth, requireRole('agency_admin', 'admin'), (req, res) => {
    if (!db) return res.status(503).json({ error: 'Not available in this server mode' });
    const { label, color } = req.body;
    if (!label || !String(label).trim()) return res.status(400).json({ error: 'label is required' });
    if (!color || !HEX_COLOR_RE.test(color)) return res.status(400).json({ error: 'color must be a hex value like #C9A84C' });
    const result = db.addLeadStatus(label.trim(), color);
    if (!result.success) return res.status(409).json({ error: result.error });
    res.json({ success: true });
  });

  // DELETE /api/lead-statuses/:label — remove a custom status (defaults refused)
  app.delete('/api/lead-statuses/:label', requireAuth, requireRole('agency_admin', 'admin'), (req, res) => {
    if (!db) return res.status(503).json({ error: 'Not available in this server mode' });
    const result = db.deleteLeadStatus(req.params.label);
    if (!result.success) return res.status(403).json({ error: result.error });
    res.json({ success: true });
  });

  // POST /api/crm-leads/import — bulk create from parsed CSV rows
  app.post('/api/crm-leads/import', requireAuth, requireRole('agency_admin', 'admin'), (req, res) => {
    if (!db) return res.status(503).json({ error: 'Not available in this server mode' });
    const { rows } = req.body;
    if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows must be an array' });
    let count = 0;
    for (const row of rows) {
      if (!row.cafe_name || !String(row.cafe_name).trim()) continue;
      db.createLead({
        cafeName: row.cafe_name.trim(), phone: row.phone, ownerName: row.owner_name,
        location: row.location, status: row.status, followUpDate: row.follow_up_date, notes: row.notes,
      });
      count++;
    }
    res.json({ success: true, count });
  });
};
