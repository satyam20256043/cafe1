'use strict';
// Sales pipeline — tracks prospective cafés the operator is pitching, before they
// sign up. Global (no business_id), admin-only, forever. Never reachable by a
// café owner/manager — same requireRole('agency_admin') guard as /api/settings.
module.exports = function register(ctx) {
  const { app, db, requireAuth, requireRole } = ctx;

  const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

  // GET /api/crm-leads — list every prospect
  // NOTE: intentionally NOT /api/leads — routes/agency.js already owns that whole
  // namespace for the unrelated website-contact-form lead capture feature, and
  // since it's require()d earlier in server.js its routes would silently shadow
  // these (Express matches the first-registered handler for a given path+method).
  app.get('/api/crm-leads', requireAuth, requireRole('agency_admin'), (req, res) => {
    if (!db) return res.status(503).json({ error: 'Not available in this server mode' });
    res.json(db.listLeads());
  });

  // POST /api/crm-leads — create a new prospect
  app.post('/api/crm-leads', requireAuth, requireRole('agency_admin'), (req, res) => {
    if (!db) return res.status(503).json({ error: 'Not available in this server mode' });
    const { cafe_name, phone, owner_name, location, status, follow_up_date, notes } = req.body;
    if (!cafe_name || !String(cafe_name).trim()) {
      return res.status(400).json({ error: 'cafe_name is required' });
    }
    const lead = db.createLead({ cafeName: cafe_name.trim(), phone, ownerName: owner_name, location, status, followUpDate: follow_up_date, notes });
    res.json(lead);
  });

  // PUT /api/crm-leads/:id — partial update (inline cell auto-save)
  app.put('/api/crm-leads/:id', requireAuth, requireRole('agency_admin'), (req, res) => {
    if (!db) return res.status(503).json({ error: 'Not available in this server mode' });
    const { cafe_name, phone, owner_name, location, status, follow_up_date, notes } = req.body;
    const fields = {};
    if (cafe_name !== undefined) fields.cafeName = cafe_name;
    if (phone !== undefined) fields.phone = phone;
    if (owner_name !== undefined) fields.ownerName = owner_name;
    if (location !== undefined) fields.location = location;
    if (status !== undefined) fields.status = status;
    if (follow_up_date !== undefined) fields.followUpDate = follow_up_date;
    if (notes !== undefined) fields.notes = notes;
    const updated = db.updateLead(req.params.id, fields);
    if (!updated) return res.status(404).json({ error: 'Lead not found' });
    res.json(updated);
  });

  // DELETE /api/crm-leads/:id
  app.delete('/api/crm-leads/:id', requireAuth, requireRole('agency_admin'), (req, res) => {
    if (!db) return res.status(503).json({ error: 'Not available in this server mode' });
    const result = db.deleteLead(req.params.id);
    res.json(result);
  });

  // GET /api/lead-statuses — dropdown options (defaults + custom)
  app.get('/api/lead-statuses', requireAuth, requireRole('agency_admin'), (req, res) => {
    if (!db) return res.status(503).json({ error: 'Not available in this server mode' });
    res.json(db.listLeadStatuses());
  });

  // POST /api/lead-statuses — add a custom status
  app.post('/api/lead-statuses', requireAuth, requireRole('agency_admin'), (req, res) => {
    if (!db) return res.status(503).json({ error: 'Not available in this server mode' });
    const { label, color } = req.body;
    if (!label || !String(label).trim()) return res.status(400).json({ error: 'label is required' });
    if (!color || !HEX_COLOR_RE.test(color)) return res.status(400).json({ error: 'color must be a hex value like #C9A84C' });
    const result = db.addLeadStatus(label.trim(), color);
    if (!result.success) return res.status(409).json({ error: result.error });
    res.json({ success: true });
  });

  // DELETE /api/lead-statuses/:label — remove a custom status (defaults refused)
  app.delete('/api/lead-statuses/:label', requireAuth, requireRole('agency_admin'), (req, res) => {
    if (!db) return res.status(503).json({ error: 'Not available in this server mode' });
    const result = db.deleteLeadStatus(req.params.label);
    if (!result.success) return res.status(403).json({ error: result.error });
    res.json({ success: true });
  });

  // POST /api/crm-leads/import — bulk create from parsed CSV rows
  app.post('/api/crm-leads/import', requireAuth, requireRole('agency_admin'), (req, res) => {
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
