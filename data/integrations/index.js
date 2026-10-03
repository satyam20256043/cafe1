'use strict';
// Picks the Google adapter once per process: mock, live, or null (Google features report "not configured").

const { createLiveAdapter } = require('./google');
const { createMockAdapter } = require('./google-mock');
const secrets = require('../secrets');

const PRODUCTION_HOSTS = ['zordical.com', 'zordical.in', 'zordic.in'];

function isProduction() {
  if (process.env.NODE_ENV === 'production') return true;
  let host = '';
  try { host = new URL(process.env.BASE_URL || '').hostname.toLowerCase(); } catch (_) {}
  return PRODUCTION_HOSTS.some(h => host === h || host.endsWith('.' + h));
}

function selectAdapter() {
  const mode = (process.env.GOOGLE_MODE || '').trim().toLowerCase();
  if (!mode) return { reason: 'GOOGLE_MODE is not set' };
  if (mode === 'mock' && isProduction()) return { reason: 'GOOGLE_MODE=mock is not allowed in production', loud: true };
  if (mode !== 'mock' && mode !== 'live') return { reason: `unknown GOOGLE_MODE "${mode}"`, loud: true };
  if (!secrets.isConfigured()) return { reason: 'TOKEN_ENCRYPTION_KEY must be 64 hex characters', loud: true };
  if (mode === 'mock') return { adapter: createMockAdapter() };

  const missing = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'].filter(k => !process.env[k]);
  if (missing.length) return { reason: `missing ${missing.join(', ')}`, loud: true };
  return { adapter: createLiveAdapter({
    clientId:     process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri:  process.env.GOOGLE_REDIRECT_URI,
  }) };
}

let _adapter; // undefined until first selection

function getGoogleAdapter() {
  if (_adapter !== undefined) return _adapter;
  const { adapter, reason, loud } = selectAdapter();
  if (adapter) console.log(`[Google] adapter=${adapter.mode}${adapter.mode === 'mock' ? ' (demo data, no real API calls)' : ''}`);
  else (loud ? console.error : console.log)(`[Google] disabled: ${reason}`);
  _adapter = adapter || null;
  return _adapter;
}

function _resetAdapter() { _adapter = undefined; }

module.exports = { getGoogleAdapter, isProduction, _resetAdapter };
