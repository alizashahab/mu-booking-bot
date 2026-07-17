#!/usr/bin/env node
/**
 * add-exception — interactively add a blackout date range to exceptions.json
 * Usage: npm run add-exception
 */

'use strict';

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');

const EXCEPTIONS_FILE = path.join(__dirname, 'exceptions.json');

const rl  = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(resolve => rl.question(q, resolve));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function main() {
  console.log('\n📅  Add a blackout date range\n');
  console.log('   The bot will skip any day that falls within this range.\n');

  // Label
  const label = (await ask('   Label (e.g. "Finals Week – Spring 2027"): ')).trim();
  if (!label) { console.log('\n   ❌  Label cannot be empty.\n'); process.exit(1); }

  // Start date
  let start;
  while (true) {
    start = (await ask('   Start date (YYYY-MM-DD): ')).trim();
    if (DATE_RE.test(start)) break;
    console.log('   ❌  Use YYYY-MM-DD format, e.g. 2027-06-07');
  }

  // End date
  let end;
  while (true) {
    end = (await ask('   End date   (YYYY-MM-DD): ')).trim();
    if (DATE_RE.test(end)) break;
    console.log('   ❌  Use YYYY-MM-DD format, e.g. 2027-06-12');
  }

  if (end < start) {
    console.log('\n   ❌  End date must be on or after the start date.\n');
    process.exit(1);
  }

  // Read existing file
  let data = { exceptions: [] };
  if (fs.existsSync(EXCEPTIONS_FILE)) {
    try { data = JSON.parse(fs.readFileSync(EXCEPTIONS_FILE, 'utf8')); }
    catch { console.log('\n   ⚠️  Could not read exceptions.json — starting fresh.\n'); }
  }

  // Check for duplicates
  const dupe = data.exceptions.find(e => e.start === start && e.end === end);
  if (dupe) {
    console.log(`\n   ⚠️  An entry with these exact dates already exists: "${dupe.label}"\n`);
    rl.close();
    process.exit(0);
  }

  data.exceptions.push({ label, start, end });

  // Sort by start date so the file stays tidy
  data.exceptions.sort((a, b) => a.start.localeCompare(b.start));

  fs.writeFileSync(EXCEPTIONS_FILE, JSON.stringify(data, null, 2) + '\n');

  console.log(`\n   ✅  Added: "${label}"\n       ${start} → ${end}\n`);
  rl.close();
}

main().catch(err => {
  console.error(`\n   ❌  ${err.message}\n`);
  process.exit(1);
});
