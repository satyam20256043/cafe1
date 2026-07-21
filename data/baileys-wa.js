'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// baileys-wa.js — per-branch WhatsApp-Web client manager (QR-scan linking),
// built on @whiskeysockets/baileys instead of whatsapp-web.js.
//
// Same job as data/waweb.js, same exported interface, so server.js /
// data/routes/wa-qr.js / the manager Settings UI need zero changes — only the
// require() picking which module to load differs. Baileys talks WhatsApp's
// multi-device WebSocket protocol directly (no Puppeteer/Chromium), so QR
// generation and post-scan connect are both near-instant instead of
// browser-boot-bound. See docs/ZORDIC_IMPROVEMENTS_ROADMAP.md-adjacent notes
// for why this exists: whatsapp-web.js's Chromium overhead was the real
// bottleneck, not server RAM.
//
// Session data is NOT compatible with .wwebjs_auth/ — a café moving from the
// old backend to this one needs one fresh QR scan. Never log or persist
// anything from .baileys_auth/ — it holds live session keys.
// ─────────────────────────────────────────────────────────────────────────────

const path = require('path');
const fs = require('fs');

let makeWASocket, useMultiFileAuthState, DisconnectReason, Boom;
try {
  const _baileys = require('@whiskeysockets/baileys');
  // Defensive: handle either a callable default export or a `.default` key,
  // since CJS interop shape for ESM-authored packages isn't always the same.
  makeWASocket = typeof _baileys === 'function' ? _baileys : _baileys.default;
  ({ useMultiFileAuthState, DisconnectReason } = _baileys);
  ({ Boom } = require('@hapi/boom'));
  if (typeof makeWASocket !== 'function') throw new Error('makeWASocket export not found');
} catch (e) {
  console.warn('[WA QR/Baileys] @whiskeysockets/baileys not installed — Baileys QR backend disabled:', e.message);
}

// Respect an explicit 0 (kill-switch: refuse all QR links) — `|| 2` would not.
const _maxEnv = parseInt(process.env.WA_QR_MAX_CLIENTS, 10);
const MAX_CLIENTS = Number.isNaN(_maxEnv) ? 2 : _maxEnv;

// Session auth data lives beside the code (gitignored), same convention as
// .wwebjs_auth/ — kept OUT of data/<id>/ so tenant purges/backups never touch
// live WhatsApp credentials.
const AUTH_DIR = path.join(__dirname, '..', '.baileys_auth');

// branchId -> { sock, state, number, qrDataUrl, startedAt }
const clients = {};

function activeCount() {
  return Object.keys(clients).length;
}

function getStatus(branchId) {
  const c = clients[branchId];
  if (!c) return { state: 'disconnected', number: null, qrDataUrl: null };
  return { state: c.state, number: c.number || null, qrDataUrl: c.qrDataUrl || null };
}

// Baileys wants a pino-shaped logger; a silent stub avoids pulling in pino
// directly while keeping pm2 logs free of Baileys' internal debug chatter.
function silentLogger() {
  const noop = () => {};
  const l = { trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop };
  l.child = () => l;
  return l;
}

function describeDisconnect(statusCode) {
  if (!DisconnectReason || statusCode == null) return statusCode ? `disconnected_${statusCode}` : 'unknown';
  const names = {
    [DisconnectReason.loggedOut]: 'logged_out',
    [DisconnectReason.connectionClosed]: 'connection_closed',
    [DisconnectReason.connectionLost]: 'connection_lost',
    [DisconnectReason.connectionReplaced]: 'connection_replaced',
    [DisconnectReason.restartRequired]: 'restart_required',
    [DisconnectReason.timedOut]: 'timed_out',
    [DisconnectReason.badSession]: 'bad_session',
  };
  return names[statusCode] || `disconnected_${statusCode}`;
}

// Starts (or returns the existing) client for a branch. Callbacks:
//   onQr(qrDataUrl)          — a fresh QR is ready to display
//   onReady({ number })      — linked & authenticated
//   onDisconnected(reason)   — session dropped (logout on the phone, ban, etc.)
//   onMessage({ from, body }) — inbound customer text (already filtered)
// Returns { success, error?, alreadyRunning? } SYNCHRONOUSLY — the actual
// Baileys handshake happens in a detached async block, mirroring waweb.js's
// client.initialize().catch(...) pattern so callers never need to await this.
function startClient(branchId, { onQr, onReady, onDisconnected, onMessage } = {}) {
  if (!makeWASocket) return { success: false, error: 'WhatsApp QR module not available on this server' };
  if (clients[branchId]) return { success: true, alreadyRunning: true };
  if (activeCount() >= MAX_CLIENTS) {
    return { success: false, error: `Server is at its QR-connection limit (${MAX_CLIENTS}). Disconnect another café or use the Business API.` };
  }

  const rec = { sock: null, state: 'connecting', number: null, qrDataUrl: null, startedAt: Date.now(), reconnectAttempts: 0 };
  clients[branchId] = rec;

  // WhatsApp's multi-device pairing handshake routinely closes and reopens the
  // socket once or twice before settling — Baileys' own docs treat any
  // non-logout close as "reconnect", not "failed". Skipping that (as the old
  // whatsapp-web.js module's deliberate no-auto-retry design would suggest)
  // leaves a freshly-scanned session stranded mid-handshake. Bounded so a
  // genuinely broken connection still gives up and reports disconnected.
  const MAX_RECONNECT_ATTEMPTS = 5;

  async function connectSocket() {
    const sessionDir = path.join(AUTH_DIR, branchId);
    fs.mkdirSync(sessionDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    const sock = makeWASocket({ auth: state, logger: silentLogger() });
    rec.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        rec.state = 'qr_pending';
        require('qrcode').toDataURL(qr, { width: 280, margin: 1 })
          .then((dataUrl) => { rec.qrDataUrl = dataUrl; if (onQr) onQr(dataUrl); })
          .catch((e) => console.error('[WA QR/Baileys] QR render failed for', branchId, e.message));
      }

      if (connection === 'open') {
        rec.state = 'connected';
        rec.qrDataUrl = null;
        rec.reconnectAttempts = 0;
        try {
          const raw = sock.user && sock.user.id ? String(sock.user.id) : '';
          rec.number = raw ? raw.split(/[:@]/)[0] : null;
        } catch (e) { rec.number = null; }
        if (onReady) onReady({ number: rec.number });
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect && lastDisconnect.error instanceof Boom)
          ? lastDisconnect.error.output?.statusCode
          : undefined;
        const loggedOut = !!DisconnectReason && statusCode === DisconnectReason.loggedOut;

        if (!loggedOut && rec.reconnectAttempts < MAX_RECONNECT_ATTEMPTS && clients[branchId] === rec) {
          rec.reconnectAttempts++;
          setTimeout(() => {
            if (clients[branchId] === rec) connectSocket().catch(() => {});
          }, 800);
          return; // transient handshake close — don't tear down or report yet
        }

        rec.state = 'disconnected';
        rec.qrDataUrl = null;
        delete clients[branchId];
        if (onDisconnected) onDisconnected(loggedOut ? 'logged_out' : describeDisconnect(statusCode));
      }
    });

    if (onMessage) {
      sock.ev.on('messages.upsert', ({ messages, type }) => {
        // 'notify' = genuinely new real-time messages; other types are
        // history-sync replay on reconnect — skip those or every reconnect
        // would re-process old chat history as if it just arrived.
        if (type !== 'notify') return;
        for (const msg of (messages || [])) {
          try {
            if (msg.key.fromMe) continue;
            const from = msg.key.remoteJid || '';
            if (!from || from.endsWith('@g.us') || from === 'status@broadcast') continue;
            const body = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim();
            if (!body) continue; // media w/o caption, reactions, etc. → skip
            onMessage({ from, body, msg });
          } catch (e) {
            console.error('[WA QR/Baileys] inbound handler error for', branchId, e.message);
          }
        }
      });
    }
  }

  connectSocket().catch((e) => {
    console.error('[WA QR/Baileys] initialize failed for', branchId, e.message);
    rec.state = 'disconnected';
    delete clients[branchId];
    if (onDisconnected) onDisconnected('init_failed');
  });

  return { success: true };
}

// Sends a text via the branch's live client. Returns true on success.
// `phoneOrId` is either a full WhatsApp JID (used as-is, the case when
// replying to an inbound message — never rewrite it, that's how the whatsapp-
// web.js module got "No LID for user" send failures for privacy-id senders)
// or bare digits, resolved through sock.onWhatsApp().
async function sendText(branchId, phoneOrId, text) {
  const c = clients[branchId];
  if (!c || c.state !== 'connected' || !c.sock) {
    console.warn('[WA QR/Baileys] send skipped — no connected client for', branchId);
    return false;
  }
  const raw = String(phoneOrId || '');
  let jid;
  if (raw.includes('@')) {
    jid = raw; // exact id WhatsApp gave us — never rewrite it
  } else {
    const digits = raw.replace(/[^0-9]/g, '');
    const withCc = digits.length === 10 ? '91' + digits : digits; // matches app-wide 91 default
    try {
      const results = await c.sock.onWhatsApp(withCc);
      jid = (results && results[0] && results[0].exists) ? results[0].jid : `${withCc}@s.whatsapp.net`;
    } catch (e) {
      jid = `${withCc}@s.whatsapp.net`;
    }
  }
  try {
    await c.sock.sendMessage(jid, { text });
    return true;
  } catch (e) {
    console.error('[WA QR/Baileys] sendText failed for', branchId, e.message);
    return false;
  }
}

// Stops a client. { logout:true } unlinks on the phone AND wipes the session
// (a fresh QR is needed next time); otherwise the session is kept for restart.
async function stopClient(branchId, { logout = false } = {}) {
  const c = clients[branchId];
  if (!c || !c.sock) { delete clients[branchId]; return { success: true }; }
  try {
    if (logout) {
      await c.sock.logout().catch(() => {});
    } else {
      try { c.sock.end(undefined); } catch (e) { /* best-effort clean close */ }
    }
  } finally {
    delete clients[branchId];
  }
  return { success: true };
}

// Stop every client (graceful shutdown before a pm2 restart). Keeps sessions.
async function stopAll() {
  await Promise.all(Object.keys(clients).map((id) => stopClient(id, { logout: false })));
}

module.exports = {
  available: !!makeWASocket,
  MAX_CLIENTS,
  startClient,
  stopClient,
  stopAll,
  sendText,
  getStatus,
  activeCount,
};
