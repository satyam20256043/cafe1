'use strict';
// Live Google Business Profile adapter — the only file that knows Google URLs.
// Errors are { code: 'AUTH'|'PERMISSION'|'NOT_FOUND'|'RATE_LIMIT'|'UPSTREAM'|'BAD_REQUEST', status, message }; AUTH means "reconnect".

const STAR_MAP = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
const MAX_RETRIES = 3;
const BACKOFF_MS = [1000, 3000, 9000];
const MAX_PAGES = 50;

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

function classify(status, body) {
  const oauthError = body && typeof body.error === 'string' ? body.error : null;
  // A bad client id/secret is our misconfiguration; asking every owner to reconnect would not fix it.
  if (oauthError === 'invalid_client' || oauthError === 'unauthorized_client') return 'BAD_REQUEST';
  if (status === 401 || oauthError === 'invalid_grant') return 'AUTH';
  if (status === 403) return 'PERMISSION';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMIT';
  if (status >= 400 && status < 500) return 'BAD_REQUEST';
  return 'UPSTREAM';
}

function errorMessage(status, body) {
  if (body && body.error && typeof body.error === 'object' && body.error.message) return body.error.message;
  if (body && typeof body.error_description === 'string') return body.error_description;
  if (body && typeof body.error === 'string') return body.error;
  return 'HTTP ' + status;
}

function logPath(url) {
  try { const u = new URL(url); return u.origin + u.pathname; } catch (_) { return '(invalid url)'; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function backoff(attempt, res) {
  const retryAfter = res ? parseInt(res.headers.get('Retry-After'), 10) : NaN;
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(retryAfter * 1000, 30000);
  return BACKOFF_MS[attempt] + Math.floor(Math.random() * 400);
}

async function attemptOnce(url, { method, headers, body, timeout }) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const start = Date.now();
  let outcome = 'network-error';
  try {
    const res = await fetch(url, { method, headers, body, signal: ctrl.signal });
    outcome = res.status;
    const text = await res.text();
    let data = {};
    if (text) { try { data = JSON.parse(text); } catch (_) {} }
    return { res, data };
  } catch (e) {
    outcome = e.name === 'AbortError' ? 'timeout' : 'network-error';
    return { failure: outcome === 'timeout' ? 'Request timed out' : 'Network error' };
  } finally {
    clearTimeout(timer);
    console.log(`[Google] ${method} ${logPath(url)} ${outcome} ${Date.now() - start}ms`);
  }
}

async function googleFetch(url, { method = 'GET', headers = {}, body, timeout = 15000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const { res, data, failure } = await attemptOnce(url, { method, headers, body, timeout });
    if (res && res.ok) return data;
    if (res) {
      const err = makeError(classify(res.status, data), res.status, errorMessage(res.status, data));
      if (res.status !== 429 && res.status < 500) throw err;
      lastError = err;
    } else {
      lastError = makeError('UPSTREAM', 0, failure);
    }
    if (attempt < MAX_RETRIES) await sleep(backoff(attempt, res));
  }
  throw lastError;
}

async function collectPages(fetchPage) {
  const items = [];
  let pageToken = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { list, next } = await fetchPage(pageToken);
    items.push(...list);
    if (!next) break;
    pageToken = next;
  }
  return items;
}

// ── Normalizers ───────────────────────────────────────────────────────────────

function normalizeReview(raw) {
  return {
    review_name:    raw.name,
    reviewer_name:  (raw.reviewer && raw.reviewer.displayName) || 'Anonymous',
    reviewer_photo: (raw.reviewer && raw.reviewer.profilePhotoUrl) || null,
    star_rating:    parseStars(raw.starRating),
    comment:        raw.comment || null,
    create_time:    raw.createTime || null,
    update_time:    raw.updateTime || null,
    reply_text:     (raw.reviewReply && raw.reviewReply.comment) || null,
    reply_time:     (raw.reviewReply && raw.reviewReply.updateTime) || null,
  };
}

function normalizeLocation(raw) {
  const addr = raw.storefrontAddress;
  const address = addr ? [addr.addressLines, addr.locality, addr.administrativeArea].flat().filter(Boolean).join(', ') : null;
  return {
    name:         raw.name,
    title:        raw.title || null,
    address:      address || null,
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

function summarizeLocation(raw) {
  const n = normalizeLocation(raw);
  return { name: n.name, title: n.title, address: n.address, mapsUri: n.mapsUri };
}

function normalizeMetrics(raw) {
  const results = [];
  for (const outer of raw.multiDailyMetricTimeSeries || []) {
    for (const inner of outer.dailyMetricTimeSeries || []) {
      for (const dv of (inner.timeSeries && inner.timeSeries.datedValues) || []) {
        const d = dv.date;
        if (!d) continue;
        const date = `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
        results.push({ date, metric: inner.dailyMetric, value: parseInt(dv.value, 10) || 0 });
      }
    }
  }
  return results;
}

function toDateTime(value, endOfDay) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(String(value || ''));
  if (!m) return null;
  return {
    date: { year: +m[1], month: +m[2], day: +m[3] },
    time: m[4] ? { hours: +m[4], minutes: +m[5] } : (endOfDay ? { hours: 23, minutes: 59 } : { hours: 0, minutes: 0 }),
  };
}

// post: { topicType, summary, ctaType, ctaUrl, title, startDate, endDate, couponCode, imageUrl }
function buildLocalPost(post) {
  const topicType = post.topicType || 'STANDARD';
  const body = { topicType, summary: post.summary };
  if (post.ctaType) {
    body.callToAction = { actionType: post.ctaType };
    if (post.ctaType !== 'CALL' && post.ctaUrl) body.callToAction.url = post.ctaUrl;
  }
  if (topicType === 'EVENT' || topicType === 'OFFER') {
    const start = toDateTime(post.startDate, false);
    const end   = toDateTime(post.endDate, true);
    if (!post.title || !start || !end) throw makeError('BAD_REQUEST', 0, `${topicType} posts need a title, a start date and an end date`);
    // Google rejects a TimeInterval unless all four fields are set.
    body.event = { title: post.title, schedule: { startDate: start.date, startTime: start.time, endDate: end.date, endTime: end.time } };
  }
  if (topicType === 'OFFER') body.offer = post.couponCode ? { couponCode: post.couponCode } : {};
  if (post.imageUrl && /^https:\/\//.test(post.imageUrl)) body.media = [{ mediaFormat: 'PHOTO', sourceUrl: post.imageUrl }];
  return body;
}

// ── Live adapter factory ──────────────────────────────────────────────────────

function createLiveAdapter({ clientId, clientSecret, redirectUri }) {
  const AUTH_URL     = 'https://accounts.google.com/o/oauth2/v2/auth';
  const TOKEN_URL    = 'https://oauth2.googleapis.com/token';
  const REVOKE_URL   = 'https://oauth2.googleapis.com/revoke';
  const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
  const ACCOUNTS_URL = 'https://mybusinessaccountmanagement.googleapis.com/v1/accounts';
  const BIZ_BASE     = 'https://mybusinessbusinessinformation.googleapis.com/v1';
  const V4_BASE      = 'https://mybusiness.googleapis.com/v4';
  const PERF_BASE    = 'https://businessprofileperformance.googleapis.com/v1';
  const FORM         = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const bearer       = at => ({ Authorization: 'Bearer ' + at });
  const bearerJson   = at => ({ Authorization: 'Bearer ' + at, 'Content-Type': 'application/json' });

  return {
    mode: 'live',

    getAuthUrl(state) {
      const params = new URLSearchParams({
        client_id:              clientId,
        redirect_uri:           redirectUri,
        response_type:          'code',
        scope:                  'openid email https://www.googleapis.com/auth/business.manage',
        access_type:            'offline',
        prompt:                 'consent',
        include_granted_scopes: 'true',
        state,
      });
      return `${AUTH_URL}?${params}`;
    },

    async exchangeCode(code) {
      const data = await googleFetch(TOKEN_URL, { method: 'POST', headers: FORM, body: new URLSearchParams({
        code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code',
      }).toString() });
      const user = await googleFetch(USERINFO_URL, { headers: bearer(data.access_token) });
      return {
        accessToken:  data.access_token,
        refreshToken: data.refresh_token || null,
        expiresAt:    Date.now() + (parseInt(data.expires_in, 10) || 3600) * 1000,
        email:        user.email || null,
      };
    },

    async refreshAccessToken(refreshToken) {
      const data = await googleFetch(TOKEN_URL, { method: 'POST', headers: FORM, body: new URLSearchParams({
        refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token',
      }).toString() });
      return { accessToken: data.access_token, expiresAt: Date.now() + (parseInt(data.expires_in, 10) || 3600) * 1000 };
    },

    async revoke(token) {
      try {
        await googleFetch(REVOKE_URL, { method: 'POST', headers: FORM, body: new URLSearchParams({ token }).toString() });
      } catch (_) { /* best effort */ }
    },

    async listAccounts(accessToken) {
      return collectPages(async pageToken => {
        const qs = new URLSearchParams({ pageSize: '20' });
        if (pageToken) qs.set('pageToken', pageToken);
        const data = await googleFetch(`${ACCOUNTS_URL}?${qs}`, { headers: bearer(accessToken) });
        return { list: (data.accounts || []).map(a => ({ name: a.name, accountName: a.accountName || a.name })), next: data.nextPageToken };
      });
    },

    async listLocations(accessToken, accountName) {
      return collectPages(async pageToken => {
        const qs = new URLSearchParams({ readMask: 'name,title,storefrontAddress,metadata', pageSize: '100' });
        if (pageToken) qs.set('pageToken', pageToken);
        const data = await googleFetch(`${BIZ_BASE}/${accountName}/locations?${qs}`, { headers: bearer(accessToken) });
        return { list: (data.locations || []).map(summarizeLocation), next: data.nextPageToken };
      });
    },

    async getLocation(accessToken, locationName) {
      const readMask = 'name,title,categories,phoneNumbers,websiteUri,regularHours,specialHours,profile,storefrontAddress,openInfo,serviceItems,metadata';
      const data = await googleFetch(`${BIZ_BASE}/${locationName}?${new URLSearchParams({ readMask })}`, { headers: bearer(accessToken) });
      return normalizeLocation(data);
    },

    async listReviews(accessToken, accountName, locationName, pageToken) {
      const qs = new URLSearchParams({ pageSize: '50' });
      if (pageToken) qs.set('pageToken', pageToken);
      const data = await googleFetch(`${V4_BASE}/${accountName}/${locationName}/reviews?${qs}`, { headers: bearer(accessToken) });
      return {
        reviews:          (data.reviews || []).map(normalizeReview),
        nextPageToken:    data.nextPageToken || null,
        averageRating:    data.averageRating || null,
        totalReviewCount: data.totalReviewCount || 0,
      };
    },

    async replyToReview(accessToken, reviewName, comment) {
      await googleFetch(`${V4_BASE}/${reviewName}/reply`, { method: 'PUT', headers: bearerJson(accessToken), body: JSON.stringify({ comment }) });
    },

    async deleteReply(accessToken, reviewName) {
      await googleFetch(`${V4_BASE}/${reviewName}/reply`, { method: 'DELETE', headers: bearer(accessToken) });
    },

    async createLocalPost(accessToken, accountName, locationName, post) {
      const data = await googleFetch(`${V4_BASE}/${accountName}/${locationName}/localPosts`, {
        method: 'POST', headers: bearerJson(accessToken), body: JSON.stringify(buildLocalPost(post)),
      });
      return { name: data.name };
    },

    async fetchDailyMetrics(accessToken, locationName, metrics, startDate, endDate) {
      const [sy, sm, sd] = startDate.split('-').map(Number);
      const [ey, em, ed] = endDate.split('-').map(Number);
      const qs = new URLSearchParams();
      for (const m of metrics) qs.append('dailyMetrics', m);
      qs.set('dailyRange.start_date.year', sy);
      qs.set('dailyRange.start_date.month', sm);
      qs.set('dailyRange.start_date.day', sd);
      qs.set('dailyRange.end_date.year', ey);
      qs.set('dailyRange.end_date.month', em);
      qs.set('dailyRange.end_date.day', ed);
      const data = await googleFetch(`${PERF_BASE}/${locationName}:fetchMultiDailyMetricsTimeSeries?${qs}`, { headers: bearer(accessToken) });
      return normalizeMetrics(data);
    },
  };
}

module.exports = { createLiveAdapter, parseStars, normalizeReview, normalizeLocation, summarizeLocation, buildLocalPost };
