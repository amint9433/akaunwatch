# AkaunWatch — check before you transfer

A community website, like caller ID but for **bank account numbers**. Before paying a seller, landlord
or "agent", people search the account number and see whether others have reported it as a scam.

Separate from the Semak Mule project. Not affiliated with PDRM, BNM or any bank.

## Features
- **Search any account number** (all banks and e-wallets). The page shows how many *different* users reported
  problems, what they described, and how many users said their deal was fine.
- **Report an account**: a police report or NSRC reference number is required. Every report is
  **reviewed by a moderator before it is published**.
- **"This is my account"**: account holders can dispute reports. While a dispute is open, reports from fewer than
  3 users are hidden. Disputes are decided within 14 days.
- **Moderation panel** at `/#/admin`: a review queue, disputes, hiding and restoring reports, and a
  **log of every action with its reason**.
- **Terms of Use** and a **Privacy Notice in English and Bahasa Melayu** at `/#/terms` and `/#/privacy`.
  Both are drafts for a lawyer to review. Set `LEGAL_DRAFT = false` in `public/app.js` after the review.

## Legal safeguards (from the legal-banking-advisor review)
- **Neutral wording**: the site never says "scam" or "scammer". Labels read "Reported by N different users",
  and every report is marked "Unverified allegation by a member of the public".
- **Labels count only distinct users whose reports were approved.** Votes cannot make a label worse.
- **Private by default**: the name at transfer and the police reference are seen by moderators only.
  The public feed hides most of each account number. Phone, email and IC numbers in descriptions are removed automatically.
- **Data retention (PDPA)**: search logs are kept 90 days, dispute emails are deleted 30 days after the decision,
  and published reports expire after about 2 years.
- **Never charge to remove a report**: this is stated in the Terms and on the dispute page.
- The server refuses to start without a proper `HASH_SALT`. Reporter IPs are never stored, only a salted hash of them.
- Rate limits, one report per account per day, and a hidden honeypot field to catch bots.

## Run it
Requires **Node.js 22.5+**. There are no dependencies to install because it uses the built-in `node:sqlite`.

```bash
npm run seed      # optional: add demo data (account numbers start with 0000)
ADMIN_TOKEN=choose-a-long-secret HASH_SALT=another-long-secret CONTACT_EMAIL=you@example.com OPERATOR_NAME="Your Company Sdn Bhd" npm start
```
Open http://localhost:3000 and try account `000011223344`.

| Env var | Purpose |
|---|---|
| `PORT` | Default 3000 |
| `ADMIN_TOKEN` | Turns on the moderation panel (`/#/admin`) |
| `HASH_SALT` | **Required.** Secret salt for IP hashing (8+ characters) |
| `CONTACT_EMAIL` | Shown for disputes, legal notices and privacy requests |
| `OPERATOR_NAME` | Legal name of the operator (e.g. your Sdn Bhd), shown in the Terms and Privacy Notice |
| `TRUST_PROXY=1` | Use `X-Forwarded-For` when the app runs behind Nginx or Cloudflare |
| `DATA_DIR` | Where the SQLite file is stored (default `./data`) |

Before launch, wipe the demo data with `npm run reset`.

## Deploying
Any host with persistent disk works, for example a small VPS, Railway or Render with a volume, or Fly.io with a volume.
Put it behind HTTPS and set `TRUST_PROXY=1`.

## Files
- `server.js`: HTTP server, API, risk scoring, validation, rate limits
- `db.js`: SQLite schema
- `seed.js`: demo data
- `public/`: front end (plain HTML, CSS and JS, no build step)

### Windows (PowerShell)
```
npm.cmd run seed
$env:ADMIN_TOKEN="choose-a-long-secret"; $env:HASH_SALT="another-long-secret"; $env:CONTACT_EMAIL="you@example.com"; npm.cmd start
```
