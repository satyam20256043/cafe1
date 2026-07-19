'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// waweb.js — per-branch WhatsApp-Web client manager (QR-scan linking).
//
// One whatsapp-web.js Client per café, keyed by branchId, session persisted via
// LocalAuth({ clientId: branchId }) so a pm2 restart re-links WITHOUT rescanning.
// This is the UNOFFICIAL WhatsApp client — kept for conversational receptionist
// traffic only (bulk sends are blocked upstream, see the QR guide §1.3). Coexists
// with the official Cloud API path (whatsapp-api.js); a café uses one mode.
//
// Never log or persist anything from `.wwebjs_auth/` — it holds live session keys.
// ─────────────────────────────────────────────────────────────────────────────

const path = require('path');

let Client, LocalAuth;
try {
  ({ Client, LocalAuth } = require('whatsapp-web.js'));
} catch (e) {
  console.warn('[WA QR] whatsapp-web.js not installed — QR linking disabled:', e.message);
}

// Respect an explicit 0 (kill-switch: refuse all QR links) — `|| 2` would not.
const _maxEnv = parseInt(process.env.WA_QR_MAX_CLIENTS, 10);
const MAX_CLIENTS = Number.isNaN(_maxEnv) ? 2 : _maxEnv;

// Session auth data lives beside the code (gitignored). Keep it OUT of data/<id>/
// so tenant purges / backups never touch live WhatsApp credentials.
const AUTH_DIR = path.join(__dirname, '..', '.wwebjs_auth');

// branchId -> { client, state, number, qrDataUrl, startedAt }
const clients = {};

function activeCount() {
  return Object.keys(clients).length;
}

function getStatus(branchId) {
  const c = clients[branchId];
  if (!c) return { state: 'disconnected', number: null, qrDataUrl: null };
  return { state: c.state, number: c.number || null, qrDataUrl: c.qrDataUrl || null };
}

// Build the puppeteer launch config. Defaults to whatsapp-web.js's bundled
// Chromium (correct on a clean server install); WA_QR_CHROME_PATH overrides it
// for machines whose puppeteer browser cache is broken/absent.
function puppeteerConfig() {
  const cfg = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
    ],
  };
  if (process.env.WA_QR_CHROME_PATH) cfg.executablePath = process.env.WA_QR_CHROME_PATH;
  return cfg;
}

// Starts (or returns the existing) client for a branch. Callbacks:
//   onQr(qrDataUrl)          — a fresh QR is ready to display
//   onReady({ number })      — linked & authenticated
//   onDisconnected(reason)   — session dropped (logout on the phone, ban, etc.)
//   onMessage({ from, body }) — inbound customer text (already filtered)
// Returns { success, error?, alreadyRunning? }.
function startClient(branchId, { onQr, onReady, onDisconnected, onMessage } = {}) {
  if (!Client) return { success: false, error: 'WhatsApp QR module not available on this server' };
  if (clients[branchId]) return { success: true, alreadyRunning: true };
  if (activeCount() >= MAX_CLIENTS) {
    return { success: false, error: `Server is at its QR-connection limit (${MAX_CLIENTS}). Disconnect another café or use the Business API.` };
  }

  const rec = { client: null, state: 'connecting', number: null, qrDataUrl: null, startedAt: Date.now() };
  clients[branchId] = rec;

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: branchId, dataPath: AUTH_DIR }),
    puppeteer: puppeteerConfig(),
  });
  rec.client = client;

  client.on('qr', (qr) => {
    rec.state = 'qr_pending';
    // qrcode npm package (already a dependency) → data-URL for the browser.
    require('qrcode').toDataURL(qr, { width: 280, margin: 1 })
      .then((dataUrl) => { rec.qrDataUrl = dataUrl; if (onQr) onQr(dataUrl); })
      .catch((e) => console.error('[WA QR] QR render failed for', branchId, e.message));
  });

  client.on('authenticated', () => { rec.state = 'connecting'; rec.qrDataUrl = null; });

  client.on('ready', () => {
    rec.state = 'connected';
    rec.qrDataUrl = null;
    try { rec.number = client.info && client.info.wid ? client.info.wid.user : null; } catch { rec.number = null; }
    if (onReady) onReady({ number: rec.number });
  });

  client.on('disconnected', (reason) => {
    rec.state = 'disconnected';
    rec.qrDataUrl = null;
    if (onDisconnected) onDisconnected(String(reason || 'unknown'));
    // whatsapp-web.js destroys itself on disconnect; drop it from the map so a
    // later startClient can cleanly re-init.
    delete clients[branchId];
  });

  if (onMessage) {
    client.on('message', (msg) => {
      try {
        if (msg.fromMe) return;                                   // our own outgoing
        const from = String(msg.from || '');
        if (from.endsWith('@g.us')) return;                        // group chat
        if (from === 'status@broadcast') return;                   // status updates
        if (msg.isStatus) return;
        const body = (msg.body || '').trim();
        if (!body) return;                                         // media w/o caption → skip
        onMessage({ from, body, msg });
      } catch (e) {
        console.error('[WA QR] inbound handler error for', branchId, e.message);
      }
    });
  }

  client.initialize().catch((e) => {
    console.error('[WA QR] initialize failed for', branchId, e.message);
    rec.state = 'disconnected';
    delete clients[branchId];
    if (onDisconnected) onDisconnected('init_failed');
  });

  return { success: true };
}

// Sends a text via the branch's live client. Returns true on success.
// `phone10or12` is digits only; we normalize to a WhatsApp chatId.
async function sendText(branchId, phone10or12, text) {
  const c = clients[branchId];
  if (!c || c.state !== 'connected' || !c.client) {
    console.warn('[WA QR] send skipped — no connected client for', branchId);
    return false;
  }
  const digits = String(phone10or12 || '').replace(/[^0-9]/g, '');
  const withCc = digits.length === 10 ? '91' + digits : digits;   // matches app-wide 91 default
  try {
    await c.client.sendMessage(`${withCc}@c.us`, text);
    return true;
  } catch (e) {
    console.error('[WA QR] sendText failed for', branchId, e.message);
    return false;
  }
}

// Stops a client. { logout:true } unlinks on the phone AND wipes the session
// (a fresh QR is needed next time); otherwise the session is kept for restart.
async function stopClient(branchId, { logout = false } = {}) {
  const c = clients[branchId];
  if (!c || !c.client) { delete clients[branchId]; return { success: true }; }
  try {
    if (logout) await c.client.logout().catch(() => {});
    await c.client.destroy().catch(() => {});
  } finally {
    delete clients[branchId];
  }
  return { success: true };
}

// Destroy every client (graceful shutdown before a pm2 restart). Keeps sessions.
async function stopAll() {
  await Promise.all(Object.keys(clients).map((id) => stopClient(id, { logout: false })));
}

module.exports = {
  available: !!Client,
  MAX_CLIENTS,
  startClient,
  stopClient,
  stopAll,
  sendText,
  getStatus,
  activeCount,
};
