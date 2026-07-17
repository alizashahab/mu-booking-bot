/**
 * mu-booking-bot — UC Davis Rec Center Auto-Booker
 *
 * Tries Table 7 first, then falls back to the closest available table
 * (6→8→5→9→…). Retries once on failure. Sends a calendar invite on success.
 *
 * Credentials are read from macOS Keychain — never hardcoded.
 * Run setup.sh once to store them.
 */

'use strict';

const { chromium } = require('playwright');
const { execSync }  = require('child_process');
const fs            = require('fs');
const path          = require('path');
const nodemailer    = require('nodemailer');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
// The booking page for your specific reservation resource. Copy the full URL
// (including the ID at the end) from your Rec Center booking page.
const BOOKING_URL      = 'YOUR_BOOKING_URL_HERE';
const LOG_FILE         = path.join(__dirname, 'booking.log');
const EXCEPTIONS_FILE  = path.join(__dirname, 'exceptions.json');
const CONFIG_FILE      = path.join(__dirname, 'config.json');
const KEYCHAIN_SERVICE = 'mu-booking-bot';
const DUO_TIMEOUT_MS   = 60_000;
// Address that receives the calendar invite on a successful booking
// (e.g. your student org's shared inbox). Leave as the placeholder to disable.
const INVITE_TO        = 'INVITE_EMAIL_HERE';

// Persistent Chrome profile — session is saved here between runs.
const BOT_PROFILE_DIR = path.join(__dirname, '.chrome-profile');

// Table fallback order: 7 first, then spiral outward (6,8,5,9,4,10…)
const TABLE_PRIORITY = [7, 6, 8, 5, 9, 4, 10, 3, 11, 2, 12, 1, 13];

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function log(message) {
  let icon = '  ';
  if      (/success|confirmed|booking confirmed|selected date|approved|session saved/i.test(message)) icon = '✅';
  else if (/^error|^fatal|failed|timeout|could not/i.test(message))                                   icon = '❌';
  else if (/warning|skipping|skip/i.test(message))                                                    icon = '⚠️';
  else if (/login|sign.?in|cas|duo|session|credential/i.test(message))                               icon = '🔐';
  else if (/navigat|right arrow|date|week|tab.*apr|tab.*may/i.test(message))                          icon = '📅';
  else if (/table\s+\d|slot/i.test(message))                                                          icon = '🪑';
  else if (/email|invite|sent/i.test(message))                                                        icon = '📧';
  else if (/starting|done\.|complete|browser closed/i.test(message))                                  icon = '🤖';
  else if (/navigating to https/i.test(message))                                                      icon = '🌐';
  else if (/screenshot/i.test(message))                                                               icon = '📸';

  const line = `[${new Date().toISOString()}] ${icon} ${message}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

// ---------------------------------------------------------------------------
// Day-of-week guard  (Mon–Thu only)
// ---------------------------------------------------------------------------
function checkDayOfWeek() {
  const day = new Date().getDay();
  if (day === 0 || day === 5 || day === 6) {
    log(`Skipping — today is ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][day]}, not a booking day.`);
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// Exceptions guard
// ---------------------------------------------------------------------------
function checkExceptions() {
  if (!fs.existsSync(EXCEPTIONS_FILE)) return;
  let data;
  try { data = JSON.parse(fs.readFileSync(EXCEPTIONS_FILE, 'utf8')); }
  catch (err) { log(`WARNING: Could not parse exceptions.json — ${err.message}. Continuing.`); return; }

  const today = new Date(); today.setHours(0, 0, 0, 0);
  for (const ex of data.exceptions || []) {
    const start = new Date(ex.start + 'T00:00:00');
    const end   = new Date(ex.end   + 'T23:59:59');
    if (today >= start && today <= end) {
      log(`Skipping — today falls within exception: "${ex.label}" (${ex.start} → ${ex.end})`);
      process.exit(0);
    }
  }
}

// ---------------------------------------------------------------------------
// macOS Keychain helper
// ---------------------------------------------------------------------------
function getSecret(account) {
  try {
    return execSync(
      `security find-generic-password -s "${KEYCHAIN_SERVICE}" -a "${account}" -w 2>/dev/null`,
      { encoding: 'utf8' }
    ).trim();
  } catch {
    throw new Error(`Could not read "${account}" from Keychain. Run setup.sh first.`);
  }
}


// ---------------------------------------------------------------------------
// Screenshot helper
// ---------------------------------------------------------------------------
async function saveErrorScreenshot(page) {
  try {
    const dest = path.join(__dirname, `error-${Date.now()}.png`);
    await page.screenshot({ path: dest, fullPage: true });
    log(`Screenshot saved → ${dest}`);
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

// "2:30 PM" → minutes since midnight (150), or null
function parseTimeToMinutes(text) {
  const m = text.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const mer = m[3]?.toLowerCase();
  if (mer === 'pm' && h !== 12) h += 12;
  if (mer === 'am' && h === 12) h = 0;
  return h * 60 + min;
}

// Date → "20260417T140000Z" (UTC)
function toIcsStamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

// Parse slot label → { startDt, endDt } in "YYYYMMDDTHHMMSS" (local, no Z)
// Tries hard to extract the actual booked date from the label text.
// Falls back to today only as a last resort, with a warning.
function parseSlotDateTime(slotLabel) {
  const pad  = n => String(n).padStart(2, '0');
  const now  = new Date();
  let year   = now.getFullYear();
  let month  = now.getMonth();   // 0-indexed
  let day    = now.getDate();
  let dateFound = false;

  // ── Try ISO: 2026-04-20 ──────────────────────────────────────────────────
  const isoM = slotLabel.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoM) {
    year = parseInt(isoM[1]); month = parseInt(isoM[2]) - 1; day = parseInt(isoM[3]);
    dateFound = true;
  }

  // ── Try "April 20" / "Apr 20" / "April 20, 2026" ────────────────────────
  if (!dateFound) {
    const MONTH_NAMES = [
      'january','february','march','april','may','june',
      'july','august','september','october','november','december',
    ];
    const MONTH_SHORT = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    const mM = slotLabel.match(
      /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})(?:[,\s]+(\d{4}))?/i
    );
    if (mM) {
      const name = mM[1].toLowerCase();
      const idx  = MONTH_NAMES.indexOf(name) !== -1 ? MONTH_NAMES.indexOf(name) : MONTH_SHORT.indexOf(name);
      if (idx !== -1) {
        month = idx; day = parseInt(mM[2]);
        if (mM[3]) year = parseInt(mM[3]);
        dateFound = true;
      }
    }
  }

  // ── Try numeric: "4/20" or "04/20/2026" ─────────────────────────────────
  if (!dateFound) {
    const nM = slotLabel.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
    if (nM) {
      month = parseInt(nM[1]) - 1; day = parseInt(nM[2]);
      if (nM[3]) year = nM[3].length === 2 ? 2000 + parseInt(nM[3]) : parseInt(nM[3]);
      dateFound = true;
    }
  }

  // ── Try weekday + offset: "Monday", "Tuesday", etc. ─────────────────────
  if (!dateFound) {
    const DAYS = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const dM   = slotLabel.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
    if (dM) {
      const target  = DAYS.indexOf(dM[1].toLowerCase());
      const current = now.getDay();
      const diff    = (target - current + 7) % 7 || 7; // 0 → 7 so we never pick today if name matches
      const future  = new Date(now); future.setDate(now.getDate() + diff);
      year = future.getFullYear(); month = future.getMonth(); day = future.getDate();
      dateFound = true;
    }
  }

  if (!dateFound) {
    log('WARNING: Could not parse a date from slot label — calendar invite will use today as a fallback.');
  }

  const ymd = `${year}${pad(month + 1)}${pad(day)}`;

  // ── Parse time ───────────────────────────────────────────────────────────
  const tokens  = slotLabel.match(/\d{1,2}(?::\d{2})?\s*(?:am|pm)/gi) || [];
  let startH = 14, startM = 0;
  if (tokens.length > 0) {
    const mins = parseTimeToMinutes(tokens[tokens.length - 1]);
    if (mins !== null) { startH = Math.floor(mins / 60); startM = mins % 60; }
  }

  return {
    startDt: `${ymd}T${pad(startH)}${pad(startM)}00`,
    endDt:   `${ymd}T${pad(startH + 1)}${pad(startM)}00`,
  };
}

// ---------------------------------------------------------------------------
// Load email/calendar config
// ---------------------------------------------------------------------------
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return {}; }
}

// ---------------------------------------------------------------------------
// Send calendar invite (iCal via email) on success
// ---------------------------------------------------------------------------
async function sendCalendarInvite(tableNum) {
  const config = loadConfig();
  if (!config.notificationEmail || !config.senderEmail) return;

  let appPassword;
  try { appPassword = getSecret('gmail-app-password'); }
  catch { log('Calendar invite skipped — email not configured.'); return; }

  // Only invite the shared address if it's been filled in (not left as the placeholder)
  const inviteSet = INVITE_TO && INVITE_TO !== 'INVITE_EMAIL_HERE';

  // Booking date is always 4 weeks from today
  const pad       = n => String(n).padStart(2, '0');
  const bookDate  = new Date();
  bookDate.setDate(bookDate.getDate() + 28);
  const ymd       = `${bookDate.getFullYear()}${pad(bookDate.getMonth() + 1)}${pad(bookDate.getDate())}`;

  // Time is always 10 AM – 2 PM
  const startDt = `${ymd}T100000`;
  const endDt   = `${ymd}T140000`;

  const uid     = `${Date.now()}@mu-booking-bot`;
  const stamp   = toIcsStamp(new Date());
  const label   = `Table ${tableNum} - MSA Tabling`;

  const bookDateStr = bookDate.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });

  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//mu-booking-bot//EN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    `DTSTART;TZID=America/Los_Angeles:${startDt}`,
    `DTEND;TZID=America/Los_Angeles:${endDt}`,
    `SUMMARY:${label}`,
    'DESCRIPTION:Booked automatically by mu-booking-bot.',
    `ORGANIZER;CN=MU Booking Bot:MAILTO:${config.senderEmail}`,
    ...(inviteSet ? [`ATTENDEE;RSVP=TRUE;PARTSTAT=NEEDS-ACTION:MAILTO:${INVITE_TO}`] : []),
    `ATTENDEE;RSVP=FALSE;PARTSTAT=ACCEPTED:MAILTO:${config.notificationEmail}`,
    'STATUS:CONFIRMED',
    'SEQUENCE:0',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: config.senderEmail, pass: appPassword },
    });

    await transporter.sendMail({
      from:    `"MU Booking Bot" <${config.senderEmail}>`,
      to:      inviteSet ? [config.notificationEmail, INVITE_TO] : [config.notificationEmail],
      subject: `📅 ${label} booked — ${bookDateStr}`,
      text:    `${label} was successfully booked.\n\nDate: ${bookDateStr}\nSlot: 10am - 2pm\n\nThis invite was sent automatically by mu-booking-bot.`,
      alternatives: [{
        contentType: 'text/calendar; charset="UTF-8"; method=REQUEST',
        content: Buffer.from(ics),
      }],
      attachments: [{
        filename:    'invite.ics',
        content:     ics,
        contentType: 'text/calendar; method=REQUEST',
      }],
    });

    log(`Calendar invite sent to ${config.notificationEmail}${inviteSet ? ` and ${INVITE_TO}` : ''}`);
  } catch (err) {
    log(`Could not send calendar invite: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Navigate the Fusion date-picker forward by clicking ">" until it stops.
// Then click the latest available date tab in the final week.
// Returns a date string like "TUE MAY 13" for use in emails/logs.
// ---------------------------------------------------------------------------
async function navigateToLatestDate(page) {
  log('Navigating to the latest available date…');

  // ── Step 1: Find the target date button using data attributes ──────────────
  // Fusion renders every bookable date as:
  //   <button data-day="13" data-month="5" data-year="2026"
  //           data-date-text="May 13, 2026"
  //           class="…single-date-select-button…">
  // ALL dates are in the DOM — only the current week's are visible.
  // We find the LAST one by data-button-index or position.

  // Read all date buttons and pick the last one
  const allDateBtns = await page.locator('button.single-date-select-button').all();
  if (allDateBtns.length === 0) {
    log('WARNING: No single-date-select-button elements found — staying on current date.');
    return await extractCurrentPageDate(page);
  }

  const lastBtn    = allDateBtns[allDateBtns.length - 1];
  const lastDay    = await lastBtn.getAttribute('data-day');
  const lastMonth  = await lastBtn.getAttribute('data-month');
  const lastYear   = await lastBtn.getAttribute('data-year');
  const lastText   = await lastBtn.getAttribute('data-date-text'); // "May 13, 2026"

  const targetDate = new Date(parseInt(lastYear), parseInt(lastMonth) - 1, parseInt(lastDay));
  log(`Last bookable date: ${lastText} → ${targetDate.toDateString()}`);

  // Sanity-check against today + 28 days
  const today     = new Date(); today.setHours(0, 0, 0, 0);
  const diffDays  = Math.round((targetDate - today) / 86_400_000);
  log(`Target booking date: ${targetDate.toDateString()} (${diffDays} days from today)`);
  if (diffDays < 20 || diffDays > 35) {
    log(`WARNING: target is ${diffDays} days out — expected ~28. Proceeding anyway.`);
  }

  // Build the CSS selector for that specific date button
  const targetSel = `button[data-day="${lastDay}"][data-month="${lastMonth}"][data-year="${lastYear}"]`;

  // Helper: find the VISIBLE copy of the target button (there may be multiple in DOM — one
  // for the main view, one inside a hidden modal — so we iterate and pick the visible one).
  const findVisibleTargetBtn = async () => {
    const btns = await page.locator(targetSel).all();
    for (const btn of btns) {
      if (await btn.isVisible().catch(() => false)) return btn;
    }
    return null;
  };

  // ── Step 2: Click ">" until not clickable (last week), then find target ────
  const MAX_CLICKS = 20;
  const arrowSel   =
    'button[id*="ShowMoreDatesRight"]:not([id*="Modal"]):not([id*="modal"]), ' +
    'button[class*="single-date-right-arrow"]:not([class*="modal"])';

  for (let i = 0; i < MAX_CLICKS; i++) {
    const arrow = page.locator(arrowSel).first();
    if (await arrow.count() === 0) { log('Right-arrow not found — stopping.'); break; }
    try {
      await arrow.click({ timeout: 500 });
      log(`Right arrow click ${i + 1}`);
    } catch {
      log(`Right arrow not clickable after ${i} click(s) — reached last week.`);
      break;
    }
  }

  // Poll for target date to become visible after the final AJAX update
  let finalBtn = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    finalBtn = await findVisibleTargetBtn();
    if (finalBtn) break;
    await page.waitForTimeout(300);
  }

  if (finalBtn) {
    log(`Target date "${lastText}" visible — clicking it.`);
    await finalBtn.scrollIntoViewIfNeeded().catch(() => {});
    await finalBtn.click({ timeout: 10_000 });
    await page.waitForTimeout(600);
    log(`Selected date: ${lastText}`);
    return lastText;
  }

  // Fallback: click whatever is the latest visible date tab
  log('Target date button did not become visible — clicking the latest visible tab.');
  return await clickTargetDateTab(page, targetDate);
}

// Click the tab for targetDate. If that exact tab isn't found, click the
// latest visible date tab as a fallback.
async function clickTargetDateTab(page, targetDate) {
  const MONTHS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };

  const parseTabDate = text => {
    const m = text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+(\d{1,2})\b/i);
    if (!m) return null;
    const mo = MONTHS[m[1].toLowerCase().slice(0, 3)];
    if (mo === undefined) return null;
    return new Date(new Date().getFullYear(), mo, parseInt(m[2], 10));
  };

  // Gather only VISIBLE date tabs inside the date-selector widget
  const allEls = await page.locator('#divBookingDateSelector button, #divBookingDateSelector a').all();
  const tabs   = [];
  for (const el of allEls) {
    if (!await el.isVisible().catch(() => false)) continue; // skip hidden buttons
    const text = (await el.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    const d    = parseTabDate(text);
    if (d) tabs.push({ el, text, d });
  }

  if (tabs.length === 0) {
    log('No visible date tabs found — falling back to extractCurrentPageDate.');
    return await extractCurrentPageDate(page);
  }

  // Sort chronologically, pick the latest
  tabs.sort((a, b) => a.d - b.d);
  log(`Visible date tabs: ${tabs.map(t => t.text).join(' | ')}`);

  // Prefer the exact target date; fall back to the latest visible tab
  const tMo    = targetDate ? targetDate.getMonth() : -1;
  const tDay   = targetDate ? targetDate.getDate()  : -1;
  const exact  = tabs.find(t => t.d.getMonth() === tMo && t.d.getDate() === tDay);
  const toClick = exact || tabs[tabs.length - 1];

  try {
    await toClick.el.scrollIntoViewIfNeeded().catch(() => {});
    await toClick.el.click({ timeout: 10_000 });
    await page.waitForTimeout(600);
    log(`Clicked date tab: "${toClick.text}"${exact ? ' (exact target)' : ' (latest visible)'}`);
    return toClick.text;
  } catch (err) {
    log(`Failed to click date tab "${toClick.text}": ${err.message}`);
    return await extractCurrentPageDate(page);
  }
}

// Read a date string from the page header or selected date tab
async function extractCurrentPageDate(page) {
  // Try the active/selected date tab first
  for (const sel of [
    '[class*="date-tab"][class*="active"], [class*="day-tab"][class*="active"], ' +
    '[class*="day-button"][class*="selected"], [class*="selected"][data-date]',
    'h1', 'h2', 'h3', '[class*="title"]',
  ]) {
    try {
      const els = await page.locator(sel).all();
      for (const el of els) {
        const text = (await el.innerText().catch(() => '')).trim().replace(/\s+/g, ' ');
        if (text.length > 3 && text.length < 80 &&
          /\d{1,2}[\/-]\d{1,2}|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b|\d{4}/i.test(text)
        ) return text;
      }
    } catch { /* skip */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Click the tab for a given table number (handles "Table 07" zero-padding)
// Returns true if the tab was found and clicked
// ---------------------------------------------------------------------------
async function clickTableTab(page, tableNum) {
  const padded = String(tableNum).padStart(2, '0'); // 7 → "07"

  // Fusion table tabs have text like "Table 07" — use a precise text-match locator.
  // :text-is() is an exact match; we also try the zero-padded and un-padded variants.
  const labels = [`Table ${padded}`, `Table ${tableNum}`];

  for (const label of labels) {
    for (const sel of ['button', 'a', '[role="tab"]', 'li']) {
      const loc = page.locator(`${sel}:visible`).filter({ hasText: new RegExp(`^\\s*${label}\\s*$`, 'i') }).first();
      try {
        if (await loc.count() > 0) {
          await loc.click({ timeout: 5_000 });
          await page.waitForTimeout(600);
          log(`Clicked Table ${padded} tab`);
          return true;
        }
      } catch { /* not visible / not found — try next */ }
    }
  }

  log(`Could not find Table ${padded} tab on this page.`);
  return false;
}

// ---------------------------------------------------------------------------
// Check if a table is already booked by the current user.
// Call this AFTER clickTableTab() so the right tab is already visible.
// ---------------------------------------------------------------------------
async function isTableAlreadyBooked(page) {
  const indicators = [
    // Common class-based markers
    page.locator(
      '[class*="booked"]:not([class*="unavailable"]), [class*="reserved"], ' +
      '[class*="confirmed"], [class*="my-booking"], [class*="mybooking"], ' +
      '[class*="checked"], [data-booked="true"], [data-status="booked"], ' +
      '[data-status="reserved"], [data-status="confirmed"]'
    ),
    // Checkmark characters in text
    page.locator(':text("✓"), :text("✔"), :text("☑"), :text("✅")'),
    // Text phrases
    page.locator(
      '[class*="slot"]:has-text("Booked"), [class*="slot"]:has-text("Reserved"), ' +
      '[class*="slot"]:has-text("Confirmed"), [class*="slot"]:has-text("My Booking")'
    ),
  ];

  for (const loc of indicators) {
    try {
      if (await loc.count() > 0) return true;
    } catch { /* selector unsupported — skip */ }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Send "already booked" info email (not a failure)
// ---------------------------------------------------------------------------
async function sendAlreadyBookedEmail(attemptedDate) {
  const config = loadConfig();
  if (!config.notificationEmail || !config.senderEmail) return;

  let appPassword;
  try { appPassword = getSecret('gmail-app-password'); }
  catch { return; }

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: config.senderEmail, pass: appPassword },
    });

    const dateLabel = attemptedDate || new Date().toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });

    await transporter.sendMail({
      from:    `"MU Booking Bot" <${config.senderEmail}>`,
      to:      config.notificationEmail,
      subject: `✅ Table 7 already booked — ${dateLabel}`,
      text: [
        `Table 7 is already booked for ${dateLabel} — no action needed.`,
        '',
        'The bot detected a confirmed booking on Table 7 and skipped the booking step.',
        '',
        `Booking URL: ${BOOKING_URL}`,
      ].join('\n'),
    });

    log(`Already-booked notification sent to ${config.notificationEmail}`);
  } catch (err) {
    log(`Could not send already-booked email: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Send failure email
// ---------------------------------------------------------------------------
async function sendFailureEmail(errorMessage, attemptedDate) {
  const config = loadConfig();
  if (!config.notificationEmail || !config.senderEmail) return;

  let appPassword;
  try { appPassword = getSecret('gmail-app-password'); }
  catch { log('Failure email skipped — email not configured.'); return; }

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: config.senderEmail, pass: appPassword },
    });

    const dateLabel = attemptedDate || new Date().toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });

    await transporter.sendMail({
      from:    `"MU Booking Bot" <${config.senderEmail}>`,
      to:      config.notificationEmail,
      subject: `⚠️ Rec Center booking failed — attempted ${dateLabel}`,
      text: [
        `The bot tried to book a table for ${dateLabel} but could not complete the booking.`,
        '',
        `Error: ${errorMessage}`,
        '',
        'What to do:',
        '  1. Open booking.log in the mu-booking-bot folder for full details.',
        '  2. Check for an error-*.png screenshot saved in the same folder.',
        '  3. Run manually: node index.js --headed',
        '',
        `Booking URL: ${BOOKING_URL}`,
      ].join('\n'),
    });

    log(`Failure email sent to ${config.notificationEmail}`);
  } catch (err) {
    log(`Could not send failure email: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Core booking logic (called up to twice — retry once on failure)
// ---------------------------------------------------------------------------
async function doBooking(page) {
  // Ensure we're on the booking page
  if (!page.url().includes('booking')) {
    log('Navigating to booking page…');
    await page.goto(BOOKING_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  }
  await page.waitForLoadState('networkidle', { timeout: 20_000 });

  // Advance to the furthest available date by clicking the right arrow
  const attemptedDate = await navigateToLatestDate(page);
  if (attemptedDate) log(`Targeting date: ${attemptedDate}`);

  // Try each table in priority order — click its tab, then look for slots
  let chosenSlot = null;
  let chosenTable = null;

  for (const tableNum of TABLE_PRIORITY) {
    log(`Checking Table ${tableNum}…`);

    const tabFound = await clickTableTab(page, tableNum);
    if (!tabFound) {
      log(`Table ${tableNum} tab not found — skipping.`);
      continue;
    }
    await page.waitForTimeout(600); // let slots render

    // For Table 7 first: check if we already have a booking on this date
    if (tableNum === 7) {
      log('Checking if Table 7 is already booked…');
      if (await isTableAlreadyBooked(page)) {
        return { tableNum: 7, slotLabel: null, alreadyBooked: true, attemptedDate };
      }
    }

    const slot = await findAvailableSlots(page);
    if (slot) {
      chosenSlot  = slot;
      chosenTable = tableNum;
      if (tableNum !== 7) log(`Table 7 unavailable — booking Table ${tableNum} instead.`);
      break;
    }
    log(`Table ${tableNum} — no available slots.`);
  }

  if (!chosenSlot) {
    throw new Error('No available slots found for any table. All tables may be fully booked.');
  }

  log(`Clicking latest slot for Table ${chosenTable}: "${chosenSlot.label}"`);
  await chosenSlot.element.scrollIntoViewIfNeeded();
  await chosenSlot.element.click();
  await page.waitForLoadState('domcontentloaded', { timeout: 15_000 });

  // Confirm the booking
  log('Looking for confirmation button…');
  const confirmBtn = page
    .getByRole('button', { name: /confirm|book|reserve|submit/i })
    .or(page.locator('[type="submit"]'))
    .first();

  await confirmBtn.waitFor({ timeout: 15_000 });
  await confirmBtn.click();
  await page.waitForLoadState('domcontentloaded', { timeout: 15_000 });

  // Verify success
  const bodyText = await page.locator('body').innerText();
  if (!/confirmed|booked|reservation|success|thank you/i.test(bodyText)) {
    await saveErrorScreenshot(page);
    log('Booking submitted but no clear success message detected — screenshot saved for review.');
  }

  return { tableNum: chosenTable, slotLabel: chosenSlot.label, attemptedDate };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  log('=== mu-booking-bot starting ===');

  checkDayOfWeek();
  checkExceptions();

  let username, password;
  try {
    username = getSecret('username');
    password = getSecret('password');
  } catch (err) {
    log(`ERROR: ${err.message}`);
    process.exit(1);
  }
  log(`Credentials loaded for user: ${username}`);

  const headless = true;

  const context = await chromium.launchPersistentContext(BOT_PROFILE_DIR, {
    headless,
    channel:  'chrome',
    slowMo:   headless ? 0 : 80,
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  // Declared outside try/catch so the catch block can always reference them
  let result       = null;
  let attemptedDate = null;

  try {
    // ── Navigate to booking page ───────────────────────────────────────────
    log(`Navigating to ${BOOKING_URL}`);
    await page.goto(BOOKING_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // ── Login (skip if session is still active) ────────────────────────────
    // Fusion auto-opens #modalLogin when not logged in. Check for the Bootstrap
    // `.show` class (present in the DOM regardless of CSS animation state) rather
    // than isVisible(), which can be fooled by opacity transitions.
    // Give the page an extra moment to finish its JS bootstrap before checking.
    await page.waitForTimeout(1_500);
    const modalOpen = await page.locator('#modalLogin.show').count() > 0;

    if (!modalOpen) {
      log('No login modal — session already active, skipping login and Duo.');
      // Wait for the booking widget to fully render before proceeding
      await page.waitForSelector('#divBookingDateSelector, button.single-date-select-button', { timeout: 15_000 })
        .catch(() => log('WARNING: booking widget did not appear within 15s — proceeding anyway.'));
    } else {
      log('Login modal detected (#modalLogin.show) — clicking UC Davis Login…');

      const loginModal    = page.locator('#modalLogin');
      const ucdavisLoginBtn = loginModal.locator('button.btn-sso-cas, [data-provider-name="JasigCas"]').first();
      await ucdavisLoginBtn.waitFor({ timeout: 10_000 });
      await ucdavisLoginBtn.click();

      await page.waitForURL(/(cas|login)\.ucdavis\.edu/, { timeout: 20_000 });
      log(`CAS page: ${page.url()}`);

      await page.locator('#username, [name="username"], [name="uid"]').first().fill(username);
      await page.locator('#password, [name="password"]').first().fill(password);

      log('Submitting CAS credentials…');
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20_000 }),
        page.locator('[name="submit"], [type="submit"], button:has-text("Login"), button:has-text("Sign in")').first().click(),
      ]);
      log(`Post-CAS URL: ${page.url()}`);

      // Duo
      const isDuoUniversal = page.url().includes('duosecurity.com') || page.url().includes('duoapi');
      if (isDuoUniversal || await page.locator('iframe[src*="duosecurity"]').count() > 0) {
        if (isDuoUniversal) {
          log('Duo Universal Prompt — sending push…');
          await tryDuoPush(page);
        } else {
          log('Legacy Duo iframe — sending push…');
          const frame = page.frameLocator('iframe[src*="duosecurity"], iframe[id="duo_iframe"]');
          await frame.locator('button:has-text("Send Me a Push"), input[value*="Push"]').first().click({ timeout: 15_000 });
        }
      } else {
        try {
          await page.waitForURL(/duosecurity\.com/, { timeout: 8_000 });
          await tryDuoPush(page);
        } catch {
          log('No Duo challenge — already authenticated or auto-pushed.');
        }
      }

      log(`Waiting up to ${DUO_TIMEOUT_MS / 1000}s for Duo approval…`);
      await page.waitForURL(/rec\.ucdavis\.edu/, { timeout: DUO_TIMEOUT_MS });
      log('Duo approved — session saved, future runs will skip Duo.');
      // Wait for the booking widget to render after redirect
      await page.waitForSelector('#divBookingDateSelector, button.single-date-select-button', { timeout: 15_000 })
        .catch(() => log('WARNING: booking widget did not appear after login — proceeding anyway.'));
    }

    // ── Book — retry once on failure ──────────────────────────────────────
    let lastError = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        if (attempt === 2) {
          log('Retrying booking (attempt 2 of 2)…');
          await page.reload({ waitUntil: 'networkidle', timeout: 30_000 });
        }
        result = await doBooking(page);
        attemptedDate = result.attemptedDate;
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        log(`Attempt ${attempt} failed: ${err.message}`);
        if (attempt < 2) await page.waitForTimeout(8_000);
      }
    }

    if (lastError) throw lastError;

    if (result.alreadyBooked) {
      log(`Table 7 is already booked for ${result.attemptedDate || 'the target date'} — skipping.`);
      await sendAlreadyBookedEmail(result.attemptedDate);
    } else {
      log(`SUCCESS: Booking confirmed — Table ${result.tableNum} | ${result.slotLabel}`);
      await sendCalendarInvite(result.tableNum);
    }

  } catch (err) {
    log(`ERROR: ${err.message}`);
    await saveErrorScreenshot(page);
    await sendFailureEmail(err.message, attemptedDate);
    process.exitCode = 1;
  } finally {
    await page.waitForTimeout(2_500);
    await context.close();
    log('Browser closed. Done.');
  }
}

// ---------------------------------------------------------------------------
// Duo push helper
// ---------------------------------------------------------------------------
async function tryDuoPush(page) {
  try {
    await page
      .getByRole('button', { name: /send.*push|push/i })
      .or(page.locator('[data-testid="push-button"], [aria-label*="push" i]'))
      .first()
      .click({ timeout: 2_000 });
    log('Duo push triggered');
  } catch {
    log('Duo push button not found — may have auto-pushed.');
  }
}

// ---------------------------------------------------------------------------
// Find available time-slot elements on the currently-visible table tab.
// Call this AFTER clickTableTab() so the right content is showing.
// ---------------------------------------------------------------------------
async function findAvailableSlots(page) {
  // Fast-skip: if the page shows an explicit "unavailable" / "fully booked" banner
  // for this table, bail out immediately without scanning every element.
  const bodySnippet = await page.locator('body').innerText({ timeout: 2_000 }).catch(() => '');
  if (/no\s+(available\s+)?slots?|fully\s+booked|not\s+available|unavailable/i.test(bodySnippet.slice(0, 3000))) {
    // Only bail if there is also NO "Book Now" text — avoids false positives
    if (!/book\s+now/i.test(bodySnippet.slice(0, 3000))) return null;
  }

  let candidates = [];

  // Strategy A: explicit "available" slot classes containing a time
  const slotLocs = [
    '[class*="slot"]:not([class*="unavailable"]):not([class*="disabled"]):not([class*="booked"])',
    '[data-status="available"]',
    '.available',
    '[class*="timeslot"]:not([class*="unavailable"]):not([class*="disabled"])',
  ];
  for (const sel of slotLocs) {
    const els = await page.locator(sel).all();
    for (const el of els) {
      const text = (await el.innerText().catch(() => '')).trim();
      if (/\d{1,2}(?::\d{2})?\s*(?:am|pm)/i.test(text)) candidates.push(el);
    }
    if (candidates.length > 0) break;
  }

  // Strategy B: "Book Now" / "Book" / "Reserve" CTA buttons
  // Fusion shows a "Book Now" button for each available slot.
  if (candidates.length === 0) {
    const bookNow = await page
      .locator('button:not([disabled]), a, [role="button"]:not([aria-disabled="true"])')
      .all();
    for (const el of bookNow) {
      const text = (await el.innerText().catch(() => '')).trim();
      if (/^(book(\s+now)?|reserve|select)$/i.test(text)) {
        candidates.push(el);
      }
    }
  }

  // Strategy C: any enabled button/link whose text looks like a time
  if (candidates.length === 0) {
    const clickable = await page
      .locator('button:not([disabled]), [role="button"]:not([aria-disabled="true"])')
      .all();
    for (const el of clickable) {
      const text = (await el.innerText().catch(() => '')).trim();
      if (/\d{1,2}(?::\d{2})?\s*(?:am|pm)/i.test(text) && text.length < 60) {
        candidates.push(el);
      }
    }
  }

  if (candidates.length === 0) return null;
  return await selectLatest(candidates);
}

// Pick the slot with the latest time from a list of candidates.
// Also tries to pull a date string from the slot's parent/ancestor elements
// so that the label passed to the calendar invite contains the actual booked date.
async function selectLatest(slots) {
  let best = null;
  let bestMinutes = -1;

  for (const slot of slots) {
    const ownText = (await slot.innerText().catch(async () =>
      (await slot.getAttribute('aria-label').catch(() => ''))
    )).trim();

    // Try to enrich with a date from ancestor context (row, section, heading above)
    let dateContext = '';
    for (const ancestorSel of [
      'xpath=ancestor::tr[1]',
      'xpath=ancestor::section[1]',
      'xpath=ancestor::div[contains(@class,"day") or contains(@class,"date") or contains(@class,"column")][1]',
      'xpath=preceding-sibling::*[contains(@class,"date") or contains(@class,"header")][1]',
    ]) {
      try {
        const ancestor = slot.locator(ancestorSel);
        if (await ancestor.count() > 0) {
          const t = (await ancestor.first().innerText().catch(() => '')).trim();
          // Only keep it if it looks like it has a date, not a giant wall of text
          if (t.length < 120 && /\d{1,2}[\/-]\d{1,2}|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|monday|tuesday|wednesday|thursday|friday)/i.test(t)) {
            dateContext = t;
            break;
          }
        }
      } catch { /* xpath unsupported in this context — skip */ }
    }

    // Combine: prefer "<date context> — <own text>" so parseSlotDateTime sees the date
    const combined = dateContext && !ownText.includes(dateContext)
      ? `${dateContext} — ${ownText}`
      : ownText;

    const tokens = combined.match(/\d{1,2}(?::\d{2})?\s*(?:am|pm)/gi) || [];
    for (const token of tokens) {
      const mins = parseTimeToMinutes(token);
      if (mins !== null && mins > bestMinutes) {
        bestMinutes = mins;
        best = { element: slot, label: combined.slice(0, 160) };
      }
    }
    if (!best) best = { element: slot, label: combined.slice(0, 160) };
  }

  return best;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
main().catch(err => {
  log(`FATAL: ${err.message}`);
  process.exit(1);
});
