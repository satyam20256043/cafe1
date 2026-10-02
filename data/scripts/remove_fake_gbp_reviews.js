#!/usr/bin/env node
/**
 * remove_fake_gbp_reviews.js
 *
 * One-off cleanup: removes hard-coded fake Google reviews that were inserted by the
 * old /api/businesses/:id/gbp/sync route (marketing.js, removed in GB0).
 *
 * A row is removed only when ALL THREE conditions match:
 *   1. source === 'google'
 *   2. id is one of: 'g1', 'g2', 'g3'
 *   3. customerName is one of: 'Aditya Sen', 'Meera Kapoor', 'Kabir Dev'
 *
 * Usage:
 *   node data/scripts/remove_fake_gbp_reviews.js            (dry-run, default)
 *   node data/scripts/remove_fake_gbp_reviews.js --apply    (writes changes)
 *
 * DO NOT run --apply on any production server. That is the operator's decision.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const APPLY    = process.argv.includes('--apply');
const DATA_DIR = path.join(__dirname, '..');

const FAKE_IDS   = new Set(['g1', 'g2', 'g3']);
const FAKE_NAMES = new Set(['Aditya Sen', 'Meera Kapoor', 'Kabir Dev']);

function isFakeRow(row) {
  return (
    row.source === 'google' &&
    FAKE_IDS.has(row.id) &&
    FAKE_NAMES.has(row.customerName)
  );
}

let totalFound  = 0;
let totalCafes  = 0;
let affectedDir = [];

// Iterate over every sub-directory inside DATA_DIR that looks like a branch dir
// (has a feedback.json inside it).
const entries = fs.readdirSync(DATA_DIR, { withFileTypes: true });

for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  const feedbackPath = path.join(DATA_DIR, entry.name, 'feedback.json');
  if (!fs.existsSync(feedbackPath)) continue;

  let feedback;
  try {
    feedback = JSON.parse(fs.readFileSync(feedbackPath, 'utf8'));
  } catch (e) {
    console.warn(`  [SKIP] ${entry.name}/feedback.json — JSON parse error: ${e.message}`);
    continue;
  }

  if (!Array.isArray(feedback)) continue;

  const fakeRows = feedback.filter(isFakeRow);
  if (fakeRows.length === 0) continue;

  totalCafes++;
  totalFound += fakeRows.length;
  affectedDir.push({ dir: entry.name, count: fakeRows.length, rows: fakeRows });

  if (APPLY) {
    const cleaned = feedback.filter(r => !isFakeRow(r));
    fs.writeFileSync(feedbackPath, JSON.stringify(cleaned, null, 2));
    console.log(`  [REMOVED] ${entry.name}/feedback.json — removed ${fakeRows.length} fake row(s)`);
  } else {
    console.log(`  [WOULD REMOVE] ${entry.name}/feedback.json — ${fakeRows.length} fake row(s):`);
    fakeRows.forEach(r => console.log(`    id=${r.id} customerName="${r.customerName}"`));
  }
}

console.log('');
if (totalFound === 0) {
  console.log('✅ No fake GBP reviews found in any branch directory.');
} else if (APPLY) {
  console.log(`✅ Done. Removed ${totalFound} fake review(s) from ${totalCafes} café(s).`);
} else {
  console.log(`📋 Dry-run: would remove ${totalFound} fake review(s) from ${totalCafes} café(s).`);
  console.log('   Run with --apply to write changes (operator decision, not on production).');
}
