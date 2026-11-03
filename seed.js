// Adds DEMO data so you can see how the site looks. Account numbers start with 0000 so they
// cannot collide with real accounts. Run `npm run reset` to wipe everything before going live.
const crypto = require('crypto');
const db = require('./db');

const h = (s) => crypto.createHash('sha256').update('seed' + s).digest('hex').slice(0, 32);
const ago = (days) => new Date(Date.now() - days * 864e5).toISOString().replace('T', ' ').slice(0, 19);

// [account, bank, name, category, platform, amount, daysAgo, description, reporter, status]
const demo = [
  ['000011223344', 'Maybank', 'DEMO SELLER ONE', 'shopping', 'Facebook Marketplace', 450, 2, 'I paid a deposit and the balance for a phone listed on Marketplace. After the transfer the seller stopped replying and I never received the item.', 'a', 'visible'],
  ['000011223344', 'Maybank', 'DEMO SELLER ONE', 'shopping', 'Facebook Marketplace', 1200, 5, 'Paid in full for a game console that was listed below market price. No delivery and no reply after payment.', 'b', 'visible'],
  ['000011223344', 'Maybank', 'DEMO SELLER ONE', 'shopping', 'Carousell', 300, 9, 'Ordered merchandise and was given a tracking number that does not exist. Item never arrived and messages are unanswered.', 'c', 'visible'],
  ['000055667788', 'CIMB Bank', 'DEMO AGENT', 'investment', 'Telegram', 15000, 1, 'Joined a trading signal group. The dashboard showed profits but I was told to pay a "withdrawal tax" to this account first. I never received any money back.', 'd', 'visible'],
  ['000055667788', 'CIMB Bank', 'DEMO AGENT', 'investment', 'WhatsApp', 8000, 3, 'Was promised weekly returns. A small first withdrawal worked, then I was asked to top up more and the platform account was frozen.', 'e', 'visible'],
  ['000099887766', 'Public Bank', null, 'job', 'WhatsApp', 2300, 4, 'Offered a part-time online task job. After small payouts I was asked to pre-pay into this account to unlock commission, which was never paid.', 'f', 'visible'],
  ['000044332211', "Touch 'n Go eWallet", 'DEMO RENTER', 'rental', 'Mudah.my', 900, 12, 'Paid a booking deposit for a room before viewing because the advertiser said they were overseas. The address given does not exist.', 'g', 'visible'],
  ['000077001122', 'RHB Bank', 'DEMO OFFICER', 'impersonation', 'Phone call', 32000, 6, 'A caller claiming to be from a courier and then the police told me to move my savings to this account for "safekeeping".', 'h', 'pending'],
];

const ins = db.prepare(`INSERT INTO reports (account, bank, holder_name, police_ref, category, platform, amount, incident_date, description, reporter_hash, status, created_at)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
demo.forEach(([acc, bank, name, cat, plat, amt, d, desc, who, status], i) => {
  ins.run(acc, bank, name, `DEMO/RPT/${1000 + i}`, cat, plat, amt, ago(d + 1).slice(0, 10), desc, h(who), status, ago(d));
});
const vote = db.prepare(`INSERT OR IGNORE INTO votes (account, voter_hash, vote) VALUES (?,?,'safe')`);
['y1', 'y2', 'y3', 'y4', 'y5'].forEach((v) => vote.run('000012121212', h(v)));
const s = db.prepare('INSERT INTO searches (account, created_at) VALUES (?,?)');
for (let i = 0; i < 40; i++) s.run(demo[i % demo.length][0], ago(i % 10));

console.log(`Seeded ${demo.length} demo reports (1 waiting for moderation). Try searching 000011223344 or 000055667788.`);
