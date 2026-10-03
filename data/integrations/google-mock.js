'use strict';
// Demo adapter for local development: same interface and output shapes as the live adapter, fabricated data only.
// In-memory state resets on restart.

const { normalizeLocation, summarizeLocation, buildLocalPost } = require('./google');

const MOCK_ACCOUNT     = 'accounts/demo-account-001';
const REVIEW_PAGE_SIZE = 5;
const DAY_MS           = 24 * 60 * 60 * 1000;

// Raw Business Information API shapes. The café deliberately lacks a website, description,
// holiday hours and services so the profile audit has findings.
const RAW_LOCATIONS = [
  {
    name:              'locations/demo-loc-cafe-001',
    title:             'Demo Café (Mock)',
    categories:        { primaryCategory: { displayName: 'Cafe' }, additionalCategories: [] },
    phoneNumbers:      { primaryPhone: '+91 98765 43210' },
    regularHours:      { periods: [{ openDay: 'MONDAY', openTime: { hours: 8 }, closeDay: 'MONDAY', closeTime: { hours: 22 } }] },
    storefrontAddress: { addressLines: ['12, Demo Street'], locality: 'Bengaluru', administrativeArea: 'Karnataka' },
    openInfo:          { status: 'OPEN' },
    metadata:          { mapsUri: 'https://maps.google.com/?q=demo' },
  },
  {
    name:              'locations/demo-loc-hotel-001',
    title:             'Demo Hotel (Mock)',
    categories:        { primaryCategory: { displayName: 'Hotel' }, additionalCategories: [] },
    phoneNumbers:      { primaryPhone: '+91 98765 43211' },
    websiteUri:        'https://example.com/demo-hotel',
    regularHours:      { periods: [{ openDay: 'MONDAY', openTime: { hours: 0 }, closeDay: 'MONDAY', closeTime: { hours: 23, minutes: 59 } }] },
    profile:           { description: 'Demo hotel for local development. Not a real business.' },
    storefrontAddress: { addressLines: ['45, Sample Road'], locality: 'Chennai', administrativeArea: 'Tamil Nadu' },
    openInfo:          { status: 'OPEN' },
    metadata:          { mapsUri: 'https://maps.google.com/?q=demoh' },
  },
];

const REVIEW_FIXTURES = [
  { id: 'rev001', reviewer_name: 'Demo Reviewer A', star_rating: 5, create_time: '2026-09-28T10:00:00Z',
    comment: 'Amazing coffee! The cold brew is perfect. Staff very friendly.' },
  { id: 'rev002', reviewer_name: 'Demo Reviewer B', star_rating: 4, create_time: '2026-09-25T14:30:00Z',
    comment: 'Thoda waiting time tha but food ekdum mast tha! Definitely coming back.' },
  { id: 'rev003', reviewer_name: 'Demo Reviewer C', star_rating: 2, create_time: '2026-09-22T19:00:00Z',
    comment: 'Service was very slow. Waited 45 minutes for simple pasta. Not acceptable.' },
  { id: 'rev004', reviewer_name: 'Demo Reviewer D', star_rating: 1, create_time: '2026-09-20T12:00:00Z',
    comment: 'बहुत बुरा अनुभव रहा। खाना ठंडा था और स्टाफ का व्यवहार रूखा था। दोबारा नहीं आऊँगा।' },
  { id: 'rev005', reviewer_name: 'Demo Reviewer E', star_rating: 5, create_time: '2026-09-18T09:00:00Z',
    comment: 'Best place to work from! Fast WiFi, great ambience, reasonable prices.',
    reply_text: 'Thank you so much! We are glad you enjoyed working from our café.', reply_time: '2026-09-18T11:00:00Z' },
  { id: 'rev006', reviewer_name: 'Demo Reviewer F', star_rating: 3, create_time: '2026-09-15T16:00:00Z',
    comment: 'Average experience. Food was okay but nothing special. Might try again.' },
  { id: 'rev007', reviewer_name: 'Demo Reviewer G', star_rating: 2, create_time: '2026-09-10T08:00:00Z',
    comment: 'Room was noisy due to street traffic. Check-in process was slow. Breakfast was decent.' },
  { id: 'rev008', reviewer_name: 'Demo Reviewer H', star_rating: 4, create_time: '2026-09-05T11:00:00Z',
    comment: null },
];

const DEFAULT_METRICS = ['BUSINESS_IMPRESSIONS_MOBILE_MAPS', 'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
  'CALL_CLICKS', 'WEBSITE_CLICKS', 'BUSINESS_DIRECTION_REQUESTS'];
const METRIC_BASE = { BUSINESS_IMPRESSIONS_MOBILE_MAPS: 120, BUSINESS_IMPRESSIONS_DESKTOP_MAPS: 60,
  CALL_CLICKS: 8, WEBSITE_CLICKS: 15, BUSINESS_DIRECTION_REQUESTS: 10 };

let reviewsByLocation = new Map();
let posts = [];

function notFound(message) {
  return Object.assign(new Error(message), { code: 'NOT_FOUND', status: 404 });
}

function rawLocation(locationName) {
  const raw = RAW_LOCATIONS.find(l => l.name === locationName);
  if (!raw) throw notFound('Location not found');
  return raw;
}

function reviewsFor(locationName) {
  rawLocation(locationName);
  if (!reviewsByLocation.has(locationName)) {
    reviewsByLocation.set(locationName, REVIEW_FIXTURES.map(f => ({
      review_name:    `${MOCK_ACCOUNT}/${locationName}/reviews/${f.id}`,
      reviewer_name:  f.reviewer_name,
      reviewer_photo: null,
      star_rating:    f.star_rating,
      comment:        f.comment,
      create_time:    f.create_time,
      update_time:    f.create_time,
      reply_text:     f.reply_text || null,
      reply_time:     f.reply_time || null,
    })));
  }
  return reviewsByLocation.get(locationName);
}

function findReview(reviewName) {
  for (const list of reviewsByLocation.values()) {
    const review = list.find(r => r.review_name === reviewName);
    if (review) return review;
  }
  throw notFound('Review not found');
}

function utcDay(dateStr) {
  return Date.parse(dateStr + 'T00:00:00Z');
}

function mockMetrics(metrics, startDate, endDate) {
  const list  = metrics && metrics.length ? metrics : DEFAULT_METRICS;
  const end   = endDate ? utcDay(endDate) : utcDay(new Date().toISOString().slice(0, 10));
  const start = startDate ? utcDay(startDate) : end - 27 * DAY_MS;
  const rows = [];
  for (let t = start; t <= end; t += DAY_MS) {
    const date = new Date(t).toISOString().slice(0, 10);
    for (const metric of list) {
      const salt = DEFAULT_METRICS.indexOf(metric) + 1 || metric.length;
      const base = METRIC_BASE[metric] || 10;
      rows.push({ date, metric, value: Math.max(0, Math.round(base * (0.7 + 0.6 * Math.sin((t / DAY_MS) * 0.4 + salt)))) });
    }
  }
  return rows;
}

function createMockAdapter() {
  return {
    mode: 'mock',

    getAuthUrl(state) {
      return `/api/google/oauth/callback?code=mock_code_12345&state=${encodeURIComponent(state)}`;
    },

    async exchangeCode() {
      return { accessToken: 'mock_access_token', refreshToken: 'mock_refresh_token', expiresAt: Date.now() + 3600 * 1000, email: 'demo@example.com' };
    },

    async refreshAccessToken() {
      return { accessToken: 'mock_access_token_refreshed', expiresAt: Date.now() + 3600 * 1000 };
    },

    async revoke() {},

    async listAccounts() {
      return [{ name: MOCK_ACCOUNT, accountName: 'Demo Business Account' }];
    },

    async listLocations(_at, accountName) {
      return accountName === MOCK_ACCOUNT ? RAW_LOCATIONS.map(summarizeLocation) : [];
    },

    async getLocation(_at, locationName) {
      return normalizeLocation(rawLocation(locationName));
    },

    async listReviews(_at, _account, locationName, pageToken) {
      const all    = reviewsFor(locationName);
      const offset = parseInt(pageToken, 10) || 0;
      const next   = offset + REVIEW_PAGE_SIZE < all.length ? String(offset + REVIEW_PAGE_SIZE) : null;
      const avg    = all.reduce((s, r) => s + r.star_rating, 0) / all.length;
      return {
        reviews:          all.slice(offset, offset + REVIEW_PAGE_SIZE).map(r => ({ ...r })),
        nextPageToken:    next,
        averageRating:    Math.round(avg * 10) / 10,
        totalReviewCount: all.length,
      };
    },

    async replyToReview(_at, reviewName, comment) {
      const review = findReview(reviewName);
      review.reply_text = comment;
      review.reply_time = new Date().toISOString();
    },

    async deleteReply(_at, reviewName) {
      const review = findReview(reviewName);
      review.reply_text = null;
      review.reply_time = null;
    },

    async createLocalPost(_at, accountName, locationName, post) {
      rawLocation(locationName);
      const body = buildLocalPost(post);
      const name = `${accountName}/${locationName}/localPosts/mock_${posts.length + 1}`;
      posts.push({ name, ...body });
      return { name };
    },

    async fetchDailyMetrics(_at, locationName, metrics, startDate, endDate) {
      rawLocation(locationName);
      return mockMetrics(metrics, startDate, endDate);
    },

    // Test helpers (local verification only)
    _addReview(locationName, fields = {}) {
      const list = reviewsFor(locationName);
      const now  = new Date().toISOString();
      const review = {
        review_name: `${MOCK_ACCOUNT}/${locationName}/reviews/added_${list.length + 1}`,
        reviewer_name: 'Demo Reviewer New', reviewer_photo: null, star_rating: 1, comment: null,
        create_time: now, update_time: now, reply_text: null, reply_time: null,
        ...fields,
      };
      list.unshift(review);
      return { ...review };
    },
    _getMockPosts() { return posts.map(p => ({ ...p })); },
    _resetState()   { reviewsByLocation = new Map(); posts = []; },
  };
}

module.exports = { createMockAdapter };
