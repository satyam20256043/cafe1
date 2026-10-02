'use strict';
/**
 * google-mock.js — Demo Google Business Profile adapter for local development (GB3).
 *
 * Implements the same interface as the live adapter. All data is fabricated and
 * clearly labelled as demo data in the UI (the index.js getGoogleAdapter() sets
 * adapter.mode = 'mock').
 *
 * replyToReview() and createLocalPost() mutate in-memory state so the UI
 * round-trips correctly during a local dev session. State resets on server restart.
 *
 * Reviewer names are obviously fake (e.g. "Demo Reviewer A").
 * Never use real names, real review text, or real metrics.
 */

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MOCK_ACCOUNT   = 'accounts/demo-account-001';
const MOCK_LOCATION1 = 'locations/demo-loc-cafe-001';
const MOCK_LOCATION2 = 'locations/demo-loc-hotel-001';

const MOCK_ACCOUNTS = [
  { name: MOCK_ACCOUNT, accountName: 'Demo Business Account' },
];

const MOCK_LOCATIONS = [
  { name: MOCK_LOCATION1, title: 'Demo Café (Mock)', address: '12, Demo Street, Bengaluru', mapsUri: 'https://maps.google.com/?q=demo' },
  { name: MOCK_LOCATION2, title: 'Demo Hotel (Mock)', address: '45, Sample Road, Chennai',  mapsUri: 'https://maps.google.com/?q=demoh' },
];

const MOCK_LOCATION_DETAIL = {
  name:         MOCK_LOCATION1,
  title:        'Demo Café (Mock)',
  categories:   { primaryCategory: { displayName: 'Cafe' }, additionalCategories: [] },
  phoneNumbers: { primaryPhone: '+91 98765 43210' },
  websiteUri:   null, // intentionally missing to generate an audit finding
  regularHours: { periods: [{ openDay: 'MONDAY', openTime: { hours: 8 }, closeDay: 'MONDAY', closeTime: { hours: 22 } }] },
  specialHours: null, // intentionally missing
  profile:      { description: null }, // intentionally short/missing → audit finding
  openInfo:     { status: 'OPEN' },
  serviceItems: null, // intentionally missing → audit finding
  storefrontAddress: { addressLines: ['12, Demo Street'], locality: 'Bengaluru', administrativeArea: 'Karnataka' },
  mapsUri:      'https://maps.google.com/?q=demo',
};

// In-memory mutable reviews (replyToReview mutates these)
const MOCK_REVIEWS_INITIAL = [
  {
    review_name:   `${MOCK_ACCOUNT}/${MOCK_LOCATION1}/reviews/rev001`,
    reviewer_name: 'Demo Reviewer A',
    reviewer_photo: null,
    star_rating:   5,
    comment:       'Amazing coffee! The cold brew is perfect. Staff very friendly.',
    create_time:   '2026-09-28T10:00:00Z',
    update_time:   '2026-09-28T10:00:00Z',
    reply_text:    null,
    reply_time:    null,
  },
  {
    review_name:   `${MOCK_ACCOUNT}/${MOCK_LOCATION1}/reviews/rev002`,
    reviewer_name: 'Demo Reviewer B',
    reviewer_photo: null,
    star_rating:   4,
    comment:       'Thoda waiting time tha but food ekdum mast tha! Definitely coming back.',
    create_time:   '2026-09-25T14:30:00Z',
    update_time:   '2026-09-25T14:30:00Z',
    reply_text:    null,
    reply_time:    null,
  },
  {
    review_name:   `${MOCK_ACCOUNT}/${MOCK_LOCATION1}/reviews/rev003`,
    reviewer_name: 'Demo Reviewer C',
    reviewer_photo: null,
    star_rating:   2,
    comment:       'Service was very slow. Waited 45 minutes for simple pasta. Not acceptable.',
    create_time:   '2026-09-22T19:00:00Z',
    update_time:   '2026-09-22T19:00:00Z',
    reply_text:    null,
    reply_time:    null,
  },
  {
    review_name:   `${MOCK_ACCOUNT}/${MOCK_LOCATION1}/reviews/rev004`,
    reviewer_name: 'Demo Reviewer D',
    reviewer_photo: null,
    star_rating:   1,
    comment:       'Bahut bura anubhav raha. Food anda tha aur staff rude tha. Wapas nahi aaunga.',
    create_time:   '2026-09-20T12:00:00Z',
    update_time:   '2026-09-20T12:00:00Z',
    reply_text:    null,
    reply_time:    null,
  },
  {
    review_name:   `${MOCK_ACCOUNT}/${MOCK_LOCATION1}/reviews/rev005`,
    reviewer_name: 'Demo Reviewer E',
    reviewer_photo: null,
    star_rating:   5,
    comment:       'Best place to work from! Fast WiFi, great ambience, reasonable prices.',
    create_time:   '2026-09-18T09:00:00Z',
    update_time:   '2026-09-18T09:00:00Z',
    reply_text:    'Thank you so much! We are glad you enjoyed working from our café. ☕',
    reply_time:    '2026-09-18T11:00:00Z',
  },
  {
    review_name:   `${MOCK_ACCOUNT}/${MOCK_LOCATION1}/reviews/rev006`,
    reviewer_name: 'Demo Reviewer F',
    reviewer_photo: null,
    star_rating:   3,
    comment:       'Average experience. Food was okay but nothing special. Might try again.',
    create_time:   '2026-09-15T16:00:00Z',
    update_time:   '2026-09-15T16:00:00Z',
    reply_text:    null,
    reply_time:    null,
  },
  {
    // Hotel-style review
    review_name:   `${MOCK_ACCOUNT}/${MOCK_LOCATION1}/reviews/rev007`,
    reviewer_name: 'Demo Reviewer G',
    reviewer_photo: null,
    star_rating:   2,
    comment:       'Room was noisy due to street traffic. Check-in process was slow. Breakfast was decent.',
    create_time:   '2026-09-10T08:00:00Z',
    update_time:   '2026-09-10T08:00:00Z',
    reply_text:    null,
    reply_time:    null,
  },
  {
    review_name:   `${MOCK_ACCOUNT}/${MOCK_LOCATION1}/reviews/rev008`,
    reviewer_name: 'Demo Reviewer H',
    reviewer_photo: null,
    star_rating:   4,
    comment:       null, // rating-only, no text
    create_time:   '2026-09-05T11:00:00Z',
    update_time:   '2026-09-05T11:00:00Z',
    reply_text:    null,
    reply_time:    null,
  },
];

// Mutable in-memory state (resets on restart — fine for mock dev)
let mockReviews = MOCK_REVIEWS_INITIAL.map(r => ({ ...r }));
let mockPosts   = [];

// ── 28 days of deterministic metrics ─────────────────────────────────────────
function buildMockMetrics() {
  const METRICS = ['BUSINESS_IMPRESSIONS_MOBILE_MAPS','BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
    'CALL_CLICKS','WEBSITE_CLICKS','BUSINESS_DIRECTION_REQUESTS'];
  const BASE = { BUSINESS_IMPRESSIONS_MOBILE_MAPS: 120, BUSINESS_IMPRESSIONS_DESKTOP_MAPS: 60,
    CALL_CLICKS: 8, WEBSITE_CLICKS: 15, BUSINESS_DIRECTION_REQUESTS: 10 };
  const results = [];
  for (let d = 27; d >= 0; d--) {
    const date = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    for (const m of METRICS) {
      // Add slight variation so the chart looks realistic
      const v = Math.round(BASE[m] * (0.7 + 0.6 * Math.sin(d * 0.4 + METRICS.indexOf(m))));
      results.push({ date, metric: m, value: Math.max(0, v) });
    }
  }
  return results;
}

// ── Mock adapter factory ──────────────────────────────────────────────────────

function createMockAdapter() {
  return {
    mode: 'mock',

    getAuthUrl(state) {
      // Returns a URL that the mock callback can accept; never hits Google.
      return `/api/google/oauth/callback?code=mock_code_12345&state=${encodeURIComponent(state)}`;
    },

    async exchangeCode(_code) {
      return { accessToken: 'mock_access_token', refreshToken: 'mock_refresh_token', expiresAt: Date.now() + 3600 * 1000, email: 'demo@example.com' };
    },

    async refreshAccessToken(_rt) {
      return { accessToken: 'mock_access_token_refreshed', expiresAt: Date.now() + 3600 * 1000 };
    },

    async revoke(_token) { /* no-op */ },

    async listAccounts(_at) { return MOCK_ACCOUNTS; },

    async listLocations(_at, _account) { return MOCK_LOCATIONS; },

    async getLocation(_at, _loc) { return { ...MOCK_LOCATION_DETAIL }; },

    async listReviews(_at, _account, _loc, pageToken) {
      // Return all reviews on first call, empty on any subsequent pageToken
      if (pageToken) return { reviews: [], nextPageToken: null, averageRating: null, totalReviewCount: 0 };
      const avg = mockReviews.reduce((s, r) => s + r.star_rating, 0) / mockReviews.length;
      return {
        reviews:          mockReviews.map(r => ({ ...r })),
        nextPageToken:    null,
        averageRating:    Math.round(avg * 10) / 10,
        totalReviewCount: mockReviews.length,
      };
    },

    async replyToReview(_at, reviewName, comment) {
      const r = mockReviews.find(r => r.review_name === reviewName);
      if (!r) throw Object.assign(new Error('Review not found'), { code: 'NOT_FOUND', status: 404 });
      r.reply_text = comment;
      r.reply_time = new Date().toISOString();
    },

    async deleteReply(_at, reviewName) {
      const r = mockReviews.find(r => r.review_name === reviewName);
      if (!r) throw Object.assign(new Error('Review not found'), { code: 'NOT_FOUND', status: 404 });
      r.reply_text = null;
      r.reply_time = null;
    },

    async createLocalPost(_at, _account, _loc, post) {
      const name = `${MOCK_ACCOUNT}/${MOCK_LOCATION1}/localPosts/mockpost_${Date.now()}`;
      mockPosts.push({ name, ...post, createdAt: new Date().toISOString() });
      return { name };
    },

    async fetchDailyMetrics(_at, _loc, _metrics, _start, _end) {
      return buildMockMetrics();
    },

    // Test helper: add a review mid-session (to verify GB5 alert logic)
    _addReview(review) { mockReviews.push(review); },
    _getMockPosts()    { return mockPosts; },
    _resetState()      { mockReviews = MOCK_REVIEWS_INITIAL.map(r => ({ ...r })); mockPosts = []; },
  };
}

module.exports = { createMockAdapter };
