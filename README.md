# AkaunWatch — check before you transfer

A community website, like caller ID but for **bank account numbers**. Before paying a seller, landlord
or "agent", people search the account number and see whether others have reported it as a scam.

Separate from the Semak Mule project. Not affiliated with PDRM, BNM or any bank.

## Features
- **Search any account number** (all banks + e-wallets). Shows a risk level, the number of reports, how many
  *different* people reported, total RM lost, community votes and search count.
- **Report a scam account**: bank, name on the account, scam type, platform, amount, date and what happened.
- **Community votes**: "It was legit" / "It was a scam". Legit votes balance out wrong reports.
- **Disputes**: account owners can challenge reports, and moderators can clear the account.
- **Moderation panel** at `/#/admin`: hide or restore reports, approve or reject disputes.
- Home page: stats, a live feed of the latest reports and the most common scam types.

## Protecting innocent people
- Risk is based on **distinct reporters**, so one person can't push an account to "High risk" alone.
- Names are always partly hidden (`AH*** B** AL*`). The public feed hides most of the account number.
  The full number is only shown to someone who typed it in.
- Phone numbers, emails and IC numbers are removed from descriptions automatically.
- Reporter IPs are never stored, only a salted one-way hash used for spam limits.
- Rate limits: 5 reports/hour, 1 report per account per day, a hidden honeypot field to catch bots,
  and a required "this is truthful" checkbox.
- Strict security headers (CSP, nosniff, frame-deny). All user text is shown as plain text, never as HTML.

## Run it
Requires **Node.js 22.5+**. There are no dependencies to install because it uses the built-in `node:sqlite`.

```bash
npm run seed      # optional: add demo data (account numbers start with 0000)
ADMIN_TOKEN=choose-a-long-secret HASH_SALT=another-secret npm start
```
Open http://localhost:3000 and try account `000011223344`.

| Env var | Purpose |
|---|---|
| `PORT` | Default 3000 |
| `ADMIN_TOKEN` | Turns on the moderation panel (`/#/admin`) |
| `HASH_SALT` | Secret salt for IP hashing. **Set this in production** |
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
