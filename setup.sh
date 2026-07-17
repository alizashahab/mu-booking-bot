#!/usr/bin/env bash
# setup.sh — one-time setup for mu-booking-bot
# ─────────────────────────────────────────────
# Run this script once. It will:
#   1. Check for Node.js (and guide you to install it if missing)
#   2. Install Node dependencies
#   3. Install the Playwright Chromium browser
#   4. Securely save your UC Davis credentials to macOS Keychain
#   5. Install and activate the launchd job (runs daily Mon–Thu at 10 AM)
# ─────────────────────────────────────────────

set -euo pipefail

# Colors for readability
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
RESET='\033[0m'

ok()   { echo -e "${GREEN}✔ ${1}${RESET}"; }
info() { echo -e "${BOLD}▶ ${1}${RESET}"; }
warn() { echo -e "${YELLOW}⚠ ${1}${RESET}"; }
fail() { echo -e "${RED}✖ ${1}${RESET}"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLIST_NAME="com.mubooking.plist"
PLIST_SRC="${SCRIPT_DIR}/${PLIST_NAME}"
PLIST_DEST="${HOME}/Library/LaunchAgents/${PLIST_NAME}"
KEYCHAIN_SERVICE="mu-booking-bot"

echo ""
echo -e "${BOLD}══════════════════════════════════════════${RESET}"
echo -e "${BOLD}   mu-booking-bot  ·  Setup${RESET}"
echo -e "${BOLD}══════════════════════════════════════════${RESET}"
echo ""

# ── 1. Node.js ────────────────────────────────────────────────────────────────
info "Checking for Node.js…"
if ! command -v node &>/dev/null; then
  fail "Node.js not found. Install it with:\n\n    brew install node\n\nThen re-run this script."
fi
NODE_VERSION=$(node --version)
ok "Node.js found: ${NODE_VERSION}"

NODE_PATH="$(command -v node)"
ok "Node binary: ${NODE_PATH}"

# ── 2. npm install ────────────────────────────────────────────────────────────
info "Installing Node dependencies…"
cd "${SCRIPT_DIR}"
npm install --silent
ok "npm dependencies installed"

# ── 3. Playwright browser ─────────────────────────────────────────────────────
info "Installing Playwright Chromium browser (this may take a minute)…"
npx playwright install chromium
ok "Playwright Chromium installed"

# ── 4. Keychain credentials ───────────────────────────────────────────────────
info "Setting up macOS Keychain credentials…"
echo ""
echo "  Your UC Davis username and password will be stored in your"
echo "  macOS Keychain under the service name '${KEYCHAIN_SERVICE}'."
echo "  They are never written to any file on disk."
echo ""

read -r -p "  Enter your UC Davis username (e.g. jsmith): " UC_USERNAME
if [[ -z "${UC_USERNAME}" ]]; then
  fail "Username cannot be empty."
fi

# Read password without echoing it
read -r -s -p "  Enter your UC Davis password: " UC_PASSWORD
echo ""
if [[ -z "${UC_PASSWORD}" ]]; then
  fail "Password cannot be empty."
fi

# Delete existing entries if present (so we don't get duplicate conflicts)
security delete-generic-password -s "${KEYCHAIN_SERVICE}" -a "username" &>/dev/null || true
security delete-generic-password -s "${KEYCHAIN_SERVICE}" -a "password" &>/dev/null || true

# Store new credentials
security add-generic-password -s "${KEYCHAIN_SERVICE}" -a "username" -w "${UC_USERNAME}"
security add-generic-password -s "${KEYCHAIN_SERVICE}" -a "password" -w "${UC_PASSWORD}"
ok "Credentials stored in Keychain"

# ── 5. Email notifications (optional) ────────────────────────────────────────
info "Setting up email notifications (optional)…"
echo ""
echo "  If the booking fails, the bot can email you automatically."
echo "  This requires a Gmail address to send FROM and a Gmail App Password."
echo "  (If you want to skip this, just press Enter when asked for the email address.)"
echo ""

read -r -p "  Email address to send alerts TO (press Enter to skip): " NOTIFY_EMAIL

if [[ -n "${NOTIFY_EMAIL}" ]]; then
  echo ""
  echo "  You need a Gmail address to send the alerts FROM."
  echo "  It can be any Gmail account — a personal one is fine."
  echo ""
  read -r -p "  Gmail address to send FROM: " SENDER_EMAIL
  echo ""
  echo "  You need a Gmail App Password (NOT your regular Gmail password)."
  echo "  To get one:"
  echo "    1. Go to myaccount.google.com"
  echo "    2. Click 'Security' → '2-Step Verification' (must be enabled)"
  echo "    3. Scroll down to 'App passwords'"
  echo "    4. Create one named 'mu-booking-bot'"
  echo "    5. Copy the 16-character password it gives you"
  echo ""
  read -r -s -p "  Gmail App Password (16 characters, no spaces): " GMAIL_APP_PASSWORD
  echo ""

  # Save non-sensitive config to file
  echo "{\"notificationEmail\": \"${NOTIFY_EMAIL}\", \"senderEmail\": \"${SENDER_EMAIL}\"}" > "${SCRIPT_DIR}/config.json"

  # Save app password to Keychain
  security delete-generic-password -s "${KEYCHAIN_SERVICE}" -a "gmail-app-password" &>/dev/null || true
  security add-generic-password -s "${KEYCHAIN_SERVICE}" -a "gmail-app-password" -w "${GMAIL_APP_PASSWORD}"
  ok "Email notifications configured — alerts will go to ${NOTIFY_EMAIL}"
else
  # Remove any old email config if re-running setup
  rm -f "${SCRIPT_DIR}/config.json"
  security delete-generic-password -s "${KEYCHAIN_SERVICE}" -a "gmail-app-password" &>/dev/null || true
  ok "Skipping email notifications"
fi

# ── 6. Patch and install launchd plist ────────────────────────────────────────
info "Installing launchd job…"

# Replace the placeholder tokens in the plist with real paths
PLIST_TMP="${PLIST_SRC}.tmp"
sed \
  -e "s|NODE_PATH|${NODE_PATH}|g" \
  -e "s|SCRIPT_DIR|${SCRIPT_DIR}|g" \
  "${PLIST_SRC}" > "${PLIST_TMP}"

# Move patched plist into LaunchAgents
mkdir -p "${HOME}/Library/LaunchAgents"
cp "${PLIST_TMP}" "${PLIST_DEST}"
rm -f "${PLIST_TMP}"
ok "Plist installed to ${PLIST_DEST}"

# Unload any existing job (ignore error if it wasn't loaded)
launchctl unload "${PLIST_DEST}" 2>/dev/null || true

# Load the new job
launchctl load "${PLIST_DEST}"
ok "launchd job loaded — will run Mon–Thu at 10:00 AM"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}══════════════════════════════════════════${RESET}"
echo -e "${GREEN}${BOLD}   Setup complete!${RESET}"
echo -e "${GREEN}${BOLD}══════════════════════════════════════════${RESET}"
echo ""
echo "  • The bot will open a visible browser window at 10:00 AM"
echo "    Monday–Thursday and book Table 7 automatically."
echo ""
echo "  • Approve the Duo Push on your phone when prompted."
echo ""
echo "  • To skip specific date ranges (e.g. finals, breaks), edit:"
echo "      ${SCRIPT_DIR}/exceptions.json"
echo ""
echo "  • Logs are saved to:"
echo "      ${SCRIPT_DIR}/booking.log"
echo ""
echo "  • To run manually right now:"
echo "      node ${SCRIPT_DIR}/index.js"
echo ""
echo "  • To stop the job permanently:"
echo "      launchctl unload ${PLIST_DEST}"
echo "      rm ${PLIST_DEST}"
echo ""
