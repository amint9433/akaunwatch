// AkaunWatch front-end — tiny hash-routed SPA, no framework.
// All user content is inserted with textContent via the h() helper (XSS-safe).
'use strict';

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
    else if (k === 'html') el.innerHTML = v; // only ever used with static strings
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

const LEVELS = {
  high:    { label: 'High risk — many scam reports', icon: '⛔', advice: 'Multiple people have reported this account. Do NOT transfer money. If you already did, call 997 (NSRC) and your bank right away.' },
  medium:  { label: 'Caution — reported by others', icon: '⚠️', advice: 'More than one report or strong community signals. Verify the seller/person through other means before paying.' },
  low:     { label: 'Low — one report', icon: '❕', advice: 'There is a single unverified report. It may be a dispute or misunderstanding — read it and judge carefully.' },
  none:    { label: 'No reports found', icon: '✅', advice: 'Nobody has reported this account yet. That is not a guarantee it is safe — scammers open new accounts often. Stay alert.' },
  cleared: { label: 'Cleared by moderators', icon: '🛡️', advice: 'Previous reports on this account were reviewed and removed after a successful dispute.' },
};

function feedItem(r) {
  // Feed shows masked numbers only, so items are not links (we never expose a full number to browsers who didn't type it).
  return h('article', { class: 'feed-item' },
    h('div', { class: 'dot', 'aria-hidden': 'true' }, '!'),
    h('div', {},
      h('div', {}, h('span', { class: 'acc' }, r.account), ' ', h('span', { class: 'tag' }, r.bank), h('span', { class: 'tag' }, r.categoryLabel)),
      h('p', { class: 'desc' }, r.description + (r.description.length >= 160 ? '…' : '')),
    ),
    h('div', { class: 'when' }, (r.amount ? rm(r.amount) + ' · ' : '') + ago(r.createdAt)),
  );
}

// ---------- pages ----------
async function pageHome() {
  const statsEl = h('div', { class: 'stats' });
  const feedEl = h('div', { class: 'feed' }, spinner());
  const catsEl = h('div', { class: 'bars' });
  const banksEl = h('div', { class: 'bars' });

  app.replaceChildren(
    h('section', { class: 'hero' },
      h('h1', {}, 'Check before you transfer.'),
      h('p', {}, 'Search a bank account number to see if the community has reported it for scams. Got scammed? Report the account to warn others.'),
      searchBox(),
      h('p', { class: 'hint' }, 'Try the demo account ', h('a', { href: '#/check/000011223344' }, '0000 1122 3344'), ' · Numbers only, any bank or e-wallet'),
    ),
    statsEl,
    h('div', { class: 'cols section' },
      h('section', {},
        h('div', { class: 'section-head' }, h('h2', {}, 'Latest reports'), h('a', { href: '#/report' }, 'Report an account →')),
        feedEl),
      h('aside', { class: 'card' },
        h('h2', { style: 'font-size:1.1rem' }, 'Most reported scam types'), catsEl,
        h('h2', { style: 'font-size:1.1rem;margin-top:20px' }, 'Reported accounts by bank'), banksEl,
      ),
    ),
  );

  const [stats, recent] = await Promise.all([api('/api/stats'), api('/api/recent')]);
  statsEl.replaceChildren(
    ...[[num(stats.accounts), 'Accounts reported'], [num(stats.reports), 'Community reports'], [rm(stats.lost), 'Total reported losses'], [num(stats.searches), 'Searches made']]
      .map(([n, l]) => h('div', { class: 'stat' }, h('div', { class: 'n' }, n), h('div', { class: 'l' }, l))),
  );
  feedEl.replaceChildren(...(recent.length ? recent.map(feedItem) : [h('div', { class: 'card empty' }, 'No reports yet. Be the first to ', h('a', { href: '#/report' }, 'report a scam account'), '.')]));

  const bars = (rows, key, labelKey) => {
    const max = Math.max(1, ...rows.map((r) => r.n));
    return rows.length ? rows.map((r) => h('div', { class: 'bar' }, h('span', {}, r[labelKey]), h('b', {}, r.n),
      h('div', { class: 'track' }, h('div', { class: 'fill', style: `width:${(r.n / max) * 100}%` })))) : [h('p', { class: 'muted' }, 'No data yet')];
  };
  catsEl.replaceChildren(...bars(stats.categories.slice(0, 6), 'n', 'label'));
  banksEl.replaceChildren(...bars(stats.banks, 'n', 'bank'));
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
  const vote = async (v, btn) => {
    btn.disabled = true;
    try { const nd = await api('/api/votes', { method: 'POST', body: { account: d.account, vote: v } }); renderResult(nd); }
    catch (e) { voteMsg.textContent = e.message; btn.disabled = false; }
  };

  const head = h('section', { class: 'result-head lv-' + d.level },
    h('div', { class: 'verdict' }, h('span', { 'aria-hidden': 'true' }, L.icon), L.label),
    h('div', { class: 'acc' }, fmtAcc(d.account)),
    d.banks.length ? h('div', { style: 'margin-top:6px' }, ...d.banks.map((b) => h('span', { class: 'tag' }, b))) : null,
    d.names.length ? h('div', { class: 'muted', style: 'margin-top:6px' }, 'Name used: ', d.names.join(', ')) : null,
    h('p', { style: 'margin-top:12px;margin-bottom:0' }, L.advice),
    h('div', { class: 'result-meta' },
      h('span', {}, h('b', {}, num(s.reports)), ' reports from ', h('b', {}, num(s.reporters)), ' people'),
      s.totalLost ? h('span', {}, h('b', {}, rm(s.totalLost)), ' reported lost') : null,
      h('span', {}, h('b', {}, num(s.scamVotes)), ' say scam · ', h('b', {}, num(s.safeVotes)), ' say safe'),
      h('span', {}, 'Searched ', h('b', {}, num(s.searches)), ' times'),
      d.lastReported ? h('span', {}, 'Last report ', h('b', {}, ago(d.lastReported))) : null,
    ),
    d.level !== 'cleared' ? h('div', { class: 'vote-row' },
      h('span', { style: 'font-weight:600' }, 'Had a deal with this account?'),
      h('button', { class: 'btn sm ok', onclick: (e) => vote('safe', e.currentTarget) }, '👍 It was legit'),
      h('button', { class: 'btn sm danger', onclick: (e) => vote('scam', e.currentTarget) }, '👎 It was a scam'),
      voteMsg,
    ) : null,
  );

  const reportsCard = h('section', { class: 'card section' },
    h('div', { class: 'section-head' }, h('h2', {}, 'Community reports'),
      h('a', { class: 'btn sm', href: '#/report/' + d.account }, '+ Add a report')),
    ...(d.reports.length ? d.reports.map((r) => h('article', { class: 'report' },
      h('div', { class: 'top' },
        h('div', {}, h('span', { class: 'tag' }, r.categoryLabel), r.platform ? h('span', { class: 'tag' }, 'via ' + r.platform) : null, h('span', { class: 'tag' }, r.bank)),
        h('span', { class: 'muted', style: 'font-size:.85rem' }, (r.amount ? rm(r.amount) + ' · ' : '') + ago(r.createdAt)),
      ),
      h('p', { class: 'desc' }, r.description),
    )) : [h('p', { class: 'muted' }, d.level === 'cleared' ? 'Reports were removed after review.' : 'No one has reported this account. If it scammed you, please add a report to protect others.')]),
  );

  app.replaceChildren(...[
    h('div', { class: 'section' }, searchBox(fmtAcc(d.account))),
    head,
    d.pendingDispute ? h('div', { class: 'notice section' }, 'ℹ️ The account owner has submitted a dispute that is under moderator review.') : null,
    reportsCard,
    h('div', { class: 'notice section' },
      'Reports are written by the public and are not verified. Always also check the official ',
      h('b', {}, 'Semak Mule'), ' portal by PDRM. Is this your account and the reports are wrong? ',
      h('a', { href: '#/dispute/' + d.account }, 'Submit a dispute'), '.'),
  ].filter(Boolean));
}

async function pageReport(prefill = '') {
  const m = await meta();
  const msg = h('div');
  const form = h('form', { class: 'form card', novalidate: true },
    h('div', { class: 'grid2' },
      h('label', {}, 'Account number *', h('input', { name: 'account', inputmode: 'numeric', required: true, value: prefill ? fmtAcc(prefill) : '', placeholder: 'e.g. 1234 5678 9012' })),
      h('label', {}, 'Bank / e-wallet *', h('select', { name: 'bank', required: true }, options(m.banks.map((b) => [b, b]), 'Choose…'))),
    ),
    h('label', {}, h('span', {}, 'Name on the account ', h('small', {}, '(as shown when you transferred — will be partially hidden publicly)')),
      h('input', { name: 'holderName', maxlength: 80, placeholder: 'e.g. AHMAD BIN ALI' })),
    h('div', { class: 'grid2' },
      h('label', {}, 'Scam type *', h('select', { name: 'category', required: true }, options(Object.entries(m.categories), 'Choose…'))),
      h('label', {}, 'Where did you meet them?', h('input', { name: 'platform', maxlength: 60, placeholder: 'Facebook, Telegram, Shopee chat…' })),
    ),
    h('div', { class: 'grid2' },
      h('label', {}, 'Amount lost (RM)', h('input', { name: 'amount', type: 'number', min: 0, step: '0.01', placeholder: '0' })),
      h('label', {}, 'Date of transfer', h('input', { name: 'incidentDate', type: 'date', max: new Date().toISOString().slice(0, 10) })),
    ),
    h('label', {}, h('span', {}, 'What happened? * ', h('small', {}, '(phone numbers, emails and IC numbers are removed automatically)')),
      h('textarea', { name: 'description', required: true, minlength: 30, maxlength: 2000, placeholder: 'Describe how the scam happened so others can recognise it. Stick to facts.' })),
    h('input', { class: 'hp', name: 'website', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' }),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'confirm', required: true }),
      h('span', {}, 'I confirm this report is true to the best of my knowledge. I understand false reports can harm innocent people and may be removed.')),
    msg,
    h('div', {}, h('button', { class: 'btn', type: 'submit' }, 'Submit report')),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    const body = formData(form); body.confirm = !!body.confirm;
    btn.disabled = true; msg.replaceChildren();
    try {
      await api('/api/reports', { method: 'POST', body });
      const acc = digits(body.account);
      app.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'card' },
        h('h1', {}, 'Thank you — report submitted'),
        h('p', {}, 'Your report is now visible to everyone who checks this account.'),
        h('div', { class: 'notice warn' }, h('b', {}, 'Lost money? Act fast: '), 'Call the National Scam Response Centre at ', h('b', {}, '997'),
          ' (8am–8pm) and your bank immediately — funds can sometimes be frozen if reported quickly. Then lodge a police report.'),
        h('p', { style: 'margin-top:16px' }, h('a', { class: 'btn', href: '#/check/' + acc }, 'View account'), ' ', h('a', { class: 'btn ghost', href: '#/' }, 'Back to home')),
      )));
    } catch (err) { msg.replaceChildren(alertBox(err.message)); btn.disabled = false; }
  });

  app.replaceChildren(h('div', { class: 'page' },
    h('h1', {}, 'Report a scam account'),
    h('p', { class: 'muted' }, 'Your report helps others avoid the same scam. We never publish your identity.'),
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
    h('label', {}, h('span', {}, 'Explain why the reports are wrong * ', h('small', {}, '(e.g. completed delivery, refund made, misunderstanding)')),
      h('textarea', { name: 'explanation', required: true, minlength: 30, maxlength: 3000 })),
    h('input', { class: 'hp', name: 'website', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' }),
    msg,
    h('div', {}, h('button', { class: 'btn', type: 'submit' }, 'Submit dispute')),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true; msg.replaceChildren();
    try {
      await api('/api/disputes', { method: 'POST', body: formData(form) });
      form.replaceChildren(h('h2', {}, 'Dispute received'), h('p', {}, 'A moderator will review it and contact you by email, usually with a request for proof (e.g. bank statement showing the account is yours, delivery receipts). A "under review" note now shows on the account page.'));
    } catch (err) { msg.replaceChildren(alertBox(err.message)); btn.disabled = false; }
  });
  app.replaceChildren(h('div', { class: 'page' },
    h('h1', {}, 'Dispute a report'),
    h('p', { class: 'muted' }, 'If your account was reported unfairly, tell us. Moderators review every dispute and can clear the account.'),
    form,
  ));
}

function pageAbout() {
  app.replaceChildren(h('div', { class: 'page' },
    h('h1', {}, 'How AkaunWatch works'),
    h('div', { class: 'card' },
      h('ol', { class: 'steps' },
        h('li', {}, h('b', {}, 'Search before you pay. '), 'Enter the account number a seller, landlord or "agent" gives you. You see how many people reported it, what they say, and community votes.'),
        h('li', {}, h('b', {}, 'Report if you were scammed. '), 'Add the account number, bank and what happened. Personal details like phone numbers and IC numbers are stripped automatically.'),
        h('li', {}, h('b', {}, 'Vote on your experience. '), 'Did a deal go fine? Vote "legit" — it balances out false or mistaken reports.'),
        h('li', {}, h('b', {}, 'Owners can dispute. '), 'If an account was reported unfairly, the owner submits a dispute and moderators can clear it.'),
      ),
    ),
    h('div', { class: 'card section' },
      h('h2', {}, 'Risk levels'),
      ...['high', 'medium', 'low', 'none', 'cleared'].map((k) => h('p', {}, h('b', {}, LEVELS[k].icon + ' ' + LEVELS[k].label + ': '), LEVELS[k].advice)),
      h('p', { class: 'muted' }, 'Risk is based on the number of different people who reported (not raw report count), so one person cannot flag an account alone.'),
    ),
    h('div', { class: 'card section' },
      h('h2', {}, 'Official channels'),
      h('p', {}, 'AkaunWatch complements — it does not replace — official checks:'),
      h('ul', {},
        h('li', {}, h('b', {}, 'NSRC 997'), ' — National Scam Response Centre hotline. Call immediately after a scam transfer.'),
        h('li', {}, h('b', {}, 'Semak Mule'), ' — PDRM CCID portal for checking accounts and phone numbers linked to police reports.'),
        h('li', {}, h('b', {}, 'Your bank'), ' — call their fraud hotline to request the transfer be stopped/frozen.'),
      ),
    ),
    h('div', { class: 'card section' },
      h('h2', {}, 'Privacy'),
      h('p', {}, 'We never store reporter IP addresses — only a one-way hash used for spam control. Account holder names are partially hidden. Full account numbers are only shown to someone who already typed that number.'),
    ),
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

  async function load() {
    body.replaceChildren(spinner());
    let d;
    try { d = await call('/api/admin/overview'); } catch (e) { body.replaceChildren(h('div', { class: 'section' }, alertBox(e.message))); return; }
    const act = (fn) => async (e) => { e.currentTarget.disabled = true; try { await fn(); load(); } catch (err) { alert(err.message); } };

    body.replaceChildren(
      h('section', { class: 'card section' }, h('h2', {}, 'Disputes'),
        d.disputes.length ? h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, ...['Account', 'Owner', 'Explanation', 'Status', ''].map((t) => h('th', {}, t)))),
          h('tbody', {}, ...d.disputes.map((x) => h('tr', {},
            h('td', {}, h('a', { href: '#/check/' + x.account }, fmtAcc(x.account)), h('br'), h('small', { class: 'muted' }, x.bank)),
            h('td', {}, x.name, h('br'), h('small', { class: 'muted' }, x.email)),
            h('td', { style: 'max-width:340px' }, x.explanation),
            h('td', {}, x.status, h('br'), h('small', { class: 'muted' }, ago(x.created_at))),
            h('td', {}, x.status === 'pending' ? [
              h('button', { class: 'btn sm ok', onclick: act(() => call('/api/admin/dispute', { id: x.id, decision: 'upheld' })) }, 'Clear account'), ' ',
              h('button', { class: 'btn sm ghost', onclick: act(() => call('/api/admin/dispute', { id: x.id, decision: 'rejected' })) }, 'Reject'),
            ] : ''),
          ))))) : h('p', { class: 'muted' }, 'No disputes.')),
      d.cleared.length ? h('section', { class: 'card section' }, h('h2', {}, 'Cleared accounts'),
        ...d.cleared.map((c) => h('p', {}, fmtAcc(c.account), ' — ', c.note, ' ',
          h('button', { class: 'btn sm ghost', onclick: act(() => call('/api/admin/unclear', { account: c.account })) }, 'Undo')))) : null,
      h('section', { class: 'card section' }, h('h2', {}, 'Latest reports'),
        h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, ...['Account', 'Details', 'Description', 'Reporter', ''].map((t) => h('th', {}, t)))),
          h('tbody', {}, ...d.reports.map((r) => h('tr', { style: r.status === 'hidden' ? 'opacity:.5' : '' },
            h('td', {}, h('a', { href: '#/check/' + r.account }, fmtAcc(r.account)), h('br'), h('small', { class: 'muted' }, r.bank)),
            h('td', {}, r.categoryLabel, h('br'), h('small', { class: 'muted' }, [r.holder_name, r.amount ? rm(r.amount) : null, ago(r.created_at)].filter(Boolean).join(' · '))),
            h('td', { style: 'max-width:360px' }, r.description),
            h('td', {}, h('code', {}, r.reporter_hash)),
            h('td', {}, h('button', { class: 'btn sm ' + (r.status === 'hidden' ? 'ghost' : 'danger'),
              onclick: act(() => call('/api/admin/report-status', { id: r.id, status: r.status === 'hidden' ? 'visible' : 'hidden' })) },
              r.status === 'hidden' ? 'Restore' : 'Hide')),
          )))))),
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
    else if (page === 'admin') await pageAdmin();
    else await pageHome();
  } catch (e) {
    app.replaceChildren(h('div', { class: 'section' }, alertBox(e.message)));
  }
}
window.addEventListener('hashchange', route);
route();
