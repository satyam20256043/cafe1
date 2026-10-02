'use strict';
/**
 * integrations/index.js — adapter selector for Google Business Profile (GB3).
 *
 * getGoogleAdapter() returns one of:
 *   - mock adapter  : GOOGLE_MODE=mock or GOOGLE_MODE unset in non-production
 *   - live adapter  : GOOGLE_MODE=live with all three GCP env vars present
 *   - null          : GOOGLE_MODE=live but vars missing (server boots, feature disabled)
 *
 * Production guard (S7): BASE_URL starting with 'https://zordical.' or 'https://zordic.'
 * will NEVER serve the mock adapter — the process exits immediately so we cannot
 * accidentally serve fabricated data to real customers.
 */

const { createLiveAdapter } = require('./google');
const { createMockAdapter }  = require('./google-mock');

// Cached instance (built once, reused per process lifetime)
let _adapter = undefined;

function getGoogleAdapter() {
  if (_adapter !== undefined) return _adapter;

  const base = (process.env.BASE_URL || '').toLowerCase();
  const isProduction = base.startsWith('https://zordical.') || base.startsWith('https://zordic.');
  const mode = (process.env.GOOGLE_MODE || '').toLowerCase();

  // S7: mock is impossible in production
  if (isProduction && mode === 'mock') {
    console.error('[Google] FATAL: GOOGLE_MODE=mock is not allowed in production (BASE_URL=%s). Exiting.', process.env.BASE_URL);
    process.exit(1);
  }

  if (mode === 'mock' || (!isProduction && mode !== 'live')) {
    const adapter = createMockAdapter();
    console.log('[Google] adapter=mock (demo data, no real API calls)');
    _adapter = adapter;
    return _adapter;
  }

  // live mode
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri  = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    console.warn('[Google] adapter=null — GOOGLE_MODE=live but GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI not set; GBP features disabled');
    _adapter = null;
    return null;
  }

  const adapter = createLiveAdapter({ clientId, clientSecret, redirectUri });
  console.log('[Google] adapter=live');
  _adapter = adapter;
  return _adapter;
}

// Allow tests to reset between runs
function _resetAdapter() { _adapter = undefined; }

module.exports = { getGoogleAdapter, _resetAdapter };
