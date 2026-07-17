# Table 7 Booking Bot

An automated bot that books a tabling spot for the Muslim Student Association (MSA) at the UC Davis Memorial Union. New dates are released four weeks out at 10:00 AM and the good tables go within minutes, so the bot runs every Monday–Thursday at exactly 10:00, grabs the newly released date, and reserves our preferred table. If Table 7 is already taken, it works outward to the next-closest tables until it finds one that's free.

It was built end-to-end using AI tools — I scoped the problem, directed the approach, and tested each iteration; the AI wrote the code. The repo also includes a full handoff guide so a successor can run and maintain it without me.

## How it works

The bot runs on a Mac. A `launchd` job (`com.mubooking.plist`) fires it at 10:00 AM, Monday through Thursday. Because macOS won't wake a sleeping machine on its own, setup also schedules a `pmset` wake five minutes earlier — so the Mac has to be plugged in for the job to run.

Each run does roughly this:

1. **Skip check.** If today isn't Mon–Thu, or falls inside a blackout range in `exceptions.json` (e.g. finals week, breaks), the bot logs it and exits.
2. **Log in.** It drives Chrome with Playwright, opens the booking page, and signs in through UC Davis CAS. The very first run needs a Duo Push approval on your phone; after that the browser session is saved to a local profile and reused, so later runs skip login and Duo entirely.
3. **Find the target date.** The booking site (Fusion) keeps all bookable dates in the page. The bot advances to the furthest-out one — the date that was just released this morning, about four weeks ahead — and selects it.
4. **Pick a table, spiral outward.** It tries tables in this order, starting at 7 and fanning out to the nearest neighbors: `7 → 6 → 8 → 5 → 9 → 4 → 10 → 3 → 11 → 2 → 12 → 1 → 13`. For Table 7 it first checks whether a booking already exists (and if so, stops and reports that). Otherwise it takes the first table in that order that has an open slot, choosing the latest time slot available on it, then confirms the reservation and checks the page for a success message.
5. **Retry once.** If a run fails partway through, it reloads and tries the whole booking once more before giving up.
6. **Notify (optional).** On success it can email a calendar invite; on failure it can email an alert with the error and a saved screenshot. Both are only sent if email is configured during setup — otherwise everything just goes to `booking.log`.

A few honest caveats:

- **The start of each quarter is manual.** The Memorial Union releases the first four weeks of dates all at once on registration day. The bot only books one date per day, so it can't grab that bulk drop — you book those by hand, then the bot takes over the next morning. The handoff guide explains this in detail.
- **It depends on the booking site's page structure.** This is a personal-scale automation that reads the live page, not an official API, so a redesign of the booking site can break the selectors. The handoff guide includes a walkthrough for updating them.
- Email alerts and the calendar invite are optional add-ons, not required for booking to work.

## Setup

The full step-by-step walkthrough (macOS, in plain language) is in the handoff guide. The short version:

1. **Fill in your two placeholders in `index.js`:**
   - `BOOKING_URL` → the URL of your own reservation page (currently `YOUR_BOOKING_URL_HERE`).
   - `INVITE_TO` → a shared inbox to CC on the calendar invite, if you want one (currently `INVITE_EMAIL_HERE`). Leave the placeholder to skip it.
2. **Run `bash setup.sh`.** It installs dependencies and the Playwright browser, then prompts for the credentials it needs and stores them in the macOS Keychain — nothing sensitive is written to a file:
   - Your UC Davis username and password.
   - Optionally, an alert email address and a Gmail App Password for sending notifications.
   - It then installs and loads the daily `launchd` job.
3. **Schedule the wake** (`sudo pmset repeat wake MTWR 09:55:00`) so the Mac is awake at run time. Keep it plugged in.
4. **Do one test run** (`node index.js`) and approve the Duo Push once.

You must supply your own credentials — none are included in this repo. Runtime files that could contain personal data (the saved browser session, logs, `config.json`, error screenshots) are excluded via `.gitignore` and are created locally when the bot runs.

Add dates you *don't* want the bot to run with `npm run add-exception`, or by editing `exceptions.json` directly.

## Handoff documentation

See [`HANDOFF.html`](HANDOFF.html) — a full, plain-language guide to installing, running, maintaining, and passing on the bot. Open it in any browser.
