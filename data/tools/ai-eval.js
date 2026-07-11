#!/usr/bin/env node
'use strict';
// Black-box AI receptionist evaluator (AI0, docs/ZORDIC_AI_RECEPTIONIST_GUIDE.md).
//
// Talks to a LOCALLY RUNNING server (default http://localhost:3010) exactly like a
// real customer would — through POST /api/businesses/:id/chat — so it exercises the
// exact same code path as WhatsApp/web widget/simulator. Never require()d by the
// server itself.
//
// Usage:
//   node data/tools/ai-eval.js                 run every case
//   node data/tools/ai-eval.js --only=deterministic   only the must-be-100% tier
//   node data/tools/ai-eval.js --only=llm             only the LLM-dependent tier
//   node data/tools/ai-eval.js --case=comp_cold_food  run a single case by id
//   node data/tools/ai-eval.js --keep                 don't tear down the test café
//
// Tiering note (see golden-set.json "tier" field): only cases whose *entire* outcome
// is decided before any Gemini call (complaint/payment-dispute escalation keywords,
// discount-request keyword net + aiMaxDiscount ceilings) are "deterministic". Multi-
// turn reservation/feedback flows are tagged "llm" even though the slot-filling turns
// after entry are deterministic — because entering the flow at all depends on Gemini
// classifying the opening message correctly (INTENT:RESERVATION / INTENT:FEEDBACK).
//
// Cases may carry "deferredUntil": "AI1"|"AI2"|"AI3"|"AI4" — known baseline gaps this
// guide's later packages are meant to close. They still run (so we can see early wins)
// but never count against the pass rate or the process exit code.
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..', '..');
const DB_PATH = path.join(ROOT, 'data', 'cafe_hq.db');
const BASE_URL = process.env.EVAL_BASE_URL || 'http://localhost:3010';

const args = process.argv.slice(2);
function getArg(name, def) {
  const p = args.find(a => a.startsWith(`--${name}=`));
  return p ? p.slice(name.length + 3) : def;
}
const hasFlag = name => args.includes(`--${name}`);
const ONLY = getArg('only', 'all'); // deterministic | llm | all
const KEEP = hasFlag('keep');
const CASE_FILTER = getArg('case', null);
// Free-tier gemini-2.5-flash allows ~10 requests/minute — fire the suite
// unthrottled and everything after the first handful 429s into the local
// fallback, poisoning the scores. Default pacing keeps LLM-tier turns under
// the cap; deterministic-tier cases never reach Gemini so they run full speed.
// Use --delay=0 for paid-tier keys or --no-gemini runs.
const TURN_DELAY_MS = parseInt(getArg('delay', '6500'), 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadGoldenSet() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'golden-set.json'), 'utf-8'));
}

async function apiPost(pathname, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const r = await fetch(BASE_URL + pathname, { method: 'POST', headers, body: JSON.stringify(body) });
  let json = null;
  try { json = await r.json(); } catch (e) { /* non-JSON response */ }
  return { status: r.status, body: json };
}

function normPhone(p) { return String(p || '').replace(/\D/g, '').slice(-10); }

// Deterministic per-case phone so re-runs are stable and cases never collide.
function phoneForCase(id) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return String(9000000000 + (h % 999999999)).slice(0, 10);
}

async function setupCafe() {
  const businessName = 'AI Eval Cafe ' + Date.now();
  const onboard = await apiPost('/api/onboard', { businessName, ownerName: 'Eval Owner', ownerPhone: '9999900000' });
  if (!onboard.body || !onboard.body.success) throw new Error('Onboard failed: ' + JSON.stringify(onboard.body));
  const businessId = onboard.body.businessId;
  const { username, tempPassword } = onboard.body.staff;

  const login = await apiPost('/api/auth/login', { businessId, username, password: tempPassword });
  const token = login.body && login.body.token;
  if (!token) throw new Error('Login failed: ' + JSON.stringify(login.body));

  // Café-wide AI discount default = 10%
  await fetch(BASE_URL + `/api/businesses/${businessId}/settings`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ aiMaxDiscount: 10 }),
  });

  // Per-item override: Cold Coffee (default seed item id '1') AI max = 25%
  const menuRes = await fetch(BASE_URL + `/api/businesses/${businessId}/menu`);
  const menu = await menuRes.json();
  const coldCoffee = menu.find(m => m.name === 'Cold Coffee');
  if (coldCoffee) coldCoffee.aiMaxDiscount = 25;
  await fetch(BASE_URL + `/api/businesses/${businessId}/menu`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(menu),
  });

  // Seed a "regular" returning customer (3 visits -> tier Regular) for personalization cases
  const regularPhone = '9811100011';
  for (let i = 0; i < 3; i++) {
    await fetch(BASE_URL + `/api/businesses/${businessId}/loyalty/award`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ phone: regularPhone, name: 'Rahul Regular', amountSpent: 200, orderId: 'seed_' + i }),
    });
  }

  return { businessId, token, regularPhone, menu };
}

// SQLite rows + the branch data folder are safe to clean up while the server is
// running (both are read fresh per request — see getBranchData/writeBranchData,
// no in-memory cache). businesses.json and the server's in-memory `businesses`
// array are NOT touched here: editing that file while the process is live gets
// silently overwritten on its next write (a known gotcha from earlier sessions).
// The stale entry is harmless (its data folder is gone, nothing routes to it) —
// clear it out next time the server is stopped for a full manual reset.
function teardownCafe(db, businessId) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);
  for (const t of tables) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
    if (cols.includes('business_id')) {
      try { db.prepare(`DELETE FROM ${t} WHERE business_id=?`).run(businessId); } catch (e) { /* table may not apply */ }
    }
  }
  try { db.prepare('DELETE FROM businesses WHERE id=?').run(businessId); } catch (e) {}
  const branchDir = path.join(ROOT, 'data', businessId);
  if (fs.existsSync(branchDir)) fs.rmSync(branchDir, { recursive: true, force: true });
}

// ---- Assertions --------------------------------------------------------------

function checkReply(reply, expect, fail) {
  const lower = (reply || '').toLowerCase();
  if (expect.replyIncludes) {
    for (const s of expect.replyIncludes) if (!lower.includes(s.toLowerCase())) fail(`reply missing required text: "${s}"`);
  }
  if (expect.replyIncludesAny) {
    if (!expect.replyIncludesAny.some(s => lower.includes(s.toLowerCase()))) fail(`reply missing any of: ${expect.replyIncludesAny.join(' | ')}`);
  }
  if (expect.replyExcludes) {
    for (const s of expect.replyExcludes) if (lower.includes(s.toLowerCase())) fail(`reply contains forbidden text: "${s}"`);
  }
  if (expect.replyMatches) {
    if (!new RegExp(expect.replyMatches, 'i').test(reply || '')) fail(`reply doesn't match /${expect.replyMatches}/i`);
  }
}

function checkSideEffects(db, businessId, phone, expect, fail) {
  const p = normPhone(phone);
  if (expect.escalationCategory) {
    const row = db.prepare('SELECT * FROM escalations WHERE business_id=? AND customer_phone=? AND category=?')
      .get(businessId, p, expect.escalationCategory);
    if (!row) fail(`no escalation row with category=${expect.escalationCategory} for ${p}`);
  }
  if (expect.couponIssued) {
    const spec = expect.couponIssued === true ? {} : expect.couponIssued;
    let sql = 'SELECT * FROM coupons WHERE business_id=? AND customer_phone=?';
    const params = [businessId, p];
    if (spec.sourceType) { sql += ' AND source_type=?'; params.push(spec.sourceType); }
    const rows = db.prepare(sql).all(...params);
    if (!rows.length) fail(`no coupon issued for ${p}` + (spec.sourceType ? ` (sourceType=${spec.sourceType})` : ''));
    else if (spec.minValue && !rows.some(r => r.discount_value >= spec.minValue)) fail(`coupon(s) issued for ${p} but none with discount_value >= ${spec.minValue}`);
  }
  if (expect.offerRequestCreated) {
    const file = path.join(ROOT, 'data', businessId, 'offer_requests.json');
    let arr = [];
    try { arr = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (e) {}
    if (!arr.some(o => normPhone(o.phone) === p)) fail(`no offer_requests.json entry for ${p}`);
  }
  if (expect.reservationCreated) {
    const file = path.join(ROOT, 'data', businessId, 'reservations.json');
    let arr = [];
    try { arr = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (e) {}
    const match = arr.find(r => normPhone(r.phone) === p);
    if (!match) fail(`no reservations.json entry for ${p}`);
    else if (expect.reservationCreated.guests && match.guests !== expect.reservationCreated.guests) {
      fail(`reservation guests=${match.guests}, expected ${expect.reservationCreated.guests}`);
    }
  }
}

// ---- Runner -------------------------------------------------------------------

async function runCase(ctx, tcase) {
  const failures = [];
  const fail = msg => failures.push(msg);
  const phone = tcase.phone || phoneForCase(tcase.id);
  let lastReply = null;

  for (const [idx, turn] of tcase.turns.entries()) {
    if (tcase.tier === 'llm' && TURN_DELAY_MS > 0) await sleep(TURN_DELAY_MS);
    const r = await apiPost(`/api/businesses/${ctx.businessId}/chat`, {
      phone, text: turn.text, customerName: tcase.customerName || 'Eval Customer',
    });
    lastReply = r.body && r.body.reply;
    if (turn.expect) {
      const turnFail = msg => failures.push(`turn ${idx + 1} ("${turn.text}"): ${msg}`);
      checkReply(lastReply, turn.expect, turnFail);
      checkSideEffects(ctx.db, ctx.businessId, phone, turn.expect, turnFail);
    }
  }
  return { id: tcase.id, tier: tcase.tier, deferredUntil: tcase.deferredUntil || null, pass: failures.length === 0, failures, lastReply };
}

async function main() {
  console.log('[ai-eval] Setting up test café...');
  const ctx = await setupCafe();
  ctx.db = new Database(DB_PATH);
  console.log('[ai-eval] businessId =', ctx.businessId);

  let cases = loadGoldenSet();
  if (CASE_FILTER) cases = cases.filter(c => c.id === CASE_FILTER);
  if (ONLY !== 'all') cases = cases.filter(c => c.tier === ONLY);
  console.log(`[ai-eval] Running ${cases.length} case(s)...\n`);

  const results = [];
  for (const tcase of cases) {
    try {
      results.push(await runCase(ctx, tcase));
    } catch (e) {
      results.push({ id: tcase.id, tier: tcase.tier, deferredUntil: tcase.deferredUntil || null, pass: false, failures: ['exception: ' + e.message] });
    }
    process.stdout.write(results[results.length - 1].pass ? '.' : 'F');
  }
  console.log('\n');

  const active = results.filter(r => !r.deferredUntil);
  const deferred = results.filter(r => r.deferredUntil);

  function summarize(rows, label) {
    const total = rows.length;
    const passed = rows.filter(r => r.pass).length;
    const pct = total ? Math.round((passed / total) * 1000) / 10 : 0;
    console.log(`${label}: ${passed}/${total} passed (${pct}%)`);
    return { total, passed, pct };
  }

  console.log('========== SCORECARD ==========');
  const det = active.filter(r => r.tier === 'deterministic');
  const llm = active.filter(r => r.tier === 'llm');
  const detSummary = summarize(det, 'DETERMINISTIC (must be 100%)');
  const llmSummary = summarize(llm, 'LLM-DEPENDENT           ');

  if (deferred.length) {
    console.log('\nDEFERRED (expected to fail until a later package — informational only):');
    const byPkg = {};
    for (const r of deferred) (byPkg[r.deferredUntil] = byPkg[r.deferredUntil] || []).push(r);
    for (const [pkg, rows] of Object.entries(byPkg).sort()) {
      const passed = rows.filter(r => r.pass).length;
      console.log(`  ${pkg}: ${passed}/${rows.length} already passing`);
    }
  }

  console.log('\n--------------------------------');
  console.log(`TOTAL: ${results.length} cases (${active.length} scored, ${deferred.length} deferred)`);
  console.log('================================\n');

  const failing = results.filter(r => !r.pass && !r.deferredUntil);
  if (failing.length) {
    console.log(`${failing.length} FAILING (non-deferred) case(s):\n`);
    for (const f of failing) {
      console.log(`  x [${f.tier}] ${f.id}`);
      for (const msg of f.failures) console.log(`      - ${msg}`);
      if (f.lastReply) console.log(`      last reply: ${JSON.stringify(f.lastReply).slice(0, 150)}`);
    }
    console.log('');
  }

  if (!KEEP) {
    console.log('[ai-eval] Cleaning up test café...');
    teardownCafe(ctx.db, ctx.businessId);
  } else {
    console.log(`[ai-eval] --keep set, leaving businessId=${ctx.businessId} for inspection`);
  }
  ctx.db.close();

  process.exitCode = detSummary.passed === detSummary.total ? 0 : 1;
}

main().catch(e => { console.error('[ai-eval] FATAL:', e); process.exitCode = 2; });
