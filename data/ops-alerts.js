'use strict';
// Operator alerting — the "silent outage" fix (IMP2). A café's WhatsApp send
// failing, or Claude/Gemini losing its API key, used to be invisible outside
// pm2 logs. This persists a small alert feed to disk, and best-effort pings
// the operator's own WhatsApp when OPERATOR_ALERT_PHONE is set.
const fs = require('fs');
const path = require('path');

const ALERTS_FILE = path.join(__dirname, 'ops_alerts.json');
const MAX_ALERTS = 200;
const DEBOUNCE_MS = 6 * 60 * 60 * 1000; // 6h

let _sendWhatsAppToCustomer = null;
function init(deps) {
  _sendWhatsAppToCustomer = (deps && deps.sendWhatsAppToCustomer) || null;
}

function readAlerts() {
  if (!fs.existsSync(ALERTS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf-8')); }
  catch (e) { return []; }
}

function writeAlerts(alerts) {
  fs.writeFileSync(ALERTS_FILE, JSON.stringify(alerts, null, 2));
}

// same kind+branchId at most once per 6h — in-memory, resets on restart
const _lastRaised = new Map();

function raiseAlert(kind, branchId, message) {
  const debounceKey = `${kind}:${branchId}`;
  const now = Date.now();
  const last = _lastRaised.get(debounceKey);
  if (last && (now - last) < DEBOUNCE_MS) return;
  _lastRaised.set(debounceKey, now);

  const alert = {
    id: `alert_${now}_${Math.random().toString(36).slice(2, 8)}`,
    kind, branchId, message,
    at: new Date(now).toISOString(),
  };

  const alerts = readAlerts();
  alerts.unshift(alert);
  if (alerts.length > MAX_ALERTS) alerts.length = MAX_ALERTS;
  writeAlerts(alerts);

  console.log(`[OPS ALERT] ${kind} (${branchId}): ${message}`);

  const phone = process.env.OPERATOR_ALERT_PHONE;
  // Send FROM a dedicated, known-good WhatsApp connection — never from
  // branchId, the subject of the alert. Sending 'global' alerts through a
  // config keyed 'global' always failed (no such business, no such config
  // directory exists), and a wa_send_failed/wa_qr_disconnected alert is
  // specifically about THAT branch's own connection being broken, so routing
  // the alert back out through the exact channel that just failed typically
  // fails the same way — defeating the point of alerting at all. Set
  // OPERATOR_ALERT_BRANCH_ID to a café whose WhatsApp connection is reliably
  // up; without it, alerts still log to console and this file, just not WhatsApp.
  const alertBranchId = process.env.OPERATOR_ALERT_BRANCH_ID;
  if (phone && alertBranchId && _sendWhatsAppToCustomer) {
    try {
      Promise.resolve(_sendWhatsAppToCustomer(alertBranchId, phone, `🔔 Zordical ops alert\n${kind} — ${branchId}\n${message}`))
        .catch(() => {});
    } catch (e) { /* best-effort — never let alerting itself break the caller */ }
  }
}

function listAlerts() {
  return readAlerts(); // newest-first on disk
}

function clearAlerts() {
  writeAlerts([]);
}

module.exports = { init, raiseAlert, listAlerts, clearAlerts };
