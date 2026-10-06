'use strict';
// Google Business Profile connection: status, connect (OAuth), location pick, disconnect, review sync.

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { encrypt, decrypt } = require('../secrets');
const { rateLimit } = require('../rateLimit');

const MANAGE_ROLES      = ['owner', 'manager', 'admin', 'agency_admin'];
const CALLBACK_PATH     = '/api/google/oauth/callback';
const NONCE_COOKIE      = 'zg_google_nonce';
const STATE_TTL_SECONDS = 10 * 60;
const NOT_CONFIGURED    = { error: "Google connection isn't available yet", code: 'GOOGLE_NOT_CONFIGURED' };
const LISTING_TAKEN     = { error: 'This Google listing is already connected to another Zordical branch', code: 'GOOGLE_LISTING_TAKEN' };
const SYNC_MAX_PAGES    = 20;
const SYNC_NOTIFY_LIMIT = 25; // max reviews queued for AI per sync run

// GB6 closed topic vocabulary — the model's topics are filtered against this; anything else is dropped.
const TOPIC_VOCAB = new Set(['food_quality', 'taste', 'portion', 'price_value', 'service', 'staff',
  'waiting_time', 'cleanliness', 'ambience', 'music_noise', 'seating', 'wifi', 'parking', 'location',
  'packaging', 'delivery', 'menu_variety', 'coffee_beverages', 'room_cleanliness', 'room_comfort',
  'check_in', 'amenities', 'breakfast', 'hospitality', 'booking_issue', 'other']);

// Per-business in-memory concurrency guard
const syncsInProgress = new Set();

// review_name holds slashes; the client URL-encodes it. Express usually decodes params, but decode
// defensively if an environment left %2F encoded.
function decodeReviewName(param) {
  let v = String(param || '');
  if (/%2[Ff]/.test(v)) { try { v = decodeURIComponent(v); } catch (_) {} }
  return v;
}

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
      if (typeof ctx.runGoogleAudit === 'function') {
        ctx.runGoogleAudit(req.params.id).catch(e => console.error('[google/location] initial audit failed:', e.message));
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

  // ── Review sync ──────────────────────────────────────────────────────────────

  async function syncGoogleReviews(businessId) {
    const conn = db.getGoogleConnection(businessId);
    if (!conn || conn.status !== 'connected') return { skipped: 'not_connected' };
    if (syncsInProgress.has(businessId)) return { skipped: 'in_progress' };

    syncsInProgress.add(businessId);
    const isFirstSync = !conn.last_sync_at;
    let inserted = 0, updated = 0, pages = 0;
    const newLowStarReviews = [];
    const newUnreplied = [];

    try {
      const adapter = adapterOrNull();
      if (!adapter) throw typedError('NOT_CONFIGURED', 'Google is not configured');
      const accessToken = await getValidAccessToken(businessId);

      let pageToken;
      do {
        const result = await adapter.listReviews(accessToken, conn.account_name, conn.location_name, pageToken);
        for (const review of (result.reviews || [])) {
          // Both live and mock adapters return snake_case field names already.
          const row = {
            review_name:    review.review_name,
            reviewer_name:  review.reviewer_name,
            reviewer_photo: review.reviewer_photo || null,
            star_rating:    review.star_rating,
            comment:        review.comment || null,
            create_time:    review.create_time,
            update_time:    review.update_time || null,
            reply_text:     review.reply_text  || null,
            reply_time:     review.reply_time  || null,
          };
          const outcome = db.upsertGoogleReview(businessId, row);
          if (outcome.skipped) continue;
          if (outcome.inserted) {
            inserted++;
            logEvent(businessId, 'review.received', { metadata: { stars: review.star_rating, source: 'google' } });
            if (review.star_rating <= 3) newLowStarReviews.push(review);
            if (!review.reply_text) newUnreplied.push(row);
          } else {
            // If Google's reply differs from what we have, Google wins (edited outside Zordical)
            updated++;
          }
        }
        pages++;
        pageToken = result.nextPageToken;
      } while (pageToken && pages < SYNC_MAX_PAGES);

      db.upsertGoogleConnection(businessId, { last_sync_at: new Date().toISOString(), last_sync_error: null });

      // Notifications — first sync: one summary; subsequent syncs: per low-star review
      if (inserted > 0 || updated > 0) {
        const business = ctx.businesses && ctx.businesses.find(b => b.id === businessId);
        const ownerPhone = business && business.ownerPhone;
        if (ownerPhone) {
          if (isFirstSync) {
            ctx.sendWhatsAppToCustomer(businessId, ownerPhone,
              `📥 Imported ${inserted} Google review${inserted === 1 ? '' : 's'} for ${business.name || businessId}. Open your dashboard to see them.`
            ).catch(() => {});
          } else {
            for (const rev of newLowStarReviews) {
              const stars = '⭐'.repeat(rev.starRating);
              ctx.sendWhatsAppToCustomer(businessId, ownerPhone,
                `${stars} New ${rev.starRating}-star Google review — tap to reply:\n${(process.env.BASE_URL || 'http://localhost:3010')}/manager/${businessId}?tab=feedback&filter=negative`
              ).catch(() => {});
            }
          }
        }
      }

      // Queue new unreplied reviews for AI analysis (GB6). Non-blocking, sequential, max SYNC_NOTIFY_LIMIT per run.
      if (typeof ctx.analyzeAndDraftReview === 'function') {
        const toAnalyze = newUnreplied.slice(0, SYNC_NOTIFY_LIMIT);
        setImmediate(async () => {
          for (const rev of toAnalyze) {
            try { await ctx.analyzeAndDraftReview(businessId, rev); }
            catch (e) { console.error('[google/sync] analyzeAndDraft failed for', rev.review_name, e.message); }
          }
        });
      }

      return { inserted, updated, pages };
    } catch (e) {
      const errMsg = e.message || String(e);
      db.upsertGoogleConnection(businessId, { last_sync_error: errMsg });
      if (e.code === 'AUTH') markNeedsReconnect(businessId, errMsg);
      throw e;
    } finally {
      syncsInProgress.delete(businessId);
    }
  }

  // Rate limit: 1 manual sync per 2 min per business
  const syncRateLimit = rateLimit({
    windowMs: 2 * 60 * 1000,
    max: 1,
    keyFn: req => `google_sync:${req.params.id}`,
    message: 'Sync is rate-limited — try again in 2 minutes.',
  });

  app.post('/api/businesses/:id/google/sync', requireAuth, requireBranchAccess, canManage, syncRateLimit, async (req, res) => {
    try {
      const result = await syncGoogleReviews(req.params.id);
      res.json(result);
    } catch (e) { sendGoogleError(res, e); }
  });

  // ── GB6: AI analysis + reply draft ────────────────────────────────────────

  function vertical(business) {
    const t = String((business && (business.businessType || business.vertical || business.category)) || '').toLowerCase();
    if (t.includes('hotel')) return 'hotel';
    if (t.includes('restaurant')) return 'restaurant';
    return 'café';
  }

  function firstName(name) {
    const n = String(name || '').trim().split(/\s+/)[0];
    return n && n.toLowerCase() !== 'anonymous' ? n : 'there';
  }

  function buildReviewPrompt(businessId, review, tone) {
    const business = (ctx.businesses || []).find(b => b.id === businessId) || {};
    const vert = vertical(business);
    const named = business.assistantName ? ` You are called ${business.assistantName}.` : '';
    const facts = ((ctx.getBranchData && ctx.getBranchData(businessId, 'knowledge.json')) || [])
      .filter(k => k && k.q && k.a && String(k.a).trim())
      .map(k => `- ${k.q} → ${k.a}`).join('\n') || '(no specific facts provided — do not invent any)';
    const stars = review.star_rating;
    const text = (review.comment || '').trim();
    const who = firstName(review.reviewer_name);
    const contact = business.contact ? ` on ${business.contact}` : '';
    const toneHint = { warmer: '\n- Make this version noticeably warmer and more personal.',
      shorter: '\n- Make this version shorter: 1–2 sentences.',
      more_formal: '\n- Make this version more formal and professional.' }[tone] || '';

    return `You are the owner of "${business.name || 'our ' + vert}", a ${vert} in India.${named}
${who} left a ${stars}-star Google review${text ? ':\n"""' + text + '"""' : ' with no written comment.'}

Facts about the business (use ONLY these for any specific claim; never go beyond them):
${facts}

Reply to this review and classify it. Output ONLY a JSON object, nothing else:
{"sentiment":"positive|neutral|negative","topics":["..."],"draft":"the public reply"}

"topics" MUST come from this exact list (choose 1–4 that apply, else ["other"]):
food_quality, taste, portion, price_value, service, staff, waiting_time, cleanliness, ambience, music_noise, seating, wifi, parking, location, packaging, delivery, menu_variety, coffee_beverages, room_cleanliness, room_comfort, check_in, amenities, breakfast, hospitality, booking_issue, other

Rules for "draft":
- Reply in the SAME language as the review (English, Hindi, or Hinglish).${text ? '' : ' There is no comment, so write a short, warm thank-you.'}
- 2–4 sentences, under 500 characters. Thank ${who} by name.
- Address the specific points raised.
- NEVER promise refunds, discounts, free items or any compensation.
- NEVER state a fact that is not in the facts above.
- NEVER mention loyalty points, rewards or coupons.
- NEVER argue with or blame the customer.
${stars <= 3 ? `- Apologise once, sincerely, and invite ${who} to reach the ${vert} directly${contact}.` : ''}
- No hashtags. At most one emoji.${toneHint}
Output ONLY the JSON object.`;
  }

  function parseReviewAnalysis(raw) {
    if (!raw) return null;
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    let obj;
    try { obj = JSON.parse(raw.slice(start, end + 1)); }
    catch (_) { return null; }
    if (!obj || typeof obj !== 'object') return null;
    const sentiment = ['positive', 'neutral', 'negative'].includes(obj.sentiment) ? obj.sentiment : null;
    const topics = Array.isArray(obj.topics) ? obj.topics.filter(t => TOPIC_VOCAB.has(t)).slice(0, 4) : [];
    let draft = typeof obj.draft === 'string' ? obj.draft.trim() : '';
    if (draft.length > 500) draft = draft.slice(0, 500).trim();
    return { sentiment, topics, draft };
  }

  function sentimentFromStars(stars) {
    if (stars >= 4) return 'positive';
    if (stars === 3) return 'neutral';
    return 'negative';
  }

  async function analyzeAndDraftReview(businessId, review, opts = {}) {
    const fallback = sentimentFromStars(review.star_rating);
    const raw = await ctx.callClaude(buildReviewPrompt(businessId, review, opts.tone));
    const parsed = parseReviewAnalysis(raw);
    if (!parsed || !parsed.draft) {
      // No usable draft (model down, parse failure): keep a stars-based sentiment, leave draft_status 'none'.
      db.updateGoogleReviewDraft(businessId, review.review_name, {
        sentiment: (parsed && parsed.sentiment) || fallback,
        draftStatus: 'none',
      });
      return { ok: false, draftStatus: 'none', sentiment: (parsed && parsed.sentiment) || fallback };
    }
    db.updateGoogleReviewDraft(businessId, review.review_name, {
      sentiment: parsed.sentiment || fallback,
      topics: parsed.topics,
      aiDraft: parsed.draft,
      draftStatus: 'drafted',
    });
    return { ok: true, draftStatus: 'drafted', draft: parsed.draft, topics: parsed.topics, sentiment: parsed.sentiment || fallback };
  }

  const draftRateLimit = rateLimit({
    windowMs: 60 * 1000, max: 10,
    keyFn: req => `google_draft:${req.params.id}`,
    message: 'Too many draft requests — try again in a minute.',
  });

  app.post('/api/businesses/:id/google/reviews/:reviewName/draft', requireAuth, requireBranchAccess, canManage, draftRateLimit, async (req, res) => {
    const reviewName = decodeReviewName(req.params.reviewName);
    const tone = ['warmer', 'shorter', 'more_formal'].includes(req.body && req.body.tone) ? req.body.tone : undefined;
    const review = db.getGoogleReview(req.params.id, reviewName);
    if (!review) return res.status(404).json({ error: 'Review not found', code: 'NOT_FOUND' });
    try {
      const result = await analyzeAndDraftReview(req.params.id, review, { tone });
      if (!result.ok) return res.status(502).json({ error: "Couldn't draft a reply right now. Please try again or write your own.", code: 'DRAFT_FAILED' });
      res.json(result);
    } catch (e) { sendGoogleError(res, e); }
  });

  // ── GB7: Reviews inbox + publish/delete/skip reply ────────────────────────

  function humanGoogleError(e) {
    if (e.code === 'AUTH') return 'Google connection needs to be reconnected';
    if (e.code === 'PERMISSION' || e.code === 'NOT_FOUND') return "Google didn't accept this reply";
    if (e.code === 'RATE_LIMIT') return 'Google is busy — try again shortly';
    return "Google isn't responding — try again";
  }

  app.get('/api/businesses/:id/google/reviews', requireAuth, requireBranchAccess, (req, res) => {
    const adapter = adapterOrNull();
    if (!adapter || !db) return res.status(503).json(NOT_CONFIGURED);
    const conn = db.getGoogleConnection(req.params.id);
    const filter = ['needs_reply', 'negative', 'replied', 'all'].includes(req.query.filter) ? req.query.filter : 'needs_reply';
    const reviews = db.listGoogleReviews(req.params.id, { filter, limit: req.query.limit, offset: req.query.offset });
    const summary = db.countGoogleReviewSummary(req.params.id);
    res.json({ mode: adapter.mode, status: conn ? conn.status : 'disconnected', filter, reviews, summary });
  });

  app.post('/api/businesses/:id/google/reviews/:reviewName/reply', requireAuth, requireBranchAccess, canManage, async (req, res) => {
    const reviewName = decodeReviewName(req.params.reviewName);
    const text = typeof (req.body && req.body.text) === 'string' ? req.body.text.trim() : '';
    if (text.length < 1 || text.length > 4000) return res.status(400).json({ error: 'Reply must be 1–4000 characters', code: 'BAD_REPLY' });
    const review = db.getGoogleReview(req.params.id, reviewName);
    if (!review) return res.status(404).json({ error: 'Review not found', code: 'NOT_FOUND' });
    // Double-tap guard: claim synchronously (better-sqlite3 is sync, so no two requests interleave here).
    if (review.draft_status === 'publishing') return res.status(409).json({ error: 'A reply is already being published', code: 'ALREADY_PUBLISHING' });
    db.updateGoogleReviewDraft(req.params.id, reviewName, { draftStatus: 'publishing' });
    try {
      const accessToken = await getValidAccessToken(req.params.id);
      await adapterOrNull().replyToReview(accessToken, reviewName, text);
      const now = new Date().toISOString();
      const aiDrafted = !!(review.ai_draft && String(review.ai_draft).trim());
      const edited = aiDrafted ? (text !== String(review.ai_draft).trim()) : false;
      db.updateGoogleReviewDraft(req.params.id, reviewName, {
        replyText: text, replyTime: now, repliedBy: req.staff.id, draftStatus: 'published', publishError: null,
      });
      logEvent(req.params.id, 'review.replied', { actor: req.staff.id, metadata: { stars: review.star_rating, aiDrafted, edited } });
      res.json({ ok: true, replyText: text, replyTime: now });
    } catch (e) {
      db.updateGoogleReviewDraft(req.params.id, reviewName, { draftStatus: 'failed', publishError: humanGoogleError(e) });
      sendGoogleError(res, e);
    }
  });

  app.delete('/api/businesses/:id/google/reviews/:reviewName/reply', requireAuth, requireBranchAccess, canManage, async (req, res) => {
    const reviewName = decodeReviewName(req.params.reviewName);
    const review = db.getGoogleReview(req.params.id, reviewName);
    if (!review) return res.status(404).json({ error: 'Review not found', code: 'NOT_FOUND' });
    try {
      const accessToken = await getValidAccessToken(req.params.id);
      await adapterOrNull().deleteReply(accessToken, reviewName);
      db.updateGoogleReviewDraft(req.params.id, reviewName, { replyText: null, replyTime: null, draftStatus: 'none' });
      logEvent(req.params.id, 'review.reply_deleted', { actor: req.staff.id, metadata: { stars: review.star_rating } });
      res.json({ ok: true });
    } catch (e) { sendGoogleError(res, e); }
  });

  app.post('/api/businesses/:id/google/reviews/:reviewName/skip', requireAuth, requireBranchAccess, canManage, (req, res) => {
    const reviewName = decodeReviewName(req.params.reviewName);
    const changed = db.updateGoogleReviewDraft(req.params.id, reviewName, { draftStatus: 'skipped' });
    if (!changed) return res.status(404).json({ error: 'Review not found', code: 'NOT_FOUND' });
    res.json({ ok: true });
  });

  // ── GB8: Profile health audit (deterministic, no AI) ──────────────────────

  const AUDIT_FIX_URL = 'https://business.google.com/';

  function withinNext60Days(sd) {
    if (!sd || !sd.year) return false;
    const t = Date.UTC(sd.year, (sd.month || 1) - 1, sd.day || 1);
    const now = Date.now();
    return t >= now - 24 * 3600 * 1000 && t <= now + 60 * 24 * 3600 * 1000;
  }

  // Build the findings list. state: true=pass (good), false=fail, null=couldn't check (excluded from score).
  function buildAuditFindings(loc, businessId, business) {
    const F = [];
    const add = (id, area, points, failSeverity, state, title, why, fix) => {
      if (state === null) { F.push({ id, area, severity: 'couldnt_check', points, earned: 0, title, why: "We couldn't read this from Google.", fix, fixUrl: AUDIT_FIX_URL }); return; }
      F.push({ id, area, severity: state ? 'good' : failSeverity, points, earned: state ? points : 0, title, why, fix, fixUrl: AUDIT_FIX_URL });
    };

    const cats = loc.categories || {};
    const hasPrimary = !!(cats.primaryCategory && (cats.primaryCategory.displayName || cats.primaryCategory.name));
    const addlCount = Array.isArray(cats.additionalCategories) ? cats.additionalCategories.length : 0;
    const phone = loc.phoneNumbers && loc.phoneNumbers.primaryPhone;
    const desc = (loc.profile && loc.profile.description) || '';
    const regularSet = !!(loc.regularHours && Array.isArray(loc.regularHours.periods) && loc.regularHours.periods.length);
    const specialPeriods = (loc.specialHours && loc.specialHours.specialHourPeriods) || [];
    const specialSoon = specialPeriods.some(p => withinNext60Days(p.startDate));
    const svcCount = Array.isArray(loc.serviceItems) ? loc.serviceItems.length : 0;
    const statusOpen = !!(loc.openInfo && loc.openInfo.status === 'OPEN');
    const addrTokens = String(loc.address || '').split(/[,\s]+/)
      .concat(String((business && business.location) || '').split(/[,\s]+/))
      .filter(t => t && t.length >= 4);
    const cityMention = !!desc && addrTokens.some(t => desc.toLowerCase().includes(t.toLowerCase()));

    add('title', 'Basics', 5, 'critical', !!loc.title, 'Business name is set', 'Customers search by name — a listing without one is hard to find.', 'Set your business name on Google.');
    add('primary_category', 'Basics', 10, 'critical', hasPrimary, 'Primary category is set', 'Your main category decides which searches show your business.', 'Pick the most accurate primary category.');
    add('phone', 'Basics', 8, 'critical', !!phone, 'Phone number is listed', 'Customers tap to call you straight from Google.', 'Add your public phone number.');
    add('address', 'Basics', 7, 'critical', !!loc.address, 'Address is set', 'A full address powers Maps directions and local search.', 'Add your full storefront address.');
    add('website', 'Basics', 5, 'needs_attention', !!loc.websiteUri, 'Website link is set', 'A website link helps customers learn more and choose you.', 'Add your website, menu or a social link.');

    add('regular_hours', 'Hours', 10, 'critical', regularSet, 'Opening hours are set', "Customers avoid places with no hours — they assume you might be closed.", 'Set your weekly opening hours.');
    add('holiday_hours', 'Hours', 5, 'needs_attention', specialSoon, 'Holiday hours set for the next 60 days', 'Festival and holiday hours (Diwali, Christmas, New Year) stop customers arriving to a closed door.', 'Add special hours for upcoming holidays.');

    add('description_length', 'Description', 8, 'needs_attention', desc.length >= 250, 'Description is detailed (250+ characters)', 'A fuller description helps customers find and choose you.', 'Write at least 250 characters about your place.');
    add('description_city', 'Description', 2, 'needs_attention', cityMention, 'Description mentions your city or area', 'Mentioning your area helps nearby customers recognise you.', 'Name your neighbourhood or city in the description.');

    add('additional_category', 'Categories', 5, 'needs_attention', addlCount >= 1, 'Extra categories are set', 'Extra categories surface you for more related searches.', 'Add one or two accurate extra categories.');

    add('services', 'Menu/Services', 5, 'needs_attention', svcCount >= 1, 'Services or menu items are listed', 'Listed services and items help customers find and choose you.', 'Add your key services or menu items.');

    const summary = db.countGoogleReviewSummary(businessId);
    const raw = db.raw();
    const now = Date.now();
    const cutoff48 = new Date(now - 48 * 3600 * 1000).toISOString();
    const since90 = new Date(now - 90 * 24 * 3600 * 1000).toISOString();

    const rr = summary.responseRate90d; // null when there were no reviews in the window
    if (rr === null) {
      add('response_rate', 'Reviews', 10, 'needs_attention', null, 'Reply rate (last 90 days)', '', 'Reply to your Google reviews.');
    } else {
      add('response_rate', 'Reviews', 10, rr < 50 ? 'critical' : 'needs_attention', rr >= 80, `Reply rate is ${rr}% (last 90 days)`, 'Replying shows customers you listen — it helps them choose you.', 'Reply to more reviews (aim for 80%+).');
    }

    const oldUnansweredNeg = raw.prepare("SELECT COUNT(*) n FROM google_reviews WHERE business_id=? AND star_rating<=3 AND (reply_text IS NULL OR reply_text='') AND create_time < ?").get(businessId, cutoff48).n;
    add('neg_backlog', 'Reviews', 10, 'critical', oldUnansweredNeg === 0, 'No low-star reviews left unanswered over 48h', 'A quick, kind reply to an unhappy customer reassures everyone reading.', 'Reply to low-star reviews within two days.');

    const replied = raw.prepare("SELECT create_time, reply_time FROM google_reviews WHERE business_id=? AND replied_by IS NOT NULL AND reply_time IS NOT NULL AND create_time>=?").all(businessId, since90);
    if (!replied.length) {
      add('reply_speed', 'Reviews', 5, 'needs_attention', null, 'Median reply time (last 90 days)', '', 'Reply to reviews soon after they arrive.');
    } else {
      const hours = replied.map(r => (Date.parse(r.reply_time) - Date.parse(r.create_time)) / 3600000).filter(h => !isNaN(h) && h >= 0).sort((a, b) => a - b);
      const mid = Math.floor(hours.length / 2);
      const median = hours.length % 2 ? hours[mid] : (hours[mid - 1] + hours[mid]) / 2;
      add('reply_speed', 'Reviews', 5, 'needs_attention', median <= 48, `Median reply time is about ${Math.round(median)}h`, 'Fast replies show customers you are attentive.', 'Aim to reply within 48 hours.');
    }

    add('status_open', 'Status', 5, 'critical', statusOpen, 'Listing is marked Open', 'A listing not marked Open can be hidden or look closed.', 'Make sure your listing status is Open.');

    return F;
  }

  async function runGoogleAudit(businessId) {
    const conn = db.getGoogleConnection(businessId);
    if (!conn || conn.status !== 'connected') throw typedError('NOT_CONNECTED', 'No Google connection');
    const accessToken = await getValidAccessToken(businessId);
    const loc = await adapterOrNull().getLocation(accessToken, conn.location_name);
    const business = (ctx.businesses || []).find(b => b.id === businessId);
    const findings = buildAuditFindings(loc, businessId, business);
    const checkable = findings.filter(f => f.severity !== 'couldnt_check');
    const earned = checkable.reduce((s, f) => s + (f.earned || 0), 0);
    const possible = checkable.reduce((s, f) => s + f.points, 0);
    const score = possible > 0 ? Math.round((earned / possible) * 100) : 0;
    db.saveGoogleAudit(businessId, score, findings);
    logEvent(businessId, 'google.audit', { metadata: { score } });
    return { score, findings };
  }

  const auditRateLimit = rateLimit({
    windowMs: 5 * 60 * 1000, max: 1,
    keyFn: req => `google_audit:${req.params.id}`,
    message: 'Audit is rate-limited — try again in a few minutes.',
  });

  app.post('/api/businesses/:id/google/audit', requireAuth, requireBranchAccess, canManage, auditRateLimit, async (req, res) => {
    try { res.json(await runGoogleAudit(req.params.id)); }
    catch (e) { sendGoogleError(res, e); }
  });

  app.get('/api/businesses/:id/google/audit', requireAuth, requireBranchAccess, (req, res) => {
    const adapter = adapterOrNull();
    if (!adapter || !db) return res.status(503).json(NOT_CONFIGURED);
    const audits = db.getLatestGoogleAudits(req.params.id, 2);
    res.json({ mode: adapter.mode, latest: audits[0] || null, previous: audits[1] || null });
  });

  // ── GB9: Google posts (draft → approve → publish/schedule) ────────────────

  const POST_TOPIC_TYPES = new Set(['STANDARD', 'OFFER', 'EVENT']);
  const POST_CTA_TYPES   = new Set(['CALL', 'ORDER', 'BOOK', 'LEARN_MORE']);
  const POST_LANGS       = { english: 'English', hindi: 'Hindi', hinglish: 'Hinglish (Roman Hindi)' };

  // Normalize + validate a request body into google_posts columns. Returns { fields } or { error }.
  function buildPostFields(body, { aiGenerated } = {}) {
    const topic_type = POST_TOPIC_TYPES.has(body.topicType) ? body.topicType : 'STANDARD';
    const summary = typeof body.summary === 'string' ? body.summary.trim() : '';
    if (summary.length < 1 || summary.length > 1500) return { error: 'Post text must be 1–1500 characters' };
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 120) : '';
    const startDate = typeof body.startDate === 'string' ? body.startDate.trim() : '';
    const endDate = typeof body.endDate === 'string' ? body.endDate.trim() : '';
    if ((topic_type === 'EVENT' || topic_type === 'OFFER')) {
      if (!title) return { error: `${topic_type === 'OFFER' ? 'Offer' : 'Event'} posts need a title` };
      if (!/^\d{4}-\d{2}-\d{2}/.test(startDate) || !/^\d{4}-\d{2}-\d{2}/.test(endDate)) return { error: `${topic_type === 'OFFER' ? 'Offer' : 'Event'} posts need a start and end date` };
    }
    const cta_type = POST_CTA_TYPES.has(body.ctaType) ? body.ctaType : null;
    let cta_url = null;
    if (cta_type && cta_type !== 'CALL') {
      if (typeof body.ctaUrl === 'string' && /^https?:\/\//.test(body.ctaUrl)) cta_url = body.ctaUrl.trim();
      else return { error: 'That call-to-action needs a valid https link' };
    }
    // Only https images can be shown by Google; anything else publishes text-only.
    const image_url = (typeof body.imageUrl === 'string' && /^https:\/\//.test(body.imageUrl)) ? body.imageUrl.trim() : null;
    return { fields: {
      topic_type, summary, title: title || null,
      start_date: startDate || null, end_date: endDate || null,
      cta_type, cta_url,
      coupon_code: (typeof body.couponCode === 'string' && body.couponCode.trim()) ? body.couponCode.trim().slice(0, 60) : null,
      image_url,
      ai_generated: aiGenerated ? 1 : 0,
    } };
  }

  async function generatePostDraft(businessId, body) {
    const business = (ctx.businesses || []).find(b => b.id === businessId) || {};
    const vert = vertical(business);
    const facts = ((ctx.getBranchData && ctx.getBranchData(businessId, 'knowledge.json')) || [])
      .filter(k => k && k.q && k.a && String(k.a).trim()).map(k => `- ${k.q} → ${k.a}`).join('\n') || '(none)';
    const menu = ((ctx.getBranchData && ctx.getBranchData(businessId, 'menu.json')) || [])
      .slice(0, 30).map(i => `- ${i.name}${i.category ? ' (' + i.category + ')' : ''}`).join('\n') || '(none)';
    const topicType = POST_TOPIC_TYPES.has(body.topicType) ? body.topicType : 'STANDARD';
    const lang = POST_LANGS[body.language] || 'English';
    const goal = typeof body.goal === 'string' ? body.goal.trim().slice(0, 300) : '';
    const offerText = typeof body.offerText === 'string' ? body.offerText.trim().slice(0, 300) : '';
    const dates = (body.startDate && body.endDate) ? `The ${topicType.toLowerCase()} runs ${body.startDate} to ${body.endDate}.` : '';

    const prompt = `You write Google Business Profile posts for "${business.name || 'our ' + vert}", a ${vert} in India.
Write a ${topicType === 'STANDARD' ? 'general update' : topicType.toLowerCase()} post. Goal: ${goal || 'engage local customers'}.
${offerText ? 'Offer details the owner supplied: ' + offerText : ''}
${dates}

Business facts (use ONLY these for any specific claim):
${facts}

Menu items (names only — never state a price):
${menu}

Output ONLY a JSON object, nothing else:
{"summary":"the post text","title":${topicType === 'STANDARD' ? 'null' : '"a short title (max 58 chars)"'},"cta":"CALL|ORDER|BOOK|LEARN_MORE|null"}

Rules:
- Write in ${lang}.
- "summary": 300–600 characters, warm and specific, no line of hashtags.
- NEVER state a price, a discount percentage, or an amount — unless it appears in the owner's offer details above.
- NEVER invent a date, offer or fact not given above.
- NEVER mention loyalty points or Zordical.
- At most one emoji.
Output ONLY the JSON object.`;

    const raw = await ctx.callClaude(prompt);
    if (!raw) return null;
    const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    let obj; try { obj = JSON.parse(raw.slice(start, end + 1)); } catch (_) { return null; }
    if (!obj || typeof obj.summary !== 'string' || !obj.summary.trim()) return null;
    let summary = obj.summary.trim(); if (summary.length > 1500) summary = summary.slice(0, 1500);
    const title = (typeof obj.title === 'string' && obj.title.trim()) ? obj.title.trim().slice(0, 58) : null;
    const cta = POST_CTA_TYPES.has(obj.cta) ? obj.cta : null;
    return { topicType, summary, title, cta };
  }

  function notifyPostFailed(businessId, post) {
    const business = (ctx.businesses || []).find(b => b.id === businessId);
    if (business && business.ownerPhone) {
      ctx.sendWhatsAppToCustomer(businessId, business.ownerPhone,
        `⚠️ Your Google post couldn't be published after 3 tries — tap to retry:\n${(process.env.BASE_URL || 'http://localhost:3010')}/manager/${businessId}?tab=campaigns`
      ).catch(() => {});
    }
  }

  async function publishGooglePost(businessId, postId, opts = {}) {
    if (!db.claimGooglePostForPublishing(businessId, postId)) return { skipped: 'not_claimable' };
    if (opts.approvedBy) db.updateGooglePost(businessId, postId, { approved_by: opts.approvedBy });
    const post = db.getGooglePost(businessId, postId);
    try {
      const conn = db.getGoogleConnection(businessId);
      if (!conn || conn.status !== 'connected') throw typedError('NOT_CONNECTED', 'No Google connection');
      const accessToken = await getValidAccessToken(businessId);
      const result = await adapterOrNull().createLocalPost(accessToken, conn.account_name, conn.location_name, {
        topicType: post.topic_type, summary: post.summary, ctaType: post.cta_type, ctaUrl: post.cta_url,
        title: post.title, startDate: post.start_date, endDate: post.end_date, couponCode: post.coupon_code, imageUrl: post.image_url,
      });
      db.updateGooglePost(businessId, postId, { status: 'published', google_post_name: result.name, last_error: null });
      logEvent(businessId, 'google.post_published', { actor: opts.approvedBy || null, metadata: { topicType: post.topic_type } });
      return { ok: true, status: 'published', googlePostName: result.name };
    } catch (e) {
      const attempts = (post.attempts || 0) + 1;
      if (e.code === 'AUTH') markNeedsReconnect(businessId, e.message);
      if (attempts < 3) {
        const retryAt = new Date(Date.now() + 5 * 60 * 1000 * attempts).toISOString();
        db.updateGooglePost(businessId, postId, { status: 'scheduled', attempts, last_error: humanGoogleError(e), scheduled_for: retryAt });
        return { ok: false, status: 'scheduled', attempts, retryAt };
      }
      db.updateGooglePost(businessId, postId, { status: 'failed', attempts, last_error: humanGoogleError(e) });
      notifyPostFailed(businessId, post);
      return { ok: false, status: 'failed', attempts };
    }
  }

  const postGenRateLimit = rateLimit({ windowMs: 60 * 1000, max: 10, keyFn: req => `google_postgen:${req.params.id}`, message: 'Too many requests — try again in a minute.' });

  app.post('/api/businesses/:id/google/posts/generate', requireAuth, requireBranchAccess, canManage, postGenRateLimit, async (req, res) => {
    if (!adapterOrNull()) return res.status(503).json(NOT_CONFIGURED);
    try {
      const draft = await generatePostDraft(req.params.id, req.body || {});
      if (!draft) return res.status(502).json({ error: "Couldn't write a draft right now. Please try again or write your own.", code: 'DRAFT_FAILED' });
      res.json(draft);
    } catch (e) { sendGoogleError(res, e); }
  });

  app.get('/api/businesses/:id/google/posts', requireAuth, requireBranchAccess, (req, res) => {
    const adapter = adapterOrNull();
    if (!adapter || !db) return res.status(503).json(NOT_CONFIGURED);
    const conn = db.getGoogleConnection(req.params.id);
    const status = ['draft', 'scheduled', 'publishing', 'published', 'failed', 'rejected'].includes(req.query.status) ? req.query.status : undefined;
    res.json({ mode: adapter.mode, status: conn ? conn.status : 'disconnected', posts: db.listGooglePosts(req.params.id, { status, limit: req.query.limit, offset: req.query.offset }) });
  });

  app.post('/api/businesses/:id/google/posts', requireAuth, requireBranchAccess, canManage, (req, res) => {
    if (!adapterOrNull()) return res.status(503).json(NOT_CONFIGURED);
    const { fields, error } = buildPostFields(req.body || {}, { aiGenerated: !!(req.body && req.body.aiGenerated) });
    if (error) return res.status(400).json({ error, code: 'BAD_POST' });
    const post = db.createGooglePost(req.params.id, { ...fields, status: 'draft', created_by: req.staff.id });
    res.json({ ok: true, post });
  });

  app.put('/api/businesses/:id/google/posts/:postId', requireAuth, requireBranchAccess, canManage, (req, res) => {
    if (!adapterOrNull()) return res.status(503).json(NOT_CONFIGURED);
    const existing = db.getGooglePost(req.params.id, req.params.postId);
    if (!existing) return res.status(404).json({ error: 'Post not found', code: 'NOT_FOUND' });
    if (existing.status !== 'draft') return res.status(409).json({ error: 'Only draft posts can be edited', code: 'NOT_EDITABLE' });
    const { fields, error } = buildPostFields(req.body || {}, { aiGenerated: !!existing.ai_generated });
    if (error) return res.status(400).json({ error, code: 'BAD_POST' });
    res.json({ ok: true, post: db.updateGooglePost(req.params.id, req.params.postId, fields) });
  });

  app.post('/api/businesses/:id/google/posts/:postId/approve', requireAuth, requireBranchAccess, canManage, async (req, res) => {
    if (!adapterOrNull()) return res.status(503).json(NOT_CONFIGURED);
    const post = db.getGooglePost(req.params.id, req.params.postId);
    if (!post) return res.status(404).json({ error: 'Post not found', code: 'NOT_FOUND' });
    if (post.status !== 'draft') return res.status(409).json({ error: 'This post has already been handled', code: 'NOT_DRAFT' });

    const scheduledFor = req.body && req.body.scheduledFor;
    if (scheduledFor) {
      const when = new Date(scheduledFor);
      if (isNaN(when.getTime())) return res.status(400).json({ error: 'Invalid schedule time', code: 'BAD_SCHEDULE' });
      if (when.getTime() > Date.now() + 60 * 1000) {
        db.updateGooglePost(req.params.id, req.params.postId, { status: 'scheduled', scheduled_for: when.toISOString(), approved_by: req.staff.id });
        return res.json({ ok: true, status: 'scheduled', scheduledFor: when.toISOString() });
      }
    }
    // Publish now
    try {
      const result = await publishGooglePost(req.params.id, req.params.postId, { approvedBy: req.staff.id });
      if (result.skipped) return res.status(409).json({ error: 'This post is already being published', code: 'ALREADY_PUBLISHING' });
      res.json(result);
    } catch (e) { sendGoogleError(res, e); }
  });

  app.post('/api/businesses/:id/google/posts/:postId/retry', requireAuth, requireBranchAccess, canManage, async (req, res) => {
    if (!adapterOrNull()) return res.status(503).json(NOT_CONFIGURED);
    const post = db.getGooglePost(req.params.id, req.params.postId);
    if (!post) return res.status(404).json({ error: 'Post not found', code: 'NOT_FOUND' });
    if (post.status !== 'failed') return res.status(409).json({ error: 'Only failed posts can be retried', code: 'NOT_FAILED' });
    db.updateGooglePost(req.params.id, req.params.postId, { status: 'scheduled', scheduled_for: new Date().toISOString(), attempts: 0, last_error: null });
    try {
      const result = await publishGooglePost(req.params.id, req.params.postId, { approvedBy: req.staff.id });
      res.json(result);
    } catch (e) { sendGoogleError(res, e); }
  });

  app.post('/api/businesses/:id/google/posts/:postId/reject', requireAuth, requireBranchAccess, canManage, (req, res) => {
    const post = db.getGooglePost(req.params.id, req.params.postId);
    if (!post) return res.status(404).json({ error: 'Post not found', code: 'NOT_FOUND' });
    db.updateGooglePost(req.params.id, req.params.postId, { status: 'rejected' });
    res.json({ ok: true });
  });

  app.delete('/api/businesses/:id/google/posts/:postId', requireAuth, requireBranchAccess, canManage, (req, res) => {
    const post = db.getGooglePost(req.params.id, req.params.postId);
    if (!post) return res.status(404).json({ error: 'Post not found', code: 'NOT_FOUND' });
    if (!['draft', 'rejected', 'failed'].includes(post.status)) return res.status(409).json({ error: 'Only draft, rejected or failed posts can be deleted', code: 'NOT_DELETABLE' });
    db.deleteGooglePost(req.params.id, req.params.postId);
    res.json({ ok: true });
  });

  ctx.analyzeAndDraftReview = analyzeAndDraftReview;
  ctx.syncGoogleReviews = syncGoogleReviews;
  ctx.runGoogleAudit = runGoogleAudit;
  ctx.publishGooglePost = publishGooglePost;
  ctx.getValidGoogleToken = getValidAccessToken;
};
