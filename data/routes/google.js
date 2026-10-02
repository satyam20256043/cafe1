'use strict';
/**
 * routes/google.js — Google Business Profile OAuth + location management (GB4).
 *
 * Owner/manager only on every mutating route.
 * Token helper: getValidAccessToken(businessId) — decrypts, refreshes if <2min left,
 * persists new token, raises opsAlerts on AUTH failure.
 *
 * syncGoogleReviews(businessId) is exported and attached to ctx for use by the
 * scheduler in server.js and the legacy /gbp/sync delegate in marketing.js.
 */

const crypto = require('crypto');

module.exports = function googleRoutes(ctx) {
  const {
    app, db, requireAuth, requireBranchAccess, requireRole,
    signToken, verifyToken, getGoogleAdapter, opsAlerts, logEvent,
  } = ctx;

  const { encrypt, decrypt, isConfigured } = require('../secrets');

  // ── Token helper ────────────────────────────────────────────────────────────

  async function getValidAccessToken(businessId) {
    const conn = db.getGoogleConnection(businessId);
    if (!conn || !conn.access_token_enc) {
      throw Object.assign(new Error('No Google connection'), { code: 'NOT_CONNECTED' });
    }

    let accessToken;
    try { accessToken = decrypt(conn.access_token_enc); }
    catch (_) {
      db.upsertGoogleConnection(businessId, { status: 'needs_reconnect', last_sync_error: 'Token decrypt failed' });
      opsAlerts.raiseAlert('google_auth', businessId, 'Access token decryption failed — reconnect required');
      throw Object.assign(new Error('Token decrypt failed'), { code: 'AUTH' });
    }

    // Refresh if expiring within 2 minutes
    if (conn.token_expires_at && conn.token_expires_at - Date.now() < 2 * 60 * 1000) {
      if (!conn.refresh_token_enc) {
        db.upsertGoogleConnection(businessId, { status: 'needs_reconnect', last_sync_error: 'No refresh token' });
        opsAlerts.raiseAlert('google_auth', businessId, 'Access token expired and no refresh token — reconnect required');
        throw Object.assign(new Error('No refresh token'), { code: 'AUTH' });
      }
      let refreshToken;
      try { refreshToken = decrypt(conn.refresh_token_enc); }
      catch (_) {
        db.upsertGoogleConnection(businessId, { status: 'needs_reconnect', last_sync_error: 'Refresh token decrypt failed' });
        opsAlerts.raiseAlert('google_auth', businessId, 'Refresh token decryption failed — reconnect required');
        throw Object.assign(new Error('Refresh token decrypt failed'), { code: 'AUTH' });
      }

      const adapter = getGoogleAdapter();
      try {
        const tokens = await adapter.refreshAccessToken(refreshToken);
        accessToken = tokens.accessToken;
        db.upsertGoogleConnection(businessId, {
          access_token_enc: encrypt(tokens.accessToken),
          token_expires_at: tokens.expiresAt,
        });
      } catch (e) {
        if (e.code === 'AUTH') {
          db.upsertGoogleConnection(businessId, { status: 'needs_reconnect', last_sync_error: 'Token refresh failed: ' + e.message });
          opsAlerts.raiseAlert('google_auth', businessId, 'Google token refresh failed — reconnect required');
        }
        throw e;
      }
    }

    return accessToken;
  }

  // ── Status ─────────────────────────────────────────────────────────────────

  app.get('/api/businesses/:id/google/status', requireAuth, requireBranchAccess, (req, res) => {
    const adapter = getGoogleAdapter();
    if (!adapter) return res.json({ configured: false });

    const conn = db.getGoogleConnection(req.params.id);
    if (!conn) {
      return res.json({
        configured: true,
        mode:        adapter.mode,
        status:      'disconnected',
        googleEmail: null, locationTitle: null, mapsUri: null,
        lastSyncAt: null, lastSyncError: null,
      });
    }
    // Never return tokens
    res.json({
      configured:    true,
      mode:          adapter.mode,
      status:        conn.status,
      googleEmail:   conn.google_email,
      accountName:   conn.account_name,
      locationTitle: conn.location_title,
      mapsUri:       conn.maps_uri,
      lastSyncAt:    conn.last_sync_at,
      lastSyncError: conn.last_sync_error,
    });
  });

  // ── Connect — generate OAuth URL ───────────────────────────────────────────

  app.post('/api/businesses/:id/google/connect',
    requireAuth, requireBranchAccess, requireRole('owner', 'manager'),
    (req, res) => {
      const adapter = getGoogleAdapter();
      if (!adapter) return res.status(503).json({ error: 'Google integration not configured' });

      const staff   = req.staff;
      const nonce   = crypto.randomBytes(16).toString('hex');
      const state   = signToken({ purpose: 'google_oauth', businessId: req.params.id, staffId: staff.id, nonce });
      const url     = adapter.getAuthUrl(state);
      res.json({ url });
    }
  );

  // ── OAuth callback — browser redirect (no auth middleware) ─────────────────

  app.get('/api/google/oauth/callback', async (req, res) => {
    const { code, state, error: oauthError } = req.query;
    const redirect = (param) => res.redirect(`/manager?google=${param}`);

    if (oauthError) return redirect('error&reason=access_denied');
    if (!code || !state) return redirect('error&reason=missing_params');

    // Validate state JWT
    const { ok, payload } = verifyToken(state);
    if (!ok || payload.purpose !== 'google_oauth' || !payload.businessId) {
      return redirect('error&reason=invalid_state');
    }

    const businessId = payload.businessId;
    const adapter    = getGoogleAdapter();
    if (!adapter) return redirect('error&reason=not_configured');

    try {
      const tokens = await adapter.exchangeCode(code);

      // In mock mode, tokens are plaintext stubs; in live mode, encrypt them.
      // We only encrypt when secrets are configured (live mode always has TOKEN_ENCRYPTION_KEY).
      const encAccess  = isConfigured() ? encrypt(tokens.accessToken)  : tokens.accessToken;
      const encRefresh = tokens.refreshToken
        ? (isConfigured() ? encrypt(tokens.refreshToken) : tokens.refreshToken)
        : null;

      db.upsertGoogleConnection(businessId, {
        status:            'pending_location',
        google_email:      tokens.email,
        access_token_enc:  encAccess,
        refresh_token_enc: encRefresh,
        token_expires_at:  tokens.expiresAt,
        connected_by:      payload.staffId,
        connected_at:      Date.now(),
        last_sync_error:   null,
      });

      // Redirect to the manager page with a `google=pick` signal.
      // The branchId is embedded so the picker can land on the right branch.
      res.redirect(`/manager/${encodeURIComponent(businessId)}?google=pick`);
    } catch (e) {
      console.error('[google/callback] exchangeCode failed:', e.code, e.message);
      redirect('error&reason=exchange_failed');
    }
  });

  // ── List locations (after connect, before pick) ────────────────────────────

  app.get('/api/businesses/:id/google/locations',
    requireAuth, requireBranchAccess, requireRole('owner', 'manager'),
    async (req, res) => {
      const adapter = getGoogleAdapter();
      if (!adapter) return res.status(503).json({ error: 'Google integration not configured' });

      try {
        const accessToken = await getValidAccessToken(req.params.id);
        const accounts    = await adapter.listAccounts(accessToken);
        const locations   = [];
        for (const account of accounts) {
          const locs = await adapter.listLocations(accessToken, account.name);
          for (const loc of locs) {
            locations.push({ accountName: account.name, ...loc });
          }
        }
        res.json({ locations });
      } catch (e) {
        const status = e.code === 'NOT_CONNECTED' ? 409 : e.code === 'AUTH' ? 401 : 500;
        res.status(status).json({ error: e.message, code: e.code });
      }
    }
  );

  // ── Pick location ──────────────────────────────────────────────────────────

  app.post('/api/businesses/:id/google/location',
    requireAuth, requireBranchAccess, requireRole('owner', 'manager'),
    async (req, res) => {
      const adapter = getGoogleAdapter();
      if (!adapter) return res.status(503).json({ error: 'Google integration not configured' });

      const { accountName, locationName } = req.body || {};
      if (!accountName || !locationName) {
        return res.status(400).json({ error: 'accountName and locationName are required' });
      }

      try {
        const accessToken = await getValidAccessToken(req.params.id);

        // Verify the location belongs to this user's accounts (never trust the body alone)
        const accounts = await adapter.listAccounts(accessToken);
        let verified = false;
        for (const account of accounts) {
          if (account.name !== accountName) continue;
          const locs = await adapter.listLocations(accessToken, account.name);
          if (locs.some(l => l.name === locationName)) { verified = true; break; }
        }
        if (!verified) {
          return res.status(403).json({ error: 'Location not found in your Google account', code: 'NOT_FOUND' });
        }

        // Fetch full location detail for title/mapsUri
        const loc = await adapter.getLocation(accessToken, locationName);

        db.upsertGoogleConnection(req.params.id, {
          status:         'connected',
          account_name:   accountName,
          location_name:  locationName,
          location_title: loc.title,
          maps_uri:       loc.mapsUri,
          last_sync_error: null,
        });

        logEvent(req.params.id, 'google.connected', { metadata: { locationTitle: loc.title } });

        // Kick off initial review sync without blocking the response
        if (ctx.syncGoogleReviews) {
          ctx.syncGoogleReviews(req.params.id).catch(e => {
            console.error('[google/location] initial sync error:', e.message);
          });
        }

        res.json({ ok: true, locationTitle: loc.title });
      } catch (e) {
        const status = e.code === 'NOT_CONNECTED' ? 409 : e.code === 'AUTH' ? 401 : 500;
        res.status(status).json({ error: e.message, code: e.code });
      }
    }
  );

  // ── Disconnect ─────────────────────────────────────────────────────────────

  app.post('/api/businesses/:id/google/disconnect',
    requireAuth, requireBranchAccess, requireRole('owner', 'manager'),
    async (req, res) => {
      const adapter = getGoogleAdapter();

      // Best-effort revoke
      try {
        const conn = db.getGoogleConnection(req.params.id);
        if (conn && conn.access_token_enc && adapter) {
          let at;
          try { at = decrypt(conn.access_token_enc); } catch (_) {}
          if (at) await adapter.revoke(at).catch(() => {});
        }
      } catch (_) {}

      db.upsertGoogleConnection(req.params.id, {
        status:            'disconnected',
        access_token_enc:  null,
        refresh_token_enc: null,
        token_expires_at:  null,
        last_sync_error:   null,
      });

      logEvent(req.params.id, 'google.disconnected', {});
      res.json({ ok: true });
    }
  );

  // ── Expose helpers on ctx for server.js scheduler + marketing.js legacy route ──

  ctx.getValidGoogleToken  = getValidAccessToken;
  // syncGoogleReviews added in GB5; placeholder so the location-pick kick-off doesn't throw
  if (!ctx.syncGoogleReviews) {
    ctx.syncGoogleReviews = async () => ({ skipped: 'not_yet_implemented' });
  }
};
