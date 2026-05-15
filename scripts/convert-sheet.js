#!/usr/bin/env node
/**
 * Convert a Google Sheets CSV export to data/game.json
 *
 * Form setup: enable "Collect email addresses" in Google Forms settings.
 * Add exactly 4 short-answer questions (no name question needed):
 *   Statement 1 | Statement 2 | Statement 3 | Which statement is the lie? (1, 2, or 3)
 *
 * Player names are derived from oviva emails: first.last@oviva.com → "First"
 *
 * Usage:
 *   node scripts/convert-sheet.js responses.csv
 *   node scripts/convert-sheet.js responses.csv --password mypassword --host "Shiv"
 *
 * --host  First name of the host as it appears in game (e.g. "Shiv" for shiv.singh@oviva.com).
 *         They have a round but won't vote and are excluded from the leaderboard scores.
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '--help') {
  console.log('Usage: node scripts/convert-sheet.js <csv-file> [--password <pw>] [--host <name>]');
  console.log('\nExpected CSV (Google Forms with email collection enabled, 4 questions):');
  console.log('  Timestamp | Email Address | Statement 1 | Statement 2 | Statement 3 | Lie # (1/2/3)');
  console.log('\nPlayer names are derived from oviva emails: first.last@oviva.com → "First"');
  process.exit(args.length === 0 ? 1 : 0);
}

function nameFromEmail(email) {
  const first = (email.split('@')[0] || '').split('.')[0];
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

const csvPath = args[0];
const pwIdx   = args.indexOf('--password');
const hostIdx = args.indexOf('--host');
const adminPassword = pwIdx   !== -1 ? args[pwIdx + 1]   : 'bi2026';
const hostPlayer    = hostIdx !== -1 ? args[hostIdx + 1] : null;

if (!fs.existsSync(csvPath)) {
  console.error(`Error: file not found: ${csvPath}`);
  process.exit(1);
}

const raw = fs.readFileSync(csvPath, 'utf8');

// Parse CSV — handles quoted fields and commas inside quotes
function parseCSV(text) {
  const rows = [];
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuotes = !inQuotes; }
      } else if (ch === ',' && !inQuotes) {
        cols.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    cols.push(cur.trim());
    rows.push(cols);
  }
  return rows;
}

const rows = parseCSV(raw);
if (rows.length < 2) {
  console.error('Error: CSV must have a header row and at least one data row.');
  process.exit(1);
}

// Detect columns from header row
const headers = rows[0].map(h => h.toLowerCase().trim());
const emailCol = headers.findIndex(h => h.includes('email'));
if (emailCol === -1) {
  console.error('Error: no email column found. Enable "Collect email addresses" in Google Forms settings.');
  process.exit(1);
}
// Remaining columns in order, skipping timestamp and email
const questionCols = headers
  .map((h, i) => i)
  .filter(i => i !== emailCol && !headers[i].includes('timestamp'));
if (questionCols.length < 4) {
  console.error(`Error: expected 4 question columns (Statement 1–3 + Lie #), found ${questionCols.length}.`);
  process.exit(1);
}
const [s1Col, s2Col, s3Col, lieCol] = questionCols;

const dataRows = rows.slice(1);
const slides = [];
const players = [];
const errors = [];

dataRows.forEach((cols, i) => {
  const rowNum = i + 2;
  const email = (cols[emailCol] || '').trim();
  const name = nameFromEmail(email);
  const s1 = cols[s1Col];
  const s2 = cols[s2Col];
  const s3 = cols[s3Col];
  const lieStr = cols[lieCol];

  if (!email) { errors.push(`Row ${rowNum}: missing email`); return; }

  if (!s1 || !s2 || !s3) { errors.push(`Row ${rowNum} (${name}): missing one or more statements`); return; }
  if (!lieStr) { errors.push(`Row ${rowNum} (${name}): missing Lie # column`); return; }

  const lieNum = parseInt(lieStr.trim(), 10);
  if (![1, 2, 3].includes(lieNum)) {
    errors.push(`Row ${rowNum} (${name}): Lie # must be 1, 2, or 3 (got "${lieStr}")`);
    return;
  }

  players.push(name.trim());
  slides.push({
    statements: [s1.trim(), s2.trim(), s3.trim()],
    correctName: name.trim(),
    lieIndex: lieNum - 1,  // convert 1-based to 0-based
  });
});

if (errors.length > 0) {
  console.error('Errors found in CSV:');
  errors.forEach(e => console.error(' ', e));
  process.exit(1);
}

const output = {
  adminPassword,
  ...(hostPlayer ? { hostPlayer } : {}),
  players,
  slides,
};

const outPath = path.join(__dirname, '..', 'data', 'game.json');
fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

console.log(`✓ Converted ${slides.length} players → ${outPath}`);
console.log(`  Admin password: ${adminPassword}`);
if (hostPlayer) console.log(`  Host player: ${hostPlayer} (excluded from leaderboard scores)`);
console.log('\nPlayers:');
players.forEach((p, i) => console.log(`  ${i + 1}. ${p} (lie: statement ${slides[i].lieIndex + 1})`));
