'use strict';
// WhatsApp QR-linking API (whatsapp-web.js). Staff-only, per-branch. The heavy
// lifting — client lifecycle, session persistence, config writes on ready — lives
// in server.js's startQrClientForBranch + data/waweb.js; these endpoints are the
// thin control surface the manager Settings panel calls.
module.exports = function register(ctx) {
  const { app, requireAuth, requireBranchAccess, waweb, startQrClientForBranch,
          getWaConfig, writeWaConfig, emitToBranch } = ctx;

  function qrUnavailable(res) {
    return res.status(503).json({ error: 'QR linking is not available on this server' });
  }

  // Begin (or resume) linking: spins up the client; the QR arrives via the
  // 'wa_qr' socket event and/or the status endpoint below.
  app.post('/api/businesses/:id/whatsapp/qr/start', requireAuth, requireBranchAccess, (req, res) => {
    if (!waweb || !waweb.available) return qrUnavailable(res);
    const result = startQrClientForBranch(req.params.id);
    if (!result.success) return res.status(503).json({ error: result.error });
    res.json({ success: true, ...waweb.getStatus(req.params.id) });
  });

  // Polling fallback for the UI (also the source of truth for the QR image while
  // the socket connects).
  app.get('/api/businesses/:id/whatsapp/qr/status', requireAuth, requireBranchAccess, (req, res) => {
    if (!waweb || !waweb.available) return qrUnavailable(res);
    res.json(waweb.getStatus(req.params.id));
  });

  // Unlink: logs out on the phone + wipes the session, then restores the café's
  // previous Cloud config (if any) so it falls back cleanly.
  app.post('/api/businesses/:id/whatsapp/qr/disconnect', requireAuth, requireBranchAccess, async (req, res) => {
    if (!waweb || !waweb.available) return qrUnavailable(res);
    const id = req.params.id;
    const cfg = getWaConfig(id) || {};
    await waweb.stopClient(id, { logout: true });
    if (cfg.cloudBackup && cfg.cloudBackup.phoneNumberId) {
      writeWaConfig(id, { mode: 'cloud', ...cfg.cloudBackup });
    } else {
      writeWaConfig(id, {});
    }
    emitToBranch(id, 'wa_status', { branchId: id, state: 'disconnected', number: null });
    res.json({ success: true });
  });
};
