'use strict';
// Google Business Profile connection: status, connect (OAuth), location pick, disconnect.

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { encrypt, decrypt } = require('../secrets');

const MANAGE_ROLES      = ['owner', 'manager', 'admin', 'agency_admin'];
const CALLBACK_PATH     = '/api/google/oauth/callback';
const NONCE_COOKIE      = 'zg_google_nonce';
const STATE_TTL_SECONDS = 10 * 60;
const NOT_CONFIGURED    = { error: "Google connection isn't available yet", code: 'GOOGLE_NOT_CONFIGURED' };
const LISTING_TAKEN     = { error: 'This Google listing is already connected to another Zordical branch', code: 'GOOGLE_LISTING_TAKEN' };

// The state travels through URLs, so it gets its own derived key: it can never pass as a staff login token.
function stateKey() {
  return crypto.createHmac('sha256', String(process.env.JWT_SECRET || '')).update('google-oauth-state:v1').digest();
}

function signState(businessId, staffId, nonce) {
  return jwt.sign({ businessId, staffId, nonce }, stateKey(), { algorithm: 'HS256', audience: 'google-oauth', expiresIn: STATE_TTL_SECONDS });
}

function verifyState(state) {
  if (typeof state !== 'string' || !state) return null;
  try { return jwt.verify(state, stateKey(), { algorithms: ['HS256'], audience: 'google-oauth' }); }
  catch (_) { return null; }
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function setNonceCookie(req, res, value, maxAgeSeconds) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.append('Set-Cookie', `${NONCE_COOKIE}=${value}; Path=${CALLBACK_PATH}; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
}

function sameNonce(a, b) {
  if (!a || !b) return false;
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function typedError(code, message) {
  return Object.assign(new Error(message), { code });
}

// Never answer a Google problem with 401: the dashboard treats any 401 as an expired Zordical login and signs the user out.
function sendGoogleError(res, e) {
  if (e.code === 'NOT_CONFIGURED') return res.status(503).json(NOT_CONFIGURED);
  if (e.code === 'NOT_CONNECTED')  return res.status(409).json({ error: 'Connect Google Business Profile first', code: 'GOOGLE_NOT_CONNECTED' });
  if (e.code === 'AUTH')           return res.status(409).json({ error: 'Google connection needs attention. Please reconnect.', code: 'GOOGLE_RECONNECT' });
  if (e.code === 'PERMISSION' || e.code === 'NOT_FOUND') {
    return res.status(409).json({ error: "This Google account can't access that listing", code: 'GOOGLE_ACCESS' });
  }
  console.error('[google]', e.code || 'ERROR', e.status || '', e.message);
  return res.status(502).json({ error: "Google isn't responding right now. Please try again in a few minutes.", code: 'GOOGLE_UNAVAILABLE' });
}

module.exports = function googleRoutes(ctx) {
  const { app, db, requireAuth, requireBranchAccess, requireRole, getGoogleAdapter, opsAlerts, logEvent } = ctx;
  const canManage = requireRole(...MANAGE_ROLES);
  const adapterOrNull = () => (db ? getGoogleAdapter() : null);

  function markNeedsReconnect(businessId, reason) {
    db.upsertGoogleConnection(businessId, { status: 'needs_reconnect', last_sync_error: reason });
    opsAlerts.raiseAlert('google_auth', businessId, `Google connection needs reconnect: ${reason}`);
  }

  async function getValidAccessToken(businessId) {
    const adapter = adapterOrNull();
    if (!adapter) throw typedError('NOT_CONFIGURED', 'Google is not configured');
    const conn = db.getGoogleConnection(businessId);
    if (!conn || !conn.access_token_enc) throw typedError('NOT_CONNECTED', 'No Google connection');

    let accessToken;
    try { accessToken = decrypt(conn.access_token_enc); }
    catch (_) { markNeedsReconnect(businessId, 'stored access token unreadable'); throw typedError('AUTH', 'Access token decrypt failed'); }
    if (!conn.token_expires_at || conn.token_expires_at - Date.now() >= 2 * 60 * 1000) return accessToken;

    if (!conn.refresh_token_enc) { markNeedsReconnect(businessId, 'no refresh token'); throw typedError('AUTH', 'No refresh token'); }
    let refreshToken;
    try { refreshToken = decrypt(conn.refresh_token_enc); }
    catch (_) { markNeedsReconnect(businessId, 'stored refresh token unreadable'); throw typedError('AUTH', 'Refresh token decrypt failed'); }
    try {
      const fresh = await adapter.refreshAccessToken(refreshToken);
      db.upsertGoogleConnection(businessId, { access_token_enc: encrypt(fresh.accessToken), token_expires_at: fresh.expiresAt });
      return fresh.accessToken;
    } catch (e) {
      if (e.code === 'AUTH') markNeedsReconnect(businessId, 'Google refused the token refresh');
      throw e;
    }
  }

  app.get('/api/businesses/:id/google/status', requireAuth, requireBranchAccess, (req, res) => {
    const adapter = adapterOrNull();
    if (!adapter) return res.json({ configured: false });
    const conn = db.getGoogleConnection(req.params.id);
    res.json({
      configured:    true,
      mode:          adapter.mode,
      status:        conn ? conn.status : 'disconnected',
      googleEmail:   conn ? conn.google_email : null,
      locationTitle: conn ? conn.location_title : null,
      mapsUri:       conn ? conn.maps_uri : null,
      lastSyncAt:    conn ? conn.last_sync_at : null,
      lastSyncError: conn ? conn.last_sync_error : null,
      syncAvailable: typeof ctx.syncGoogleReviews === 'function',
    });
  });

  app.post('/api/businesses/:id/google/connect', requireAuth, requireBranchAccess, canManage, (req, res) => {
    const adapter = adapterOrNull();
    if (!adapter) return res.status(503).json(NOT_CONFIGURED);
    const nonce = crypto.randomBytes(16).toString('hex');
    setNonceCookie(req, res, nonce, STATE_TTL_SECONDS);
    res.json({ url: adapter.getAuthUrl(signState(req.params.id, req.staff.id, nonce)) });
  });

  // Browser redirect from Google: no Zordical auth header. The tenant comes only from the signed state,
  // and the nonce cookie proves this browser started the flow.
  app.get(CALLBACK_PATH, async (req, res) => {
    let businessId = null;
    const finish = query => {
      setNonceCookie(req, res, '', 0);
      res.redirect(`/manager${businessId ? '/' + encodeURIComponent(businessId) : ''}?google=${query}`);
    };
    try {
      const payload = verifyState(req.query.state);
      if (!payload || !payload.businessId) return finish('error&reason=invalid_state');
      businessId = payload.businessId;
      if (!sameNonce(readCookie(req, NONCE_COOKIE), payload.nonce)) return finish('error&reason=invalid_state');
      if (req.query.error) return finish('error&reason=access_denied');
      if (typeof req.query.code !== 'string' || !req.query.code) return finish('error&reason=missing_code');
      const adapter = adapterOrNull();
      if (!adapter) return finish('error&reason=not_configured');

      const tokens = await adapter.exchangeCode(req.query.code);
      db.upsertGoogleConnection(businessId, {
        status:            'pending_location',
        google_email:      tokens.email,
        access_token_enc:  encrypt(tokens.accessToken),
        refresh_token_enc: tokens.refreshToken ? encrypt(tokens.refreshToken) : null,
        token_expires_at:  tokens.expiresAt,
        connected_by:      payload.staffId || null,
        connected_at:      new Date().toISOString(),
        last_sync_error:   null,
      });
      finish('pick');
    } catch (e) {
      console.error('[google/callback] connect failed:', e.code || 'ERROR', e.status || '', e.message);
      finish('error&reason=exchange_failed');
    }
  });

  app.get('/api/businesses/:id/google/locations', requireAuth, requireBranchAccess, canManage, async (req, res) => {
    const adapter = adapterOrNull();
    if (!adapter) return res.status(503).json(NOT_CONFIGURED);
    try {
      const accessToken = await getValidAccessToken(req.params.id);
      const locations = [];
      for (const account of await adapter.listAccounts(accessToken)) {
        for (const loc of await adapter.listLocations(accessToken, account.name)) {
          locations.push({ accountName: account.name, name: loc.name, title: loc.title, address: loc.address });
        }
      }
      res.json({ locations });
    } catch (e) { sendGoogleError(res, e); }
  });

  app.post('/api/businesses/:id/google/location', requireAuth, requireBranchAccess, canManage, async (req, res) => {
    const adapter = adapterOrNull();
    if (!adapter) return res.status(503).json(NOT_CONFIGURED);
    const { accountName, locationName } = req.body || {};
    if (typeof accountName !== 'string' || !/^accounts\/[^/]+$/.test(accountName) ||
        typeof locationName !== 'string' || !/^locations\/[^/]+$/.test(locationName)) {
      return res.status(400).json({ error: 'Choose a listing first', code: 'BAD_LOCATION' });
    }
    const takenElsewhere = () => db.findGoogleLocationOwner(locationName, req.params.id);
    if (takenElsewhere()) return res.status(409).json(LISTING_TAKEN);

    try {
      const accessToken = await getValidAccessToken(req.params.id);
      const accounts = await adapter.listAccounts(accessToken);
      const owned = accounts.some(a => a.name === accountName) &&
        (await adapter.listLocations(accessToken, accountName)).some(l => l.name === locationName);
      if (!owned) return res.status(403).json({ error: "That listing isn't in your Google account", code: 'GOOGLE_ACCESS' });

      const loc = await adapter.getLocation(accessToken, locationName);
      // Re-check after the awaits; the check and the write below run without yielding.
      if (takenElsewhere()) return res.status(409).json(LISTING_TAKEN);
      db.upsertGoogleConnection(req.params.id, {
        status:          'connected',
        account_name:    accountName,
        location_name:   locationName,
        location_title:  loc.title,
        maps_uri:        loc.mapsUri,
        last_sync_error: null,
      });
      logEvent(req.params.id, 'google.connected', { actor: req.staff.id, metadata: { locationTitle: loc.title } });

      if (typeof ctx.syncGoogleReviews === 'function') {
        ctx.syncGoogleReviews(req.params.id).catch(e => console.error('[google/location] initial sync failed:', e.message));
      }
      res.json({ ok: true, locationTitle: loc.title });
    } catch (e) { sendGoogleError(res, e); }
  });

  app.post('/api/businesses/:id/google/disconnect', requireAuth, requireBranchAccess, canManage, (req, res) => {
    if (!db) return res.status(503).json(NOT_CONFIGURED);
    const conn = db.getGoogleConnection(req.params.id);
    const readable = enc => { try { return enc ? decrypt(enc) : null; } catch (_) { return null; } };
    // Revoking the refresh token ends the whole grant, and still works after the access token has expired.
    const toRevoke = conn ? (readable(conn.refresh_token_enc) || readable(conn.access_token_enc)) : null;

    db.upsertGoogleConnection(req.params.id, {
      status: 'disconnected', access_token_enc: null, refresh_token_enc: null, token_expires_at: null, last_sync_error: null,
    });
    logEvent(req.params.id, 'google.disconnected', { actor: req.staff.id });
    res.json({ ok: true });

    const adapter = adapterOrNull();
    if (toRevoke && adapter) adapter.revoke(toRevoke).catch(() => {});
  });

  ctx.getValidGoogleToken = getValidAccessToken;
};
