// AkaunWatch front-end — tiny hash-routed SPA, no framework.
// All user content is inserted with textContent via the h() helper (XSS-safe).
'use strict';

// Set to false once a Malaysian advocate & solicitor has reviewed the Terms and Privacy Notice.
const LEGAL_DRAFT = true;

const app = document.getElementById('app');
let META = null;

// ---------- utilities ----------
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v; // CSSOM is allowed by our strict CSP
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

const meta = async () => META || (META = await api('/api/meta'));
const digits = (s) => String(s || '').replace(/\D/g, '');
const fmtAcc = (s) => s.replace(/(.{4})/g, '$1 ').trim();
const rm = (n) => 'RM ' + Number(n || 0).toLocaleString('en-MY', { maximumFractionDigits: 0 });
const num = (n) => Number(n || 0).toLocaleString('en-MY');
function ago(sqlDate) {
  if (!sqlDate) return '';
  const d = new Date(sqlDate.replace(' ', 'T') + 'Z');
  const s = (Date.now() - d) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  if (s < 86400 * 30) return Math.floor(s / 86400) + ' d ago';
  return d.toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric' });
}
const spinner = () => h('div', { class: 'spinner', role: 'status', 'aria-label': 'Loading' });
const alertBox = (msg, kind = 'err') => h('div', { class: 'alert ' + kind, role: 'alert' }, msg);
const formData = (form) => Object.fromEntries(new FormData(form).entries());
const options = (list, placeholder) => [h('option', { value: '' }, placeholder), ...list.map(([v, l]) => h('option', { value: v }, l))];
const unverified = () => h('span', { class: 'unverified' }, 'Unverified allegation by a member of the public');

function searchBox(value = '') {
  const input = h('input', { name: 'q', inputmode: 'numeric', autocomplete: 'off', placeholder: 'Enter bank account number', 'aria-label': 'Bank account number', value });
  const form = h('form', { class: 'search', role: 'search', onsubmit: (e) => {
    e.preventDefault();
    const a = digits(input.value);
    if (a.length < 6 || a.length > 20) { input.setCustomValidity('Enter 6–20 digits'); input.reportValidity(); return; }
    location.hash = '#/check/' + a;
  } }, input, h('button', { class: 'btn', type: 'submit' }, 'Check'));
  input.addEventListener('input', () => input.setCustomValidity(''));
  return form;
}

// Labels describe what users reported. They never call anyone a scammer.
const LEVELS = {
  high: {
    icon: '⛔', label: (n) => `Reported by ${n} different users`,
    advice: 'Several different people say they lost money after transferring to this account. These reports are not verified by AkaunWatch, but we strongly suggest you do not transfer until you have confirmed who you are paying by other means.',
  },
  medium: {
    icon: '⚠️', label: () => 'Reported by 2 different users',
    advice: 'Two people reported a problem with this account. The reports are not verified. Check the person or seller carefully before paying.',
  },
  low: {
    icon: '❕', label: () => 'Reported by 1 user',
    advice: 'One person reported a problem. It may be a misunderstanding or a dispute. Read the report and judge carefully.',
  },
  none: {
    icon: '✅', label: () => 'No published reports',
    advice: 'No published reports for this account. That is not a guarantee: new accounts are opened all the time. Stay alert and also check PDRM Semak Mule.',
  },
  review: {
    icon: '🕒', label: () => 'Under review',
    advice: 'The account holder has disputed the reports. Report details are hidden while a moderator reviews the dispute (decision within 14 days).',
  },
  cleared: {
    icon: '🛡️', label: () => 'Cleared after review',
    advice: 'Earlier reports on this account were reviewed and removed after the account holder’s dispute.',
  },
};

function feedItem(r) {
  // The feed only shows masked numbers, so items are not links.
  return h('article', { class: 'feed-item' },
    h('div', { class: 'dot', 'aria-hidden': 'true' }, '!'),
    h('div', {},
      h('div', {}, h('span', { class: 'acc' }, r.account), ' ', h('span', { class: 'tag' }, r.bank), h('span', { class: 'tag' }, r.categoryLabel)),
      h('p', { class: 'desc' }, r.description + (r.description.length >= 160 ? '…' : '')),
      unverified(),
    ),
    h('div', { class: 'when' }, (r.amount ? rm(r.amount) + ' · ' : '') + ago(r.createdAt)),
  );
}

// ---------- pages ----------
async function pageHome() {
  const statsEl = h('div', { class: 'stats' });
  const feedEl = h('div', { class: 'feed' }, spinner());
  const catsEl = h('div', { class: 'bars' });

  app.replaceChildren(
    h('section', { class: 'hero' },
      h('h1', {}, 'Check before you transfer.'),
      h('p', {}, 'Search a bank account number to see whether other users have reported problems after transferring money to it.'),
      searchBox(),
      h('p', { class: 'hint' }, 'Try the demo account ', h('a', { href: '#/check/000011223344' }, '0000 1122 3344'), ' · Numbers only, any bank or e-wallet'),
    ),
    statsEl,
    h('div', { class: 'cols section' },
      h('section', {},
        h('div', { class: 'section-head' }, h('h2', {}, 'Latest published reports'), h('a', { href: '#/report' }, 'Report an account →')),
        feedEl),
      h('aside', { class: 'card' },
        h('h2', { style: 'font-size:1.1rem' }, 'What people reported'), catsEl,
        h('p', { class: 'muted', style: 'font-size:.85rem;margin-top:16px' },
          'Every report is checked by a moderator before it is published. Reports are allegations by members of the public and are not verified by AkaunWatch.'),
      ),
    ),
  );

  const [stats, recent] = await Promise.all([api('/api/stats'), api('/api/recent')]);
  statsEl.replaceChildren(
    ...[[num(stats.accounts), 'Accounts with reports'], [num(stats.reports), 'Published reports'], [rm(stats.lost), 'Losses described in reports'], [num(stats.searches), 'Searches (last 90 days)']]
      .map(([n, l]) => h('div', { class: 'stat' }, h('div', { class: 'n' }, n), h('div', { class: 'l' }, l))),
  );
  feedEl.replaceChildren(...(recent.length ? recent.map(feedItem)
    : [h('div', { class: 'card empty' }, 'No published reports yet.')]));

  const max = Math.max(1, ...stats.categories.map((r) => r.n));
  catsEl.replaceChildren(...(stats.categories.length ? stats.categories.slice(0, 6).map((r) => h('div', { class: 'bar' }, h('span', {}, r.label), h('b', {}, r.n),
    h('div', { class: 'track' }, h('div', { class: 'fill', style: `width:${(r.n / max) * 100}%` })))) : [h('p', { class: 'muted' }, 'No data yet')]));
}

async function pageCheck(account) {
  app.replaceChildren(h('div', { class: 'section' }, searchBox(fmtAcc(account))), spinner());
  let data;
  try { data = await api('/api/lookup?account=' + encodeURIComponent(account)); }
  catch (e) { app.replaceChildren(h('div', { class: 'section' }, searchBox(fmtAcc(account))), h('div', { class: 'section' }, alertBox(e.message))); return; }
  renderResult(data);
}

function renderResult(d) {
  const L = LEVELS[d.level];
  const s = d.stats;
  const voteMsg = h('span', { class: 'muted', style: 'font-size:.9rem' });
  const vote = async (btn) => {
    btn.disabled = true;
    try { renderResult(await api('/api/votes', { method: 'POST', body: { account: d.account, vote: 'safe' } })); }
    catch (e) { voteMsg.textContent = e.message; btn.disabled = false; }
  };
  const hasReports = ['high', 'medium', 'low'].includes(d.level);

  const head = h('section', { class: 'result-head lv-' + d.level },
    h('div', { class: 'verdict' }, h('span', { 'aria-hidden': 'true' }, L.icon), L.label(s.reporters)),
    h('div', { class: 'acc' }, fmtAcc(d.account)),
    d.banks.length ? h('div', { style: 'margin-top:6px' }, ...d.banks.map((b) => h('span', { class: 'tag' }, b))) : null,
    h('p', { style: 'margin-top:12px;margin-bottom:0' }, L.advice),
    h('div', { class: 'result-meta' },
      hasReports ? h('span', {}, h('b', {}, num(s.reports)), ' published reports from ', h('b', {}, num(s.reporters)), ' different users') : null,
      hasReports && s.totalLost ? h('span', {}, h('b', {}, rm(s.totalLost)), ' in losses described') : null,
      h('span', {}, h('b', {}, num(s.safeVotes)), ' users said their deal was fine'),
      h('span', {}, 'Searched ', h('b', {}, num(s.searches)), ' times in the last 90 days'),
      d.lastReported ? h('span', {}, 'Last report ', h('b', {}, ago(d.lastReported))) : null,
    ),
    d.level !== 'cleared' ? h('div', { class: 'vote-row' },
      h('span', { style: 'font-weight:600' }, 'Did you deal with this account and everything was fine?'),
      h('button', { class: 'btn sm ok', onclick: (e) => vote(e.currentTarget) }, '👍 My deal was fine'),
      voteMsg,
    ) : null,
  );

  const reportsCard = h('section', { class: 'card section' },
    h('div', { class: 'section-head' }, h('h2', {}, 'What users reported'),
      h('a', { class: 'btn sm', href: '#/report/' + d.account }, '+ Report a problem')),
    ...(d.reports.length ? d.reports.map((r) => h('article', { class: 'report' },
      h('div', { class: 'top' },
        h('div', {}, h('span', { class: 'tag' }, r.categoryLabel), r.platform ? h('span', { class: 'tag' }, 'via ' + r.platform) : null, h('span', { class: 'tag' }, r.bank)),
        h('span', { class: 'muted', style: 'font-size:.85rem' }, (r.amount ? rm(r.amount) + ' · ' : '') + ago(r.createdAt)),
      ),
      h('p', { class: 'desc' }, r.description),
      unverified(),
    )) : [h('p', { class: 'muted' }, {
      cleared: 'Reports were removed after review.',
      review: 'Report details are hidden while the dispute is reviewed.',
    }[d.level] || 'No published reports. If you lost money after transferring to this account, make a police or NSRC report first, then tell us.')]),
  );

  app.replaceChildren(...[
    h('div', { class: 'section' }, searchBox(fmtAcc(d.account))),
    head,
    reportsCard,
    h('div', { class: 'owner-box section' },
      h('div', {},
        h('b', {}, 'Is this your account?'),
        h('p', { style: 'margin:4px 0 0' }, 'If these reports are wrong, tell us. While we review, reports from fewer than 3 users are hidden. We never charge to review or remove a report.')),
      h('a', { class: 'btn ghost', href: '#/dispute/' + d.account }, 'This is my account')),
    h('div', { class: 'notice section' },
      'AkaunWatch shows what members of the public told us. It is not a police or bank record. Also check the official ',
      h('b', {}, 'Semak Mule'), ' portal by PDRM.'),
  ].filter(Boolean));
}

async function pageReport(prefill = '') {
  const m = await meta();
  const msg = h('div');
  const form = h('form', { class: 'form card', novalidate: true },
    h('div', { class: 'notice warn' }, h('b', {}, 'Lost money? Act fast first: '), 'call the National Scam Response Centre at ', h('b', {}, '997'),
      ' and your bank, then make a police report. You will need the report number below.'),
    h('div', { class: 'grid2' },
      h('label', {}, 'Account number you transferred to *', h('input', { name: 'account', inputmode: 'numeric', required: true, value: prefill ? fmtAcc(prefill) : '', placeholder: 'e.g. 1234 5678 9012' })),
      h('label', {}, 'Bank / e-wallet *', h('select', { name: 'bank', required: true }, options(m.banks.map((b) => [b, b]), 'Choose…'))),
    ),
    h('div', { class: 'grid2' },
      h('label', {}, h('span', {}, 'Police report or NSRC reference no. * ', h('small', {}, '(private — moderators only)')),
        h('input', { name: 'policeRef', required: true, maxlength: 40, placeholder: 'e.g. IPD/123/2026' })),
      h('label', {}, h('span', {}, 'Name shown when you transferred ', h('small', {}, '(private — moderators only)')),
        h('input', { name: 'holderName', maxlength: 80 })),
    ),
    h('div', { class: 'grid2' },
      h('label', {}, 'What happened? *', h('select', { name: 'category', required: true }, options(Object.entries(m.categories), 'Choose…'))),
      h('label', {}, 'Where did you meet them?', h('input', { name: 'platform', maxlength: 60, placeholder: 'Facebook, Telegram, Shopee chat…' })),
    ),
    h('div', { class: 'grid2' },
      h('label', {}, 'Amount transferred (RM)', h('input', { name: 'amount', type: 'number', min: 0, step: '0.01', placeholder: '0' })),
      h('label', {}, 'Date of transfer', h('input', { name: 'incidentDate', type: 'date', max: new Date().toISOString().slice(0, 10) })),
    ),
    h('label', {}, h('span', {}, 'Describe what happened to you * ', h('small', {}, '(phone numbers, emails and IC numbers are removed automatically)')),
      h('textarea', { name: 'description', required: true, minlength: 30, maxlength: 2000,
        placeholder: 'Describe what happened to you, step by step. Stick to facts. Do not name or label anyone (e.g. do not write "he is a scammer").' })),
    h('input', { class: 'hp', name: 'website', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' }),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'confirm', required: true }),
      h('span', {}, 'I confirm this is my own experience and is true. I have made a police or NSRC report. I am responsible for what I write, and I agree to the ',
        h('a', { href: '#/terms', target: '_blank' }, 'Terms of Use'), ' and ', h('a', { href: '#/privacy', target: '_blank' }, 'Privacy Notice'),
        '. I understand false reports can harm innocent people and may be removed.')),
    msg,
    h('div', {}, h('button', { class: 'btn', type: 'submit' }, 'Submit for review')),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    const body = formData(form); body.confirm = !!body.confirm;
    btn.disabled = true; msg.replaceChildren();
    try {
      await api('/api/reports', { method: 'POST', body });
      app.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'card' },
        h('h1', {}, 'Thank you — report received'),
        h('p', {}, 'A moderator checks every report before it is published. Your report will not appear publicly until it has been reviewed.'),
        h('p', { class: 'muted' }, 'We never publish your identity, the name you entered or your police report number.'),
        h('p', { style: 'margin-top:16px' }, h('a', { class: 'btn', href: '#/' }, 'Back to home')),
      )));
    } catch (err) { msg.replaceChildren(alertBox(err.message)); btn.disabled = false; }
  });

  app.replaceChildren(h('div', { class: 'page' },
    h('h1', {}, 'Report an account'),
    h('p', { class: 'muted' }, 'Tell others what happened after you transferred money. Every report is reviewed before it is published.'),
    form,
  ));
}

async function pageDispute(prefill = '') {
  const m = await meta();
  const msg = h('div');
  const form = h('form', { class: 'form card' },
    h('div', { class: 'grid2' },
      h('label', {}, 'Your account number *', h('input', { name: 'account', inputmode: 'numeric', required: true, value: prefill ? fmtAcc(prefill) : '' })),
      h('label', {}, 'Bank *', h('select', { name: 'bank', required: true }, options(m.banks.map((b) => [b, b]), 'Choose…'))),
    ),
    h('div', { class: 'grid2' },
      h('label', {}, 'Full name (as per bank) *', h('input', { name: 'name', required: true, maxlength: 80 })),
      h('label', {}, 'Email *', h('input', { name: 'email', type: 'email', required: true, maxlength: 120 })),
    ),
    h('label', {}, h('span', {}, 'Explain why the reports are wrong * ', h('small', {}, '(e.g. item delivered, refund made, misunderstanding)')),
      h('textarea', { name: 'explanation', required: true, minlength: 30, maxlength: 3000 })),
    h('input', { class: 'hp', name: 'website', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' }),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'consent', required: true }),
      h('span', {}, 'I agree that AkaunWatch may use these details to review my dispute, as described in the ', h('a', { href: '#/privacy', target: '_blank' }, 'Privacy Notice'), '.')),
    msg,
    h('div', {}, h('button', { class: 'btn', type: 'submit' }, 'Submit dispute')),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    const btn = form.querySelector('button[type=submit]');
    const body = formData(form); body.consent = !!body.consent;
    btn.disabled = true; msg.replaceChildren();
    try {
      await api('/api/disputes', { method: 'POST', body });
      form.replaceChildren(h('h2', {}, 'Dispute received'),
        h('p', {}, 'We will acknowledge your dispute by email within 2 working days and decide within 14 days. We may ask for proof, such as a bank statement showing the account is yours or delivery receipts.'),
        h('p', {}, 'While we review, reports from fewer than 3 different users on this account are hidden.'));
    } catch (err) { msg.replaceChildren(alertBox(err.message)); btn.disabled = false; }
  });
  app.replaceChildren(h('div', { class: 'page' },
    h('h1', {}, 'This is my account'),
    h('p', { class: 'muted' }, 'If your account was reported unfairly, tell us. A moderator reviews every dispute.'),
    takedownPolicy(m),
    h('div', { class: 'section' }, form),
  ));
}

function takedownPolicy(m) {
  return h('div', { class: 'card' },
    h('h2', { style: 'font-size:1.15rem' }, 'Our dispute and takedown policy'),
    h('ul', {},
      h('li', {}, 'We acknowledge every dispute within ', h('b', {}, '2 working days'), ' and decide within ', h('b', {}, '14 days'), '.'),
      h('li', {}, 'While a dispute is open, reports from fewer than 3 different users are hidden.'),
      h('li', {}, 'If the reports are wrong, we remove them and show the account as "Cleared after review".'),
      h('li', {}, 'We keep a record of every decision.'),
      h('li', {}, h('b', {}, 'We never charge money'), ' to review, remove or clear a report. Anyone asking you for payment in our name is not us.'),
      h('li', {}, 'Legal notices: ', h('a', { href: 'mailto:' + m.contactEmail }, m.contactEmail)),
    ),
  );
}

function pageAbout() {
  app.replaceChildren(h('div', { class: 'page' },
    h('h1', {}, 'How AkaunWatch works'),
    h('div', { class: 'card' },
      h('ol', { class: 'steps' },
        h('li', {}, h('b', {}, 'Search before you pay. '), 'Enter the account number a seller, landlord or "agent" gives you. You see whether other users have reported problems.'),
        h('li', {}, h('b', {}, 'Report what happened to you. '), 'Make a police or NSRC report first, then tell us. A moderator reviews every report before it is published.'),
        h('li', {}, h('b', {}, 'Say when a deal was fine. '), 'If you dealt with an account and everything was fine, you can say so.'),
        h('li', {}, h('b', {}, 'Account holders can respond. '), 'If an account was reported unfairly, the holder can dispute it, and we review within 14 days.'),
      ),
    ),
    h('div', { class: 'card section' },
      h('h2', {}, 'What the labels mean'),
      ...['high', 'medium', 'low', 'none', 'review', 'cleared'].map((k) => h('p', {}, h('b', {}, LEVELS[k].icon + ' ' + LEVELS[k].label('3 or more') + ': '), LEVELS[k].advice)),
      h('p', { class: 'muted' }, 'Labels only count different users whose reports passed moderation. They describe what people reported; they are not a finding that anyone committed an offence.'),
    ),
    h('div', { class: 'card section' },
      h('h2', {}, 'Official channels'),
      h('ul', {},
        h('li', {}, h('b', {}, 'NSRC 997'), ': National Scam Response Centre hotline. Call immediately after a scam transfer.'),
        h('li', {}, h('b', {}, 'Semak Mule'), ': PDRM CCID portal for accounts and phone numbers linked to police reports.'),
        h('li', {}, h('b', {}, 'Your bank'), ': call its fraud hotline to ask for the transfer to be stopped or frozen.'),
      ),
    ),
  ));
}

function draftBanner() {
  return LEGAL_DRAFT ? h('div', { class: 'notice warn', style: 'margin-bottom:16px' }, 'Draft for legal review — not yet final.') : null;
}

async function pageTerms() {
  const m = await meta();
  const S = (title, ...items) => h('section', { class: 'card section legal' }, h('h2', {}, title), ...items);
  app.replaceChildren(h('div', { class: 'page' },
    h('h1', {}, 'Terms of Use'),
    draftBanner(),
    S('1. Who we are',
      h('p', {}, 'AkaunWatch is operated by ', h('b', {}, m.operator), ' ("we"). It is a free community service. We are not affiliated with PDRM, Bank Negara Malaysia, MCMC or any bank.')),
    S('2. What the reports are',
      h('p', {}, 'Reports are written by members of the public about their own experience. They are allegations, not facts verified by us, and they are not a finding that anyone committed an offence. Do not rely on AkaunWatch alone. Always use official channels such as NSRC 997 and PDRM Semak Mule.')),
    S('3. If you submit a report, you promise that',
      h('ul', {},
        h('li', {}, 'it describes your own experience and is true to the best of your knowledge;'),
        h('li', {}, 'you have made a police or NSRC report about it;'),
        h('li', {}, 'you will not name or insult anyone, or include other people’s personal details;'),
        h('li', {}, 'you are not reporting to harass someone, settle a personal dispute or hurt a competitor.')),
      h('p', {}, 'You are responsible for what you submit. We may edit, refuse, hide or remove any report at our discretion, and we review every report before it is published.')),
    S('4. Disputes and takedowns',
      h('p', {}, 'Account holders may dispute reports. We acknowledge disputes within 2 working days and decide within 14 days. While a dispute is open, reports from fewer than 3 different users are hidden. We never charge money to review, remove or clear a report.')),
    S('5. Not allowed',
      h('ul', {},
        h('li', {}, 'false or misleading reports;'),
        h('li', {}, 'automated access, scraping or bulk copying of the site;'),
        h('li', {}, 'using the site to harass, threaten or expose anyone.'))),
    S('6. Authorities',
      h('p', {}, 'We may share information with the police or other authorities when the law requires it, or to help investigate a scam.')),
    S('7. Liability',
      h('p', {}, 'The service is provided "as is". To the extent the law allows, we are not liable for decisions you make based on the site, including transfers you make or do not make.')),
    S('8. Law and contact',
      h('p', {}, 'These terms are governed by the laws of Malaysia. Contact and legal notices: ', h('a', { href: 'mailto:' + m.contactEmail }, m.contactEmail), '.')),
  ));
}

async function pagePrivacy() {
  const m = await meta();
  const r = m.retention;
  const S = (title, ...items) => h('section', { class: 'card section legal' }, h('h2', {}, title), ...items);
  app.replaceChildren(h('div', { class: 'page' },
    h('h1', {}, 'Privacy Notice / Notis Privasi'),
    draftBanner(),
    h('p', { class: 'muted' }, 'English followed by Bahasa Melayu. Data user: ', m.operator, '. Contact: ', h('a', { href: 'mailto:' + m.contactEmail }, m.contactEmail)),

    S('What we collect and why',
      h('ul', {},
        h('li', {}, h('b', {}, 'Reports: '), 'account number, bank, what happened, amount, date and platform, which are published after moderation. The name shown at transfer and your police/NSRC reference are private and only seen by moderators to check reports.'),
        h('li', {}, h('b', {}, 'Disputes: '), 'your name, email and explanation, used only to review your dispute.'),
        h('li', {}, h('b', {}, 'Spam protection: '), 'a one-way scrambled code (hash) made from your internet address. We do not store your internet address itself.'),
        h('li', {}, h('b', {}, 'Searches: '), 'which account numbers are searched, to show search counts.'))),
    S('Account holders',
      h('p', {}, 'If your account number appears in a report, you can see what is published by searching for it, ask us to correct it, or dispute it from the "This is my account" page.')),
    S('Who sees it',
      h('p', {}, 'Moderators. The police or other authorities if the law requires it. Our hosting provider stores the data on servers that may be outside Malaysia.')),
    S('How long we keep it',
      h('ul', {},
        h('li', {}, `Search records: ${r.searchDays} days.`),
        h('li', {}, `Dispute email addresses: deleted ${r.disputeEmailDays} days after a decision.`),
        h('li', {}, `Published reports: removed from public view after about ${Math.round(r.reportDays / 365)} years.`),
        h('li', {}, 'Moderation records are kept so we can show how decisions were made.'))),
    S('Your rights',
      h('p', {}, 'You can ask to access or correct your personal data, or withdraw consent, by emailing ', h('a', { href: 'mailto:' + m.contactEmail }, m.contactEmail), '. We will reply within 21 days. If there is a data breach that affects you, we will notify you and the authorities as required by law.')),

    h('h2', { class: 'section' }, 'Bahasa Melayu'),
    S('Data yang kami kumpul dan sebabnya',
      h('ul', {},
        h('li', {}, h('b', {}, 'Laporan: '), 'nombor akaun, bank, apa yang berlaku, jumlah, tarikh dan platform, yang disiarkan selepas semakan moderator. Nama yang dipaparkan semasa pindahan dan nombor laporan polis/NSRC adalah sulit dan hanya dilihat oleh moderator.'),
        h('li', {}, h('b', {}, 'Pertikaian: '), 'nama, e-mel dan penjelasan anda, hanya untuk menyemak pertikaian.'),
        h('li', {}, h('b', {}, 'Perlindungan spam: '), 'kod sehala (hash) daripada alamat internet anda. Kami tidak menyimpan alamat internet itu sendiri.'),
        h('li', {}, h('b', {}, 'Carian: '), 'nombor akaun yang dicari, untuk menunjukkan jumlah carian.'))),
    S('Pemegang akaun',
      h('p', {}, 'Jika nombor akaun anda ada dalam laporan, anda boleh mencarinya untuk melihat apa yang disiarkan, meminta pembetulan, atau membuat pertikaian melalui halaman "This is my account".')),
    S('Siapa yang melihat data',
      h('p', {}, 'Moderator. Polis atau pihak berkuasa lain jika dikehendaki oleh undang-undang. Penyedia hosting kami mungkin menyimpan data di luar Malaysia.')),
    S('Tempoh simpanan',
      h('ul', {},
        h('li', {}, `Rekod carian: ${r.searchDays} hari.`),
        h('li', {}, `E-mel pertikaian: dipadam ${r.disputeEmailDays} hari selepas keputusan.`),
        h('li', {}, `Laporan yang disiarkan: dikeluarkan daripada paparan awam selepas kira-kira ${Math.round(r.reportDays / 365)} tahun.`),
        h('li', {}, 'Rekod moderasi disimpan untuk menunjukkan bagaimana keputusan dibuat.'))),
    S('Hak anda',
      h('p', {}, 'Anda boleh meminta akses atau pembetulan data peribadi anda, atau menarik balik persetujuan, dengan menghantar e-mel ke ', h('a', { href: 'mailto:' + m.contactEmail }, m.contactEmail), '. Kami akan membalas dalam masa 21 hari. Jika berlaku pelanggaran data yang menjejaskan anda, kami akan memaklumkan anda dan pihak berkuasa seperti yang dikehendaki undang-undang.')),
  ));
}

async function pageAdmin() {
  let token = '';
  try { token = sessionStorage.getItem('aw_admin') || ''; } catch {}
  const body = h('div');
  const tokenInput = h('input', { type: 'password', placeholder: 'Admin token', value: token });
  const login = h('form', { class: 'search', style: 'margin:0', onsubmit: (e) => { e.preventDefault(); token = tokenInput.value; try { sessionStorage.setItem('aw_admin', token); } catch {} load(); } },
    tokenInput, h('button', { class: 'btn' }, 'Open'));
  app.replaceChildren(h('div', { class: 'section' }, h('h1', {}, 'Moderation'), login, body));

  const call = (path, data) => api(path, { method: data ? 'POST' : 'GET', body: data, headers: { 'X-Admin-Token': token } });
  // Every action asks for a reason, which is stored in the moderation log.
  const act = (question, fn, required = false) => async (e) => {
    const note = prompt(question);
    if (note === null) return;
    if (required && note.trim().length < 5) { alert('Please write a short reason (5+ characters).'); return; }
    e.target.disabled = true;
    try { await fn(note); load(); } catch (err) { alert(err.message); e.target.disabled = false; }
  };
  const reportRow = (r, buttons) => h('tr', { class: r.status === 'hidden' || r.status === 'expired' ? 'dim' : '' },
    h('td', {}, h('a', { href: '#/check/' + r.account }, fmtAcc(r.account)), h('br'), h('small', { class: 'muted' }, r.bank),
      h('br'), h('small', { class: 'muted' }, r.reporters + ' reporter(s) total')),
    h('td', {}, r.categoryLabel, h('br'), h('small', { class: 'muted' }, [r.amount ? rm(r.amount) : null, ago(r.created_at)].filter(Boolean).join(' · ')),
      h('br'), h('small', {}, 'Police/NSRC: ', h('b', {}, r.police_ref || '—')), r.holder_name ? [h('br'), h('small', {}, 'Name: ', r.holder_name)] : null),
    h('td', { style: 'max-width:360px' }, r.description),
    h('td', {}, h('code', {}, r.reporter_hash), h('br'), h('small', { class: 'muted' }, r.status)),
    h('td', {}, buttons),
  );
  const table = (heads, rows) => h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, ...heads.map((t) => h('th', {}, t)))), h('tbody', {}, ...rows)));

  async function load() {
    body.replaceChildren(spinner());
    let d;
    try { d = await call('/api/admin/overview'); } catch (e) { body.replaceChildren(h('div', { class: 'section' }, alertBox(e.message))); return; }
    const status = (r, action, label, cls) => h('button', { class: 'btn sm ' + cls,
      onclick: act(`${label} report #${r.id}. Reason (optional):`, (note) => call('/api/admin/report-status', { id: r.id, action, note })) }, label);

    body.replaceChildren(
      h('section', { class: 'card section' }, h('h2', {}, `Waiting for review (${d.pending.length})`),
        h('p', { class: 'muted' }, 'Before approving, check that the police/NSRC reference looks real and the description is factual, does not name anyone and does not call anyone a criminal.'),
        d.pending.length ? table(['Account', 'Details', 'Description', 'Reporter', ''], d.pending.map((r) =>
          reportRow(r, [status(r, 'approve', 'Approve', 'ok'), ' ', status(r, 'reject', 'Reject', 'danger')]))) : h('p', { class: 'muted' }, 'Nothing to review.')),

      h('section', { class: 'card section' }, h('h2', {}, 'Disputes'),
        h('p', { class: 'muted' }, 'Acknowledge by email within 2 working days. Decide within 14 days.'),
        d.disputes.length ? table(['Account', 'Owner', 'Explanation', 'Status', ''], d.disputes.map((x) => h('tr', {},
          h('td', {}, h('a', { href: '#/check/' + x.account }, fmtAcc(x.account)), h('br'), h('small', { class: 'muted' }, x.bank)),
          h('td', {}, x.name, h('br'), h('small', { class: 'muted' }, x.email)),
          h('td', { style: 'max-width:340px' }, x.explanation, x.decision_note ? [h('br'), h('small', { class: 'muted' }, 'Decision: ' + x.decision_note)] : null),
          h('td', {}, x.status, h('br'), h('small', { class: 'muted' }, ago(x.created_at))),
          h('td', {}, x.status === 'pending' ? [
            h('button', { class: 'btn sm ok', onclick: act('Clear this account. Reason (kept in log):', (note) => call('/api/admin/dispute', { id: x.id, decision: 'upheld', note }), true) }, 'Clear account'), ' ',
            h('button', { class: 'btn sm ghost', onclick: act('Reject this dispute. Reason (kept in log):', (note) => call('/api/admin/dispute', { id: x.id, decision: 'rejected', note }), true) }, 'Reject'),
          ] : ''),
        ))) : h('p', { class: 'muted' }, 'No disputes.')),

      d.cleared.length ? h('section', { class: 'card section' }, h('h2', {}, 'Cleared accounts'),
        ...d.cleared.map((c) => h('p', {}, fmtAcc(c.account), ' — ', c.note || '', ' ',
          h('button', { class: 'btn sm ghost', onclick: act('Undo clearing. Reason (kept in log):', (note) => call('/api/admin/unclear', { account: c.account, note }), true) }, 'Undo')))) : null,

      h('section', { class: 'card section' }, h('h2', {}, 'Reviewed reports'),
        d.reports.length ? table(['Account', 'Details', 'Description', 'Reporter', ''], d.reports.map((r) =>
          reportRow(r, r.status === 'visible' ? status(r, 'hide', 'Hide', 'danger') : status(r, 'restore', 'Restore', 'ghost')))) : h('p', { class: 'muted' }, 'None yet.')),

      h('section', { class: 'card section' }, h('h2', {}, 'Moderation log'),
        d.log.length ? table(['When', 'Action', 'Target', 'Reason', 'By'], d.log.map((l) => h('tr', {},
          h('td', {}, ago(l.created_at)), h('td', {}, l.action), h('td', {}, l.target), h('td', {}, l.note || '—'), h('td', {}, h('code', {}, l.actor_hash || ''))))) : h('p', { class: 'muted' }, 'No actions yet.')),
    );
  }
  if (token) load();
}

// ---------- router ----------
async function route() {
  const [, page = '', arg = ''] = (location.hash || '#/').split('/');
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#/' + (page === 'check' ? '' : page)));
  window.scrollTo(0, 0);
  try {
    if (page === 'check' && arg) await pageCheck(digits(arg));
    else if (page === 'report') await pageReport(digits(arg));
    else if (page === 'dispute') await pageDispute(digits(arg));
    else if (page === 'about') pageAbout();
    else if (page === 'terms') await pageTerms();
    else if (page === 'privacy') await pagePrivacy();
    else if (page === 'admin') await pageAdmin();
    else await pageHome();
  } catch (e) {
    app.replaceChildren(h('div', { class: 'section' }, alertBox(e.message)));
  }
}
window.addEventListener('hashchange', route);
route();
