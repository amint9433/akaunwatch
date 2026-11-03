// Adds DEMO data so you can see how the site looks. Account numbers start with 0000 so they
// cannot collide with real accounts. Run `npm run reset` to wipe everything before going live.
const crypto = require('crypto');
const db = require('./db');

const h = (s) => crypto.createHash('sha256').update('seed' + s).digest('hex').slice(0, 32);
const ago = (days) => new Date(Date.now() - days * 864e5).toISOString().replace('T', ' ').slice(0, 19);

const demo = [
  ['000011223344', 'Maybank', 'DEMO SELLER ONE', 'shopping', 'Facebook Marketplace', 450, 2, 'Bought an iPhone 15 from a Marketplace seller. Paid deposit + balance, seller blocked me right after transfer. Same photos used in other listings.', 'a'],
  ['000011223344', 'Maybank', 'DEMO SELLER ONE', 'shopping', 'Facebook Marketplace', 1200, 5, 'Same account! Selling a PS5 at cheap price, asked for full payment first, then disappeared. Profile name keeps changing.', 'b'],
  ['000011223344', 'Maybank', 'DEMO SELLER ONE', 'shopping', 'Carousell', 300, 9, 'Ordered concert merchandise. Got fake tracking number, never received anything. Seller unreachable after 2 days.', 'c'],
  ['000055667788', 'CIMB Bank', 'DEMO INVESTMENT AGENT', 'investment', 'Telegram', 15000, 1, 'Joined a "forex signal" group, they showed fake profits on a dashboard. Asked to pay withdrawal tax to this account before I can cash out. Never got anything back.', 'd'],
  ['000055667788', 'CIMB Bank', 'DEMO INVESTMENT AGENT', 'investment', 'WhatsApp', 8000, 3, 'Investment scheme promising 30% weekly returns. First small withdrawal worked, then asked to top-up more. Account frozen on their "platform".', 'e'],
  ['000099887766', 'Public Bank', null, 'job', 'WhatsApp', 2300, 4, 'Part-time job liking TikTok videos. After a few small payouts they asked me to "pre-pay" for tasks into this account to unlock commission.', 'f'],
  ['000044332211', "Touch 'n Go eWallet", 'DEMO RENTER', 'rental', 'Mudah.my', 900, 12, 'Room rental ad in Subang. Asked for booking deposit before viewing, claimed they are overseas. Address does not exist.', 'g'],
  ['000077001122', 'RHB Bank', 'DEMO OFFICER', 'impersonation', 'Phone call', 32000, 6, 'Caller claimed to be from a courier then transferred me to a "police officer" saying my IC was used for money laundering. Told to move savings to this "safe" account.', 'h'],
];

const ins = db.prepare(`INSERT INTO reports (account, bank, holder_name, category, platform, amount, incident_date, description, reporter_hash, created_at)
                        VALUES (?,?,?,?,?,?,?,?,?,?)`);
for (const [acc, bank, name, cat, plat, amt, d, desc, who] of demo) {
  ins.run(acc, bank, name, cat, plat, amt, ago(d + 1).slice(0, 10), desc, h(who), ago(d));
}
const vote = db.prepare('INSERT OR IGNORE INTO votes (account, voter_hash, vote) VALUES (?,?,?)');
['x1', 'x2', 'x3', 'x4'].forEach((v) => vote.run('000011223344', h(v), 'scam'));
['y1', 'y2', 'y3', 'y4', 'y5'].forEach((v) => vote.run('000012121212', h(v), 'safe'));
const s = db.prepare('INSERT INTO searches (account, created_at) VALUES (?,?)');
for (let i = 0; i < 40; i++) s.run(demo[i % demo.length][0], ago(i % 10));

console.log(`Seeded ${demo.length} demo reports. Try searching 000011223344 or 000055667788.`);
