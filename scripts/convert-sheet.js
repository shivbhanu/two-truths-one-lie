#!/usr/bin/env node
/**
 * Convert a Google Sheets CSV export to data/game.json
 *
 * Sheet format (5 columns, header row required):
 *   Name | Statement 1 | Statement 2 | Statement 3 | Lie # (1/2/3)
 *
 * Usage:
 *   node scripts/convert-sheet.js responses.csv
 *   node scripts/convert-sheet.js responses.csv --password mypassword --host "Shiv"
 *
 * --host  Name of the admin/host player. They have a round but won't vote
 *         and are excluded from the leaderboard scores.
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '--help') {
  console.log('Usage: node scripts/convert-sheet.js <csv-file> [--password <pw>] [--host <name>]');
  console.log('\nSheet columns (with header row):');
  console.log('  Name | Statement 1 | Statement 2 | Statement 3 | Lie # (1/2/3)');
  process.exit(args.length === 0 ? 1 : 0);
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

// Skip header row
const dataRows = rows.slice(1);
const slides = [];
const players = [];
const errors = [];

dataRows.forEach((cols, i) => {
  const rowNum = i + 2; // 1-based, accounting for header
  const [name, s1, s2, s3, lieStr] = cols;

  if (!name) { errors.push(`Row ${rowNum}: missing Name`); return; }
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
