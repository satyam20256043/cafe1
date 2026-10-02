'use strict';
/**
 * google.js — Live Google Business Profile adapter (GB3).
 *
 * The ONLY file that knows Google API URLs. All other code calls methods on
 * the adapter returned by createGoogleAdapter(); none of it touches fetch directly.
 *
 * Retry policy:
 *   - Network errors, 429, 5xx: up to 3 retries, backoff 1s → 3s → 9s + jitter.
 *     Honours Retry-After header on 429.
 *   - 400, 401, 403, 404: no retry — throw immediately.
 * Every call has a 15-second AbortController timeout.
 *
 * Error shape: { code, status, message }
 *   code: 'AUTH' | 'PERMISSION' | 'NOT_FOUND' | 'RATE_LIMIT' | 'UPSTREAM' | 'BAD_REQUEST'
 *   'AUTH' (401 / invalid_grant) → callers set needs_reconnect.
 *
 * Normalisation happens here — no raw Google JSON escapes this file.
 * Never log full response bodies, tokens, or client secrets.
 */

// ── Helpers ──────────────────────────────────────────────────────────────────

const STAR_MAP = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

function parseStars(raw) {
  if (typeof raw === 'number') return raw;
  return STAR_MAP[String(raw).toUpperCase()] || null;
}

function makeError(code, status, message) {
  const e = new Error(message);
  e.code   = code;
  e.status = status;
  return e;
}

function codeFromStatus(status, body) {
  if (status === 401) return 'AUTH';
  if (status === 403) return 'PERMISSION';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMIT';
  if (status >= 400 && status < 500) return 'BAD_REQUEST';
  return 'UPSTREAM';
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const NO_RETRY  = new Set([400, 401, 403, 404]);

async function fetchWithRetry(url, opts = {}) {
  const { method = 'GET', headers = {}, body, timeout = 15000 } = opts;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    const start = Date.now();
    try {
      const res = await fetch(url, { method, headers, body, signal: ctrl.signal });
      const ms  = Date.now() - start;
      // Redact auth header in log
      const logUrl = url.replace(/access_token=[^&]+/, 'access_token=REDACTED');
      console.log(`[Google] ${method} ${logUrl.slice(0, 120)} ${res.status} ${ms}ms`);
      clearTimeout(timer);
      if (res.ok) return res;
      // Parse error body for detail (small, no tokens expected)
      let errBody = {};
      try { errBody = await res.json(); } catch (_) {}
      const msg = (errBody.error && errBody.error.message) || (typeof errBody.error === 'string' && errBody.error) || res.statusText || String(res.status);
      if (NO_RETRY.has(res.status)) {
        throw makeError(codeFromStatus(res.status, errBody), res.status, msg);
      }
      if (!RETRYABLE.has(res.status)) {
        throw makeError(codeFromStatus(res.status, errBody), res.status, msg);
      }
      // Retryable
      let delay = [1000, 3000, 9000][attempt] + Math.floor(Math.random() * 400);
      if (res.status === 429) {
        const ra = res.headers.get('Retry-After');
        if (ra) delay = Math.min(parseInt(ra) * 1000 || delay, 30000);
      }
      lastError = makeError(codeFromStatus(res.status, errBody), res.status, msg);
      if (attempt < 2) await new Promise(r => setTimeout(r, delay));
    } catch (e) {
      clearTimeout(timer);
      if (e.code === 'AUTH' || e.code === 'PERMISSION' || e.code === 'NOT_FOUND' || e.code === 'BAD_REQUEST') throw e;
      if (e.name === 'AbortError') { lastError = makeError('UPSTREAM', 0, 'Request timed out'); }
      else { lastError = e.code ? e : makeError('UPSTREAM', 0, e.message || 'Network error'); }
      if (attempt < 2) await new Promise(r => setTimeout(r, [1000, 3000, 9000][attempt] + Math.floor(Math.random() * 400)));
    }
  }
  throw lastError || makeError('UPSTREAM', 0, 'Max retries exceeded');
}

function authHeader(accessToken) {
  return { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' };
}

// ── Normalizers ───────────────────────────────────────────────────────────────

function normalizeReview(raw) {
  return {
    review_name:   raw.name,
    reviewer_name: (raw.reviewer && raw.reviewer.displayName) || 'Anonymous',
    reviewer_photo:(raw.reviewer && raw.reviewer.profilePhotoUrl) || null,
    star_rating:   parseStars(raw.starRating),
    comment:       raw.comment || null,
    create_time:   raw.createTime || null,
    update_time:   raw.updateTime || null,
    reply_text:    (raw.reviewReply && raw.reviewReply.comment) || null,
    reply_time:    (raw.reviewReply && raw.reviewReply.updateTime) || null,
  };
}

function normalizeLocation(raw) {
  const addr = raw.storefrontAddress;
  const addrStr = addr ? [addr.addressLines, addr.locality, addr.administrativeArea].flat().filter(Boolean).join(', ') : null;
  return {
    name:         raw.name,
    title:        raw.title || null,
    address:      addrStr,
    mapsUri:      (raw.metadata && raw.metadata.mapsUri) || null,
    categories:   raw.categories || null,
    phoneNumbers: raw.phoneNumbers || null,
    websiteUri:   raw.websiteUri || null,
    regularHours: raw.regularHours || null,
    specialHours: raw.specialHours || null,
    profile:      raw.profile || null,
    openInfo:     raw.openInfo || null,
    serviceItems: raw.serviceItems || null,
  };
}

function normalizeMetrics(raw, locationName) {
  // Business Profile Performance API response shape:
  // { multiDailyMetricTimeSeries: [ { dailyMetricTimeSeries: [{ dailyMetric, timeSeries: { datedValues: [{date,value}] } }] } ] }
  const results = [];
  const series = (raw.multiDailyMetricTimeSeries || []);
  for (const outer of series) {
    for (const inner of (outer.dailyMetricTimeSeries || [])) {
      const metric = inner.dailyMetric;
      for (const dv of ((inner.timeSeries && inner.timeSeries.datedValues) || [])) {
        const d = dv.date;
        const dateStr = d ? `${d.year}-${String(d.month).padStart(2,'0')}-${String(d.day).padStart(2,'0')}` : null;
        if (dateStr) results.push({ date: dateStr, metric, value: parseInt(dv.value) || 0 });
      }
    }
  }
  return results;
}

// ── Live adapter factory ──────────────────────────────────────────────────────

function createLiveAdapter({ clientId, clientSecret, redirectUri }) {
  const AUTH_URL   = 'https://accounts.google.com/o/oauth2/v2/auth';
  const TOKEN_URL  = 'https://oauth2.googleapis.com/token';
  const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
  const USERINFO   = 'https://openidconnect.googleapis.com/v1/userinfo';
  const ACCOUNTS   = 'https://mybusinessaccountmanagement.googleapis.com/v1/accounts';
  const BIZ_BASE   = 'https://mybusinessbusinessinformation.googleapis.com/v1';
  const REVIEWS_BASE = 'https://mybusiness.googleapis.com/v4';
  const PERF_BASE  = 'https://businessprofileperformance.googleapis.com/v1';

  return {
    mode: 'live',

    getAuthUrl(state) {
      const params = new URLSearchParams({
        client_id:     clientId,
        redirect_uri:  redirectUri,
        response_type: 'code',
        scope:         'openid email https://www.googleapis.com/auth/business.manage',
        access_type:   'offline',
        prompt:        'consent',
        include_granted_scopes: 'true',
        state,
      });
      return `${AUTH_URL}?${params}`;
    },

    async exchangeCode(code) {
      const body = new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' });
      const res  = await fetchWithRetry(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
      const data = await res.json();
      // Get user email
      const uiRes   = await fetchWithRetry(USERINFO, { headers: { 'Authorization': 'Bearer ' + data.access_token } });
      const uiData  = await uiRes.json();
      return {
        accessToken:  data.access_token,
        refreshToken: data.refresh_token || null,
        expiresAt:    Date.now() + (parseInt(data.expires_in) || 3600) * 1000,
        email:        uiData.email || null,
      };
    },

    async refreshAccessToken(refreshToken) {
      const body = new URLSearchParams({ refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token' });
      const res  = await fetchWithRetry(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
      const data = await res.json();
      return {
        accessToken: data.access_token,
        expiresAt:   Date.now() + (parseInt(data.expires_in) || 3600) * 1000,
      };
    },

    async revoke(token) {
      try {
        await fetchWithRetry(REVOKE_URL + '?token=' + encodeURIComponent(token), { method: 'POST' });
      } catch (_) { /* best effort */ }
    },

    async listAccounts(accessToken) {
      const res  = await fetchWithRetry(ACCOUNTS, { headers: authHeader(accessToken) });
      const data = await res.json();
      return (data.accounts || []).map(a => ({ name: a.name, accountName: a.accountName || a.name }));
    },

    async listLocations(accessToken, accountName) {
      const url  = `${BIZ_BASE}/${accountName}/locations?readMask=name,title,storefrontAddress,metadata`;
      const res  = await fetchWithRetry(url, { headers: authHeader(accessToken) });
      const data = await res.json();
      return (data.locations || []).map(l => ({
        name:    l.name,
        title:   l.title || null,
        address: l.storefrontAddress ? [l.storefrontAddress.addressLines, l.storefrontAddress.locality].flat().filter(Boolean).join(', ') : null,
        mapsUri: l.metadata && l.metadata.mapsUri || null,
      }));
    },

    async getLocation(accessToken, locationName) {
      const mask = 'name,title,categories,phoneNumbers,websiteUri,regularHours,specialHours,profile,storefrontAddress,openInfo,serviceItems,metadata';
      const res  = await fetchWithRetry(`${BIZ_BASE}/${locationName}?readMask=${mask}`, { headers: authHeader(accessToken) });
      const data = await res.json();
      return normalizeLocation(data);
    },

    async listReviews(accessToken, accountName, locationName, pageToken) {
      let url = `${REVIEWS_BASE}/${accountName}/${locationName}/reviews?pageSize=50`;
      if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
      const res  = await fetchWithRetry(url, { headers: authHeader(accessToken) });
      const data = await res.json();
      return {
        reviews:          (data.reviews || []).map(normalizeReview),
        nextPageToken:    data.nextPageToken || null,
        averageRating:    data.averageRating || null,
        totalReviewCount: data.totalReviewCount || 0,
      };
    },

    async replyToReview(accessToken, reviewName, comment) {
      const url = `${REVIEWS_BASE}/${reviewName}/reply`;
      await fetchWithRetry(url, { method: 'PUT', headers: authHeader(accessToken), body: JSON.stringify({ comment }) });
    },

    async deleteReply(accessToken, reviewName) {
      const url = `${REVIEWS_BASE}/${reviewName}/reply`;
      await fetchWithRetry(url, { method: 'DELETE', headers: authHeader(accessToken) });
    },

    async createLocalPost(accessToken, accountName, locationName, post) {
      const url  = `${REVIEWS_BASE}/${accountName}/${locationName}/localPosts`;
      const body = { topicType: post.topicType || 'STANDARD', summary: post.summary };
      if (post.ctaType) body.callToAction = { actionType: post.ctaType, url: post.ctaUrl };
      if (post.title)  body.event = { title: post.title, schedule: { startDate: post.startDate, endDate: post.endDate } };
      if (post.imageUrl && post.imageUrl.startsWith('https://')) {
        body.media = [{ mediaFormat: 'PHOTO', sourceUrl: post.imageUrl }];
      }
      const res  = await fetchWithRetry(url, { method: 'POST', headers: authHeader(accessToken), body: JSON.stringify(body) });
      const data = await res.json();
      return { name: data.name };
    },

    async fetchDailyMetrics(accessToken, locationName, metrics, startDate, endDate) {
      const [sy, sm, sd] = startDate.split('-').map(Number);
      const [ey, em, ed] = endDate.split('-').map(Number);
      const body = {
        dailyMetrics: metrics,
        dailyRange: {
          startDate: { year: sy, month: sm, day: sd },
          endDate:   { year: ey, month: em, day: ed },
        },
      };
      const url  = `${PERF_BASE}/${locationName}:fetchMultiDailyMetricsTimeSeries`;
      const res  = await fetchWithRetry(url, { method: 'POST', headers: authHeader(accessToken), body: JSON.stringify(body) });
      const data = await res.json();
      return normalizeMetrics(data, locationName);
    },
  };
}

module.exports = { createLiveAdapter, parseStars, normalizeReview, normalizeLocation };
