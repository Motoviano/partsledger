"use strict";
let D, ACC = [], AIDX = {}, I = [], OH = [], COGS = [], ME = null, TODAY;
const fmt = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });
const gbp = v => fmt.format(v || 0), n0 = v => Math.round(v || 0).toLocaleString('en-GB');
const pct = v => isFinite(v) ? (v * 100).toFixed(1) + '%' : '–';
const cls = v => v < 0 ? 'neg' : '';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const $ = id => document.getElementById(id);
function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => t.hidden = true, Math.max(3200, msg.length * 60)); }
// Errors seen in the browser go to the server log; if the server is down they wait and go with the next request.
const logQueue = [];
function logBrowser(where, message, detail) { logQueue.push({ where, message: String(message).slice(0, 900), detail: String(detail || '').slice(0, 3000), at: new Date().toISOString() }); }
function flushLog() { if (!logQueue.length) return; const entries = logQueue.splice(0, 20); fetch('/api/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entries }) }).catch(() => logQueue.unshift(...entries)); }
window.addEventListener('error', e => { logBrowser('page', e.message, `${e.filename}:${e.lineno}:${e.colno}`); setTimeout(flushLog, 500); });
window.addEventListener('unhandledrejection', e => { if (e.reason && e.reason.message === 'login') return; logBrowser('page', e.reason && e.reason.message || e.reason, e.reason && e.reason.stack); setTimeout(flushLog, 500); });
async function api(url, opt = {}) {
  let r;
  try { r = await fetch(url, opt); } catch (e) { logBrowser(url, 'Network error: ' + e.message); throw new Error('Couldn\'t reach Partsledger. Check your internet connection and try again.'); }
  if (r.status === 401) { location.href = '/login'; throw new Error('login'); }
  const j = r.headers.get('content-type')?.includes('json') ? await r.json() : {};
  if (!r.ok) {
    if (!j.error) logBrowser(`${(opt.method || 'GET')} ${url}`, `HTTP ${r.status} with no message (server down or restarting?)`);
    throw new Error(j.error || ([502, 503, 504].includes(r.status)
      ? 'Partsledger is restarting after an update. Wait a minute and try again; nothing was changed.'
      : `Something went wrong (error ${r.status}). Please send a screenshot.`));
  }
  if (logQueue.length) setTimeout(flushLog, 0);
  return j;
}
const post = (url, body) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// ---------------------------------------------------------------- dates
const dt = s => new Date(s + 'T12:00:00Z'), iso = d => d.toISOString().slice(0, 10);
const addD = (s, n) => { const d = dt(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const monday = s => addD(s, -((dt(s).getUTCDay() + 6) % 7));
const mEnd = (y, m) => iso(new Date(Date.UTC(y, m, 0)));
const ym = (y, m) => { while (m < 1) { m += 12; y--; } while (m > 12) { m -= 12; y++; } return [y, m]; };
const first = (y, m) => `${y}-${String(m).padStart(2, '0')}-01`;
function range(key) {
  const t = TODAY, y = +t.slice(0, 4), m = +t.slice(5, 7);
  switch (key) {
    case 'tw': return [monday(t), t];
    case 'lw': { const s = addD(monday(t), -7); return [s, addD(s, 6)]; }
    case 'mtd': return [first(y, m), t];
    case 'lm': { const [py, pm] = ym(y, m - 1); return [first(py, pm), mEnd(py, pm)]; }
    case 'q': { const qs = Math.floor((m - 1) / 3) * 3 + 1; return [first(y, qs), mEnd(y, qs + 2)]; }
    case 'lq': { const [qy, qs] = ym(y, Math.floor((m - 1) / 3) * 3 + 1 - 3); return [first(qy, qs), mEnd(...ym(qy, qs + 2))]; }
    case 'vq': case 'lvq': { // VAT quarters: Mar–May, Jun–Aug, Sep–Nov, Dec–Feb
      let [vy, vs] = ym(y, m - ((m - 3 + 12) % 3)); if (key === 'lvq') [vy, vs] = ym(vy, vs - 3);
      const [ey, em] = ym(vy, vs + 2); return [first(vy, vs), mEnd(ey, em)];
    }
    case 'ytd': return [`${y}-01-01`, t];
    case 'custom': return [$('fFrom').value || '2000-01-01', $('fTo').value || t];
    default: return [D.minDate || '2000-01-01', D.asOf];
  }
}
const nice = s => dt(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

// ---------------------------------------------------------------- filters
let selAcc = () => new Set(), selGrp = () => new Set(), groups = [];
function buildMS(menuId, sumId, items, allLabel, noun) {
  const menu = $(menuId), prev = menu.dataset.built ? new Set([...menu.querySelectorAll('input[data-v]')].filter(b => !b.checked).map(b => b.dataset.v)) : new Set();
  menu.innerHTML = `<label class="all"><input type="checkbox" id="${menuId}-all" checked> ${allLabel}</label>` +
    items.map((it, i) => `<label><input type="checkbox" id="${menuId}-${i}" data-v="${esc(it.v)}" ${prev.has(it.v) ? '' : 'checked'}> ${it.html}${it.note ? `<em>${it.note}</em>` : ''}</label>`).join('');
  menu.dataset.built = 1;
  const all = menu.querySelector('.all input'), boxes = [...menu.querySelectorAll('input[data-v]')], sum = document.querySelector('#' + sumId + ' summary');
  const sync = () => {
    const on = boxes.filter(b => b.checked); all.checked = on.length === boxes.length; all.indeterminate = on.length > 0 && on.length < boxes.length;
    sum.textContent = on.length === boxes.length ? allLabel : on.length === 0 ? 'None selected' : on.length <= 2 ? on.map(b => b.dataset.v).join(', ') : `${on.length} ${noun} selected`;
  };
  all.onchange = () => { boxes.forEach(b => b.checked = all.checked); sync(); ordState.limit = 100; renderAll(); };
  boxes.forEach(b => b.onchange = () => { sync(); ordState.limit = 100; renderAll(); });
  sync(); return () => new Set(boxes.filter(b => b.checked).map(b => b.dataset.v));
}
document.addEventListener('click', e => document.querySelectorAll('details.ms[open]').forEach(d => { if (!d.contains(e.target)) d.open = false; }));
function F() { const an = selAcc(), gs = selGrp(); return { a: new Set(ACC.filter(a => an.has(a.name)).map(a => a.i)), g: gs, allG: gs.size === groups.length, r: range($('fPeriod').value) }; }
const itemsIn = (f, r) => I.filter(x => x.d >= r[0] && x.d <= r[1] && f.a.has(x.a) && f.g.has(x.g));
const ohIn = (f, r) => f.allG ? OH.filter(x => x.d >= r[0] && x.d <= r[1] && f.a.has(x.a)) : [];
const cogsOf = x => x.q * x.uc, stockBack = x => x.ret ? cogsOf(x) : 0;
const profitOf = x => x.s + x.fee + x.ad + x.po + x.rf - cogsOf(x) + stockBack(x);
function totals(its, oh) {
  const T = { sales: 0, orders: new Set(), units: 0, ret: 0, fee: 0, ad: 0, po: 0, rf: 0, cogs: 0, back: 0, gross: 0, oh: 0 };
  its.forEach(x => { T.sales += x.s; T.orders.add(x.a + '|' + x.o); T.units += x.q; T.ret += x.ret; T.fee += x.fee; T.ad += x.ad; T.po += x.po; T.rf += x.rf; T.cogs += cogsOf(x); T.back += stockBack(x); T.gross += profitOf(x); });
  oh.forEach(o => T.oh += o.v); T.net = T.gross + T.oh; T.orders = T.orders.size; return T;
}

// ---------------------------------------------------------------- tiles
const TILESETS = {
  tymfl: ['Today / Yesterday / Month to date / This month (forecast) / Last month', ['today', 'yday', 'mtd', 'fc', 'lm']],
  tyml: ['Today / Yesterday / Month to date / Last month', ['today', 'yday', 'mtd', 'lm']],
  ty71430: ['Today / Yesterday / 7 days / 14 days / 30 days', ['today', 'yday', 'd7', 'd14', 'd30']],
  weeks: ['This week / Last week / 2 weeks ago / 3 weeks ago', ['tw', 'lw', 'w2', 'w3']],
  months: ['Month to date / Last month / 2 months ago / 3 months ago', ['mtd', 'lm', 'm2', 'm3']],
  days: ['Today / Yesterday / 2 days ago / 3 days ago', ['today', 'yday', 'dd2', 'dd3']],
  days78: ['Today / Yesterday / 7 days ago / 8 days ago', ['today', 'yday', 'dd7', 'dd8']],
  quarters: ['This quarter / Last quarter / 2 quarters ago / 3 quarters ago', ['q', 'lq', 'q2', 'q3']],
};
const TILE_COLORS = ['--t0', '--t1', '--t2', '--t3', '--t4'];
function tileDef(k) {
  const t = TODAY, y = +t.slice(0, 4), m = +t.slice(5, 7);
  const mon = n => { const [yy, mm] = ym(y, m - n); return [first(yy, mm), mEnd(yy, mm)]; };
  const qtr = n => { const [qy, qs] = ym(y, Math.floor((m - 1) / 3) * 3 + 1 - 3 * n); return [first(qy, qs), mEnd(...ym(qy, qs + 2))]; };
  const wk = n => { const s = addD(monday(t), -7 * n); return [s, addD(s, 6)]; };
  const day = n => [addD(t, -n), addD(t, -n)];
  const last = n => [addD(t, -(n - 1)), t];
  const D = {
    today: ['Today', [t, t]], yday: ['Yesterday', day(1)], dd2: ['2 days ago', day(2)], dd3: ['3 days ago', day(3)],
    dd7: ['7 days ago', day(7)], dd8: ['8 days ago', day(8)], d7: ['Last 7 days', last(7)], d14: ['Last 14 days', last(14)], d30: ['Last 30 days', last(30)],
    mtd: ['Month to date', [first(y, m), t]], fc: ['This month (forecast)', [first(y, m), mEnd(y, m)]], lm: ['Last month', mon(1)], m2: ['2 months ago', mon(2)], m3: ['3 months ago', mon(3)],
    tw: ['This week', [monday(t), t]], lw: ['Last week', wk(1)], w2: ['2 weeks ago', wk(2)], w3: ['3 weeks ago', wk(3)],
    q: ['This quarter', [qtr(0)[0], t]], lq: ['Last quarter', qtr(1)], q2: ['2 quarters ago', qtr(2)], q3: ['3 quarters ago', qtr(3)],
  };
  return { key: k, name: D[k][0], r: D[k][1] };
}
let tileSet = 'tymfl', activeTile = null;
try { tileSet = localStorage.getItem('pl_tiles') || 'tymfl'; } catch (e) { }
function renderTileMenu() {
  const sel = $('tileSet'); if (!sel) return;
  sel.innerHTML = Object.entries(TILESETS).map(([k, v]) => `<option value="${k}" ${k === tileSet ? 'selected' : ''}>${v[0]}</option>`).join('');
}
function renderTiles() {
  const f = F(), keys = (TILESETS[tileSet] || TILESETS.tymfl)[1];
  const lmR = tileDef('lm').r, lm = totals(itemsIn(f, lmR), ohIn(f, lmR));
  $('tiles').style.gridTemplateColumns = `repeat(${keys.length},minmax(0,1fr))`;
  $('tiles').innerHTML = keys.map((k, i) => {
    const td = tileDef(k); let T, sub = td.r[0] === td.r[1] ? nice(td.r[0]) : `${nice(td.r[0])} – ${nice(td.r[1])}`;
    if (k === 'fc') {
      // Forecast = what has sold so far this month + the expected daily pace for the days left.
      // The pace blends the last 14 full days with last month's daily average, so a slow or busy
      // first few days of the month doesn't swing it. Other fees (shop subscription, insertion fees)
      // mostly land at the start of the month, so they are counted once: last month's total, or this
      // month's so far if that's already more.
      const mt = [td.r[0], TODAY]; T = totals(itemsIn(f, mt), ohIn(f, mt));
      const r14 = [addD(TODAY, -14), addD(TODAY, -1)], p14 = totals(itemsIn(f, r14), []);
      const lmDays = +lmR[1].slice(8, 10), left = +td.r[1].slice(8, 10) - +TODAY.slice(8, 10);
      const has14 = p14.sales !== 0, hasLm = lm.sales !== 0;
      const pace = p => has14 && hasLm ? (p14[p] / 14 + lm[p] / lmDays) / 2 : has14 ? p14[p] / 14 : hasLm ? lm[p] / lmDays : 0;
      ['sales', 'units', 'orders', 'fee', 'ad', 'po', 'rf', 'cogs', 'back', 'gross', 'ret'].forEach(p => T[p] += pace(p) * left);
      T.oh = Math.min(T.oh, lm.oh); T.net = T.gross + T.oh;
      sub += ' · pace from last 14 days and last month';
    } else T = totals(itemsIn(f, td.r), ohIn(f, td.r));
    const d = (k === 'fc' || k === 'mtd') && lm.sales ? (T.sales - lm.sales) / Math.abs(lm.sales) : null;
    return `<article class="tile ${activeTile === k ? 'active' : ''}" style="--hd:var(${TILE_COLORS[i % 5]})" data-tile="${k}" tabindex="0" role="button" aria-label="Show ${td.name} in the product table">
      <header><b>${td.name}</b><span>${sub}</span></header><div class="body">
      <div class="kv big"><small>Sales${d != null ? ` <span class="delta ${d < 0 ? 'neg' : 'pos'}">${d >= 0 ? '+' : ''}${(d * 100).toFixed(1)}%</span>` : ''}</small><b>${gbp(T.sales)}</b></div>
      <div class="kv"><small>Orders / units</small><b>${n0(T.orders)} / ${n0(T.units)}</b></div>
      <div class="kv"><small>Returns</small><b>${n0(T.ret)}</b></div>
      <div class="kv"><small>eBay fees</small><b class="${cls(T.fee)}">${gbp(T.fee)}</b></div>
      <div class="kv"><small>Ads</small><b class="${cls(T.ad)}">${gbp(T.ad)}</b></div>
      <div class="kv"><small>Postage</small><b class="${cls(T.po)}">${gbp(T.po)}</b></div>
      <div class="kv"><small>COGS (net of returns)</small><b class="neg">${gbp(-(T.cogs - T.back))}</b></div>
      <div class="kv"><small>Product profit</small><b>${gbp(T.gross)}</b></div>
      <div class="kv"><small>Other fees</small><b class="${cls(T.oh)}">${gbp(T.oh)}</b></div>
      <div class="net"><small>Net profit${k === 'fc' ? '<span class="delta">estimate</span>' : ''}</small><b class="${cls(T.net)}">${gbp(T.net)}</b></div>
    </div></article>`;
  }).join('');
  document.querySelectorAll('[data-tile]').forEach(el => {
    const go = () => {
      const td = tileDef(el.dataset.tile); activeTile = el.dataset.tile;
      $('fPeriod').value = 'custom'; $('fFrom').value = td.r[0]; $('fTo').value = el.dataset.tile === 'fc' ? TODAY : td.r[1];
      ordState.limit = 100; renderAll(); $('prodTable').scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    el.onclick = go; el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
  });
}
// ---------------------------------------------------------------- tables
function table(el, cols, rows, foot, state) {
  const s = state.sort; if (s) { const c = cols[s.i]; rows.sort((a, b) => { const A = c.v(a), B = c.v(b); return (typeof A === 'string' ? A.localeCompare(B) : (A - B)) * (s.asc ? 1 : -1); }); }
  el.innerHTML = `<thead><tr>${cols.map((c, i) => `<th class="${c.l ? 'l' : ''} ${s && s.i === i ? 'sorted' + (s.asc ? ' asc' : '') : ''}" data-i="${i}" scope="col">${c.h}</th>`).join('')}</tr></thead>
  <tbody>${rows.length ? rows.slice(0, state.limit || 1e9).map((r, ri) => `<tr data-ri="${ri}">${cols.map(c => `<td class="${c.cl || ''} ${c.l ? 'l' : ''}">${c.f(r)}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${cols.length}" class="empty">${state.empty || 'No sales for this selection.'}</td></tr>`}</tbody>
  ${foot && rows.length ? `<tfoot><tr>${foot.map(x => `<td>${x}</td>`).join('')}</tr></tfoot>` : ''}`;
  el.querySelectorAll('th').forEach(th => th.onclick = () => { const i = +th.dataset.i; state.sort = state.sort && state.sort.i === i ? { i, asc: !state.sort.asc } : { i, asc: !!cols[i].l }; state.render(); });
  state.rows = rows;
}
const money = v => `<span class="${cls(v)}">${gbp(v)}</span>`;
const srcChip = l => l === 'K' ? '<span class="chip k">Known cost</span>' : l === 'P' ? '<span class="chip b">Price band</span>' : '<span class="chip m">No cost</span>';
function csv(name, head, rows) {
  const q = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const blob = new Blob(['﻿' + [head, ...rows].map(r => r.map(q).join(',')).join('\n')], { type: 'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

const prodState = { sort: { i: 11, asc: false }, render: renderProducts };
function renderProducts() {
  const f = F(), q = $('prodSearch').value.toLowerCase(), m = new Map();
  itemsIn(f, f.r).forEach(x => {
    let r = m.get(x.sku); if (!r) { r = { sku: x.sku, t: x.t, g: x.g, u: 0, ret: 0, s: 0, ad: 0, rf: 0, fee: 0, cogs: 0, po: 0, p: 0, srcs: new Set() }; m.set(x.sku, r); }
    r.u += x.q; r.ret += x.ret; r.s += x.s; r.ad += x.ad; r.rf += x.rf; r.fee += x.fee; r.cogs += cogsOf(x) - stockBack(x); r.po += x.po; r.p += profitOf(x); r.srcs.add(x.src);
  });
  const rows = [...m.values()].filter(r => !q || r.sku.toLowerCase().includes(q) || r.t.toLowerCase().includes(q));
  const T = rows.reduce((a, r) => { ['u', 'ret', 's', 'ad', 'rf', 'fee', 'cogs', 'po', 'p'].forEach(k => a[k] += r[k]); return a; }, { u: 0, ret: 0, s: 0, ad: 0, rf: 0, fee: 0, cogs: 0, po: 0, p: 0 });
  $('prodSub').textContent = `${rows.length} products · ${nice(f.r[0])} – ${nice(f.r[1])}. Product profit before insertion fees and shop subscription.`;
  const cols = [
    { h: 'Product', l: 1, cl: 'prod', v: r => r.sku, f: r => `<span class="t">${esc(r.t)}</span><span class="s">${esc(r.sku)}</span> ${srcChip(r.srcs.has('M') ? 'M' : r.srcs.has('P') ? 'P' : 'K')}` },
    { h: 'Units', v: r => r.u, f: r => n0(r.u) }, { h: 'Returns', v: r => r.ret, f: r => r.ret ? `<span class="chip ret">${r.ret}</span>` : '0' },
    { h: 'Sales', v: r => r.s, f: r => gbp(r.s) }, { h: 'Ads', v: r => r.ad, f: r => money(r.ad) }, { h: 'Refunds', v: r => r.rf, f: r => money(r.rf) },
    { h: 'eBay fees', v: r => r.fee, f: r => money(r.fee) }, { h: 'COGS', v: r => -r.cogs, f: r => money(-r.cogs) }, { h: 'Postage', v: r => r.po, f: r => money(r.po) },
    { h: 'Margin', v: r => r.s ? r.p / r.s : 0, f: r => `<span class="${cls(r.p)}">${pct(r.s ? r.p / r.s : NaN)}</span>` },
    { h: 'Per unit', v: r => r.p / r.u, f: r => money(r.p / r.u) }, { h: 'Profit', v: r => r.p, f: r => `<b>${money(r.p)}</b>` }];
  table($('prodTable'), cols, rows, ['Total', n0(T.u), n0(T.ret), gbp(T.s), money(T.ad), money(T.rf), money(T.fee), money(-T.cogs), money(T.po), pct(T.s ? T.p / T.s : NaN), '', money(T.p)], prodState);
}
$('prodCsv').onclick = () => csv('products.csv', ['SKU', 'Product', 'Group', 'Units', 'Returns', 'Sales', 'Ads', 'Refunds', 'eBay fees', 'COGS', 'Postage', 'Profit'],
  (prodState.rows || []).map(r => [r.sku, r.t, r.g, r.u, r.ret, r.s.toFixed(2), r.ad.toFixed(2), r.rf.toFixed(2), r.fee.toFixed(2), (-r.cogs).toFixed(2), r.po.toFixed(2), r.p.toFixed(2)]));

const ordState = { sort: { i: 0, asc: false }, limit: 100, render: renderOrders };
function renderOrders() {
  const f = F(), q = $('ordSearch').value.toLowerCase();
  const rows = itemsIn(f, f.r).filter(x => !q || x.o.toLowerCase().includes(q) || x.sku.toLowerCase().includes(q) || x.t.toLowerCase().includes(q) || x.id.includes(q));
  $('ordSub').textContent = `${rows.length} items sold · ${nice(f.r[0])} – ${nice(f.r[1])}`;
  const T = rows.reduce((a, x) => { a.q += x.q; a.s += x.s; a.fee += x.fee; a.ad += x.ad; a.po += x.po; a.rf += x.rf; a.c += cogsOf(x) - stockBack(x); a.p += profitOf(x); return a; }, { q: 0, s: 0, fee: 0, ad: 0, po: 0, rf: 0, c: 0, p: 0 });
  const cols = [
    { h: 'Date', l: 1, v: x => x.d, f: x => nice(x.d) },
    { h: 'Account', l: 1, v: x => ACC[x.a].name, f: x => `<span class="dot" style="background:${ACC[x.a].color}"></span>${esc(ACC[x.a].name)}` },
    { h: 'Order', l: 1, v: x => x.o, f: x => `<span class="sku">${esc(x.o)}</span>` },
    { h: 'Product', l: 1, cl: 'prod', v: x => x.sku, f: x => `<span class="t">${esc(x.t)}</span><span class="s">${esc(x.sku.startsWith('No SKU') ? 'No SKU' : x.sku)}</span>` +
        (x.id ? ` <button class="link" type="button" data-setsku="${esc(x.id)}">${x.sku.startsWith('No SKU') ? 'Set SKU' : 'Change SKU'}</button>` : '') },
    { h: 'Qty', v: x => x.q, f: x => x.q }, { h: 'Sale', v: x => x.s, f: x => gbp(x.s) }, { h: 'eBay fees', v: x => x.fee, f: x => money(x.fee) }, { h: 'Ads', v: x => x.ad, f: x => money(x.ad) },
    { h: 'Postage', v: x => x.po, f: x => money(x.po) }, { h: 'Refund', v: x => x.rf, f: x => x.rf ? money(x.rf) + (x.ret ? ' <span class="chip ret">Returned</span>' : '') : '–' },
    { h: 'COGS', v: x => -(cogsOf(x) - stockBack(x)), f: x => money(-(cogsOf(x) - stockBack(x))) + (x.src !== 'K' ? ` ${srcChip(x.src)}` : '') },
    { h: 'Profit', v: profitOf, f: x => `<b>${money(profitOf(x))}</b>` }, { h: 'Margin', v: x => x.s ? profitOf(x) / x.s : 0, f: x => `<span class="${cls(profitOf(x))}">${pct(x.s ? profitOf(x) / x.s : NaN)}</span>` }];
  table($('ordTable'), cols, rows, ['Total', '', '', '', n0(T.q), gbp(T.s), money(T.fee), money(T.ad), money(T.po), money(T.rf), money(-T.c), money(T.p), pct(T.s ? T.p / T.s : NaN)], ordState);
  $('ordMore').hidden = rows.length <= ordState.limit;
  $('ordTable').querySelectorAll('[data-setsku]').forEach(b => b.onclick = () => {
    const cell = b.parentElement; if (cell.querySelector('.inline-sku')) return;
    const id = b.dataset.setsku; const box = document.createElement('div'); box.className = 'inline-sku';
    box.innerHTML = `<input id="sku-${esc(id)}" aria-label="SKU for item ${esc(id)}" placeholder="e.g. MRRMK8-0501-LH"><button class="btn" type="button">Save</button>`;
    cell.appendChild(box); const inp = box.querySelector('input'); inp.focus();
    box.querySelector('button').onclick = async () => { try { await post('/api/sku-map', { item_id: id, sku: inp.value.trim() }); toast('SKU saved for every sale of item ' + id); await load(); } catch (e) { toast(e.message); } };
  });
}
$('ordMore').onclick = () => { ordState.limit += 200; renderOrders(); };
$('ordCsv').onclick = () => csv('sold-items.csv', ['Date', 'Account', 'Order', 'Item ID', 'SKU', 'Product', 'Qty', 'Sale', 'eBay fees', 'Ads', 'Postage', 'Refund', 'Returned', 'COGS', 'COGS basis', 'Profit'],
  (ordState.rows || []).map(x => [x.d, ACC[x.a].name, x.o, x.id, x.sku, x.t, x.q, x.s, x.fee, x.ad, x.po, x.rf, x.ret ? 'Yes' : '', (-(cogsOf(x) - stockBack(x))).toFixed(2), { K: 'Known cost', P: 'Price band', M: 'No cost' }[x.src], profitOf(x).toFixed(2)]));

// ---------------------------------------------------------------- COGS
const cogsState = { sort: { i: 0, asc: true }, render: renderCogs, empty: 'No SKUs match.' };
function renderCogs() {
  const f = F(), q = $('cogsSearch').value.toLowerCase(), show = $('cogsShow').value;
  const rows = COGS.filter(c => (f.allG || f.g.has(c.group)) && (!q || c.sku.toLowerCase().includes(q) || c.title.toLowerCase().includes(q)) &&
    (!show || (show === 'need' && c.source === 'Needs cost') || (show === 'band' && c.cost == null && c.source !== 'Needs cost') || (show === 'known' && c.cost != null)));
  const basis = c => c.cost != null ? `<span class="chip k">${esc(c.source)}</span>${c.since ? ` <span class="muted">since ${nice(c.since)}</span>` : ''}${c.changes > 1 ? ` <button class="link" type="button" data-hist="${esc(c.sku)}">${c.changes} changes</button>` : ''}`
    : c.source === 'Needs cost' ? '<span class="chip m">Needs a cost</span>' : `<span class="chip b">${esc(c.source)}</span>`;
  const ebay = ACC.filter(a => a.channel === 'ebay');
  const cols = [
    { h: 'SKU', l: 1, v: c => c.sku, f: c => `<span class="sku">${esc(c.sku)}</span>` },
    { h: 'Group', l: 1, v: c => c.group, f: c => c.group },
    { h: 'Product', l: 1, cl: 'prod', v: c => c.title, f: c => `<span class="t">${esc(c.title)}</span>` },
    { h: 'Cost (£)', v: c => c.cost ?? -1, f: c => `<input class="cost-in" type="number" step="0.01" min="0" id="cost-${esc(c.sku)}" data-sku="${esc(c.sku)}" value="${c.cost ?? ''}" placeholder="band" aria-label="Cost for ${esc(c.sku)}">` },
    { h: 'Basis', l: 1, v: c => c.source, f: basis },
    ...ebay.map(a => ({ h: esc(a.name) + ' price', v: c => c.prices[a.i] ?? -1, f: c => c.prices[a.i] != null ? gbp(c.prices[a.i]) : '–' })),
    { h: 'Units sold', v: c => c.units, f: c => n0(c.units) }];
  table($('cogsTable'), cols, rows, null, cogsState);
  document.querySelectorAll('.cost-in').forEach(inp => inp.onchange = async () => {
    const mode = document.querySelector('input[name=cmode]:checked').value, v = inp.value.trim();
    try {
      await post('/api/cogs', { sku: inp.dataset.sku, cost: v === '' ? null : +v, mode, from: $('cFrom').value });
      toast(v === '' ? `Cost removed for ${inp.dataset.sku}` : `Saved ${gbp(+v)} for ${inp.dataset.sku}` + (mode === 'from' ? ` from ${nice($('cFrom').value)}` : '')); await load();
    } catch (e) { toast(e.message); }
  });
  document.querySelectorAll('[data-hist]').forEach(b => b.onclick = async () => {
    const h = await api('/api/cogs/' + encodeURIComponent(b.dataset.hist) + '/history');
    toast(h.map(x => `${x.effective_from <= '2000-01-01' ? 'From the start' : 'From ' + nice(x.effective_from)}: ${gbp(x.cost)}`).join(' · '));
  });
}
function renderBands() {
  const b = D.settings.bands;
  $('bandGrid').innerHTML = '<span>Price under</span><span>COGS</span>' + [0, 1, 2, 3, 4].map(i => `
    <input type="number" step="0.01" id="bl${i}" aria-label="Band ${i + 1} price under" value="${b[i] ? b[i][0] : ''}">
    <input type="number" step="0.01" id="bc${i}" aria-label="Band ${i + 1} cost" value="${b[i] ? b[i][1] : ''}">`).join('');
}
$('saveBands').onclick = async () => {
  const bands = [0, 1, 2, 3, 4].map(i => [$('bl' + i).value, $('bc' + i).value]).filter(x => x[0] !== '' && x[1] !== '').map(x => [+x[0], +x[1]]);
  try { await post('/api/settings', { bands }); toast('Price bands saved'); await load(); } catch (e) { toast(e.message); }
};
['cogsSearch', 'cogsShow'].forEach(id => $(id).addEventListener('input', renderCogs));

// ---------------------------------------------------------------- charts
const charts = {};
function mk(id, cfg) { if (charts[id]) charts[id].destroy(); charts[id] = new Chart($(id), cfg); }
function renderCharts() {
  if (!window.Chart) return;
  const f = F(), its = itemsIn(f, f.r), oh = ohIn(f, f.r);
  Chart.defaults.color = css('--muted'); Chart.defaults.font.family = css('--body'); Chart.defaults.borderColor = css('--line');
  const months = [...new Set(its.map(x => x.d.slice(0, 7)).concat(oh.map(o => o.d.slice(0, 7))))].sort();
  const mlab = months.map(m => dt(m + '-01').toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' }));
  const accs = ACC.filter(a => f.a.has(a.i) && a.hasData);
  mk('cMonth', { type: 'bar', data: { labels: mlab, datasets: accs.map(a => ({ label: a.name, backgroundColor: a.color, borderRadius: 3,
      data: months.map(m => +(its.filter(x => x.a === a.i && x.d.startsWith(m)).reduce((s, x) => s + profitOf(x), 0) + oh.filter(o => o.a === a.i && o.d.startsWith(m)).reduce((s, o) => s + o.v, 0)).toFixed(2)) })) },
    options: { maintainAspectRatio: false, scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, ticks: { callback: v => '£' + v } } },
      plugins: { tooltip: { callbacks: { label: c => `${c.dataset.label}: ${gbp(c.raw)}`, footer: it => 'Total: ' + gbp(it.reduce((s, c) => s + c.raw, 0)) } } } } });
  const weeks = [...new Set(its.map(x => monday(x.d)))].sort(), ws = weeks.map(w => its.filter(x => monday(x.d) === w));
  mk('cWeek', { data: { labels: weeks.map(w => nice(w).replace(/ \d{4}$/, '')), datasets: [
      { type: 'line', label: 'Sales (£)', data: ws.map(a => +a.reduce((s, x) => s + x.s, 0).toFixed(2)), borderColor: css('--accent'), backgroundColor: css('--accent-soft'), fill: true, tension: .3, pointRadius: 0, yAxisID: 'y' },
      { type: 'bar', label: 'Orders', data: ws.map(a => new Set(a.map(x => x.a + '|' + x.o)).size), backgroundColor: css('--line'), yAxisID: 'y1' }] },
    options: { maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 8 } }, y: { ticks: { callback: v => '£' + v } }, y1: { position: 'right', grid: { display: false } } } } });
  const gm = new Map(); its.forEach(x => gm.set(x.g, (gm.get(x.g) || 0) + profitOf(x)));
  const gs = [...gm.entries()].sort((a, b) => b[1] - a[1]);
  mk('cGroup', { type: 'bar', data: { labels: gs.map(g => g[0]), datasets: [{ label: 'Profit', data: gs.map(g => +g[1].toFixed(2)), backgroundColor: gs.map(g => g[1] < 0 ? css('--bad') : css('--t1')), borderRadius: 3 }] },
    options: { indexAxis: 'y', maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => gbp(c.raw) } } }, scales: { x: { ticks: { callback: v => '£' + v } }, y: { grid: { display: false } } } } });
  const sm = new Map(); its.forEach(x => sm.set(x.sku, (sm.get(x.sku) || 0) + profitOf(x)));
  const top = [...sm.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  mk('cTop', { type: 'bar', data: { labels: top.map(t => t[0].length > 22 ? t[0].slice(0, 21) + '…' : t[0]), datasets: [{ label: 'Profit', data: top.map(t => +t[1].toFixed(2)), backgroundColor: css('--accent'), borderRadius: 3 }] },
    options: { indexAxis: 'y', maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => gbp(c.raw) } } }, scales: { x: { ticks: { callback: v => '£' + v } }, y: { grid: { display: false }, ticks: { font: { family: css('--mono'), size: 11 } } } } } });
}

// ---------------------------------------------------------------- uploads
function renderUploads() {
  $('upTable').innerHTML = `<thead><tr><th class="l">Uploaded</th><th class="l">File</th><th class="l">Type</th><th class="l">Account</th><th class="l">Covers</th><th>New rows</th><th>Already loaded</th><th class="l">By</th>${ME.is_admin ? '<th></th>' : ''}</tr></thead><tbody>${
    D.uploads.length ? D.uploads.map(u => `<tr><td class="l">${esc((u.uploaded_at || '').slice(0, 16))}</td><td class="l">${esc(u.filename)}</td><td class="l">${esc(u.kind)}</td><td class="l">${esc(u.account || '–')}</td>
      <td class="l">${u.date_from ? (u.date_from === u.date_to ? nice(u.date_from) : nice(u.date_from) + ' – ' + nice(u.date_to)) : '–'}</td><td>${n0(u.rows_added)}</td><td>${n0(u.rows_skipped)}</td><td class="l">${esc(u.uploaded_by || '')}</td>
      ${ME.is_admin ? `<td>${/transactions/.test(u.kind) ? `<button class="link danger" type="button" data-undo="${u.id}">Remove this upload</button>` : ''}</td>` : ''}</tr>`).join('')
    : `<tr><td colspan="9" class="empty">Nothing uploaded yet. Start with the Transaction report for each eBay account.</td></tr>`}</tbody>`;
  document.querySelectorAll('[data-undo]').forEach(b => b.onclick = async () => {
    if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Click again to remove its rows'; return; }
    try { const r = await api('/api/uploads/' + b.dataset.undo, { method: 'DELETE' }); toast(`Removed ${r.removed} rows`); await load(); } catch (e) { toast(e.message); }
  });
}
async function sendFiles(files) {
  if (!files.length) return;
  const fd = new FormData(); [...files].forEach(f => fd.append('files', f)); fd.append('account_id', $('upAcc').value);
  $('upResults').innerHTML = `<div class="ok">Uploading ${files.length} file${files.length > 1 ? 's' : ''}…</div>`;
  try {
    const r = await api('/api/upload', { method: 'POST', body: fd });
    $('upResults').innerHTML = r.results.map(x => `<div class="${x.ok ? 'ok' : 'err'}"><b>${esc(x.file)}</b>: ${esc(x.msg)}</div>`).join('');
    await load();
  } catch (e) { $('upResults').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  $('upFile').value = '';
}
$('upFile').onchange = e => sendFiles(e.target.files);
const drop = $('drop');
['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => sendFiles(e.dataTransfer.files));

// ---------------------------------------------------------------- users
async function renderUsers() {
  $('addUser').hidden = !ME.is_admin; $('backupBtn').hidden = !ME.is_admin;
  const us = await api('/api/users');
  $('userTable').innerHTML = `<thead><tr><th class="l">Name</th><th class="l">Email</th><th class="l">Role</th><th class="l">Added</th>${ME.is_admin ? '<th></th>' : ''}</tr></thead><tbody>${us.map(u => `<tr>
    <td class="l">${esc(u.name)}</td><td class="l">${esc(u.email)}</td><td class="l">${u.is_admin ? 'Admin' : 'User'}</td><td class="l">${esc((u.created_at || '').slice(0, 10))}</td>
    ${ME.is_admin ? `<td>${u.id !== ME.id ? `<button class="link" type="button" data-pw="${u.id}">Set new password</button> · <button class="link danger" type="button" data-del="${u.id}">Remove</button>` : ''}</td>` : ''}</tr>`).join('')}</tbody>`;
  document.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Click again to remove'; return; }
    try { await api('/api/users/' + b.dataset.del, { method: 'DELETE' }); toast('User removed'); renderUsers(); } catch (e) { toast(e.message); }
  });
  document.querySelectorAll('[data-pw]').forEach(b => b.onclick = () => {
    const cell = b.parentElement; if (cell.querySelector('.inline-sku')) return;
    const box = document.createElement('div'); box.className = 'inline-sku';
    box.innerHTML = `<input type="password" aria-label="New password" placeholder="New password" minlength="8"><button class="btn" type="button">Save</button>`; cell.appendChild(box);
    box.querySelector('button').onclick = async () => { try { await post(`/api/users/${b.dataset.pw}/password`, { password: box.querySelector('input').value }); toast('Password changed'); box.remove(); } catch (e) { toast(e.message); } };
  });
}
$('addUser').onsubmit = async e => {
  e.preventDefault();
  try { await post('/api/users', { name: $('nuName').value, email: $('nuEmail').value, password: $('nuPw').value, is_admin: $('nuAdmin').checked }); toast('User added'); e.target.reset(); renderUsers(); } catch (err) { toast(err.message); }
};
$('myPw').onsubmit = async e => { e.preventDefault(); try { await post(`/api/users/${ME.id}/password`, { password: $('myNewPw').value }); toast('Your password was changed'); e.target.reset(); } catch (err) { toast(err.message); } };
$('backupBtn').onclick = () => { location.href = '/api/backup'; };
// ---------------------------------------------------------------- log (admins)
async function renderLog() {
  if (!ME || !ME.is_admin) { $('logPanel').hidden = true; return; }
  $('logPanel').hidden = false;
  let L; try { L = await api(`/api/logs?level=${$('logLevel').value}&q=${encodeURIComponent($('logSearch').value)}&days=${$('logDays').value}`); } catch (e) { toast(e.message); return; }
  const c = L.last24h || {};
  $('logSub').textContent = `Last 24 hours: ${c.error || 0} errors, ${c.warn || 0} refused actions, ${c.browser || 0} browser errors. Kept 90 days.` + (L.readKey ? ' Read-only key is on.' : '');
  $('logTable').innerHTML = L.rows.length ? `<thead><tr><th class="l">When (UTC)</th><th class="l">Type</th><th class="l">Where</th><th class="l">What happened</th></tr></thead><tbody>${L.rows.map((r, i) => `<tr>
    <td class="l" style="white-space:nowrap">${esc(r.at)}</td><td class="l"><span class="chip ${{ error: 'm', warn: 'ret', browser: 'b', info: 'k' }[r.level] || ''}">${esc({ error: 'Error', warn: 'Refused', browser: 'Browser', info: 'Info' }[r.level] || r.level)}</span></td>
    <td class="l"><span class="sku">${esc(r.source)}</span>${r.user_email ? `<span class="sub">${esc(r.user_email)}</span>` : ''}</td>
    <td class="l prod">${esc(r.message)}${r.detail ? ` <button class="link" type="button" data-ld="${i}">Details</button><pre class="logd" id="ld${i}" hidden>${esc(r.detail)}</pre>` : ''}</td></tr>`).join('')}</tbody>`
    : '<tbody><tr><td class="empty">Nothing logged for this filter.</td></tr></tbody>';
  $('logTable').querySelectorAll('[data-ld]').forEach(b => b.onclick = () => { const p = $('ld' + b.dataset.ld); p.hidden = !p.hidden; });
}
['logLevel', 'logDays'].forEach(id => $(id).addEventListener('change', renderLog));
$('logSearch').addEventListener('input', () => { clearTimeout(renderLog.t); renderLog.t = setTimeout(renderLog, 300); });
$('logDl').onclick = () => { window.open(`/api/logs.txt?days=${$('logDays').value}&level=${$('logLevel').value}`, '_blank'); };


// ---------------------------------------------------------------- traffic
// Flags: what each listing most needs, checked in this order
const FLAGS = {
  oos: { name: 'Out of stock', chip: 'm', next: 'Restock it or end the listing' },
  noimp: { name: 'No impressions', chip: 'm', next: 'Not showing in search: check title keywords, category and item specifics' },
  lowctr: { name: 'Seen, rarely clicked', chip: 'ret', next: 'Shows in search but few click: improve the main photo, price or the start of the title' },
  nosale: { name: 'Views, no sales', chip: 'ret', next: 'People look but don\'t buy: check price against others, postage cost and fitment' },
  sell: { name: 'Selling', chip: 'k', next: '' },
};
const pctS = v => v === 0 ? '0%' : isFinite(v) ? (v * 100).toFixed(v < 0.01 ? 2 : 1) + '%' : '–';
const TR_MIN_IMPR = 300, TR_LOW_CTR = 0.01, TR_MIN_VIEWS = 20;
let TR = null, trKey = '', trFlag = 'attn';
const trState = { sort: { i: 3, asc: false }, limit: 100, render: renderTraffic, empty: 'No listings match.' };
function flagOf(r) {
  if (r.active && r.qty === 0) return 'oos';
  if (r.units > 0) return 'sell';
  if (r.active && r.imp === 0) return 'noimp';
  if (r.imp >= TR_MIN_IMPR && r.v / r.imp < TR_LOW_CTR) return 'lowctr';
  if (r.v >= TR_MIN_VIEWS) return 'nosale';
  return '';
}
function trafficRows(TRd, f) {
  // sales and profit from the money data, by account + item number
  const sold = new Map();
  itemsIn({ ...f, g: new Set(groups) }, f.r).forEach(x => {
    const k = x.a + '|' + x.id, s = sold.get(k) || { u: 0, p: 0, s: 0, sku: x.sku, g: x.g, t: x.t }; s.u += x.q; s.p += profitOf(x); s.s += x.s; sold.set(k, s);
  });
  return TRd.rows.map(r => {
    const a = AIDX[r[0]], s = sold.get(a + '|' + r[1]);
    const sku = r[2] || (s && s.sku) || '', g = !r[2] && s ? s.g : r[3];
    const o = { a, id: r[1], sku, g, t: r[4] || (s && s.t) || '', price: r[5], qty: r[6], active: !!r[7], imp: r[8], simp: r[9], v: r[10], sv: r[11], tx: r[12],
      units: s ? s.u : 0, p: s ? s.p : 0, s: s ? s.s : 0 };
    o.flag = flagOf(o); return o;
  }).filter(r => r.a !== undefined && f.a.has(r.a) && (f.allG || f.g.has(r.g)));
}
async function renderTraffic() {
  const f = F(); if ($('fPeriod').value === 'all') f.r = [addD(TODAY, -30), addD(TODAY, -1)];  // traffic is kept for the last 30 days
  if ($('fPeriod').value === 'all') $('rangeNote').textContent = `${nice(f.r[0])} – ${nice(f.r[1])} · traffic is kept for the last 30 days`;
  const key = f.r.join('|');
  if (trKey !== key) {
    $('trSub').textContent = 'Loading…';
    try { TR = await api(`/api/traffic?start=${f.r[0]}&end=${f.r[1]}`); trKey = key; } catch (e) { toast(e.message); return; }
  }
  const all = trafficRows(TR, f);
  const q = $('trSearch').value.toLowerCase();
  // summary
  const T = all.reduce((t, r) => { t.imp += r.imp; t.v += r.v; t.u += r.units; t.p += r.p; return t; }, { imp: 0, v: 0, u: 0, p: 0 });
  const cnt = {}; all.forEach(r => cnt[r.flag] = (cnt[r.flag] || 0) + 1);
  const attn = (cnt.noimp || 0) + (cnt.lowctr || 0) + (cnt.nosale || 0);
  const stat = (k, v, sub) => `<div class="stat"><small>${k}</small><b>${v}</b>${sub ? `<span>${sub}</span>` : ''}</div>`;
  $('trStats').innerHTML = stat('Listings', n0(all.filter(r => r.active).length), 'active') + stat('Impressions', n0(T.imp), 'times shown on eBay') +
    stat('Views', n0(T.v), 'listing page opened') + stat('Click-through', pct(T.imp ? T.v / T.imp : NaN), 'views ÷ impressions') +
    stat('Sold', n0(T.u), 'units in this period') + stat('Conversion', pctS(T.v ? T.u / T.v : NaN), 'units ÷ views');
  const fb = [['attn', 'Needs attention (in stock)', attn], ['all', 'All listings', all.length], ...Object.entries(FLAGS).map(([k, x]) => [k, x.name, cnt[k] || 0])];
  $('trFlags').innerHTML = fb.map(([k, n, c]) => `<button type="button" data-flag="${k}" aria-pressed="${trFlag === k}">${n} <em>${n0(c)}</em></button>`).join('');
  $('trFlags').querySelectorAll('[data-flag]').forEach(b => b.onclick = () => { trFlag = b.dataset.flag; trState.limit = 100; renderTraffic(); });
  // coverage / setup notice
  const cov = Object.entries(TR.coverage || {}).filter(([id]) => f.a.has(AIDX[id]));
  const days = Math.round((dt(f.r[1]) - dt(f.r[0])) / 864e5) + 1;
  let note = '';
  if (!TR.rows.length && !cov.length) note = 'No traffic data yet. On the eBay page, click <b>Reconnect</b> for each account to allow traffic data, then <b>Sync now</b>. The last 30 days load in a few minutes.';
  else if (cov.length) {
    const lo = cov.map(c => c[1].from).sort()[0], hi = cov.map(c => c[1].to).sort().pop(), n = Math.max(...cov.map(c => c[1].days));
    if (n < days) note = `eBay traffic covers ${nice(lo)} – ${nice(hi)} (${n} of the ${days} days chosen). eBay publishes traffic a day late, and Partsledger keeps it from ${TRAFFIC_START()} onwards. Sales and profit cover the whole period.`;
  }
  $('trNotice').innerHTML = note; $('trNotice').hidden = !note;
  // table
  const rows = all.filter(r => (trFlag === 'all' || (trFlag === 'attn' ? ['noimp', 'lowctr', 'nosale'].includes(r.flag) : r.flag === trFlag)) &&
    (!q || r.sku.toLowerCase().includes(q) || r.t.toLowerCase().includes(q) || r.id.includes(q)));
  $('trSub').textContent = `${rows.length} listings · ${nice(f.r[0])} – ${nice(f.r[1])}. Flags: under ${pct(TR_LOW_CTR)} click-through after ${TR_MIN_IMPR}+ impressions, or ${TR_MIN_VIEWS}+ views with no sale.`;
  const cols = [
    { h: 'Listing', l: 1, cl: 'prod', v: r => r.sku || r.t, f: r => `<span class="t">${esc(r.t)}</span><span class="s"><span class="dot" style="background:${ACC[r.a].color}"></span>${esc(ACC[r.a].name)} · ${esc(r.sku || 'No SKU')} · <a href="https://www.ebay.co.uk/itm/${esc(r.id)}" target="_blank" rel="noopener">${esc(r.id)}</a></span>` },
    { h: 'Price', v: r => r.price ?? -1, f: r => r.price != null ? gbp(r.price) : '–' },
    { h: 'Stock', v: r => r.qty ?? -1, f: r => r.active ? n0(r.qty) : '<span class="muted">ended</span>' },
    { h: 'Impressions', v: r => r.imp, f: r => n0(r.imp) },
    { h: 'Views', v: r => r.v, f: r => n0(r.v) },
    { h: 'Click-through', v: r => r.imp ? r.v / r.imp : -1, f: r => r.imp ? pct(r.v / r.imp) : '–' },
    { h: 'Sold', v: r => r.units, f: r => n0(r.units) },
    { h: 'Conversion', v: r => r.v ? r.units / r.v : -1, f: r => r.v ? pctS(r.units / r.v) : '–' },
    { h: 'Profit', v: r => r.p, f: r => r.units ? money(r.p) : '–' },
    { h: 'What to do', l: 1, v: r => r.flag, f: r => r.flag ? `<span class="chip ${FLAGS[r.flag].chip}">${FLAGS[r.flag].name}</span>${FLAGS[r.flag].next ? `<span class="next">${FLAGS[r.flag].next}</span>` : ''}` : '' }];
  const S = rows.reduce((t, r) => { t.imp += r.imp; t.v += r.v; t.u += r.units; t.p += r.p; return t; }, { imp: 0, v: 0, u: 0, p: 0 });
  table($('trTable'), cols, rows, ['Total', '', '', n0(S.imp), n0(S.v), pct(S.imp ? S.v / S.imp : NaN), n0(S.u), pctS(S.v ? S.u / S.v : NaN), money(S.p), ''], trState);
  $('trMore').hidden = rows.length <= trState.limit;
}
const TRAFFIC_START = () => nice(addD(TODAY, -30));
$('trMore').onclick = () => { trState.limit += 200; renderTraffic(); };
$('trSearch').addEventListener('input', () => { trState.limit = 100; renderTraffic(); });
$('trCsv').onclick = () => csv('traffic.csv', ['Account', 'Item number', 'SKU', 'Group', 'Title', 'Price', 'Stock', 'Impressions', 'Search impressions', 'Views', 'Views from search', 'Click-through', 'Sold', 'Conversion', 'Profit', 'Flag'],
  (trState.rows || []).map(r => [ACC[r.a].name, r.id, r.sku, r.g, r.t, r.price ?? '', r.active ? r.qty : 'ended', r.imp, r.simp, r.v, r.sv, r.imp ? (r.v / r.imp * 100).toFixed(2) + '%' : '',
    r.units, r.v ? (r.units / r.v * 100).toFixed(2) + '%' : '', r.p.toFixed(2), r.flag ? FLAGS[r.flag].name : '']));

// ---------------------------------------------------------------- bulk edit
let EL = null, edTraffic = null, edRows = [], edJobTimer = null;
const edState = { sort: null, limit: 200, render: () => drawEdit(), empty: 'Nothing to change for these listings.' };
// Profit estimates from the last 90 days of sales: each account's eBay fee rate, each SKU's postage per unit
function edRates() {
  const from = addD(TODAY, -90), fee = {}, post = {}, gpost = {};
  I.forEach(x => {
    if (x.d < from) return;
    const f = fee[x.a] ||= { s: 0, f: 0 }; f.s += x.s; f.f -= x.fee;
    const p = post[x.sku] ||= { q: 0, c: 0 }; p.q += x.q; p.c -= x.po;
    const g = gpost[x.g] ||= { q: 0, c: 0 }; g.q += x.q; g.c -= x.po;
  });
  const all = Object.values(fee).reduce((t, f) => ({ s: t.s + f.s, f: t.f + f.f }), { s: 0, f: 0 });
  const dflt = all.s > 0 ? all.f / all.s : 0.13;
  return {
    fee: a => fee[a] && fee[a].s > 50 ? fee[a].f / fee[a].s : dflt,
    post: (sku, g) => post[sku] && post[sku].q ? Math.max(0, post[sku].c / post[sku].q) : gpost[g] && gpost[g].q ? Math.max(0, gpost[g].c / gpost[g].q) : 0,
  };
}
const COGSBY = () => Object.fromEntries(COGS.map(c => [c.sku, c]));
function costAt(cmap, sku, price) {
  const c = cmap[sku]; if (c && c.cost != null) return { c: c.cost, src: 'cost' };
  const b = (D.settings.bands || []).slice().sort((x, y) => x[0] - y[0]).find(b => price < b[0]);
  return b ? { c: b[1], src: 'band' } : null;
}
const to99up = p => Math.ceil(p + 0.01 - 1e-9) - 0.01, to99 = p => Math.max(0.99, Math.round(p + 0.01) - 0.01);
const round2 = p => Math.round(p * 100) / 100;

function edShowOpts() {
  const fld = $('edField').value;
  document.querySelectorAll('.ed-opt').forEach(o => o.hidden = o.dataset.for !== fld);
  const how = $('edPriceHow').value;
  $('edPriceValL').textContent = { profit: 'Minimum profit £', pct: 'Change by %', add: 'Change by £', set: 'New price £' }[how];
  $('edAdWrap').hidden = how !== 'profit'; $('edRaiseWrap').hidden = how !== 'profit';
  const th = $('edTitleHow').value; $('edFindWrap').hidden = th !== 'replace'; $('edReplL').textContent = th === 'replace' ? 'Replace with' : 'Text to add';
  $('edHelp').textContent = {
    price: how === 'profit' ? 'Works out the lowest price that leaves this profit after COGS, postage (your average label cost for the SKU), eBay fees (each account\'s own rate over the last 90 days) and ads.' : 'Changes the Buy It Now price.',
    qty: 'Sets the quantity available. 0 keeps the listing but shows it as out of stock (if out-of-stock control is on in eBay). For SKUs in Stock sync, change the stock number on the Stock sync page instead, or the sync will put it back.',
    title: 'eBay titles can be up to 80 characters. Listings that would go over are left out.',
    bestoffer: 'Buyers\' offers at or above the accept price are accepted at once; offers below the decline price are declined at once (so no sale can leave less than your minimum profit after COGS, postage, eBay fees and ads). Offers in between wait for you in Seller Hub. The current Best Offer settings are read from eBay first, so Undo puts them back.',
    fitment: 'Reads each ticked listing\'s fitment rows and item specifics from eBay, then adds what the title is missing: make and model, the year range (e.g. 2012-2023, after the model and platform such as MK8) and the OE number. Nothing is removed and titles stay within 80 characters. Up to 500 listings at a time.',
    specific: 'Adds or changes one item specific. The listing\'s other specifics stay as they are. Several values: separate them with |.',
  }[fld];
}
['edField', 'edPriceHow', 'edTitleHow'].forEach(id => $(id).addEventListener('change', () => { edShowOpts(); $('edPrevPanel').hidden = true; }));
// the change types as buttons, so every option (incl. Best Offer rules) is in view
function edKinds() {
  const sel = $('edField');
  $('edKinds').innerHTML = [...sel.options].map(o => `<button type="button" role="radio" aria-checked="${o.value === sel.value}" data-v="${o.value}">${esc(o.textContent)}</button>`).join('');
  $('edKinds').querySelectorAll('button').forEach(b => b.onclick = () => { sel.value = b.dataset.v; sel.dispatchEvent(new Event('change')); edKinds(); });
}
edKinds();

// Step 1: the listings themselves. Ticks say which ones a bulk change touches; typed values are one-off changes.
let edOff = new Set(), edTyped = new Map(), edTrInfo = null, edMode = 'bulk';
const edKey = r => r.aid + '|' + r.id;
const edLState = { sort: null, limit: 100, render: () => drawList(), empty: 'No listings match these filters.' };
function edPicked() {
  const f = F(), pre = $('edPrefix').value.trim().toLowerCase(), q = $('edSearch').value.trim().toLowerCase(), st = $('edStock').value, tf = $('edTraffic').value;
  const bf = $('edBoF').value;
  return EL.rows.map(r => ({ a: AIDX[r[0]], aid: r[0], id: r[1], sku: r[2], g: r[3], t: r[4], price: r[5], qty: r[6], sold: r[7], ad: r[8], bo: r[9] ? { on: !!r[9][0], accept: r[9][1], decline: r[9][2], at: r[9][3] } : null }))
    .filter(r => r.a !== undefined && f.a.has(r.a) && (f.allG || f.g.has(r.g)) &&
      (!pre || r.sku.toLowerCase().startsWith(pre)) && (!q || r.t.toLowerCase().includes(q) || r.sku.toLowerCase().includes(q) || r.id.includes(q)) &&
      (st === 'all' || (st === 'in' ? r.qty > 0 : r.qty === 0)) &&
      (!tf || (() => { const fl = edTrInfo && edTrInfo.get(edKey(r))?.flag; return tf === 'attn' ? ['noimp', 'lowctr', 'nosale'].includes(fl) : fl === tf; })()) &&
      (!bf || (bf === 'unread' ? !r.bo : bf === 'off' ? r.bo && !r.bo.on : bf === 'on' ? r.bo && r.bo.on : r.bo && r.bo.on && (r.bo.accept || r.bo.decline))));
}
function edProfitFn() {
  const R = edRates(), cmap = COGSBY(), adIn = (+$('edAd').value || 0) / 100;
  const f = (r, price) => {
    const c = costAt(cmap, r.sku, price); if (!c) return null;
    const ad = r.ad != null ? r.ad / 100 : adIn;
    return { p: price * (1 - R.fee(r.a) - ad) - c.c - R.post(r.sku, r.g), c, ad, fee: R.fee(r.a), post: R.post(r.sku, r.g) };
  };
  f.R = R; f.cmap = cmap; return f;
}
async function renderEdit() {
  edShowOpts();
  if (!EL) { $('edCount').textContent = 'Loading listings…'; try { EL = await api('/api/edit/listings'); } catch (e) { toast(e.message); return; } }
  if (!edTrInfo) {
    edTrInfo = new Map();
    try {
      const r = [addD(TODAY, -30), addD(TODAY, -1)], f = F();
      const td = await api(`/api/traffic?start=${r[0]}&end=${r[1]}`);
      trafficRows(td, { ...f, a: new Set(ACC.map(a => a.i)), r, allG: true }).forEach(x => edTrInfo.set(ACC[x.a].id + '|' + x.id, { imp: x.imp, v: x.v, flag: x.flag }));
    } catch (e) { }
  }
  drawList(); renderEditJobs();
}
function drawList() {
  const rows = edPicked(), pf = edProfitFn();
  rows.forEach(r => { r.tr = edTrInfo && edTrInfo.get(edKey(r)); const ty = edTyped.get(edKey(r)) || {}; r.pp = pf(r, ty.price ?? r.price ?? 0); });
  const on = rows.filter(r => !edOff.has(edKey(r))).length;
  $('edCount').textContent = EL.connected.length ? `${n0(rows.length)} listings · ${n0(on)} ticked` : 'Connect an eBay account first (eBay page).';
  const typedN = [...edTyped.values()].filter(v => Object.keys(v).length).length;
  $('edTypedBtn').disabled = !typedN; $('edTypedBtn').classList.toggle('primary', !!typedN); $('edTypedBtn').textContent = typedN ? `Review typed changes (${typedN})` : 'Review typed changes';
  const cols = [
    { h: '', l: 1, v: r => edOff.has(edKey(r)) ? 1 : 0, f: r => `<input type="checkbox" class="el-sel" data-k="${esc(edKey(r))}" ${edOff.has(edKey(r)) ? '' : 'checked'} aria-label="Tick ${esc(r.sku || r.id)}">` },
    { h: 'Listing', l: 1, cl: 'prod', v: r => r.t, f: r => { const ty = edTyped.get(edKey(r)) || {};
        const title = ty.title != null ? `<input class="title-in changed" data-k="${esc(edKey(r))}" data-f="title" value="${esc(ty.title)}" maxlength="120" aria-label="New title"><span class="tlen ${ty.title.length > 80 ? 'over' : ''}">${ty.title.length}/80</span>`
          : `<span class="t">${esc(r.t)}</span>`;
        return `${title}<span class="s"><span class="dot" style="background:${ACC[r.a].color}"></span>${esc(ACC[r.a].name)} · ${esc(r.sku || 'No SKU')} · <a href="https://www.ebay.co.uk/itm/${esc(r.id)}" target="_blank" rel="noopener">${esc(r.id)}</a>${ty.title == null ? ` · <button class="link" type="button" data-edtitle="${esc(edKey(r))}">Edit title</button>` : ''}</span>`; } },
    { h: 'Price', v: r => r.price ?? 0, f: r => { const t = edTyped.get(edKey(r))?.price; return `<input type="number" class="cell-in ${t != null ? 'changed' : ''}" data-k="${esc(edKey(r))}" data-f="price" step="0.01" min="0.99" value="${t ?? r.price ?? ''}" aria-label="Price for ${esc(r.sku || r.id)}">`; } },
    { h: 'Stock', v: r => r.qty ?? 0, f: r => { const t = edTyped.get(edKey(r))?.qty; return `<input type="number" class="cell-in ${t != null ? 'changed' : ''}" style="width:70px" data-k="${esc(edKey(r))}" data-f="qty" step="1" min="0" value="${t ?? r.qty ?? ''}" aria-label="Stock for ${esc(r.sku || r.id)}">`; } },
    { h: 'Sold', v: r => r.sold, f: r => n0(r.sold) },
    { h: 'Cost', v: r => r.pp ? r.pp.c.c : -1, f: r => r.pp ? gbp(r.pp.c.c) + (r.pp.c.src === 'band' ? '<span class="sub">price band</span>' : '') : '<span class="neg">none</span>' },
    { h: 'Profit / sale', v: r => r.pp ? r.pp.p : -1e9, f: r => r.pp ? `<b>${money(r.pp.p)}</b><span class="sub">fees ${(r.pp.fee * 100).toFixed(0)}% · ads ${(r.pp.ad * 100).toFixed(0)}%${r.pp.post ? ' · post £' + r.pp.post.toFixed(2) : ''}</span>` : '–' },
    { h: 'Views 30d', v: r => r.tr ? r.tr.v : -1, f: r => r.tr ? `${n0(r.tr.v)}<span class="sub">${n0(r.tr.imp)} impr.</span>` : '–' },
    { h: 'Traffic', l: 1, v: r => r.tr?.flag || '', f: r => r.tr && r.tr.flag ? `<span class="chip ${FLAGS[r.tr.flag].chip}">${FLAGS[r.tr.flag].name}</span>` : '' },
    { h: 'Best Offer', l: 1, v: r => r.bo ? (r.bo.on ? 2 : 1) : 0, f: r => !r.bo ? '<span class="muted">not read</span>' : r.bo.on ? `<span class="chip b">On</span>${r.bo.accept ? `<span class="sub">accept from ${gbp(r.bo.accept)}</span>` : ''}${r.bo.decline ? `<span class="sub">decline below ${gbp(r.bo.decline)}</span>` : ''}` : '<span class="muted">Off</span>' }];
  table($('edList'), cols, rows, null, edLState);
  edBoNote(rows);
  $('edListMore').hidden = rows.length <= edLState.limit;
  const L = $('edList');
  L.querySelectorAll('.el-sel').forEach(b => b.onchange = () => { b.checked ? edOff.delete(b.dataset.k) : edOff.add(b.dataset.k); const n = rows.filter(r => !edOff.has(edKey(r))).length; $('edCount').textContent = `${n0(rows.length)} listings · ${n0(n)} ticked`; });
  L.querySelectorAll('[data-edtitle]').forEach(b => b.onclick = () => {
    const r = rows.find(x => edKey(x) === b.dataset.edtitle); const ty = edTyped.get(edKey(r)) || {}; ty.title = r.t; edTyped.set(edKey(r), ty); drawList();
    const inp = L.querySelector(`.title-in[data-k="${CSS.escape(edKey(r))}"]`); if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
  });
  L.querySelectorAll('.cell-in,.title-in').forEach(inp => {
    const set = () => {
      const r = rows.find(x => edKey(x) === inp.dataset.k), fld = inp.dataset.f, ty = edTyped.get(inp.dataset.k) || {};
      const cur = fld === 'price' ? r.price : fld === 'qty' ? r.qty : r.t;
      let v = fld === 'title' ? inp.value : inp.value === '' ? null : +inp.value;
      if (fld === 'price' && v != null) v = round2(v); if (fld === 'qty' && v != null) v = Math.max(0, Math.round(v));
      if (v == null || v === cur) delete ty[fld]; else ty[fld] = v;
      edTyped.set(inp.dataset.k, ty); return fld;
    };
    inp.addEventListener('input', () => {
      const fld = set(); inp.classList.toggle('changed', edTyped.get(inp.dataset.k)?.[fld] != null);
      if (fld === 'title') { const l = inp.nextElementSibling; l.textContent = `${inp.value.length}/80`; l.classList.toggle('over', inp.value.length > 80); }
      const n = [...edTyped.values()].filter(v => Object.keys(v).length).length; $('edTypedBtn').disabled = !n; $('edTypedBtn').classList.toggle('primary', !!n); $('edTypedBtn').textContent = n ? `Review typed changes (${n})` : 'Review typed changes';
    });
    if (inp.dataset.f !== 'title') inp.addEventListener('change', () => { set(); drawList(); });  // refresh the profit column
  });
}
['edPrefix', 'edSearch'].forEach(id => $(id).addEventListener('input', () => { $('edPrevPanel').hidden = true; edLState.limit = 100; drawList(); }));
['edStock', 'edTraffic', 'edBoF'].forEach(id => $(id).addEventListener('change', () => { $('edPrevPanel').hidden = true; edLState.limit = 100; drawList(); }));
// Best Offer isn't in the listings sync: it's read from eBay listing by listing, on request
let edBoPoll = null;
function edBoNote(rows) {
  const p = EL && EL.boScan, unread = rows.filter(r => !r.bo).length, on = rows.filter(r => r.bo && r.bo.on).length;
  $('edBoScan').disabled = !!(p && p.running) || !rows.length;
  $('edBoScan').textContent = p && p.running ? `Reading ${n0(p.done)} of ${n0(p.total)}…` : `Read Best Offer from eBay (${n0(Math.min(rows.length, 3000))})`;
  $('edBoScanNote').textContent = rows.some(r => r.bo) ? `${n0(on)} with Best Offer on${unread ? ` · ${n0(unread)} not read yet` : ''}` : '';
}
$('edBoScan').onclick = async () => {
  const rows = edPicked().slice(0, 3000); if (!rows.length) return;
  try {
    const r = await post('/api/edit/bestoffer/scan', { items: rows.map(x => ({ account_id: x.aid, item_id: x.id })) });
    toast(`Reading Best Offer for ${n0(r.queued)} listings…`);
    EL.boScan = { running: true, total: r.queued, done: 0 }; edBoNote(edPicked());
    clearInterval(edBoPoll);
    edBoPoll = setInterval(async () => {
      try {
        const p = await api('/api/edit/bestoffer/scan'); EL.boScan = p; edBoNote(edPicked());
        if (!p.running) { clearInterval(edBoPoll); EL = await api('/api/edit/listings'); drawList(); toast(`Best Offer read for ${n0(p.done)} listings` + (p.failed ? ` (${p.failed} failed)` : '')); }
      } catch (e) { clearInterval(edBoPoll); }
    }, 3000);
  } catch (e) { toast(e.message); }
};
$('edBoHow').addEventListener('change', () => { document.querySelectorAll('.bo-set').forEach(x => x.hidden = $('edBoHow').value === 'off'); $('edPrevPanel').hidden = true; });
$('edAd').addEventListener('change', () => EL && drawList());
$('edListMore').onclick = () => { edLState.limit += 200; drawList(); };
$('edNone').onclick = () => { edPicked().forEach(r => edOff.add(edKey(r))); drawList(); };
$('edAllOn').onclick = () => { edPicked().forEach(r => edOff.delete(edKey(r))); drawList(); };

function edShowPreview(out, same, what) {
  edRows = out.sort((x, y) => y.ok - x.ok); edState.limit = 200;
  const blocked = out.filter(r => !r.ok).length;
  $('edPrevPanel').hidden = false;
  $('edPrevSub').textContent = `${n0(out.length)} ${what}` + (same ? ` · ${n0(same)} already right, left as they are` : '') + (blocked ? ` · ${n0(blocked)} can't be changed (see notes)` : '') + '. Untick any you want to leave.';
  drawEdit(); $('edPrevPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
$('edTypedBtn').onclick = () => {
  const pf = edProfitFn(), byKey = new Map(EL.rows.map(r => [r[0] + '|' + r[1], { a: AIDX[r[0]], aid: r[0], id: r[1], sku: r[2], g: r[3], t: r[4], price: r[5], qty: r[6], sold: r[7], ad: r[8] }]));
  const out = [];
  edTyped.forEach((ty, k) => {
    const r = byKey.get(k); if (!r) return;
    if (ty.price != null) { const p0 = pf(r, r.price || 0), p1 = pf(r, ty.price); out.push({ ...r, fld: 'price', cur: r.price, nv: ty.price, ok: ty.price >= 0.99, note: ty.price < 0.99 ? 'eBay\'s minimum is £0.99' : p0 && p1 ? `Profit about ${gbp(p0.p)} → ${gbp(p1.p)}` : p1 ? `Profit about ${gbp(p1.p)}` : 'No cost at this price, so profit unknown' }); }
    if (ty.qty != null) out.push({ ...r, fld: 'qty', cur: r.qty, nv: ty.qty, ok: true, note: ty.qty === 0 ? 'Shows as out of stock' : '' });
    if (ty.title != null && ty.title.trim() !== r.t) { const t = ty.title.replace(/\s{2,}/g, ' ').trim(); out.push({ ...r, fld: 'title', cur: r.t, nv: t, ok: t.length > 0 && t.length <= 80, note: `${t.length} characters` + (t.length > 80 ? ", over eBay's 80" : '') }); }
  });
  if (!out.length) return toast('Type a new price, stock or title in a row first.');
  edMode = 'typed'; edShowPreview(out, 0, 'changes you typed');
};

$('edPreview').onclick = () => {
  const picked = edPicked().filter(r => !edOff.has(edKey(r))), fld = $('edField').value;
  if (!picked.length) return toast('No listings are ticked in step 1.');
  if (fld === 'fitment') return edFitment(picked);
  if (fld === 'bestoffer') return edBestOffer(picked);
  const pf = edProfitFn(), out = [];
  let same = 0;
  for (const r of picked) {
    let nv = null, note = '', ok = true, old = null;
    if (fld === 'price') {
      const how = $('edPriceHow').value, v = +$('edPriceVal').value || 0, cur = r.price || 0; old = cur;
      if (how === 'profit') {
        const ad = (+$('edAd').value || 0) / 100, fr = pf.R.fee(r.a), po = pf.R.post(r.sku, r.g), k = 1 - fr - ad;
        let c = costAt(pf.cmap, r.sku, cur);
        if (!c) { out.push({ ...r, fld, cur, nv: null, ok: false, note: 'No cost for this SKU. Add it on the COGS page.' }); continue; }
        let p = cur;
        for (let i = 0; i < 4; i++) { c = costAt(pf.cmap, r.sku, p) || c; p = (v + c.c + po) / k; }
        p = $('ed99').checked ? to99up(p) : Math.ceil(p * 100) / 100;
        if ($('edRaise').checked && p <= cur) { same++; continue; }
        nv = p;
        note = `Cost £${c.c.toFixed(2)}${c.src === 'band' ? ' (price band)' : ''} · postage £${po.toFixed(2)} · fees ${(fr * 100).toFixed(1)}% · ads ${(ad * 100).toFixed(1)}%`;
      } else {
        nv = how === 'set' ? v : how === 'pct' ? cur * (1 + v / 100) : cur + v;
        nv = $('ed99').checked && how !== 'set' ? to99(nv) : round2(nv);
      }
      if (nv < 0.99) { nv = 0.99; note = 'Raised to eBay\'s minimum £0.99'; }
      if (Math.abs(nv - cur) < 0.005) { same++; continue; }
      const p0 = pf(r, cur), p1 = pf(r, nv);
      if (p0 && p1) note = `Profit about ${gbp(p0.p)} → ${gbp(p1.p)}` + (note ? ' · ' + note : '');
    } else if (fld === 'qty') {
      nv = Math.max(0, Math.round(+$('edQty').value || 0)); old = r.qty;
      if (nv === r.qty) { same++; continue; }
    } else if (fld === 'title') {
      const how = $('edTitleHow').value, find = $('edFind').value, repl = $('edRepl').value; old = r.t;
      if (how === 'replace') {
        if (!find) return toast('Type the text to find.');
        const rx = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        if (!rx.test(r.t)) { same++; continue; }
        nv = r.t.replace(rx, repl);
      } else {
        if (!repl.trim()) return toast('Type the text to add.');
        if (r.t.toLowerCase().includes(repl.trim().toLowerCase())) { same++; continue; }
        nv = how === 'start' ? repl.trim() + ' ' + r.t : r.t + ' ' + repl.trim();
      }
      nv = nv.replace(/\s{2,}/g, ' ').trim();
      if (nv === r.t) { same++; continue; }
      if (nv.length > 80) { ok = false; note = `${nv.length} characters, over eBay's 80`; } else note = `${nv.length} characters`;
    } else {
      const name = $('edSpecName').value.trim(), val = $('edSpecVal').value.trim();
      if (!name || !val) return toast('Type the item specific name and its value.');
      nv = { name, value: val, mode: $('edSpecMode').value };
      note = nv.mode === 'missing' ? 'Skipped when applying if the listing already has it' : 'Replaces any value it has now';
    }
    out.push({ ...r, fld, cur: old, nv, ok, note });
  }
  edMode = 'bulk';
  edShowPreview(out, same, `listings get a new ${{ price: 'price', qty: 'quantity', title: 'title', specific: 'item specific' }[fld]}`);
};
async function edFitment(picked) {
  if (picked.length > 500) return toast(`${n0(picked.length)} listings are ticked; do up to 500 at a time (use the filters in step 1).`);
  $('edPrevPanel').hidden = false; $('edTable').innerHTML = ''; $('edPrevSub').textContent = `Reading fitment from eBay… 0 of ${n0(picked.length)}`;
  $('edPrevPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  let job;
  try { job = await post('/api/titles/suggest', { items: picked.map(r => ({ account_id: r.aid, item_id: r.id, sku: r.sku, title: r.t })) }); } catch (e) { $('edPrevPanel').hidden = true; return toast(e.message); }
  let res;
  for (;;) {
    await new Promise(ok => setTimeout(ok, 2000));
    try { res = await api('/api/titles/suggest/' + job.job); } catch (e) { return toast(e.message); }
    $('edPrevSub').textContent = `Reading fitment from eBay… ${n0(res.job.done)} of ${n0(res.job.total)}`;
    if (['finished', 'stopped'].includes(res.job.status)) break;
  }
  const by = new Map(res.rows.map(x => [x.account_id + '|' + x.item_id, x]));
  let same = 0; const out = [];
  picked.forEach(r => {
    const x = by.get(edKey(r)); if (!x) return;
    if (x.status !== 'ok') { out.push({ ...r, fld: 'title', cur: r.t, nv: null, ok: false, note: 'Couldn\'t read it from eBay: ' + (x.note || '') }); return; }
    if (!x.new_title || x.new_title === x.old_title) {
      if ((x.note || '').startsWith('Title says')) out.push({ ...r, fld: 'title', cur: x.old_title, nv: x.old_title, ok: false, note: x.note });
      else same++;
      return;
    }
    out.push({ ...r, t: x.old_title, fld: 'title', cur: x.old_title, nv: x.new_title, ok: x.new_title.length <= 80, note: `Adds ${x.added} · ${x.new_title.length} characters · ${x.note}` });
  });
  edMode = 'fitment';
  edShowPreview(out, same, 'titles can be improved from fitment');
}
const FLD_NAME = { price: 'Price', qty: 'Stock', title: 'Title', specific: 'Item specific', bestoffer: 'Best Offer', fitment: 'Fitment' };
const boText = v => !v ? '–' : v.off ? 'turn off' : v.restore !== undefined ? boText(v.restore || { enabled: false }) : v.enabled === false ? 'off' :
  [v.accept ? `accept from ${gbp(v.accept)}` : '', v.decline ? `decline below ${gbp(v.decline)}` : ''].filter(Boolean).join(' · ') || 'on';
function edBestOffer(picked) {
  if ($('edBoHow').value === 'off') {
    const out = picked.map(r => r.bo && !r.bo.on ? { ...r, fld: 'bestoffer', cur: null, nv: null, ok: false, note: 'Best Offer is already off' }
      : { ...r, fld: 'bestoffer', cur: null, nv: { off: true }, ok: true, note: r.bo ? `Read from eBay ${ago(r.bo.at)}; checked again when applied` : 'Not read yet: if Best Offer is already off, eBay is left as it is' });
    edMode = 'bestoffer'; edShowPreview(out, 0, 'listings get Best Offer turned off'); return;
  }
  const pf = edProfitFn(), acc = (+$('edBoAcc').value || 0) / 100, minP = +$('edBoMinP').value || 0, ad = (+$('edBoAd').value || 0) / 100, on = $('edBoOn').checked;
  const ceil2 = v => Math.ceil(v * 100 - 1e-6) / 100, floor2 = v => Math.floor(v * 100 + 1e-6) / 100;
  const out = [];
  for (const r of picked) {
    const price = r.price || 0, fr = pf.R.fee(r.a), po = pf.R.post(r.sku, r.g), k = 1 - fr - ad;
    const c = costAt(pf.cmap, r.sku, price);  // what the part cost: an offer doesn't change it, so the band comes from the listing price
    if (!c) { out.push({ ...r, fld: 'bestoffer', cur: null, nv: null, ok: false, note: 'No cost for this SKU. Add it on the COGS page.' }); continue; }
    const fl = (minP + c.c + po) / k;
    const decline = ceil2(fl), accept = Math.max(floor2(price * (1 - acc)), ceil2(decline + 0.01));
    const prof = p => p * k - c.c - po;
    if (accept >= price || decline >= price) { out.push({ ...r, fld: 'bestoffer', cur: null, nv: null, ok: false, note: `Price ${gbp(price)} is too close to the ${gbp(decline)} floor for Best Offer` }); continue; }
    out.push({ ...r, fld: 'bestoffer', cur: null, nv: { accept, decline, enable: on }, ok: true,
      note: `Accept from ${gbp(accept)} (${((1 - accept / price) * 100).toFixed(0)}% off, profit about ${gbp(prof(accept))}) · decline below ${gbp(decline)} (keeps ${gbp(minP)}) · cost ${gbp(c.c)}${c.src === 'band' ? ' (band)' : ''}, postage ${gbp(po)}, fees ${(fr * 100).toFixed(1)}%, ads ${(ad * 100).toFixed(0)}%` });
  }
  edMode = 'bestoffer';
  edShowPreview(out, 0, 'listings get Best Offer rules');
}
function edFmt(fld, v) { return v == null ? '–' : fld === 'bestoffer' ? esc(boText(v)) : fld === 'price' ? gbp(v) : fld === 'qty' ? n0(v) : fld === 'specific' ? `${esc(v.name)}: <b>${esc(v.value)}</b>` : esc(v); }
function drawEdit() {
  const cols = [
    { h: `<input type="checkbox" id="edAll" aria-label="Select all" checked>`, l: 1, v: () => 0, f: r => `<input type="checkbox" class="ed-sel" data-k="${r.aid}|${esc(r.id)}|${r.fld}" ${r.ok ? 'checked' : 'disabled'} aria-label="Select ${esc(r.sku || r.id)}">` },
    { h: 'Listing', l: 1, cl: 'prod', v: r => r.sku, f: r => `<span class="t">${esc(r.fld === 'title' ? r.cur : r.t)}</span><span class="s"><span class="dot" style="background:${ACC[r.a].color}"></span>${esc(ACC[r.a].name)} · ${esc(r.sku || 'No SKU')} · <a href="https://www.ebay.co.uk/itm/${esc(r.id)}" target="_blank" rel="noopener">${esc(r.id)}</a></span>` },
    { h: 'Change', l: 1, v: r => r.fld, f: r => FLD_NAME[r.fld] },
    { h: 'Now', l: 1, cl: 'prod', v: r => typeof r.cur === 'number' ? r.cur : String(r.cur ?? ''), f: r => r.fld === 'bestoffer' && r.bo ? esc(r.bo.on ? boText({ enabled: true, accept: r.bo.accept, decline: r.bo.decline }) : 'off') : r.fld === 'specific' || r.fld === 'bestoffer' ? '<span class="muted">read when applied</span>' : r.fld === 'title' ? `<span class="oldv">${esc(r.cur)}</span>` : edFmt(r.fld, r.cur) },
    { h: 'New', l: 1, cl: 'prod', v: r => typeof r.nv === 'number' ? r.nv : String(r.nv ?? ''), f: r => `<b>${edFmt(r.fld, r.nv)}</b>` },
    { h: 'Notes', l: 1, cl: 'prod', v: r => r.note, f: r => `<span class="${r.ok ? 'muted' : 'neg'}">${esc(r.note)}</span>` }];
  table($('edTable'), cols, edRows, null, edState);
  $('edMore').hidden = edRows.length <= edState.limit;
  const all = $('edAll'); if (all) { all.onclick = e => e.stopPropagation(); all.onchange = () => { document.querySelectorAll('.ed-sel:not([disabled])').forEach(b => b.checked = all.checked); edSel(); }; }
  document.querySelectorAll('.ed-sel').forEach(b => b.onchange = edSel); edSel();
}
function edChosen() {
  const on = new Set([...document.querySelectorAll('.ed-sel:checked')].map(b => b.dataset.k));
  // rows beyond "Show more" aren't drawn yet: they count as ticked unless they can't be applied
  const drawn = new Set([...document.querySelectorAll('.ed-sel')].map(b => b.dataset.k));
  const k = r => `${r.aid}|${r.id}|${r.fld}`;
  return edRows.filter(r => r.ok && (on.has(k(r)) || !drawn.has(k(r))));
}
function edSel() { const ch = edChosen(); $('edSel').textContent = `${n0(ch.length)} selected`; }
$('edMore').onclick = () => { edState.limit += 500; drawEdit(); };
$('edCsv').onclick = () => csv('bulk-edit-preview.csv', ['Account', 'Item number', 'SKU', 'Title', 'Change', 'Now', 'New', 'Notes'],
  edRows.map(r => [ACC[r.a].name, r.id, r.sku, r.t, FLD_NAME[r.fld], typeof r.cur === 'object' ? '' : r.cur, typeof r.nv === 'object' && r.nv ? `${r.nv.name}: ${r.nv.value}` : r.nv, r.note]));
$('edApply').onclick = async () => {
  const b = $('edApply'), ch = edChosen(), fld = $('edField').value;
  if (!ch.length) return toast('Select at least one change.');
  const nList = new Set(ch.map(x => x.aid + '|' + x.id)).size;
  if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = `Click again to change ${n0(nList)} live listings`; setTimeout(() => { b.dataset.sure = ''; b.textContent = 'Apply to eBay'; }, 6000); return; }
  b.dataset.sure = ''; b.textContent = 'Apply to eBay';
  const summary = edMode === 'bestoffer' && $('edBoHow').value === 'off' ? 'Best Offer: turn off' : edMode === 'bestoffer' ? `Best Offer: accept up to ${$('edBoAcc').value}% off, decline below the £${$('edBoMinP').value} profit floor` : edMode === 'fitment' ? 'Title from fitment (years, make/model, OE)' : edMode === 'typed' ? `Typed changes on ${nList} listing${nList === 1 ? '' : 's'}`
    : fld === 'price' ? { profit: `Price: profit at least £${$('edPriceVal').value} after ${$('edAd').value}% ads`, pct: `Price ${$('edPriceVal').value}%`, add: `Price ${$('edPriceVal').value >= 0 ? '+' : ''}£${$('edPriceVal').value}`, set: `Price set to £${$('edPriceVal').value}` }[$('edPriceHow').value]
    : fld === 'qty' ? `Quantity set to ${$('edQty').value}` : fld === 'title' ? `Title: ${$('edTitleHow').selectedOptions[0].text.toLowerCase()} "${$('edTitleHow').value === 'replace' ? $('edFind').value + '" → "' + $('edRepl').value : $('edRepl').value}"`
    : `${$('edSpecName').value} = ${$('edSpecVal').value} (${$('edSpecMode').value === 'missing' ? 'where missing' : 'all'})`;
  try {
    const r = await post('/api/edit/jobs', { summary, changes: ch.map(x => ({ account_id: x.aid, item_id: x.id, sku: x.sku, title: x.t, field: x.fld, old: x.cur, new: x.nv })) });
    toast('Sending changes to eBay…'); $('edPrevPanel').hidden = true;
    if (edMode === 'typed') ch.forEach(x => { const ty = edTyped.get(x.aid + '|' + x.id); if (ty) delete ty[x.fld]; });
    EL = null; showEditJob(r.job); renderEdit();
  } catch (e) { toast(e.message); }
};
async function renderEditJobs() {
  const jobs = await api('/api/edit/jobs');
  $('edJobs').innerHTML = jobs.length ? `<thead><tr><th class="l">#</th><th class="l">When</th><th class="l">Change</th><th>Listings</th><th>Changed</th><th>Skipped</th><th>Failed</th><th class="l">Status</th><th></th></tr></thead><tbody>${jobs.slice(0, 15).map(j => `<tr>
    <td class="l">${j.id}</td><td class="l">${esc(j.created_at.slice(0, 16))}</td><td class="l prod">${esc(j.summary)}<span class="sub">${esc(j.created_by || '')}</span></td>
    <td>${j.total}</td><td>${j.ok}</td><td>${j.skipped}</td><td>${j.failed}</td>
    <td class="l">${j.status === 'running' || j.status === 'queued' ? `<span class="chip b">Working ${j.done}/${j.total}</span>` : j.undone_by ? `<span class="chip ret">Undone by #${j.undone_by}</span>` : `<span class="chip k">${esc(j.status)}</span>`}</td>
    <td><button class="link" type="button" data-edshow="${j.id}">Details</button>${j.status === 'finished' && j.ok && !j.undone_by ? ` <button class="link danger" type="button" data-edundo="${j.id}">Undo</button>` : ''}</td></tr>`).join('')}</tbody>`
    : '<tbody><tr><td class="empty">No bulk edits yet.</td></tr></tbody>';
  document.querySelectorAll('[data-edshow]').forEach(b => b.onclick = () => showEditJob(+b.dataset.edshow));
  document.querySelectorAll('[data-edundo]').forEach(b => b.onclick = async () => {
    if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Click again to undo'; return; }
    try { const r = await api(`/api/edit/jobs/${b.dataset.edundo}/undo`, { method: 'POST' }); toast('Putting the old values back…'); EL = null; showEditJob(r.job); } catch (e) { toast(e.message); }
  });
}
async function showEditJob(id) {
  clearTimeout(edJobTimer);
  const { job, items } = await api('/api/edit/jobs/' + id), run = job.status === 'running' || job.status === 'queued';
  const fmt = (f, v) => { try { v = JSON.parse(v); } catch (e) { } if (f === 'fitment') return v == null ? '–' : `${n0(v.rows ?? 0)} fitment rows`; return f === 'bestoffer' ? esc(boText(v)) : f === 'specific' ? (v && v.name ? `${esc(v.name)}: ${esc(v.value ?? (v.restore ? v.restore.join(', ') : 'not set'))}` : Array.isArray(v) ? esc(v.join(', ')) : '–') : edFmt(f, v); };
  $('edJob').innerHTML = `<div class="panel-head"><div><h2>#${job.id}: ${esc(job.summary)}</h2><p>${job.done} of ${job.total} done · ${job.ok} changed · ${job.skipped} skipped · ${job.failed} failed · ${run ? 'working…' : esc(job.status)}</p></div></div>
    <div class="tbl-wrap"><table><thead><tr><th class="l">Account</th><th class="l">Listing</th><th class="l">Before</th><th class="l">After</th><th class="l">Result</th></tr></thead><tbody>${items.map(i => `<tr>
      <td class="l">${esc(i.account)}</td><td class="l prod"><span class="t">${esc(i.title || '')}</span><span class="s">${esc(i.sku || '')} · <a href="https://www.ebay.co.uk/itm/${esc(i.item_id)}" target="_blank" rel="noopener">${esc(i.item_id)}</a></span></td>
      <td class="l prod">${fmt(i.field, i.old_value)}</td><td class="l prod">${fmt(i.field, i.new_value)}</td>
      <td class="l prod">${i.status === 'ok' ? '<span class="chip k">Done</span> ' : i.status === 'failed' ? '<span class="chip m">Failed</span> ' : i.status === 'skipped' ? '<span class="chip ret">Skipped</span> ' : '<span class="chip b">Waiting</span> '}${esc(i.message || '')}</td></tr>`).join('')}</tbody></table></div>`;
  if (run) edJobTimer = setTimeout(() => showEditJob(id), 2500); else renderEditJobs();
}

// ---------------------------------------------------------------- stock sync
let STK = null, stTyped = new Map();  // sku -> {on_hand?, enabled?}
const stState = { sort: null, limit: 150, render: () => drawStock(), empty: 'No SKUs match.' };
const accName = id => (ACC[AIDX[id]] || {}).name || '#' + id, accColor = id => (ACC[AIDX[id]] || {}).color || '#888';
async function renderStock() {
  try { STK = await api('/api/stock'); } catch (e) { toast(e.message); return; }
  const s = STK.settings;
  $('stAuto').textContent = s.stock_auto ? 'Automatic sync: ON (click to turn off)' : 'Automatic sync: OFF (click to turn on)';
  $('stAuto').classList.toggle('on', !!s.stock_auto); $('stAuto').classList.toggle('primary', !s.stock_auto);
  if (document.activeElement !== $('stCap')) $('stCap').value = s.stock_cap || 0;
  $('stCapNote').textContent = s.stock_cap ? `Listings show at most ${s.stock_cap}, even when you have more.` : 'Listings show your full stock.';
  $('stAcc').innerHTML = `<thead><tr><th class="l">Account</th><th class="l">eBay out-of-stock control</th><th class="l">Last order check</th></tr></thead><tbody>${STK.accounts.map(a => `<tr>
    <td class="l"><span class="dot" style="background:${a.color}"></span>${esc(a.name)}</td>
    <td class="l">${a.oos_control === 1 ? '<span class="chip k">On</span> <span class="muted">sold-out listings stay live at 0</span>' : a.oos_control === 0 ? '<span class="chip m">Off</span> <span class="muted">listings won\'t be set to 0 (eBay would end them). Turn it on in Seller Hub → Account → Site preferences.</span>' : '<span class="muted">checked at the next order check</span>'}</td>
    <td class="l prod">${a.last_check ? esc(a.last_check.replace('T', ' ').slice(0, 16)) + ' UTC · ' : ''}${a.last_status === 'error' ? '<span class="chip m">Error</span> ' : ''}${esc(a.last_message || (a.last_check ? '' : 'Starts once a stock number is set'))}</td></tr>`).join('')}</tbody>`;
  const pl = STK.plan, ready = pl.filter(p => !p[5]);
  $('stPending').innerHTML = pl.length ? `<b>${n0(ready.length)} listings</b> on eBay don't match the stock numbers${pl.length > ready.length ? ` (${pl.length - ready.length} held back, see list)` : ''}.${s.stock_auto ? ' They update at the next check (within 10 minutes).' : ''}` : 'Every synced listing on eBay matches its stock number.';
  $('stPushBtn').hidden = !ready.length; $('stShowPlan').hidden = !pl.length;
  $('stPlan').innerHTML = `<thead><tr><th class="l">Account</th><th class="l">SKU</th><th class="l">Item</th><th>eBay now</th><th>Will be</th><th class="l"></th></tr></thead><tbody>${pl.map(p => `<tr>
    <td class="l"><span class="dot" style="background:${accColor(p[0])}"></span>${esc(accName(p[0]))}</td><td class="l"><span class="sku">${esc(p[2])}</span></td>
    <td class="l"><a href="https://www.ebay.co.uk/itm/${esc(p[1])}" target="_blank" rel="noopener">${esc(p[1])}</a></td><td>${p[3] ?? '–'}</td><td><b>${p[4]}</b></td><td class="l prod">${p[5] ? `<span class="neg">${esc(p[5])}</span>` : ''}</td></tr>`).join('')}</tbody>`;
  drawStock(); drawStockLogs();
}
function stRows() {
  const f = F(), q = $('stSearch').value.trim().toLowerCase(), show = $('stShow').value, cap = STK.settings.stock_cap;
  return STK.skus.map(r => {
    const ty = stTyped.get(r.sku) || {}, oh = 'on_hand' in ty ? ty.on_hand : r.on_hand, en = 'enabled' in ty ? ty.enabled : !!r.enabled;
    const tgt = oh == null ? null : (cap ? Math.min(oh, cap) : oh);
    const diff = en && tgt != null && r.listings.some(l => l[2] !== tgt);
    const accs = new Set(r.listings.map(l => l[0]));
    return { ...r, oh, en, tgt, diff, nacc: accs.size, typed: Object.keys(ty).length > 0 };
  }).filter(r => (f.allG || f.g.has(r.group)) && (!q || r.sku.toLowerCase().includes(q) || r.title.toLowerCase().includes(q)) &&
    (show === 'all' || (show === 'multi' && r.nacc >= 2) || (show === 'unset' && r.oh == null) || (show === 'synced' && r.en && r.oh != null) || (show === 'off' && !r.en) || (show === 'diff' && r.diff)));
}
function drawStock() {
  if (!STK) return;
  const rows = stRows();
  const synced = STK.skus.filter(r => r.enabled && r.on_hand != null).length;
  $('stSub').textContent = `${n0(rows.length)} SKUs shown · ${n0(synced)} synced. A SKU is only synced once it has a stock number. Sales before you set the number don't count.`;
  const cols = [
    { h: 'SKU', l: 1, cl: 'prod', v: r => r.sku, f: r => `<span class="t">${esc(r.title || r.sku)}</span><span class="s">${esc(r.sku)}</span>` },
    { h: 'On eBay now', l: 1, v: r => r.listings.length, f: r => `<div class="qchips">${r.listings.map(l => `<a class="qchip ${r.en && r.tgt != null && l[2] !== r.tgt ? 'off' : ''}" href="https://www.ebay.co.uk/itm/${esc(l[1])}" target="_blank" rel="noopener" title="${esc(accName(l[0]))} · ${esc(l[1])}"><span class="dot" style="background:${accColor(l[0])}"></span>${l[2] ?? '–'}</a>`).join('') || '<span class="muted">not listed</span>'}</div>` },
    { h: 'Stock on hand', v: r => r.oh ?? -1, f: r => `<input type="number" class="cell-in ${'on_hand' in (stTyped.get(r.sku) || {}) ? 'changed' : ''}" data-sku="${esc(r.sku)}" min="0" step="1" value="${r.oh ?? ''}" placeholder="not set" aria-label="Stock for ${esc(r.sku)}">` },
    { h: 'Sync', v: r => r.en ? 1 : 0, f: r => `<input type="checkbox" class="st-en" data-sku="${esc(r.sku)}" ${r.en ? 'checked' : ''} aria-label="Sync ${esc(r.sku)}">` },
    { h: 'Status', l: 1, v: r => r.oh == null ? 2 : !r.en ? 3 : r.diff ? 0 : 1, f: r => r.oh == null ? '<span class="muted">No stock number</span>' : !r.en ? '<span class="muted">Not synced</span>' : r.diff ? `<span class="chip ret">eBay will change to ${r.tgt}</span>` : '<span class="chip k">In sync</span>' }];
  table($('stTable'), cols, rows, null, stState);
  $('stMore').hidden = rows.length <= stState.limit;
  $('stTable').querySelectorAll('.cell-in').forEach(inp => inp.addEventListener('input', () => {
    const sku = inp.dataset.sku, base = STK.skus.find(x => x.sku === sku), ty = stTyped.get(sku) || {};
    const v = inp.value === '' ? null : Math.max(0, Math.round(+inp.value));
    if (v === base.on_hand) delete ty.on_hand; else ty.on_hand = v;
    stTyped.set(sku, ty); inp.classList.toggle('changed', 'on_hand' in ty); stDirty();
  }));
  $('stTable').querySelectorAll('.st-en').forEach(b => b.onchange = () => {
    const sku = b.dataset.sku, base = STK.skus.find(x => x.sku === sku), ty = stTyped.get(sku) || {};
    if (b.checked === !!base.enabled) delete ty.enabled; else ty.enabled = b.checked;
    stTyped.set(sku, ty); stDirty();
  });
  stDirty();
}
function stDirty() { const n = [...stTyped.values()].filter(v => Object.keys(v).length).length; $('stSave').disabled = !n; $('stDirty').textContent = n ? `${n} unsaved` : ''; }
function drawStockLogs() {
  $('stLog').innerHTML = STK.log.length ? `<thead><tr><th class="l">When (UTC)</th><th class="l">SKU</th><th>Change</th><th>Stock</th><th class="l">Why</th></tr></thead><tbody>${STK.log.map(l => `<tr>
    <td class="l">${esc((l.at || '').replace('T', ' ').slice(0, 16))}</td><td class="l"><span class="sku">${esc(l.sku)}</span></td><td>${l.change == null ? '–' : (l.change > 0 ? '+' : '') + l.change}</td><td>${l.on_hand ?? '–'}</td>
    <td class="l prod">${esc(l.reason)}${l.account ? ' on ' + esc(l.account) : ''}${l.by ? ` <span class="sub">${esc(l.by)}</span>` : ''}</td></tr>`).join('')}</tbody>` : '<tbody><tr><td class="empty">Nothing yet.</td></tr></tbody>';
  $('stPushes').innerHTML = STK.pushes.length ? `<thead><tr><th class="l">When (UTC)</th><th class="l">Account</th><th class="l">SKU</th><th>Qty</th><th class="l">Result</th></tr></thead><tbody>${STK.pushes.map(p => `<tr>
    <td class="l">${esc((p.at || '').slice(0, 16))}</td><td class="l">${esc(p.account || '')}</td><td class="l"><span class="sku">${esc(p.sku)}</span></td><td>${p.old_qty ?? '–'} → <b>${p.new_qty}</b></td>
    <td class="l prod">${p.status === 'ok' ? '<span class="chip k">Done</span>' : '<span class="chip m">Failed</span> ' + esc(p.message)}</td></tr>`).join('')}</tbody>` : '<tbody><tr><td class="empty">Nothing sent yet.</td></tr></tbody>';
}
$('stSearch').addEventListener('input', () => { stState.limit = 150; drawStock(); });
$('stShow').addEventListener('change', () => { stState.limit = 150; drawStock(); });
$('stMore').onclick = () => { stState.limit += 300; drawStock(); };
function stFill(pick) {
  let n = 0;
  stRows().forEach(r => { if (r.oh != null) return; const q = r.listings.map(l => l[2]).filter(v => v != null); if (!q.length) return;
    const ty = stTyped.get(r.sku) || {}; ty.on_hand = pick(q); stTyped.set(r.sku, ty); n++; });
  toast(n ? `Filled ${n} SKUs. Check them, then Save stock.` : 'Every SKU shown already has a stock number.'); drawStock();
}
$('stFillMin').onclick = () => stFill(q => Math.min(...q));
$('stFillMax').onclick = () => stFill(q => Math.max(...q));
function stToggleShown(on) { stRows().forEach(r => { const base = STK.skus.find(x => x.sku === r.sku), ty = stTyped.get(r.sku) || {}; if (on === !!base.enabled) delete ty.enabled; else ty.enabled = on; stTyped.set(r.sku, ty); }); drawStock(); }
$('stOff').onclick = () => stToggleShown(false);
$('stOn').onclick = () => stToggleShown(true);
$('stSave').onclick = async () => {
  const items = [...stTyped.entries()].filter(([, v]) => Object.keys(v).length).map(([sku, v]) => ({ sku, ...v }));
  try { const r = await post('/api/stock/set', { items }); stTyped = new Map(); toast(`Saved ${r.saved} SKUs` + (STK.settings.stock_auto ? '. eBay updates within 10 minutes.' : '. Automatic sync is off, so nothing is sent to eBay yet.')); renderStock(); } catch (e) { toast(e.message); }
};
$('stAuto').onclick = async () => {
  const b = $('stAuto'), on = !STK.settings.stock_auto;
  if (on && b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = `Click again: update ${n0(STK.plan.filter(p => !p[5]).length)} listings now and keep them in step`; setTimeout(() => { b.dataset.sure = ''; renderStock(); }, 6000); return; }
  b.dataset.sure = '';
  try { await post('/api/stock/settings', { stock_auto: on }); if (on) await api('/api/stock/push', { method: 'POST' }); toast(on ? 'Automatic stock sync is on' : 'Automatic stock sync is off'); setTimeout(renderStock, on ? 2500 : 0); } catch (e) { toast(e.message); }
};
$('stCap').addEventListener('change', async () => { try { await post('/api/stock/settings', { stock_cap: +$('stCap').value || 0 }); renderStock(); } catch (e) { toast(e.message); } });
$('stShowPlan').onclick = () => { $('stPlanWrap').hidden = !$('stPlanWrap').hidden; $('stShowPlan').textContent = $('stPlanWrap').hidden ? 'Show which listings' : 'Hide the list'; };
$('stPushBtn').onclick = async () => {
  const b = $('stPushBtn'); if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Click again to update eBay'; setTimeout(() => { b.dataset.sure = ''; b.textContent = 'Update eBay now'; }, 6000); return; }
  b.dataset.sure = ''; b.textContent = 'Update eBay now';
  try { await api('/api/stock/push', { method: 'POST' }); toast('Updating quantities on eBay…'); setTimeout(renderStock, 4000); } catch (e) { toast(e.message); }
};

// ---------------------------------------------------------------- buyer messages
let MSG = null, msSel = null, msDrafts = new Map(), msTicked = new Set(), msShownOpen = [];
function msBulkCount() {
  const n = msTicked.size; $('msBulkDone').disabled = !n; $('msBulkDone').textContent = n ? `Mark ${n} as done` : 'Mark ticked as done';
  $('msTickAll').textContent = msShownOpen.length && msShownOpen.every(t => msTicked.has(t.k)) ? 'Untick all' : `Tick all shown (${msShownOpen.length})`;
}
const ukTime = s => s ? new Date(s + 'Z').toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
function ago(s) {
  const m = (Date.now() - new Date(s + 'Z')) / 6e4;
  return m < 60 ? `${Math.max(1, Math.round(m))} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
}
function msThreads() {
  const th = new Map();
  MSG.messages.forEach(m => {
    const k = `${m.account_id}|${m.sender}|${m.item_id || ''}`;
    const t = th.get(k) || { k, a: m.account_id, sender: m.sender, item: m.item_id, title: m.item_title, msgs: [] };
    t.msgs.push(m); th.set(k, t);
  });
  return [...th.values()].map(t => {
    t.msgs.sort((x, y) => x.created.localeCompare(y.created));
    t.last = t.msgs[t.msgs.length - 1];
    t.openMsgs = t.msgs.filter(m => m.status !== 'Answered' && !m.done);
    t.open = t.openMsgs.length > 0; t.done = !t.open && t.msgs.some(m => m.done && m.status !== 'Answered');
    return t;
  });
}
async function renderMsgs(keepSel) {
  try { MSG = await api('/api/messages'); } catch (e) { toast(e.message); return; }
  const errs = MSG.accounts.filter(a => a.last_status === 'error');
  const checked = MSG.accounts.map(a => a.last_check).filter(Boolean).sort().pop();
  $('msStatus').innerHTML = MSG.accounts.length ? (checked ? `Checked ${ago(checked)} (every 10 minutes) for ${MSG.accounts.map(a => esc(a.name)).join(', ')}.` : 'First check runs within a few minutes.') +
    (errs.length ? ` <span class="neg">${errs.map(a => `${esc(a.name)}: ${esc(a.last_message)}`).join(' · ')}</span>` : '') : 'Connect your eBay accounts on the eBay page first.';
  drawThreads(); drawTemplates();
  if (keepSel && msSel) drawConvo();
}
function drawThreads() {
  const f = F(), show = $('msShow').value, q = $('msSearch').value.trim().toLowerCase();
  const all = msThreads().filter(t => f.a.has(AIDX[t.a]));
  const n = all.filter(t => t.open).length; $('msgBadge').textContent = n; $('msgBadge').hidden = !n; D.msgOpen = n;
  const rows = all.filter(t => (show === 'all' || (show === 'open' && t.open) || (show === 'answered' && !t.open && !t.done) || (show === 'done' && t.done)) &&
    (!q || t.sender.toLowerCase().includes(q) || (t.title || '').toLowerCase().includes(q) || t.msgs.some(m => (m.body || '').toLowerCase().includes(q) || (m.subject || '').toLowerCase().includes(q))))
    .sort((x, y) => (y.open - x.open) || y.last.created.localeCompare(x.last.created));
  // tick boxes for conversations waiting for a reply, so several can be marked done at once
  const tickable = rows.filter(t => t.open);
  [...msTicked].forEach(k => { if (!tickable.some(t => t.k === k)) msTicked.delete(k); });
  $('msBulk').hidden = !tickable.length;
  $('msList').innerHTML = rows.length ? rows.map(t => `<div class="trow" role="listitem">${t.open ? `<input type="checkbox" class="ms-tick" data-k="${esc(t.k)}" ${msTicked.has(t.k) ? 'checked' : ''} aria-label="Tick conversation with ${esc(t.sender)}">` : '<span class="ms-tick-gap"></span>'}<button type="button" class="thread ${t.open ? 'open' : ''}" data-k="${esc(t.k)}" aria-current="${msSel === t.k}">
      <span class="top"><span><span class="dot" style="background:${accColor(t.a)}"></span>${esc(accName(t.a))}</span><span>${ago(t.last.created)}</span></span>
      <b>${esc(t.sender)}</b><span class="it">${esc(t.title || 'General question')}</span><span class="sn">${esc((t.last.body || t.last.subject || '').slice(0, 120))}</span></button></div>`).join('')
    : `<p class="empty">${show === 'open' ? 'No questions waiting for a reply.' : 'No messages match.'}</p>`;
  $('msList').querySelectorAll('.thread').forEach(b => b.onclick = () => { msSel = b.dataset.k; $('msList').querySelectorAll('.thread').forEach(x => x.setAttribute('aria-current', x === b)); drawConvo(); });
  $('msList').querySelectorAll('.ms-tick').forEach(c => c.onchange = () => { c.checked ? msTicked.add(c.dataset.k) : msTicked.delete(c.dataset.k); msBulkCount(); });
  msShownOpen = tickable; msBulkCount();
  if (!msSel && rows.length && matchMedia('(min-width:861px)').matches) { msSel = rows[0].k; $('msList').querySelector('.thread').setAttribute('aria-current', 'true'); drawConvo(); }
  if (msSel && !rows.some(t => t.k === msSel) && !all.some(t => t.k === msSel)) { msSel = null; $('msConvo').innerHTML = '<p class="empty">Choose a conversation.</p>'; }
}
function drawConvo() {
  const t = msThreads().find(x => x.k === msSel); if (!t) return;
  const it = MSG.items[t.item] || null;
  const bubbles = [];
  t.msgs.forEach(m => {
    bubbles.push(`<div class="bubble buyer"><small>${esc(t.sender)} · ${ukTime(m.created)}${m.subject && !/^(question|re:)/i.test(m.subject) ? ' · ' + esc(m.subject) : ''}</small>${esc(m.body || '')}</div>`);
    const rs = m.responses && m.responses.length ? m.responses : m.reply_text ? [m.reply_text] : [];
    rs.forEach(r => bubbles.push(`<div class="bubble me"><small>You${m.replied_by ? ' (' + esc(m.replied_by) + ')' : ''}${m.replied_at ? ' · ' + ukTime(m.replied_at) : ''}</small>${esc(r)}</div>`));
    if (!rs.length && m.status === 'Answered') bubbles.push('<div class="bubble me"><small>You</small><span class="muted">Answered on eBay</span></div>');
  });
  const target = t.openMsgs[t.openMsgs.length - 1] || t.last;
  const draft = msDrafts.get(t.k) || '';
  $('msConvo').innerHTML = `<div class="head"><h3>${t.item ? `<a href="https://www.ebay.co.uk/itm/${esc(t.item)}" target="_blank" rel="noopener">${esc(t.title || t.item)}</a>` : 'General question'}</h3>
      <div class="meta"><span><span class="dot" style="background:${accColor(t.a)}"></span>${esc(accName(t.a))}</span><span>Buyer: <b>${esc(t.sender)}</b></span>
      ${it ? `<span>SKU <span class="sku">${esc(it.sku || '–')}</span></span><span>${gbp(it.price)}</span><span>Stock ${it.qty ?? '–'}</span><span>Sold ${n0(it.sold)}</span>` : ''}
      ${t.open ? '<span class="chip ret">Needs a reply</span>' : t.done ? '<span class="chip b">Marked done</span>' : '<span class="chip k">Answered</span>'}</div></div>
    <div class="msgs" id="msMsgs">${bubbles.join('')}</div>
    <div class="reply">
      <div class="tpls">${MSG.templates.map((p, i) => `<button type="button" class="tplbtn" data-tpl="${i}">${esc(p.name)}</button>`).join('')}</div>
      <label for="msText" class="muted" style="font-size:12px">Reply to ${esc(t.sender)} — sent through eBay (no links, phone numbers or email addresses)</label>
      <textarea id="msText" maxlength="2000">${esc(draft)}</textarea>
      <div class="row"><span class="muted" id="msLen">${draft.length}/2000</span>
        <label class="chk" style="padding:0"><input type="checkbox" id="msPublic"> Also show on the listing's public questions</label>
        <span style="flex:1"></span>
        ${t.open ? '<button class="btn" type="button" id="msDone">Mark done, no reply</button>' : t.done ? '<button class="btn" type="button" id="msUndone">Move back to needs a reply</button>' : ''}
        <button class="btn primary" type="button" id="msSend">Send reply</button></div>
    </div>`;
  const box = $('msMsgs'); box.scrollTop = box.scrollHeight;
  const ta = $('msText');
  ta.oninput = () => { msDrafts.set(t.k, ta.value); $('msLen').textContent = `${ta.value.length}/2000`; };
  $('msConvo').querySelectorAll('[data-tpl]').forEach(b => b.onclick = () => {
    const p = MSG.templates[+b.dataset.tpl]; const txt = p.text.replaceAll('{buyer}', t.sender).replaceAll('{title}', t.title || 'this part');
    ta.value = ta.value.trim() ? ta.value.trim() + '\n\n' + txt : txt; ta.oninput(); ta.focus();
  });
  $('msSend').onclick = async () => {
    const b = $('msSend'); if (!ta.value.trim()) return toast('Type a reply first.');
    if (/https?:\/\/|www\.|@[a-z0-9-]+\.[a-z]|\b0\d{9,10}\b/i.test(ta.value) && b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'eBay may block links, emails or phone numbers. Send anyway?'; return; }
    b.disabled = true; b.textContent = 'Sending…';
    try { await post('/api/messages/reply', { account_id: t.a, message_id: target.message_id, text: ta.value, public: $('msPublic').checked }); msDrafts.delete(t.k); toast('Reply sent'); await renderMsgs(true); }
    catch (e) { toast(e.message); b.disabled = false; b.textContent = 'Send reply'; b.dataset.sure = ''; }
  };
  const done = $('msDone'); if (done) done.onclick = async () => { await post('/api/messages/done', { account_id: t.a, message_ids: t.openMsgs.map(m => m.message_id), done: true }); toast('Marked done'); renderMsgs(true); };
  const und = $('msUndone'); if (und) und.onclick = async () => { await post('/api/messages/done', { account_id: t.a, message_ids: t.msgs.map(m => m.message_id), done: false }); renderMsgs(true); };
}
function drawTemplates() {
  $('tplList').innerHTML = MSG.templates.map((p, i) => `<div class="tpl"><input type="text" value="${esc(p.name)}" data-i="${i}" data-f="name" aria-label="Quick reply name" maxlength="40">
    <textarea data-i="${i}" data-f="text" aria-label="Quick reply text" maxlength="2000">${esc(p.text)}</textarea><button class="link danger" type="button" data-del="${i}">Remove</button></div>`).join('') || '<p class="empty">No quick replies yet.</p>';
  $('tplList').querySelectorAll('[data-f]').forEach(el => el.oninput = () => { MSG.templates[+el.dataset.i][el.dataset.f] = el.value; });
  $('tplList').querySelectorAll('[data-del]').forEach(b => b.onclick = () => { MSG.templates.splice(+b.dataset.del, 1); drawTemplates(); });
}
$('tplAdd').onclick = () => { MSG.templates.push({ name: 'New reply', text: 'Hi {buyer}, ' }); drawTemplates(); };
$('tplSave').onclick = async () => { try { MSG.templates = await post('/api/messages/templates', { items: MSG.templates }); toast('Quick replies saved'); drawTemplates(); if (msSel) drawConvo(); } catch (e) { toast(e.message); } };
$('msShow').addEventListener('change', drawThreads);
$('msTickAll').onclick = () => { const all = msShownOpen.every(t => msTicked.has(t.k)); msShownOpen.forEach(t => all ? msTicked.delete(t.k) : msTicked.add(t.k)); drawThreads(); };
$('msBulkDone').onclick = async () => {
  const ths = msThreads().filter(t => msTicked.has(t.k));
  const items = ths.flatMap(t => t.openMsgs.map(m => ({ account_id: t.a, message_id: m.message_id })));
  if (!items.length) return;
  try { await post('/api/messages/done', { items, done: true }); toast(`${ths.length} conversation${ths.length === 1 ? '' : 's'} marked done`); msTicked.clear(); renderMsgs(true); } catch (e) { toast(e.message); }
};
$('msSearch').addEventListener('input', drawThreads);
$('msCheck').onclick = async () => { try { await api('/api/messages/check', { method: 'POST' }); toast('Checking eBay for new messages…'); setTimeout(() => renderMsgs(true), 8000); } catch (e) { toast(e.message); } };
setInterval(() => { if (page === 'msgs' && MSG && !document.hidden && !($('msText') && document.activeElement === $('msText'))) renderMsgs(true); }, 120000);

// ---------------------------------------------------------------- Promoted Listings performance
let adViews = null;
let ADS = null, adFlag = 'sugg', adOff = new Set(), adOn = new Set(), adRateTyped = new Map(), adRowsCache = [];
const adState = { sort: null, limit: 150, render: () => drawAds(), empty: 'No listings match.' };
const AD_ACT = {
  stop: { name: 'Stop', chip: 'm' }, lower: { name: 'Lower', chip: 'ret' }, raise: { name: 'Raise', chip: 'b' },
  start: { name: 'Start', chip: 'b' }, keep: { name: 'Keep', chip: 'k' }, organic: { name: 'Sells without ads', chip: 'k' }, none: { name: 'No change', chip: '' },
};
async function renderAds2() {
  try {
    const w = $('adWin').value;
    [ADS] = await Promise.all([api('/api/ads?window=' + w), EL ? null : api('/api/edit/listings').then(r => { EL = r; }),
      adViews ? null : api(`/api/traffic?start=${addD(TODAY, -30)}&end=${addD(TODAY, -1)}`).then(td => { adViews = new Map(td.rows.map(r => [r[0] + '|' + r[1], r[10]])); adViews.has_data = td.rows.length > 0; }).catch(() => { adViews = new Map(); })]);
  } catch (e) { toast(e.message); return; }
  const st = ADS.state;
  $('adStatus').innerHTML = st.length ? st.map(a => `${esc(a.name)}: ${a.fetched_at ? (a.status === 'error' ? '<span class="neg">' + esc(a.message) + '</span>' : `updated ${ago(a.fetched_at)} · ${esc(a.message || '')}`) : 'first report within the hour'}`).join('<br>')
    + '<br><span class="muted">Ad fees and ad sales come from your eBay payments (each Promoted Listings fee is tied to its sale); impressions and clicks come from eBay\'s daily ad report.</span>' : 'Connect your eBay accounts on the eBay page first.';
  drawAds(); drawAdLog();
}
function adRows() {
  const f = F(), w = +$('adWin').value, from = addD(TODAY, -w), pf = edProfitFn();
  const orgU = Math.max(0, +$('adOrgU').value || 0), orgV = Math.max(0, +$('adOrgV').value || 0);
  const minP = +$('adMinP').value || 0, lo = +$('adLo').value || 2, hi = +$('adHi').value || 15, step = +$('adStep').value || 2, startAt = +$('adStart').value || 5;
  const cur = new Map(), perf = new Map(), own = new Map();
  ADS.current.forEach(c => { if (c[4] === 'COST_PER_SALE') cur.set(c[0] + '|' + c[1], { cid: c[2], cname: c[3], rate: c[5], status: c[6], dyn: c[7] === 'DYNAMIC' }); });
  ADS.perf.forEach(p => perf.set(p[0] + '|' + p[1], { imp: p[2], clicks: p[3], units: p[4], sales: p[5], fees: p[6] }));
  I.forEach(x => { if (x.d < from || !x.id) return; const k = ACC[x.a].id + '|' + x.id, o = own.get(k) || { u: 0, adU: 0, adS: 0, adF: 0 };
    o.u += x.q; if (x.ad < 0) { o.adU += x.q; o.adS += x.s; o.adF -= x.ad; } own.set(k, o); });
  const r1 = v => Math.floor(v * 10) / 10;
  return EL.rows.map(r => {
    const L = { a: AIDX[r[0]], aid: r[0], id: r[1], sku: r[2], g: r[3], t: r[4], price: r[5] || 0, qty: r[6] };
    const k = L.aid + '|' + L.id, c = cur.get(k), p = perf.get(k), o = own.get(k) || { u: 0, adU: 0, adS: 0, adF: 0 };
    const cost = costAt(pf.cmap, L.sku, L.price), fr = pf.R.fee(L.a), post = pf.R.post(L.sku, L.g);
    const base = cost ? L.price * (1 - fr) - cost.c - post : null;      // profit per sale before ads
    const maxRate = base != null && L.price ? r1((base - minP) / L.price * 100) : null;
    const rate = c ? c.rate : null;
    const adU = o.adU || (p ? p.units : 0), adF = o.adF || (p ? p.fees : 0), adS = o.adS || (p ? p.sales : 0);
    const profitNow = base != null ? base - L.price * (rate || 0) / 100 : null;
    let act = 'none', nr = null, why = '';
    if (L.qty === 0) { act = 'none'; why = 'Out of stock'; }
    else if (!cost) { act = 'none'; why = 'No cost for this SKU, so no safe rate can be worked out'; }
    else if (rate != null) {
      if (maxRate < lo) { act = 'stop'; why = `Even at ${lo}% an ad sale leaves less than ${gbp(minP)} (${gbp(base - L.price * lo / 100)})`; }
      else if (rate > maxRate + 0.05) { act = 'lower'; nr = Math.max(lo, Math.min(hi, maxRate)); why = `At ${rate}% an ad sale leaves ${gbp(profitNow)}; ${nr}% keeps ${gbp(minP)}+`; }
      else if (adU === 0 && p && p.imp < 200 && rate + 0.05 < Math.min(maxRate, hi)) { act = 'raise'; nr = r1(Math.min(rate + step, maxRate, hi)); why = `Hardly shown in ads (${n0(p.imp)} impressions); ${nr}% still leaves ${gbp(base - L.price * nr / 100)}`; }
      else if (adU === 0 && p && p.clicks >= 30) { act = 'keep'; why = `${n0(p.clicks)} ad clicks but no sale: check price, photos or fitment`; }
      else { act = 'keep'; why = adU ? `${n0(adU)} ad sales, each leaving about ${gbp(profitNow)}` : 'No ad sales yet; an ad costs nothing until it sells'; }
    } else if (Math.max(0, o.u - adU) >= Math.max(1, orgU) && (!adViews || !adViews.has_data || (adViews.get(k) || 0) >= orgV)) {
      act = 'organic'; why = `Sold ${n0(Math.max(0, o.u - adU))} without ads in ${w} days` + (adViews && adViews.has_data ? ` with ${n0(adViews.get(k) || 0)} views in 30 days` : '') + ', so no ad suggested';
    } else if (maxRate >= lo) { act = 'start'; nr = r1(Math.max(lo, Math.min(startAt, maxRate, hi))); why = `Not promoted. ${nr}% still leaves ${gbp(base - L.price * nr / 100)} per sale`; }
    else { act = 'none'; why = `Not promoted. Margin too thin: below ${lo}% would be needed`; }
    if (c && c.dyn && nr != null && act !== 'stop') why += `. eBay sets rates itself in "${c.cname}", so this moves it to ${'Partsledger General'} at a fixed rate`;
    const typed = adRateTyped.get(k);
    return { ...L, k, c, p, o, rate, maxRate, base, profitNow, adU, adF, adS, act, nr: typed != null ? typed : nr, why, cost };
  }).filter(r => r.a !== undefined && f.a.has(r.a) && (f.allG || f.g.has(r.g)));
}
function drawAds() {
  if (!ADS || !EL) return;
  const all = adRows(), q = $('adSearch').value.trim().toLowerCase();
  adRowsCache = all;
  const cnt = {}; all.forEach(r => cnt[r.act] = (cnt[r.act] || 0) + 1);
  const sugg = (cnt.stop || 0) + (cnt.lower || 0) + (cnt.raise || 0) + (cnt.start || 0);
  const T = all.reduce((t, r) => { t.fees += r.adF; t.adS += r.adS; t.adU += r.adU; t.u += r.o.u; t.imp += r.p ? r.p.imp : 0; t.cl += r.p ? r.p.clicks : 0; t.prom += r.rate != null ? 1 : 0; return t; }, { fees: 0, adS: 0, adU: 0, u: 0, imp: 0, cl: 0, prom: 0 });
  const stat = (k, v, sub) => `<div class="stat"><small>${k}</small><b>${v}</b>${sub ? `<span>${sub}</span>` : ''}</div>`;
  $('adStats').innerHTML = stat('Ad fees', gbp(T.fees), `last ${$('adWin').value} days`) + stat('Ad sales', gbp(T.adS), `${n0(T.adU)} units`) +
    stat('Return on ads', T.fees ? (T.adS / T.fees).toFixed(1) + '×' : '–', 'ad sales ÷ ad fees') + stat('Sold through ads', pct(T.u ? T.adU / T.u : NaN), `of ${n0(T.u)} units sold`) +
    stat('Ad clicks', n0(T.cl), `${n0(T.imp)} ad impressions`) + stat('Promoted', n0(T.prom), `${n0(sugg)} suggestions`);
  const fb = [['sugg', 'Suggested changes', sugg], ['all', 'All listings', all.length], ...['stop', 'lower', 'raise', 'start', 'organic', 'keep'].map(k => [k, AD_ACT[k].name, cnt[k] || 0])];
  $('adFlags').innerHTML = fb.map(([k, n, c]) => `<button type="button" data-af="${k}" aria-pressed="${adFlag === k}">${n} <em>${n0(c)}</em></button>`).join('');
  $('adFlags').querySelectorAll('[data-af]').forEach(b => b.onclick = () => { adFlag = b.dataset.af; adState.limit = 150; drawAds(); });
  const rows = all.filter(r => (adFlag === 'all' || (adFlag === 'sugg' ? ['stop', 'lower', 'raise', 'start'].includes(r.act) : r.act === adFlag)) &&
    (!q || r.sku.toLowerCase().includes(q) || r.t.toLowerCase().includes(q) || r.id.includes(q)));
  $('adSub').textContent = `${n0(rows.length)} listings. Rates are worked out so each ad sale still leaves at least ${gbp(+$('adMinP').value || 0)} after COGS, postage, eBay fees and the ad fee.`;
  const canAct = r => ['stop', 'lower', 'raise', 'start'].includes(r.act) || adRateTyped.has(r.k);
  const cols = [
    { h: '', l: 1, v: r => adOff.has(r.k) ? 1 : 0, f: r => canAct(r) ? `<input type="checkbox" class="ad-sel" data-k="${esc(r.k)}" ${adTicked(r) ? 'checked' : ''} aria-label="Tick ${esc(r.sku || r.id)}">` : '' },
    { h: 'Listing', l: 1, cl: 'prod', v: r => r.t, f: r => `<span class="t">${esc(r.t)}</span><span class="s"><span class="dot" style="background:${ACC[r.a].color}"></span>${esc(ACC[r.a].name)} · ${esc(r.sku || 'No SKU')} · <a href="https://www.ebay.co.uk/itm/${esc(r.id)}" target="_blank" rel="noopener">${esc(r.id)}</a></span>` },
    { h: 'Price', v: r => r.price, f: r => gbp(r.price) + `<span class="sub">stock ${r.qty ?? '–'}</span>` },
    { h: 'Rate now', v: r => r.rate ?? -1, f: r => r.rate != null ? `${r.rate}%<span class="sub">${r.c.dyn ? 'dynamic · ' : ''}${esc((r.c.cname || '').slice(0, 22))}</span>` : '<span class="muted">not promoted</span>' },
    { h: 'Ad clicks', v: r => r.p ? r.p.clicks : -1, f: r => r.p ? `${n0(r.p.clicks)}<span class="sub">${n0(r.p.imp)} impr.</span>` : '–' },
    { h: 'Ad sales', v: r => r.adU, f: r => `${n0(r.adU)}<span class="sub">${r.adU ? gbp(r.adS) + ' · ' : ''}of ${n0(r.o.u)} sold</span>` },
    { h: 'Ad fees', v: r => r.adF, f: r => r.adF ? money(-r.adF) + (r.adS ? `<span class="sub">${(r.adF / r.adS * 100).toFixed(1)}% of ad sales</span>` : '') : '–' },
    { h: 'Profit / ad sale', v: r => r.profitNow ?? -1e9, f: r => (r.profitNow != null && r.rate != null ? `<b>${money(r.profitNow)}</b>` : r.base != null ? `<span class="muted">${gbp(r.base)} before ads</span>` : '–') +
        (r.maxRate != null ? `<span class="sub">safe up to ${r.maxRate > 0 ? r.maxRate + '%' : 'no rate'}</span>` : '') },
    { h: 'Suggestion', l: 1, cl: 'prod', v: r => r.act, f: r => `${r.act !== 'none' ? `<span class="chip ${AD_ACT[r.act].chip}">${AD_ACT[r.act].name}${r.nr != null && r.act !== 'stop' ? ' → ' + r.nr + '%' : ''}</span>` : ''}<span class="next">${esc(r.why)}</span>` },
    { h: 'New rate %', v: r => r.nr ?? -1, f: r => r.act === 'stop' && !adRateTyped.has(r.k) ? '<span class="neg">stop</span>' : `<input type="number" class="cell-in ${adRateTyped.has(r.k) ? 'changed' : ''}" style="width:72px" data-k="${esc(r.k)}" step="0.1" min="1" max="100" value="${r.nr ?? r.rate ?? ''}" placeholder="–" aria-label="New ad rate for ${esc(r.sku || r.id)}">` }];
  table($('adTable'), cols, rows, null, adState);
  $('adMore').hidden = rows.length <= adState.limit;
  $('adTable').querySelectorAll('.ad-sel').forEach(b => b.onchange = () => { adSetTick(b.dataset.k, b.checked); adSelCount(); });
  adShown = rows;
  $('adTable').querySelectorAll('.cell-in').forEach(inp => inp.addEventListener('change', () => {
    const v = inp.value === '' ? null : Math.round(+inp.value * 10) / 10;
    if (v == null) adRateTyped.delete(inp.dataset.k); else adRateTyped.set(inp.dataset.k, v);
    drawAds();
  }));
  adSelCount();
}
let adShown = [];
// "Start" (new ads) is opt-in; every other suggestion starts ticked
const adTicked = r => (r.act === 'start' && !adRateTyped.has(r.k)) ? adOn.has(r.k) : !adOff.has(r.k);
function adSetTick(k, on) { if (on) { adOn.add(k); adOff.delete(k); } else { adOn.delete(k); adOff.add(k); } }
function adChosen() {
  return adRowsCache.filter(r => adTicked(r) && (['stop', 'lower', 'raise', 'start'].includes(r.act) || adRateTyped.has(r.k)))
    .filter(r => adRateTyped.has(r.k) ? r.nr !== r.rate : true);
}
function adSelCount() { $('adSel').textContent = `${n0(adChosen().length)} ticked`; }
function drawAdLog() {
  $('adLog').innerHTML = ADS.changes.length ? `<thead><tr><th class="l">When (UTC)</th><th class="l">Account</th><th class="l">Listing</th><th>Before</th><th>After</th><th class="l">Result</th></tr></thead><tbody>${ADS.changes.map(c => `<tr>
    <td class="l">${esc((c.at || '').slice(0, 16))}</td><td class="l">${esc(c.account || '')}</td><td class="l"><span class="sku">${esc(c.sku || '')}</span> <a href="https://www.ebay.co.uk/itm/${esc(c.item_id)}" target="_blank" rel="noopener">${esc(c.item_id)}</a></td>
    <td>${c.old_rate != null ? c.old_rate + '%' : '–'}</td><td>${c.action === 'stop' ? 'stopped' : c.new_rate + '%'}</td>
    <td class="l prod">${c.status === 'done' ? '<span class="chip k">Done</span> ' : c.status === 'failed' ? '<span class="chip m">Failed</span> ' : '<span class="chip b">Waiting</span> '}${esc(c.message || '')}</td></tr>`).join('')}</tbody>` : '<tbody><tr><td class="empty">No ad changes sent yet.</td></tr></tbody>';
  if (ADS.changes.some(c => c.status === 'waiting')) setTimeout(async () => { if (page === 'ads') { ADS = await api('/api/ads?window=' + $('adWin').value); drawAds(); drawAdLog(); } }, 3000);
}
['adMinP', 'adLo', 'adHi', 'adStep', 'adStart', 'adOrgU', 'adOrgV'].forEach(id => $(id).addEventListener('change', () => drawAds()));
$('adWin').addEventListener('change', renderAds2);
$('adSearch').addEventListener('input', () => { adState.limit = 150; drawAds(); });
$('adMore').onclick = () => { adState.limit += 300; drawAds(); };
$('adTickAll').onclick = () => { adShown.forEach(r => adSetTick(r.k, true)); drawAds(); };
$('adUntickAll').onclick = () => { adShown.forEach(r => adSetTick(r.k, false)); drawAds(); };
$('adRefresh').onclick = async () => { try { await api('/api/ads/refresh', { method: 'POST' }); toast('Asking eBay for the latest ad report… this can take a few minutes'); setTimeout(renderAds2, 60000); } catch (e) { toast(e.message); } };
$('adCsv').onclick = () => csv('promoted-listings.csv', ['Account', 'Item number', 'SKU', 'Title', 'Price', 'Rate now', 'Ad impressions', 'Ad clicks', 'Ad sales units', 'Ad sales £', 'Ad fees £', 'All units sold', 'Profit per ad sale', 'Highest safe rate', 'Suggestion', 'New rate', 'Why'],
  (adState.rows || []).map(r => [ACC[r.a].name, r.id, r.sku, r.t, r.price, r.rate ?? '', r.p ? r.p.imp : '', r.p ? r.p.clicks : '', r.adU, r.adS.toFixed(2), r.adF.toFixed(2), r.o.u, r.profitNow != null ? r.profitNow.toFixed(2) : '', r.maxRate ?? '', AD_ACT[r.act].name, r.nr ?? '', r.why]));
$('adApply').onclick = async () => {
  const b = $('adApply'), ch = adChosen();
  if (!ch.length) return toast('Nothing ticked to change.');
  const n = { stop: 0, rate: 0 }; ch.forEach(r => (r.act === 'stop' && !adRateTyped.has(r.k)) ? n.stop++ : n.rate++);
  if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = `Click again: ${n.rate} rate changes${n.stop ? `, stop ${n.stop}` : ''}`; setTimeout(() => { b.dataset.sure = ''; b.textContent = 'Apply ticked to eBay'; }, 6000); return; }
  b.dataset.sure = ''; b.textContent = 'Apply ticked to eBay';
  try {
    const r = await post('/api/ads/apply', { changes: ch.map(x => ({ account_id: x.aid, item_id: x.id, sku: x.sku, action: x.act === 'stop' && !adRateTyped.has(x.k) ? 'stop' : 'rate', old_rate: x.rate, new_rate: x.nr })) });
    toast(`Sending ${r.queued} changes to eBay…`); adRateTyped = new Map(); adOff = new Set(); adOn = new Set(); setTimeout(renderAds2, 2500);
  } catch (e) { toast(e.message); }
};

// ---------------------------------------------------------------- returns and cases
let RTN = null;
const rtState = { sort: { i: 2, asc: false }, limit: 200, render: () => drawReturns(), empty: 'No SKUs with returns in this period.' };
const rtListState = { sort: null, limit: 100, render: () => drawReturns(), empty: 'Nothing for this selection.' };
const RT_REASON = {
  NOT_AS_DESCRIBED: 'Not as described', DEFECTIVE_ITEM: 'Faulty', ARRIVED_DAMAGED: 'Arrived damaged', DOES_NOT_FIT: "Doesn't fit",
  WRONG_SIZE: "Doesn't fit", MISSING_PARTS: 'Missing parts', ORDERED_WRONG_ITEM: 'Ordered the wrong part', ORDERED_DIFFERENT_ITEM: 'Ordered the wrong part',
  ORDERED_BY_MISTAKE: 'Ordered by mistake', NO_LONGER_NEED: 'No longer needed', NO_LONGER_NEEDED: 'No longer needed', FOUND_BETTER_PRICE: 'Found it cheaper',
  CHANGED_MIND: 'Changed mind', BUYER_CANCEL_ORDER: 'Cancelled', EXPIRED_ITEM: 'Expired', FAKE_OR_COUNTERFEIT: 'Not genuine',
  ITEM_NOT_RECEIVED: 'Not received', INR: 'Not received', SNAD: 'Not as described', RETURN: 'Return case', OTHER: 'Other',
};
const rtReason = r => RT_REASON[r.reason] || (r.reason ? r.reason.toLowerCase().replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()) : 'No reason given');
const rtSellerSide = r => r.kind !== 'return' || r.reason_type === 'SNAD' || ['NOT_AS_DESCRIBED', 'DEFECTIVE_ITEM', 'ARRIVED_DAMAGED', 'MISSING_PARTS', 'FAKE_OR_COUNTERFEIT', 'DOES_NOT_FIT', 'WRONG_SIZE'].includes(r.reason);
const rtOpen = r => !/CLOSED|COMPLETED|REFUNDED|CANCELLED|CANCELED|RESOLVED|ESCALATED_CLOSED/i.test(`${r.state || ''} ${r.status || ''}`);
async function renderReturns() {
  try { RTN = await api('/api/returns'); } catch (e) { toast(e.message); return; }
  const errs = RTN.state.filter(s => s.last_status === 'error');
  const last = RTN.state.map(s => s.last_check).filter(Boolean).sort().pop();
  $('rtStatus').innerHTML = RTN.state.length ? (last ? `Checked ${ago(last)} (every 3 hours). ` : 'First check runs within a few minutes. ') + RTN.state.map(s => s.last_message ? `${esc(s.name)}: ${s.last_status === 'error' ? '<span class="neg">' + esc(s.last_message) + '</span>' : esc(s.last_message)}` : '').filter(Boolean).join(' · ') : 'Connect your eBay accounts on the eBay page first.';
  drawReturns();
}
function drawReturns() {
  if (!RTN) return;
  const f = F(); if ($('fPeriod').value === 'all') f.r = [f.r[0], TODAY];  // returns can be opened after the last sale
  const [from, to] = f.r;
  // the sale behind each return, from the money data
  const byOrder = new Map(); I.forEach(x => { const k = ACC[x.a].id + '|' + x.o; (byOrder.get(k) || byOrder.set(k, []).get(k)).push(x); });
  const rows = RTN.rows.map(r => {
    const sale = (byOrder.get(r.account_id + '|' + r.order_id) || []).filter(x => !r.item_id || x.id === r.item_id);
    const sku = r.sku || (sale[0] && sale[0].sku) || '', g = sale[0] ? sale[0].g : (sku ? (sku.match(/^[A-Za-z]+/) || [''])[0].toUpperCase().replace(/^MRR.*/, 'MRR') : 'NO SKU');
    return { ...r, a: AIDX[r.account_id], sku, g: g || 'NO SKU', title: r.title || (sale[0] && sale[0].t) || '', sale, net: sale.length ? sale.reduce((t, x) => t + profitOf(x), 0) : null, d: (r.created || '').slice(0, 10) };
  }).filter(r => r.a !== undefined && f.a.has(r.a) && (f.allG || f.g.has(r.g)) && r.d >= from && r.d <= to);
  const sold = itemsIn(f, f.r);
  const unitsBySku = new Map(), unitsByG = new Map(); let units = 0;
  sold.forEach(x => { units += x.q; unitsBySku.set(x.sku, (unitsBySku.get(x.sku) || 0) + x.q); unitsByG.set(x.g, (unitsByG.get(x.g) || 0) + x.q); });
  const ret = rows.filter(r => r.kind === 'return'), inr = rows.filter(r => r.kind === 'inquiry'), cases = rows.filter(r => r.kind === 'case');
  const retUnits = ret.reduce((t, r) => t + (r.qty || 1), 0), refunded = rows.reduce((t, r) => t + (r.refund || 0), 0);
  const netAll = rows.reduce((t, r) => t + (r.net || 0), 0);
  const stat = (k, v, sub, c = '') => `<div class="stat"><small>${k}</small><b class="${c}">${v}</b>${sub ? `<span>${sub}</span>` : ''}</div>`;
  $('rtStats').innerHTML = stat('Returns', n0(ret.length), `${n0(ret.filter(rtOpen).length)} still open`) + stat('Return rate', pct(units ? retUnits / units : NaN), `of ${n0(units)} units sold`) +
    stat('Refunded', gbp(refunded), 'to buyers') + stat('Net on those sales', gbp(netAll), 'returns with a matched sale', cls(netAll)) +
    stat('Not received', n0(inr.length), `${n0(inr.filter(rtOpen).length)} open`) + stat('Cases', n0(cases.length), `${n0(cases.filter(rtOpen).length)} open`);
  // reasons
  const rc = new Map(); rows.forEach(r => { const k = rtReason(r), o = rc.get(k) || { n: 0, seller: rtSellerSide(r) }; o.n++; rc.set(k, o); });
  const rlist = [...rc.entries()].sort((a, b) => b[1].n - a[1].n), max = Math.max(1, ...rlist.map(x => x[1].n));
  const sellerN = rows.filter(rtSellerSide).length;
  $('rtReasonSub').innerHTML = rows.length ? `<span class="neg">Red</span>: part or listing problem (${n0(sellerN)}). Orange: buyer's choice (${n0(rows.length - sellerN)}).` : '';
  $('rtReasons').innerHTML = rlist.length ? rlist.map(([k, o]) => `<div class="bar"><span>${esc(k)}</span><span class="track"><span class="fill ${o.seller ? 'seller' : ''}" style="width:${o.n / max * 100}%;display:block"></span></span><span>${n0(o.n)} · ${pct(o.n / rows.length)}</span></div>`).join('') : '<p class="empty">No returns in this period.</p>';
  // by group
  const gm = new Map(); rows.forEach(r => { const o = gm.get(r.g) || { g: r.g, n: 0, ret: 0, other: 0, ref: 0, net: 0 }; o.n++; if (r.kind === 'return') o.ret += r.qty || 1; else o.other++; o.ref += r.refund || 0; o.net += r.net || 0; gm.set(r.g, o); });
  const groupsRows = [...gm.values()].map(o => ({ ...o, units: unitsByG.get(o.g) || 0 })).sort((a, b) => a.net - b.net);
  $('rtGroups').innerHTML = groupsRows.length ? `<thead><tr><th class="l">Group</th><th>Sold</th><th>Returns</th><th>Rate</th><th>Not received / cases</th><th>Refunded</th><th>Net on those sales</th></tr></thead><tbody>${groupsRows.map(o => `<tr>
    <td class="l"><span class="sku">${esc(o.g)}</span></td><td>${n0(o.units)}</td><td>${n0(o.ret)}</td><td>${o.units ? `<span class="${o.ret / o.units >= 0.1 ? 'neg' : ''}">${pct(o.ret / o.units)}</span>` : '–'}</td><td>${n0(o.other)}</td><td>${gbp(o.ref)}</td><td>${money(o.net)}</td></tr>`).join('')}</tbody>`
    : '<tbody><tr><td class="empty">No returns in this period.</td></tr></tbody>';
  // by SKU
  const q = $('rtSearch').value.trim().toLowerCase();
  const sm = new Map(); rows.forEach(r => { const k = r.sku || 'No SKU: ' + (r.title || r.item_id); const o = sm.get(k) || { sku: k, t: r.title, g: r.g, n: 0, ret: 0, other: 0, ref: 0, net: 0, reasons: new Map() }; o.n++; if (r.kind === 'return') o.ret += r.qty || 1; else o.other++; o.ref += r.refund || 0; o.net += r.net || 0; o.reasons.set(rtReason(r), (o.reasons.get(rtReason(r)) || 0) + 1); sm.set(k, o); });
  const skuRows = [...sm.values()].map(o => ({ ...o, units: unitsBySku.get(o.sku) || 0, top: [...o.reasons.entries()].sort((a, b) => b[1] - a[1])[0] }))
    .filter(o => !q || o.sku.toLowerCase().includes(q) || (o.t || '').toLowerCase().includes(q));
  $('rtSkuSub').textContent = `${n0(skuRows.length)} SKUs with a return, request or case · ${nice(from)} – ${nice(to)}. Flagged: 10%+ return rate with 2 or more returns.`;
  table($('rtSkus'), [
    { h: 'SKU', l: 1, cl: 'prod', v: o => o.sku, f: o => `<span class="t">${esc(o.t || o.sku)}</span><span class="s">${esc(o.sku)}</span>` },
    { h: 'Sold', v: o => o.units, f: o => n0(o.units) },
    { h: 'Returns', v: o => o.ret, f: o => n0(o.ret) },
    { h: 'Not received / cases', v: o => o.other, f: o => n0(o.other) },
    { h: 'Rate', v: o => o.units ? o.ret / o.units : -1, f: o => o.units ? `<span class="${o.ret / o.units >= 0.1 ? 'neg' : ''}">${pct(o.ret / o.units)}</span>` : '–' },
    { h: 'Main reason', l: 1, v: o => o.top ? o.top[0] : '', f: o => o.top ? `${esc(o.top[0])}${o.reasons.size > 1 ? ` <span class="sub">+${o.reasons.size - 1} other</span>` : ''}` : '' },
    { h: 'Refunded', v: o => o.ref, f: o => gbp(o.ref) },
    { h: 'Net on those sales', v: o => o.net, f: o => money(o.net) },
    { h: '', l: 1, v: o => o.units && o.ret / o.units >= 0.1 && o.ret >= 2 ? 1 : 0, f: o => o.units && o.ret / o.units >= 0.1 && o.ret >= 2 ? '<span class="chip m">Check listing</span>' : '' }], skuRows, null, rtState);
  // every return
  const kf = $('rtKind').value;
  const list = rows.filter(r => !kf || (kf === 'open' ? rtOpen(r) : r.kind === kf)).filter(r => !q || r.sku.toLowerCase().includes(q) || (r.title || '').toLowerCase().includes(q));
  table($('rtList'), [
    { h: 'Opened', l: 1, v: r => r.created, f: r => nice(r.d) },
    { h: 'Account', l: 1, v: r => r.account_id, f: r => `<span class="dot" style="background:${ACC[r.a].color}"></span>${esc(ACC[r.a].name)}` },
    { h: 'Type', l: 1, v: r => r.kind, f: r => `<span class="chip ${r.kind === 'case' ? 'm' : r.kind === 'inquiry' ? 'ret' : 'b'}">${{ return: 'Return', inquiry: 'Not received', case: 'Case' }[r.kind]}</span>` },
    { h: 'Listing', l: 1, cl: 'prod', v: r => r.sku, f: r => `<span class="t">${esc(r.title || r.item_id || '')}</span><span class="s">${esc(r.sku || 'No SKU')} · buyer ${esc(r.buyer || '–')}${r.order_id ? ` · <a href="https://www.ebay.co.uk/sh/ord/details?orderid=${encodeURIComponent(r.order_id)}" target="_blank" rel="noopener">order</a>` : ''}</span>` },
    { h: 'Reason', l: 1, cl: 'prod', v: r => rtReason(r), f: r => `<span class="${rtSellerSide(r) ? 'neg' : ''}">${esc(rtReason(r))}</span>${r.comments ? `<span class="cmt">"${esc(r.comments.slice(0, 220))}"</span>` : ''}` },
    { h: 'Status', l: 1, v: r => r.state || '', f: r => `${rtOpen(r) ? '<span class="chip ret">Open</span> ' : ''}<span class="sub">${esc(((r.state || r.status || '') + '').toLowerCase().replace(/_/g, ' '))}</span>` },
    { h: 'Refund', v: r => r.refund || 0, f: r => r.refund ? gbp(r.refund) : '–' },
    { h: 'Net on the sale', v: r => r.net ?? 0, f: r => r.net != null ? money(r.net) : `<span class="muted" title="${r.order_id ? 'This sale is outside the loaded data' : 'eBay doesn\'t say which order this belongs to'}">–</span>` }], list, null, rtListState);
  $('rtMore').hidden = list.length <= rtListState.limit;
  rtListState.csv = list;
}
$('rtCheck').onclick = async () => { try { await api('/api/returns/check', { method: 'POST' }); toast('Checking eBay for returns and cases…'); setTimeout(renderReturns, 15000); } catch (e) { toast(e.message); } };
$('rtSearch').addEventListener('input', drawReturns);
$('rtKind').addEventListener('change', drawReturns);
$('rtMore').onclick = () => { rtListState.limit += 200; drawReturns(); };
$('rtCsv').onclick = () => csv('returns.csv', ['Opened', 'Account', 'Type', 'Order', 'Item number', 'SKU', 'Title', 'Buyer', 'Reason', 'Buyer comment', 'Status', 'Refund', 'Net on the sale'],
  (rtListState.csv || []).map(r => [r.created, ACC[r.a].name, r.kind, r.order_id || '', r.item_id || '', r.sku, r.title, r.buyer || '', rtReason(r), r.comments || '', r.state || r.status || '', r.refund ?? '', r.net != null ? r.net.toFixed(2) : '']));

// ---------------------------------------------------------------- payouts
let PAY = null;
const poState = { sort: { i: 1, asc: false }, limit: 500, render: () => drawPayouts(), empty: 'No payouts for this selection.' };
const poOk = p => /SUCCEEDED/i.test(p.status || ''), poProblem = p => /FAIL|REVERS|RETRY|INITIATED|PENDING/i.test(p.status || '');
const poStatus = s => ({ SUCCEEDED: ['Paid', 'k'], INITIATED: ['On its way', 'b'], RETRYABLE_FAILED: ['Failed, eBay will retry', 'ret'], TERMINAL_FAILED: ['Failed', 'm'], REVERSED: ['Reversed', 'm'] }[s] || [String(s || '–').toLowerCase().replace(/_/g, ' '), '']);
async function renderPayouts() {
  try { PAY = await api('/api/payouts'); } catch (e) { toast(e.message); return; }
  const last = PAY.state.map(s => s.last_check).filter(Boolean).sort().pop();
  $('poStatus').innerHTML = PAY.state.length ? (last ? `Checked ${ago(last)} (every 6 hours). ` : 'First check runs within a few minutes. ') + PAY.state.map(s => s.last_message ? `${esc(s.name)}: ${s.last_status === 'error' ? '<span class="neg">' + esc(s.last_message) + '</span>' : esc(s.last_message)}` : '').filter(Boolean).join(' · ') : 'Connect your eBay accounts on the eBay page first.';
  drawPayouts();
}
function poRows() {
  const f = F(); const to = $('fPeriod').value === 'all' ? TODAY : f.r[1], show = $('poShow').value;
  return PAY.rows.map(p => ({ ...p, a: AIDX[p.account_id], d: (p.date || '').slice(0, 10) }))
    .filter(p => p.a !== undefined && f.a.has(p.a) && p.d >= f.r[0] && p.d <= to)
    .filter(p => !show || (show === 'todo' ? poOk(p) && !p.banked : show === 'done' ? !!p.banked : poProblem(p)));
}
function drawPayouts() {
  if (!PAY) return;
  const rows = poRows(), paid = rows.filter(poOk);
  const sum = xs => xs.reduce((t, p) => t + (p.amount || 0), 0);
  const banked = paid.filter(p => p.banked), todo = paid.filter(p => !p.banked), prob = rows.filter(poProblem);
  const stat = (k, v, sub, c = '') => `<div class="stat"><small>${k}</small><b class="${c}">${v}</b>${sub ? `<span>${sub}</span>` : ''}</div>`;
  const P = rows.reduce((t, p) => { const x = p.parts || {}; ['sales', 'refunds', 'labels', 'ads', 'fees', 'claims', 'other'].forEach(k => t[k] += x[k] || 0); return t; }, { sales: 0, refunds: 0, labels: 0, ads: 0, fees: 0, claims: 0, other: 0 });
  const fsel = PAY.state.filter(x => F().a.has(AIDX[x.id]) && x.total != null);
  const inEbay = fsel.reduce((t, x) => t + (x.total || 0), 0), held = fsel.reduce((t, x) => t + (x.on_hold || 0), 0);
  $('poStats').innerHTML = stat('Money in eBay now', fsel.length ? gbp(inEbay) : '–', fsel.length ? (held ? `${gbp(held)} on hold · ` : '') + 'not paid out yet' : 'after the next check') +
    stat('Paid out', gbp(sum(paid)), `${n0(paid.length)} payouts`) + stat('Found in bank', gbp(sum(banked)), `${n0(banked.length)} ticked`) +
    stat('Not yet ticked', gbp(sum(todo)), `${n0(todo.length)} payouts`, todo.length ? 'neg' : '') + stat('Problems or waiting', n0(prob.length), prob.length ? gbp(sum(prob)) : 'none', prob.length ? 'neg' : '') +
    stat('Taken off', gbp(P.refunds + P.labels + P.ads + P.fees + P.claims + P.other), `from ${gbp(P.sales)} of sales after eBay fees`);
  const part = (p, k) => p.parts ? money(p.parts[k] || 0) : '<span class="muted">–</span>';
  table($('poTable'), [
    { h: 'Found in bank', l: 1, v: p => p.banked ? 1 : 0, f: p => poOk(p) ? `<input type="checkbox" class="po-b" data-k="${p.account_id}|${esc(p.payout_id)}" ${p.banked ? 'checked' : ''} aria-label="Found payout ${esc(p.payout_id)} in the bank">${p.banked && p.banked_by ? `<span class="sub">${esc(p.banked_by.split('@')[0])}</span>` : ''}` : '' },
    { h: 'Date', l: 1, v: p => p.date || '', f: p => p.d ? nice(p.d) : '–' },
    { h: 'Account', l: 1, v: p => p.account_id, f: p => `<span class="dot" style="background:${ACC[p.a].color}"></span>${esc(ACC[p.a].name)}` },
    { h: 'Amount', v: p => p.amount || 0, f: p => `<b>${gbp(p.amount)}</b>` },
    { h: 'Status', l: 1, v: p => p.status || '', f: p => { const [n, c] = poStatus(p.status); return `<span class="chip ${c}">${esc(n)}</span>`; } },
    { h: 'To', l: 1, v: p => p.last4 || '', f: p => `${esc(p.instrument || 'Bank')}${p.last4 ? ' ••' + esc(p.last4) : ''}${p.bank_ref ? `<span class="sub">ref ${esc(p.bank_ref)}</span>` : ''}` },
    { h: 'Sales', v: p => p.parts ? p.parts.sales : 0, f: p => part(p, 'sales') + (p.parts && p.parts.orders ? `<span class="sub">${n0(p.parts.orders)} orders</span>` : '') },
    { h: 'Refunds', v: p => p.parts ? p.parts.refunds : 0, f: p => part(p, 'refunds') },
    { h: 'Postage labels', v: p => p.parts ? p.parts.labels : 0, f: p => part(p, 'labels') },
    { h: 'Ad fees', v: p => p.parts ? p.parts.ads : 0, f: p => part(p, 'ads') },
    { h: 'Other fees', v: p => p.parts ? p.parts.fees + p.parts.claims + p.parts.other : 0, f: p => p.parts ? money(p.parts.fees + p.parts.claims + p.parts.other) : '–' },
    { h: 'Check', v: p => 0, f: p => { if (!p.parts) return ''; const s = ['sales', 'refunds', 'labels', 'ads', 'fees', 'claims', 'other'].reduce((t, k) => t + (p.parts[k] || 0), 0); const diff = Math.abs(s - (p.amount || 0)); return diff < 0.02 ? '<span class="chip k">Adds up</span>' : `<span class="chip ret" title="Parts add up to ${gbp(s)}">Off by ${gbp(diff)}</span>`; } }],
    rows, null, poState);
  $('poTable').querySelectorAll('.po-b').forEach(b => b.onchange = async () => {
    const [account_id, payout_id] = b.dataset.k.split('|');
    try { await post('/api/payouts/banked', { items: [{ account_id: +account_id, payout_id, banked: b.checked }] }); const p = PAY.rows.find(x => x.account_id == account_id && x.payout_id === payout_id); p.banked = b.checked ? 1 : 0; p.banked_by = b.checked ? ME.email : null; drawPayouts(); } catch (e) { toast(e.message); b.checked = !b.checked; }
  });
  // by month
  const mm = new Map(); rows.forEach(p => { const k = p.d.slice(0, 7), o = mm.get(k) || { k, n: 0, paid: 0, banked: 0, todo: 0 }; o.n++; if (poOk(p)) { o.paid += p.amount || 0; if (p.banked) o.banked += p.amount || 0; else o.todo += p.amount || 0; } mm.set(k, o); });
  const ms = [...mm.values()].sort((a, b) => b.k.localeCompare(a.k));
  $('poMonths').innerHTML = ms.length ? `<thead><tr><th class="l">Month</th><th>Payouts</th><th>Paid out</th><th>Found in bank</th><th>Not yet ticked</th></tr></thead><tbody>${ms.map(o => `<tr><td class="l">${new Date(o.k + '-15T12:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })}</td><td>${n0(o.n)}</td><td>${gbp(o.paid)}</td><td>${gbp(o.banked)}</td><td class="${o.todo ? 'neg' : ''}">${gbp(o.todo)}</td></tr>`).join('')}</tbody>` : '<tbody><tr><td class="empty">No payouts yet.</td></tr></tbody>';
  poState.csv = rows;
  drawSalesMonths();
}
function drawSalesMonths() {
  // money from sales per month (sales data) vs paid out so far (transactions inside payouts, by their own date)
  const f = F(), accIds = new Set(ACC.filter(a => f.a.has(a.i)).map(a => a.id));
  const exp = new Map(), paid = new Map();
  I.forEach(x => { if (!f.a.has(x.a)) return; const m = x.d.slice(0, 7); exp.set(m, (exp.get(m) || 0) + x.s + x.fee + x.ad + x.po + x.rf); });
  OH.forEach(o => { if (!f.a.has(o.a)) return; const m = o.d.slice(0, 7); exp.set(m, (exp.get(m) || 0) + o.v); });
  PAY.paidByMonth.forEach(([aid, m, v]) => { if (accIds.has(aid)) paid.set(m, (paid.get(m) || 0) + v); });
  const firsts = Object.entries(PAY.firstPayout || {}).filter(([aid]) => accIds.has(+aid)).map(([, d]) => (d || '').slice(0, 10)).sort();
  const covered = firsts.length ? firsts[firsts.length - 1] : null;  // payouts are loaded for every selected account from this date
  const months = [...new Set([...exp.keys(), ...paid.keys()])].sort().reverse().slice(0, 8);
  $('poSalesMonths').innerHTML = months.length ? `<thead><tr><th class="l">Sales month</th><th>Money from sales</th><th>Paid out so far</th><th>Still to come</th><th class="l"></th></tr></thead><tbody>${months.map(m => {
    const e = exp.get(m) || 0, p = paid.get(m) || 0, left = e - p, partial = covered && m + '-31' < covered.slice(0, 7) + '-01';
    const label = new Date(m + '-15T12:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    return `<tr><td class="l">${label}</td><td>${gbp(e)}</td><td>${gbp(p)}</td><td class="${left > 1 && !partial ? 'neg' : ''}">${partial ? '<span class="muted">–</span>' : gbp(left)}</td>
      <td class="l prod"><span class="muted">${partial ? 'Payouts before ' + nice(covered) + ' aren\'t loaded' : m === TODAY.slice(0, 7) ? 'Month not finished' : Math.abs(left) <= 1 ? 'All paid out' : left > 0 ? 'In your eBay balance or on its way' : 'Paid out more than this month earned (earlier sales or adjustments)'}</span></td></tr>`;
  }).join('')}</tbody>` : '<tbody><tr><td class="empty">No data yet.</td></tr></tbody>';
}
$('poShow').addEventListener('change', drawPayouts);
$('poCheck').onclick = async () => { try { await api('/api/payouts/check', { method: 'POST' }); toast('Checking eBay for payouts…'); setTimeout(renderPayouts, 20000); } catch (e) { toast(e.message); } };
$('poCsv').onclick = () => csv('payouts.csv', ['Date', 'Account', 'Payout ID', 'Amount', 'Currency', 'Status', 'To', 'Last 4', 'Bank reference', 'Sales', 'Refunds', 'Postage labels', 'Ad fees', 'Other fees', 'Orders', 'Found in bank', 'Ticked by'],
  (poState.csv || []).map(p => [p.date, ACC[p.a].name, p.payout_id, p.amount, p.currency, p.status, p.instrument || '', p.last4 || '', p.bank_ref || '', ...(p.parts ? [p.parts.sales, p.parts.refunds, p.parts.labels, p.parts.ads, (p.parts.fees + p.parts.claims + p.parts.other).toFixed(2), p.parts.orders] : ['', '', '', '', '', '']), p.banked ? 'Yes' : '', p.banked_by || '']));

// ---------------------------------------------------------------- offers to interested buyers
let OFS = null, ofRows = [], ofOff = new Set();
const ofState = { sort: null, limit: 1000, render: () => drawOffers(), empty: 'No listings have interested buyers right now.' };
async function renderOffers() {
  try { OFS = await api('/api/offers'); } catch (e) { toast(e.message); return; }
  const s = OFS.settings;
  $('ofAuto').textContent = s.offer_auto ? 'Automatic offers: ON (click to turn off)' : 'Automatic offers: OFF (click to turn on)';
  $('ofAuto').classList.toggle('on', !!s.offer_auto); $('ofAuto').classList.toggle('primary', !s.offer_auto);
  [['ofDisc', 'offer_discount'], ['ofMinP', 'offer_min_profit'], ['ofMinD', 'offer_min_discount'], ['ofDays', 'offer_days_between'], ['ofMsg', 'offer_message'], ['ofSched', 'offer_schedule'], ['ofDay', 'offer_weekday'], ['ofTime', 'offer_time']].forEach(([id, k]) => { if (document.activeElement !== $(id)) $(id).value = s[k]; });
  $('ofWhenWrap').hidden = $('ofSched').value !== 'weekly';
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const when = s.offer_schedule === 'weekly' ? `every ${days[s.offer_weekday]} at ${s.offer_time} (UK time)` : 'every 6 hours';
  const nxt = OFS.nextRun ? new Date(OFS.nextRun).toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null;
  $('ofStatus').innerHTML = (s.offer_auto ? `<b>Automatic: ${when}.</b> Next run ${nxt}. The app finds interested buyers and sends the offers that pass the rules. ` : `Automatic sending is off (set to ${when}); offers only go out when you click Send offers. `) +
    OFS.state.filter(x => x.last_check).map(x => `${esc(x.name)}: ${x.last_status === 'error' ? '<span class="neg">' + esc(x.last_message) + '</span>' : esc(x.last_message)} (${ago(x.last_check)})`).join(' · ');
  drawOffers(); drawOfferLog(); drawOfferStats();
}
function ofInWin() { const w = +$('ofWin').value, from = new Date(Date.now() - w * 864e5).toISOString().slice(0, 10), f = F(); return OFS.log.filter(o => o.status === 'sent' && (o.at || '').slice(0, 10) >= from && f.a.has(AIDX[o.account_id])); }
function drawOfferStats() {
  const sent = ofInWin(), done = sent.filter(o => (Date.now() - new Date(o.at.replace(' ', 'T') + 'Z')) > 3 * 864e5);
  const at = sent.flatMap(o => o.sales.filter(x => x.at_offer)), other = sent.flatMap(o => o.sales.filter(x => !x.at_offer));
  const units = at.reduce((t, x) => t + x.qty, 0), value = at.reduce((t, x) => t + x.unit * x.qty, 0), prof = at.reduce((t, x) => t + x.profit, 0);
  const won = done.filter(o => o.sales.some(x => x.at_offer)).length;
  const stat = (k, v, sub, c = '') => `<div class="stat"><small>${k}</small><b class="${c}">${v}</b>${sub ? `<span>${sub}</span>` : ''}</div>`;
  $('ofStats').innerHTML = stat('Offers sent', n0(sent.length), `last ${$('ofWin').value} days`) + stat('Buyers reached', n0(sent.reduce((t, o) => t + (o.buyers || 0), 0)), 'interested buyers') +
    stat('Sold at offer price', n0(units), units ? gbp(value) + ' of sales' : 'units') + stat('Profit from offer sales', gbp(prof), 'after COGS, fees, postage', cls(prof)) +
    stat('Offers that sold', pct(done.length ? won / done.length : NaN), `${n0(won)} of ${n0(done.length)} finished offers`) + stat('Other sales in offer time', n0(other.reduce((t, x) => t + x.qty, 0)), 'not at the offer price');
}
function drawOffers() {
  const f = F(), rows = ofRows.map(r => ({ ...r, a: AIDX[r.account_id], k: r.account_id + '|' + r.item_id })).filter(r => r.a !== undefined && f.a.has(r.a));
  const ok = rows.filter(r => !r.skip);
  $('ofSub').textContent = ofRows.length ? `${n0(rows.length)} listings with interested buyers · ${n0(ok.length)} can get an offer within your rules.` : $('ofSub').textContent;
  table($('ofTable'), [
    { h: '', l: 1, v: r => r.skip ? 1 : 0, f: r => r.skip ? '' : `<input type="checkbox" class="of-sel" data-k="${esc(r.k)}" ${ofOff.has(r.k) ? '' : 'checked'} aria-label="Send an offer for ${esc(r.sku || r.item_id)}">` },
    { h: 'Listing', l: 1, cl: 'prod', v: r => r.title || '', f: r => `<span class="t">${esc(r.title || r.item_id)}</span><span class="s"><span class="dot" style="background:${ACC[r.a].color}"></span>${esc(ACC[r.a].name)} · ${esc(r.sku || 'No SKU')} · <a href="https://www.ebay.co.uk/itm/${esc(r.item_id)}" target="_blank" rel="noopener">${esc(r.item_id)}</a></span>` },
    { h: 'Price now', v: r => r.price || 0, f: r => gbp(r.price) + `<span class="sub">stock ${r.qty ?? '–'}</span>` },
    { h: 'Lowest price', v: r => r.floor ?? -1, f: r => r.floor != null ? `${gbp(r.floor)}<span class="sub">keeps ${gbp(OFS.settings.offer_min_profit)}</span>` : '–' },
    { h: 'Offer', v: r => r.offer ?? -1, f: r => r.offer != null && !r.skip ? `<b>${gbp(r.offer)}</b><span class="sub">${((1 - r.offer / r.price) * 100).toFixed(1)}% off</span>` : '–' },
    { h: 'Profit at offer', v: r => r.profit ?? -1e9, f: r => r.profit != null && !r.skip ? money(r.profit) : '–' },
    { h: 'Notes', l: 1, cl: 'prod', v: r => r.skip || '', f: r => r.skip ? `<span class="muted">${esc(r.skip)}</span>` : `<span class="muted">${esc(r.why || '')}</span>${r.last_offer ? `<span class="sub">last offer ${esc(r.last_offer.slice(0, 10))}</span>` : ''}` }],
    rows.sort((x, y) => (!!x.skip - !!y.skip)), null, ofState);
  $('ofTable').querySelectorAll('.of-sel').forEach(b => b.onchange = () => { b.checked ? ofOff.delete(b.dataset.k) : ofOff.add(b.dataset.k); ofCount(); });
  ofCount();
}
function ofChosen() { const f = F(); return ofRows.filter(r => !r.skip && f.a.has(AIDX[r.account_id]) && !ofOff.has(r.account_id + '|' + r.item_id)); }
function ofCount() { const n = ofChosen().length; $('ofSel').textContent = ofRows.length ? `${n0(n)} ticked` : ''; $('ofSend').disabled = !n; }
function drawOfferLog() {
  const shown = OFS.log.filter(o => o.status !== 'sent' || ofInWin().includes(o));
  $('ofLog').innerHTML = shown.length ? `<thead><tr><th class="l">When (UTC)</th><th class="l">Account</th><th class="l">Listing</th><th>Price</th><th>Offer</th><th>Buyers</th><th class="l">Sold</th><th class="l">Result</th></tr></thead><tbody>${shown.map(o => `<tr>
    <td class="l">${esc((o.at || '').slice(0, 16))}${o.auto ? '<span class="sub">automatic</span>' : o.by ? `<span class="sub">${esc(o.by.split('@')[0])}</span>` : ''}</td><td class="l">${esc(o.account || '')}</td>
    <td class="l prod"><span class="t">${esc(o.title || '')}</span><span class="s">${esc(o.sku || '')} · <a href="https://www.ebay.co.uk/itm/${esc(o.item_id)}" target="_blank" rel="noopener">${esc(o.item_id)}</a></span></td>
    <td>${gbp(o.price)}</td><td><b>${gbp(o.offer_price)}</b></td><td>${n0(o.buyers)}</td>
    <td class="l prod">${(() => { const a = (o.sales || []).filter(x => x.at_offer), b = (o.sales || []).filter(x => !x.at_offer);
      return (a.length ? `<span class="chip k">${n0(a.reduce((t, x) => t + x.qty, 0))} at offer</span> <span class="sub">${money(a.reduce((t, x) => t + x.profit, 0))} profit</span>` : o.status === 'sent' ? '<span class="muted">none yet</span>' : '') +
        (b.length ? `<span class="sub">+${n0(b.reduce((t, x) => t + x.qty, 0))} at another price</span>` : ''); })()}</td>
    <td class="l prod">${o.status === 'sent' ? '<span class="chip k">Sent</span> ' : '<span class="chip m">Failed</span> '}${esc(o.message || '')}</td></tr>`).join('')}</tbody>` : '<tbody><tr><td class="empty">No offers sent yet.</td></tr></tbody>';
}
$('ofFind').onclick = async () => {
  const b = $('ofFind'); b.disabled = true; b.textContent = 'Asking eBay…';
  try { const r = await post('/api/offers/find', {}); ofRows = r.rows; ofOff = new Set(); drawOffers(); renderOffers(); } catch (e) { toast(e.message); }
  b.disabled = false; b.textContent = 'Find interested buyers';
};
$('ofSend').onclick = async () => {
  const b = $('ofSend'), ch = ofChosen(); if (!ch.length) return;
  if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = `Click again to send ${n0(ch.length)} offers`; setTimeout(() => { b.dataset.sure = ''; b.textContent = 'Send offers'; }, 6000); return; }
  b.dataset.sure = ''; b.textContent = 'Send offers';
  try { const r = await post('/api/offers/send', { items: ch.map(x => ({ account_id: x.account_id, item_id: x.item_id })) }); toast(`Sending ${r.queued} offers…`); ofRows = []; $('ofTable').innerHTML = ''; setTimeout(renderOffers, 4000); } catch (e) { toast(e.message); }
};
$('ofSched').addEventListener('change', () => { $('ofWhenWrap').hidden = $('ofSched').value !== 'weekly'; });
$('ofWin').addEventListener('change', () => { drawOfferStats(); drawOfferLog(); });
$('ofSaveSet').onclick = async () => {
  try { await post('/api/offers/settings', { offer_schedule: $('ofSched').value, offer_weekday: +$('ofDay').value, offer_time: $('ofTime').value || '10:00', offer_discount: +$('ofDisc').value, offer_min_profit: +$('ofMinP').value, offer_min_discount: +$('ofMinD').value, offer_days_between: +$('ofDays').value, offer_message: $('ofMsg').value }); toast('Offer settings saved' + (ofRows.length ? '. Click Find interested buyers to recalculate.' : '')); renderOffers(); } catch (e) { toast(e.message); }
};
$('ofAuto').onclick = async () => {
  const b = $('ofAuto'), on = !OFS.settings.offer_auto, s = OFS.settings;
  const when = s.offer_schedule === 'weekly' ? `every ${['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][s.offer_weekday]} at ${s.offer_time}` : 'every 6 hours';
  if (on && b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = `Click again: send offers automatically ${when}`; setTimeout(() => { b.dataset.sure = ''; renderOffers(); }, 6000); return; }
  b.dataset.sure = '';
  try { await post('/api/offers/settings', { offer_auto: on }); toast(on ? 'Automatic offers are on' : 'Automatic offers are off'); renderOffers(); } catch (e) { toast(e.message); }
};

// ---------------------------------------------------------------- discounts
let PMD = null, pmMbPrev = null, pmSPrev = null;
const PM_TYPE = { VOLUME_DISCOUNT: 'Multi-buy', MARKDOWN_SALE: 'Sale', ORDER_DISCOUNT: 'Order discount', CODED_COUPON: 'Coupon code' };
const PM_STATUS = { RUNNING: ['Running', 'k'], SCHEDULED: ['Scheduled', 'b'], PAUSED: ['Paused', 'ret'], DRAFT: ['Draft', ''], ENDED: ['Ended', ''] };
async function renderPromos() {
  try { PMD = await api('/api/promos'); } catch (e) { toast(e.message); return; }
  const f = F(), r = PMD.rule;
  $('pmSub').textContent = PMD.fetched ? `Read from eBay ${ago(PMD.fetched)}. Ended discounts aren't shown.` : 'Not read from eBay yet. Click Refresh from eBay.';
  const rows = PMD.promotions.filter(p => f.a.has(AIDX[p.account_id]));
  $('pmTable').innerHTML = rows.length ? `<thead><tr><th class="l">Account</th><th class="l">Discount</th><th class="l">Type</th><th class="l">Status</th><th class="l">From</th><th class="l">To</th><th class="l">Listings</th><th></th></tr></thead><tbody>${rows.map(p => { const [sn, sc] = PM_STATUS[p.status] || [p.status, '']; return `<tr>
    <td class="l"><span class="dot" style="background:${accColor(p.account_id)}"></span>${esc(accName(p.account_id))}</td>
    <td class="l prod">${esc(p.name || '')}${p.managed ? ' <span class="chip b">Partsledger</span>' : ''}</td><td class="l">${esc(PM_TYPE[p.type] || p.type)}</td>
    <td class="l"><span class="chip ${sc}">${esc(sn)}</span></td><td class="l">${p.start ? nice(p.start.slice(0, 10)) : '–'}</td><td class="l">${p.end ? nice(p.end.slice(0, 10)) : '–'}</td>
    <td class="l">${p.listings != null ? n0(p.listings) : esc(p.scope || '–')}</td>
    <td>${p.status === 'RUNNING' ? `<button class="link" type="button" data-pm="pause" data-a="${p.account_id}" data-p="${esc(p.promotion_id)}">Pause</button> ` : ''}${p.status === 'PAUSED' ? `<button class="link" type="button" data-pm="resume" data-a="${p.account_id}" data-p="${esc(p.promotion_id)}">Resume</button> ` : ''}<button class="link danger" type="button" data-pm="end" data-a="${p.account_id}" data-p="${esc(p.promotion_id)}">End</button></td></tr>`; }).join('')}</tbody>`
    : '<tbody><tr><td class="empty">No running or scheduled discounts.</td></tr></tbody>';
  $('pmTable').querySelectorAll('[data-pm]').forEach(b => b.onclick = async () => {
    if (b.dataset.pm === 'end' && b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Click again to end it'; return; }
    try { await post('/api/promos/act', { account_id: +b.dataset.a, promotion_id: b.dataset.p, action: b.dataset.pm }); toast('Done'); renderPromos(); } catch (e) { toast(e.message); }
  });
  if (document.activeElement.closest && !document.activeElement.closest('#p-promos .form-row')) {
    $('pmT2').value = r.tiers[0]; $('pmT3').value = r.tiers[1]; $('pmT4').value = r.tiers[2] ?? ''; $('pmMax').value = r.max_price; $('pmMinP').value = r.min_profit; $('pmExcl').value = r.exclude_prefixes || '';
  }
  $('pmMbState').innerHTML = r.enabled ? '<span class="chip k">On: kept up to date daily</span>' : '<span class="chip">Off</span>';
  $('pmMbApply').textContent = r.enabled ? 'Update multi-buy now' : 'Start multi-buy'; $('pmMbStop').hidden = !r.enabled;
  if (!$('pmSFrom').value) { $('pmSFrom').value = TODAY; $('pmSTo').value = addD(TODAY, 14); }
  $('pmLog').innerHTML = PMD.log.length ? `<thead><tr><th class="l">When (UTC)</th><th class="l">Account</th><th class="l">What</th><th class="l">Result</th></tr></thead><tbody>${PMD.log.map(l => `<tr><td class="l">${esc((l.at || '').slice(0, 16))}${l.by ? `<span class="sub">${esc(l.by.split('@')[0])}</span>` : ''}</td><td class="l">${esc(l.account || '')}</td><td class="l">${esc(l.action)}</td>
    <td class="l prod">${l.status === 'ok' ? '<span class="chip k">Done</span> ' : '<span class="chip m">Failed</span> '}${esc(l.message || '')}</td></tr>`).join('')}</tbody>` : '<tbody><tr><td class="empty">Nothing yet.</td></tr></tbody>';
}
function pmResult(el, prev, label) {
  const f = F(), accs = Object.entries(prev).filter(([a]) => f.a.has(AIDX[a]));
  const tin = accs.reduce((t, [, v]) => t + v.in.length, 0), tout = accs.reduce((t, [, v]) => t + v.out.length, 0);
  const out = accs.flatMap(([a, v]) => v.out.map(x => ({ a: +a, x })));
  el.innerHTML = `<div class="form-row" style="padding-top:0"><b>${n0(tin)} listings ${label}</b><span class="muted">${accs.map(([a, v]) => `${esc(accName(+a))}: ${n0(v.in.length)} in, ${n0(v.out.length)} left out`).join(' · ')}</span>
    ${out.length ? `<button class="link" type="button" data-pmshow>Show the ${n0(out.length)} left out</button>` : ''}</div>
    <div class="tbl-wrap" data-pmout hidden><table><thead><tr><th class="l">Account</th><th class="l">Listing</th><th>Price</th><th class="l">Why left out</th></tr></thead><tbody>${out.slice(0, 1000).map(({ a, x }) => `<tr>
      <td class="l">${esc(accName(a))}</td><td class="l prod"><span class="t">${esc(x[2] || '')}</span><span class="s">${esc(x[1] || 'No SKU')} · <a href="https://www.ebay.co.uk/itm/${esc(x[0])}" target="_blank" rel="noopener">${esc(x[0])}</a></span></td><td>${gbp(x[3])}</td><td class="l prod"><span class="muted">${esc(x[4])}</span></td></tr>`).join('')}</tbody></table></div>`;
  const s = el.querySelector('[data-pmshow]'); if (s) s.onclick = () => { const t = el.querySelector('[data-pmout]'); t.hidden = !t.hidden; };
  return tin;
}
function pmTiers() { return [$('pmT2').value, $('pmT3').value, $('pmT4').value].filter(v => v !== '').map(Number); }
$('pmMbPreview').onclick = async () => {
  const b = $('pmMbPreview'); b.disabled = true; b.textContent = 'Working out…';
  try { pmMbPrev = await post('/api/promos/preview', { kind: 'multibuy', tiers: pmTiers(), max_price: +$('pmMax').value || 0, min_profit: +$('pmMinP').value || 0, exclude_prefixes: $('pmExcl').value });
    const n = pmResult($('pmMbResult'), pmMbPrev, `qualify for: ${pmTiers().map((t, i) => `buy ${i + 2}${i === pmTiers().length - 1 ? '+' : ''} ${t}% off`).join(', ')}`); $('pmMbApply').disabled = !n; renderPromos();
  } catch (e) { toast(e.message); }
  b.disabled = false; b.textContent = 'Preview';
};
$('pmMbApply').onclick = async () => {
  const b = $('pmMbApply'); if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Click again to send it to eBay'; setTimeout(() => { b.dataset.sure = ''; renderPromos(); }, 6000); return; }
  b.dataset.sure = '';
  try { await post('/api/promos/multibuy', { enabled: true }); toast('Setting up the multi-buy on eBay… this takes a minute'); setTimeout(renderPromos, 20000); } catch (e) { toast(e.message); }
};
$('pmMbStop').onclick = async () => {
  const b = $('pmMbStop'); if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Click again to end the app multi-buy'; return; }
  b.dataset.sure = '';
  try { await post('/api/promos/multibuy', { enabled: false }); toast('Ending the app multi-buy…'); setTimeout(renderPromos, 8000); } catch (e) { toast(e.message); }
};
$('pmSPreview').onclick = async () => {
  const b = $('pmSPreview'); b.disabled = true; b.textContent = 'Working out…';
  try { pmSPrev = await post('/api/promos/preview', { kind: 'sale', pct: +$('pmSPct').value, max_price: +$('pmSMax').value || 0, prefix: $('pmSPre').value.trim(), min_profit: +$('pmSMinP').value || 0 });
    const n = pmResult($('pmSResult'), pmSPrev, `can be ${$('pmSPct').value}% off from ${nice($('pmSFrom').value)} to ${nice($('pmSTo').value)}`); $('pmSCreate').disabled = !n;
  } catch (e) { toast(e.message); }
  b.disabled = false; b.textContent = 'Preview';
};
$('pmSCreate').onclick = async () => {
  const b = $('pmSCreate'); if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Click again to create the sale'; setTimeout(() => { b.dataset.sure = ''; b.textContent = 'Create sale'; }, 6000); return; }
  b.dataset.sure = ''; b.textContent = 'Create sale';
  const f = F();
  try { const r = await post('/api/promos/sale', { name: $('pmSName').value, pct: +$('pmSPct').value, start: $('pmSFrom').value + 'T00:00:00', end: $('pmSTo').value + 'T23:59:00', max_price: +$('pmSMax').value || 0, prefix: $('pmSPre').value.trim(), min_profit: +$('pmSMinP').value || 0, accounts: ACC.filter(a => f.a.has(a.i)).map(a => a.id) });
    toast(`Creating the sale for ${r.queued} listings…`); $('pmSCreate').disabled = true; setTimeout(renderPromos, 10000); } catch (e) { toast(e.message); }
};
$('pmRefresh').onclick = async () => { const b = $('pmRefresh'); b.disabled = true; try { await api('/api/promos/refresh', { method: 'POST' }); await renderPromos(); } catch (e) { toast(e.message); } b.disabled = false; };

// ---------------------------------------------------------------- eBay
let EBS = null, cpRows = [], jobTimer = null;
async function renderEbay() {
  EBS = await api('/api/ebay/status');
  const setup = $('ebaySetup');
  setup.hidden = EBS.configured && !EBS.missing.length;
  setup.innerHTML = `The eBay keys aren't set yet. In Render, open partsledger → Environment and add: <b>${EBS.missing.map(esc).join(', ')}</b>. Then connect each account below.`;
  $('ebayAcc').innerHTML = `<thead><tr><th class="l">Account</th><th class="l">Status</th><th class="l">Login valid until</th><th class="l">Last sync</th><th></th></tr></thead><tbody>${EBS.accounts.map(a => {
    const c = a.connection, sy = a.sync;
    return `<tr><td class="l"><span class="dot" style="background:${a.color}"></span>${esc(a.name)}</td>
      <td class="l">${c ? `<span class="chip k">Connected as ${esc(c.ebay_user)}</span>` : '<span class="chip m">Not connected</span>'}</td>
      <td class="l">${c && c.refresh_expires ? nice(c.refresh_expires) : '–'}</td>
      <td class="l prod">${sy && sy.last_tx_sync ? `${esc(sy.last_tx_sync.slice(0, 16))} UTC · ${sy.last_status === 'ok' ? '' : '<span class="chip m">Error</span> '}${esc(sy.last_message || '')}` : (c ? 'Waiting for first sync' : '–')}
        ${c ? (!c.traffic ? '<br><span class="chip ret">Reconnect to add traffic data</span>' : sy && sy.traffic_message ? `<br><span class="muted">Traffic:</span> ${sy.traffic_status === 'error' ? '<span class="chip m">Error</span> ' : ''}${esc(sy.traffic_message)}` : '<br><span class="muted">Traffic: waiting for next sync</span>') : ''}</td>
      <td>${ME.is_admin ? `<a class="btn ${c && !c.traffic ? 'primary' : ''}" href="/ebay/connect/${a.id}">${c ? 'Reconnect' : 'Connect'}</a>${c ? ` <button class="link danger" type="button" data-disc="${a.id}">Disconnect</button>` : ''}` : ''}</td></tr>`;
  }).join('')}</tbody>`;
  $('syncNow').hidden = !EBS.accounts.some(a => a.connection);
  document.querySelectorAll('[data-disc]').forEach(b => b.onclick = async () => {
    if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Click again to disconnect'; return; }
    await api('/api/ebay/disconnect/' + b.dataset.disc, { method: 'POST' }); toast('Disconnected'); renderEbay();
  });
  const opts = EBS.accounts.map(a => `<option value="${a.id}">${esc(a.name)}${a.connection ? '' : ' (not connected)'}</option>`).join('');
  if (!$('cpFrom').options.length) {
    $('cpFrom').innerHTML = opts; $('cpTo').innerHTML = opts;
    const auto = EBS.accounts.find(a => a.name === 'Autonation'); if (auto) $('cpFrom').value = auto.id;
    const other = EBS.accounts.find(a => a.id != $('cpFrom').value); if (other) $('cpTo').value = other.id;
    loadPolicies();
  }
  renderAds();
  const jobs = await api('/api/ebay/jobs'); if (jobs[0] && !$('cpJob').dataset.job) showJob(jobs[0].id);
}
async function loadPolicies() {
  ['cpShip', 'cpRet', 'cpPay'].forEach(id => $(id).innerHTML = '<option value="">Loading…</option>');
  try {
    const p = await api('/api/ebay/policies/' + $('cpTo').value);
    const fill = (id, list) => $(id).innerHTML = list.length ? list.map(x => `<option value="${esc(x.id)}" ${x.default ? 'selected' : ''}>${esc(x.name)}</option>`).join('') : '<option value="">None found</option>';
    fill('cpShip', p.SHIPPING); fill('cpRet', p.RETURN_POLICY); fill('cpPay', p.PAYMENT);
  } catch (e) { ['cpShip', 'cpRet', 'cpPay'].forEach(id => $(id).innerHTML = '<option value="">Connect this account first</option>'); }
}
$('cpTo').onchange = () => { loadPolicies(); $('cpTable').innerHTML = ''; cpRows = []; cpCount(); };
$('cpFrom').onchange = () => { $('cpTable').innerHTML = ''; cpRows = []; cpCount(); };
function newPrice(p) { const k = $('cpPriceKind').value, v = +$('cpPriceVal').value || 0; return Math.max(0.99, k === 'pct' ? p * (1 + v / 100) : k === 'add' ? p + v : p); }
function cpCount() { const n = document.querySelectorAll('.cp-sel:checked').length; $('cpCount').textContent = cpRows.length ? `${n} of ${cpRows.length} selected` : ''; }
function drawCp() {
  $('cpTable').innerHTML = cpRows.length ? `<thead><tr><th class="l"><input type="checkbox" id="cpAll" aria-label="Select all" checked></th><th class="l">SKU</th><th class="l">Title</th><th>Price now</th><th>New price</th><th>Sold</th><th class="l"></th></tr></thead><tbody>${
    cpRows.map((r, i) => `<tr><td class="l"><input type="checkbox" class="cp-sel" id="cp-${i}" data-item="${esc(r.item_id)}" ${r.dupe_in_source ? '' : 'checked'} aria-label="Select ${esc(r.sku)}"></td>
      <td class="l"><span class="sku">${esc(r.sku)}</span></td><td class="l prod"><span class="t">${esc(r.title)}</span></td><td>${gbp(r.price)}</td><td><b>${gbp(newPrice(r.price || 0))}</b></td><td>${n0(r.sold)}</td>
      <td class="l">${r.dupe_in_source ? '<span class="chip ret">Same SKU listed twice on source</span>' : ''}</td></tr>`).join('')}</tbody>`
    : `<tbody><tr><td class="empty">Every listing with that SKU start is already on the other account.</td></tr></tbody>`;
  const all = $('cpAll'); if (all) all.onchange = () => { document.querySelectorAll('.cp-sel').forEach(b => b.checked = all.checked); cpCount(); };
  document.querySelectorAll('.cp-sel').forEach(b => b.onchange = cpCount); cpCount();
}
['cpPriceKind', 'cpPriceVal'].forEach(id => $(id).addEventListener('input', () => cpRows.length && drawCp()));
$('cpLoad').onclick = async () => {
  if ($('cpFrom').value === $('cpTo').value) return toast('Choose two different accounts.');
  cpRows = await api(`/api/ebay/candidates?source=${$('cpFrom').value}&target=${$('cpTo').value}&prefix=${encodeURIComponent($('cpPrefix').value)}`);
  drawCp();
};
async function startJob(mode) {
  const items = [...document.querySelectorAll('.cp-sel:checked')].map(b => b.dataset.item);
  if (!items.length) return toast('Select at least one listing.');
  try {
    const r = await post('/api/ebay/jobs', { source: +$('cpFrom').value, target: +$('cpTo').value, mode, items,
      price: { kind: $('cpPriceKind').value, value: +$('cpPriceVal').value || 0 },
      policies: { shipping: $('cpShip').value, return: $('cpRet').value, payment: $('cpPay').value } });
    showJob(r.job);
  } catch (e) { toast(e.message); }
}
$('cpVerify').onclick = () => startJob('verify');
$('syncNow').onclick = async () => { try { await api('/api/ebay/sync', { method: 'POST' }); toast('Syncing with eBay… this takes a minute'); setTimeout(async () => { trKey = ''; await load(); }, 45000); setTimeout(renderEbay, 8000); } catch (e) { toast(e.message); } };
$('cpCopy').onclick = () => {
  const b = $('cpCopy'); if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Click again to create the listings'; setTimeout(() => { b.dataset.sure = ''; b.textContent = 'Copy selected'; }, 6000); return; }
  b.dataset.sure = ''; b.textContent = 'Copy selected'; startJob('copy');
};
async function showJob(id) {
  clearTimeout(jobTimer); $('cpJob').dataset.job = id;
  const { job, items } = await api('/api/ebay/jobs/' + id);
  const run = job.status === 'running' || job.status === 'queued';
  $('cpJob').innerHTML = `<div class="panel-head"><div><h2>${job.mode === 'verify' ? 'Check' : 'Copy'} #${job.id}: ${job.done} of ${job.total} done</h2>
    <p>${job.ok} ${job.mode === 'verify' ? 'passed' : 'listed'} · ${job.failed} failed · ${run ? 'working…' : esc(job.status)}</p></div></div>
    <div class="tbl-wrap"><table><thead><tr><th class="l">SKU</th><th class="l">Title</th><th class="l">Result</th><th class="l">New item</th></tr></thead><tbody>${items.map(i => `<tr>
      <td class="l"><span class="sku">${esc(i.sku || '')}</span></td><td class="l prod"><span class="t">${esc(i.title || '')}</span></td>
      <td class="l prod">${i.status === 'ok' ? '<span class="chip k">OK</span> ' : i.status === 'failed' ? '<span class="chip m">Failed</span> ' : '<span class="chip b">Waiting</span> '}${esc(i.message || '')}</td>
      <td class="l">${i.new_item_id ? `<a href="https://www.ebay.co.uk/itm/${esc(i.new_item_id)}" target="_blank" rel="noopener">${esc(i.new_item_id)}</a>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
  if (run) jobTimer = setTimeout(() => showJob(id), 2500);
}
(() => { const q = new URLSearchParams(location.search), e = q.get('ebay'); if (!e) return;
  const m = { ok: 'eBay account connected', declined: 'eBay connection was cancelled', notset: 'Add the eBay keys in Render first',
    wrong: `You logged in to eBay as ${q.get('got')}, which isn't this account. Log out of eBay and connect again with the right account.`, error: 'eBay said: ' + (q.get('msg') || 'error') };
  setTimeout(() => toast(m[e] || e), 600); try { history.replaceState(null, '', '/#ebay'); } catch (err) { } })();


async function renderAds() {
  const rows = await api('/api/ebay/adrates');
  const by = {}; rows.forEach(r => { const a = by[r.account_id] ||= { name: r.account, n: 0, pending: 0, working: 0, done: 0, failed: 0 }; a.n++; a[r.status]++; });
  const connected = new Set((EBS?.accounts || []).filter(a => a.connection).map(a => a.id));
  $('adSum').innerHTML = rows.length ? `<thead><tr><th class="l">Account</th><th>Listings</th><th>Waiting</th><th>Promoted</th><th>Failed</th><th></th></tr></thead><tbody>${Object.entries(by).map(([id, a]) => `<tr>
    <td class="l">${esc(a.name)}</td><td>${a.n}</td><td>${a.pending + a.working}</td><td>${a.done}</td><td>${a.failed}</td>
    <td>${a.working ? 'Working…' : (a.pending || a.failed) ? (connected.has(+id) ? `<button class="btn primary" type="button" data-apply="${id}">Apply ${a.pending + a.failed} to eBay</button>` : '<span class="muted">Connect this account first</span>') : '<span class="chip k">All applied</span>'}</td></tr>`).join('')}</tbody>`
    : '<tbody><tr><td class="empty">No ad rates uploaded yet.</td></tr></tbody>';
  $('adRows').innerHTML = rows.some(r => r.status === 'failed') ? `<thead><tr><th class="l">Account</th><th class="l">Item</th><th class="l">SKU</th><th>Rate</th><th class="l">Why it failed</th></tr></thead><tbody>${
    rows.filter(r => r.status === 'failed').map(r => `<tr><td class="l">${esc(r.account)}</td><td class="l">${esc(r.item_id)}</td><td class="l"><span class="sku">${esc(r.sku || '')}</span></td><td>${r.rate}%</td><td class="l prod">${esc(r.message || '')}</td></tr>`).join('')}</tbody>` : '';
  document.querySelectorAll('[data-apply]').forEach(b => b.onclick = async () => { try { await api('/api/ebay/adrates/apply/' + b.dataset.apply, { method: 'POST' }); toast('Sending rates to eBay…'); setTimeout(renderAds, 1500); } catch (e) { toast(e.message); } });
  if (rows.some(r => r.status === 'working')) setTimeout(renderAds, 3000);
}
$('adFile').onchange = async e => {
  const f = e.target.files[0]; if (!f) return; const fd = new FormData(); fd.append('file', f);
  try { const r = await api('/api/ebay/adrates', { method: 'POST', body: fd }); toast(`${r.saved} ad rates saved` + (r.skipped ? `, ${r.skipped} rows skipped` : '')); renderAds(); } catch (err) { toast(err.message); }
  e.target.value = '';
};

// ---------------------------------------------------------------- competitor prices
let CPD = null, cpOff = new Set(), cpPick = new Set(), cpOpen = null, cpPoll = null;
const cpState = { sort: null, limit: 500, render: () => drawCompete(), empty: 'No listings for this selection.' };
const CPS = { match: ['Can match', 'b'], lower: ['Can get closer', 'ret'], cant: ['Below safe price', 'm'], raise: ['Can go up', 'k'], cheapest: ['Cheapest', 'k'], alone: ['No other sellers', 'k'], nocost: ['No cost', 'm'] };
async function renderCompete() {
  try { CPD = await api('/api/compete'); } catch (e) { toast(e.message); return; }
  const s = CPD.settings, pr = CPD.progress;
  $('cpAuto').textContent = s.comp_auto ? 'Daily check: ON (click to turn off)' : 'Daily check: OFF (click to turn on)';
  $('cpAuto').classList.toggle('primary', !s.comp_auto);
  [['cpCut', 'comp_undercut'], ['cpMinP', 'comp_min_profit'], ['cpRaise', 'comp_raise_pct'], ['cpDaily', 'comp_daily']].forEach(([id, k]) => { if (document.activeElement !== $(id)) $(id).value = s[k]; });
  $('cpStatus').innerHTML = (pr.running ? `<b>Checking ${n0(pr.done)} of ${n0(pr.total)} listings…</b> ` : '') +
    (s.comp_auto ? `Every day after 3am the app checks ${n0(s.comp_daily)} listings (not checked yet first, then the oldest checks). ` : 'Listings are only checked when you click Check. ') +
    `eBay searches used today: ${n0(CPD.calls)} of ${n0(CPD.cap)}. Nothing changes on eBay until you click Change prices.`;
  drawCompete();
  clearTimeout(cpPoll); if (pr.running && page === 'compete') cpPoll = setTimeout(renderCompete, 4000);
}
function cmRows() {
  const f = F(), q = $('cpSearch').value.trim().toLowerCase(), v = $('cpView').value;
  return (CPD ? CPD.rows : []).map(r => ({ ...r, a: AIDX[r.account_id], k: r.account_id + '|' + r.item_id })).filter(r => r.a !== undefined && f.a.has(r.a)
    && (!q || (r.sku || '').toLowerCase().includes(q) || (r.title || '').toLowerCase().includes(q))
    && (v === 'all' || (v === 'unchecked' ? !r.checked : r.state === v)));
}
function drawCompete() {
  if (!CPD) return;
  const rows = cmRows(), all = CPD.rows.filter(r => AIDX[r.account_id] !== undefined && F().a.has(AIDX[r.account_id]));
  const cnt = k => all.filter(r => r.state === k).length;
  $('cpStats').innerHTML = [['Checked', n0(all.filter(r => r.checked).length) + ' of ' + n0(all.length)], ['You\'re cheapest', n0(cnt('cheapest') + cnt('raise') + cnt('alone'))],
    ['Can match safely', n0(cnt('match'))], ['Cheaper sellers below your safe price', n0(cnt('cant') + cnt('lower'))], ['Could go up', n0(cnt('raise'))]]
    .map(([l, v]) => `<div class="stat"><small>${l}</small><b>${v}</b></div>`).join('');
  $('cpSub').textContent = `${n0(rows.length)} listings` + (rows.length > cpState.limit ? ` (first ${n0(cpState.limit)} shown)` : '') + '. Click the number of sellers to see them, mark ones that aren\'t the same part, or change the search words.';
  table($('cpTable'), [
    { h: '', l: 1, v: r => r.suggest != null ? 0 : 1, f: r => r.suggest != null ? `<input type="checkbox" class="cp-sel" data-k="${esc(r.k)}" ${cpTicked(r) ? 'checked' : ''} aria-label="Change the price of ${esc(r.sku || r.item_id)}">` : '' },
    { h: 'Listing', l: 1, cl: 'prod', v: r => r.title || '', f: r => `<span class="t">${esc(r.title || r.item_id)}</span><span class="s"><span class="dot" style="background:${ACC[r.a].color}"></span>${esc(ACC[r.a].name)} · ${esc(r.sku || 'No SKU')} · <a href="https://www.ebay.co.uk/itm/${esc(r.item_id)}" target="_blank" rel="noopener">${esc(r.item_id)}</a> · stock ${r.qty ?? '–'}</span>` },
    { h: 'You', v: r => r.ours ?? r.price ?? 0, f: r => `<b>${gbp(r.ours ?? r.price)}</b>` + (r.post ? `<span class="sub">${gbp(r.price)} + ${gbp(r.post)} post</span>` : r.checked ? '<span class="sub">free post</span>' : '') },
    { h: 'Cheapest other', v: r => r.cheapest ?? 1e9, f: r => r.cheapest != null ? `<a href="${esc(r.cheapest_url || '#')}" target="_blank" rel="noopener">${gbp(r.cheapest)}</a><span class="sub">${esc(r.cheapest_seller || '')}</span>` : '–' },
    { h: 'Middle price', v: r => r.median ?? 1e9, f: r => r.median != null ? gbp(r.median) : '–' },
    { h: 'Sellers', v: r => r.n ?? -1, f: r => r.checked ? (r.status === 'error' ? `<a href="#" class="cp-open" data-k="${esc(r.k)}"><span class="neg">error</span></a>` : `<a href="#" class="cp-open" data-k="${esc(r.k)}">${n0(r.n)}${r.rank ? ` <span class="muted">· you're ${ord(r.rank)}</span>` : ''}</a>` + (r.kind === 'title' ? '<span class="sub">by title: check</span>' : r.kind === 'custom' ? '<span class="sub">your search words</span>' : '')) : '<span class="muted">not checked</span>' },
    { h: 'Lowest safe price', v: r => r.floor ?? -1, f: r => r.floor != null ? gbp(r.floor) : '–' },
    { h: 'Suggested', v: r => r.suggest != null ? r.suggest - r.price : -1e9, f: r => r.suggest != null ? `<b>${gbp(r.suggest)}</b><span class="sub ${r.suggest > r.price ? 'pos' : ''}">${r.suggest > r.price ? '+' : ''}${gbp(r.suggest - r.price)}</span>` : '–' },
    { h: 'Notes', l: 1, cl: 'prod', v: r => r.state || '', f: r => (r.state && CPS[r.state] ? `<span class="chip ${CPS[r.state][1]}">${CPS[r.state][0]}</span> ` : '') + `<span class="muted">${esc(r.why || (r.status === 'error' ? r.message : '') || '')}</span>` + (r.checked ? `<span class="sub">checked ${ago(r.checked)}</span>` : '') }],
    cpState.sort ? rows : rows.sort((x, y) => (x.suggest == null) - (y.suggest == null) || !x.checked - !y.checked || (y.sold || 0) - (x.sold || 0)), null, cpState);
  const t = $('cpTable');
  t.querySelectorAll('.cp-sel').forEach(b => b.onchange = () => { if (b.checked) { cpOff.delete(b.dataset.k); cpPick.add(b.dataset.k); } else { cpPick.delete(b.dataset.k); cpOff.add(b.dataset.k); } cpCount(); });
  t.querySelectorAll('.cp-open').forEach(a => a.onclick = e => { e.preventDefault(); cpOpen = cpOpen === a.dataset.k ? null : a.dataset.k; drawCompete(); });
  if (cpOpen) {
    const ri = (cpState.rows || []).findIndex(r => r.k === cpOpen), tr = t.querySelector(`tbody tr[data-ri="${ri}"]`);
    if (ri >= 0 && tr) tr.insertAdjacentHTML('afterend', `<tr class="cp-detail"><td colspan="9" class="l">${cpDetail(cpState.rows[ri])}</td></tr>`), cpWireDetail(cpState.rows[ri]);
  }
  cpCount();
}
const ord = n => n + (n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th');
function cpDetail(r) {
  const its = r.items || [];
  return `<div style="padding:8px 4px">
    <div class="form-row" style="padding:0 0 10px"><div class="f" style="flex:1;min-width:240px"><label for="cpQ">Search words${r.kind === 'part' ? ' (from the part number)' : r.kind === 'title' ? ' (from the title)' : ''}</label><input type="text" id="cpQ" value="${esc(r.query || '')}" maxlength="100" style="width:100%"></div>
      <button class="btn" type="button" id="cpQSave">Search again</button>${r.kind === 'custom' ? '<button class="btn" type="button" id="cpQAuto">Back to automatic</button>' : ''}${r.ignored ? `<button class="btn" type="button" id="cpUnign">Show the ${r.ignored} hidden again</button>` : ''}</div>
    ${r.status === 'error' ? `<p class="neg">${esc(r.message || '')}</p>` : its.length ? `<table class="mini" style="width:100%"><thead><tr><th class="l">Seller</th><th class="l">Their listing</th><th>Price</th><th>Postage</th><th>Total</th><th></th></tr></thead><tbody>${its.map(x => `<tr>
      <td class="l">${esc(x.seller || '')}<span class="sub">${x.fb != null ? n0(x.fb) + ' feedback' : ''}</span></td>
      <td class="l prod"><a href="${esc(x.url || '#')}" target="_blank" rel="noopener">${esc(x.title || x.id)}</a>${x.exact ? ' <span class="chip k">part number in title</span>' : ''}</td>
      <td>${gbp(x.price)}</td><td>${x.ship == null ? '<span class="muted">?</span>' : x.ship ? gbp(x.ship) : 'Free'}</td><td><b>${gbp(x.total)}</b></td>
      <td><button class="link cp-ign" type="button" data-o="${esc(x.id)}">Not the same part</button></td></tr>`).join('')}</tbody></table>
      ${r.n_exact ? `<p class="muted" style="margin:8px 0 0">Prices above use only the ${r.n_exact} listings with your part number in their title.</p>` : ''}` : '<p class="muted">No other sellers found with these search words.</p>'}</div>`;
}
function cpWireDetail(r) {
  const one = { account_id: r.account_id, item_id: r.item_id };
  $('cpQSave').onclick = async () => { try { await post('/api/compete/query', { ...one, query: $('cpQ').value }); toast('Searching…'); setTimeout(renderCompete, 2500); } catch (e) { toast(e.message); } };
  if ($('cpQAuto')) $('cpQAuto').onclick = async () => { try { await post('/api/compete/query', { ...one, query: '' }); toast('Searching…'); setTimeout(renderCompete, 4000); } catch (e) { toast(e.message); } };
  if ($('cpUnign')) $('cpUnign').onclick = async () => { try { await post('/api/compete/ignore', { ...one, undo: true }); renderCompete(); } catch (e) { toast(e.message); } };
  document.querySelectorAll('.cp-ign').forEach(b => b.onclick = async () => { try { await post('/api/compete/ignore', { ...one, other_id: b.dataset.o }); renderCompete(); } catch (e) { toast(e.message); } });
}
// matches found by title alone aren't ticked until you've looked at them
const cpTicked = r => cpPick.has(r.k) || (!cpOff.has(r.k) && r.kind !== 'title');
function cpChosen() { return cmRows().filter(r => r.suggest != null && cpTicked(r)); }
function cpCount() {
  const n = cpChosen().length, m = Math.min(cmRows().length, 4500);
  $('cpSel').textContent = n ? `${n0(n)} price changes ticked` : '';
  $('cpApply').disabled = !n; $('cpApply').textContent = n ? `Change ${n0(n)} price${n === 1 ? '' : 's'}` : 'Change prices';
  $('cpCheck').textContent = `Check ${n0(m)} listings`; $('cpCheck').disabled = !m || (CPD && CPD.progress.running);
}
['cpView', 'cpSearch'].forEach(id => $(id).addEventListener('input', () => { cpOpen = null; drawCompete(); }));
$('cpCheck').onclick = async () => {
  const b = $('cpCheck'), rs = cmRows(); if (!rs.length) return;
  if (rs.length > 50 && b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = `Click again: ${n0(rs.length)} eBay searches`; setTimeout(() => { b.dataset.sure = ''; cpCount(); }, 6000); return; }
  b.dataset.sure = '';
  try { const r = await post('/api/compete/check', { items: rs.map(x => ({ account_id: x.account_id, item_id: x.item_id })) }); toast(`Checking ${n0(r.queued)} listings…` + (r.capped ? ' (the rest go over today\'s eBay limit)' : '')); setTimeout(renderCompete, 1500); } catch (e) { toast(e.message); }
};
$('cpApply').onclick = async () => {
  const b = $('cpApply'), ch = cpChosen(); if (!ch.length) return;
  if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = `Click again to change ${n0(ch.length)} prices on eBay`; setTimeout(() => { b.dataset.sure = ''; cpCount(); }, 6000); return; }
  b.dataset.sure = '';
  try { const r = await post('/api/compete/apply', { items: ch.map(x => ({ account_id: x.account_id, item_id: x.item_id })) }); toast(`Changing ${n0(r.changed)} prices. You can follow it and undo it on Bulk edit → Recent edits.`); cpOff = new Set(); cpPick = new Set(); setTimeout(renderCompete, 5000); } catch (e) { toast(e.message); }
};
$('cpSave').onclick = async () => {
  try { await post('/api/compete/settings', { comp_undercut: +$('cpCut').value, comp_min_profit: +$('cpMinP').value, comp_raise_pct: +$('cpRaise').value, comp_daily: +$('cpDaily').value }); toast('Saved'); renderCompete(); } catch (e) { toast(e.message); }
};
$('cpAuto').onclick = async () => { try { await post('/api/compete/settings', { comp_auto: !CPD.settings.comp_auto }); renderCompete(); } catch (e) { toast(e.message); } };

// ---------------------------------------------------------------- fitment check
let FTD = null, ftOff = new Set(), ftOpen = null, ftPoll = null;
const ftState = { sort: null, limit: 500, render: () => drawFitment(), empty: 'No listings for this selection.' };
const FTC = { none: ['No fitment', 'm'], make: ['Make mismatch', 'm'], fewer: ['Fewer rows', 'ret'], years: ['Years differ', 'b'], model: ['Title', 'b'] };
async function renderFitment() {
  try { FTD = await api('/api/fitment'); } catch (e) { toast(e.message); return; }
  const pr = FTD.progress;
  const none = !FTD.rows.some(r => r.checked);
  $('ftStatus').innerHTML = pr.running ? `<b>Checking ${n0(pr.done)} of ${n0(pr.total)} listings…</b> The results fill in as it goes.`
    : none ? '<b>Start here:</b> click <b>Check listings</b> below. The app reads each listing\'s fitment from eBay (a few minutes for a thousand listings), then the problems show up in the table.'
    : `<span class="muted">Last check: ${n0(pr.done || 0)} listings${pr.failed ? `, ${n0(pr.failed)} failed` : ''}. Click Check listings again after you change fitment on eBay.</span>`;
  drawFitment();
  clearTimeout(ftPoll); if (pr.running && page === 'fitment') ftPoll = setTimeout(renderFitment, 4000);
}
// what Check reads: every listing for the account filter and search, whatever the view; never-checked first, then the oldest checks
function ftTargets() {
  const f = F(), q = $('ftSearch').value.trim().toLowerCase();
  return (FTD ? FTD.rows : []).filter(r => AIDX[r.account_id] !== undefined && f.a.has(AIDX[r.account_id])
    && (!q || (r.sku || '').toLowerCase().includes(q) || (r.title || '').toLowerCase().includes(q)))
    .sort((x, y) => (x.checked || '').localeCompare(y.checked || '') || (y.sold || 0) - (x.sold || 0)).slice(0, FTD.max);
}
function ftRows() {
  const f = F(), q = $('ftSearch').value.trim().toLowerCase(), v = $('ftView').value;
  return (FTD ? FTD.rows : []).map(r => ({ ...r, a: AIDX[r.account_id], k: r.account_id + '|' + r.item_id })).filter(r => r.a !== undefined && f.a.has(r.a)
    && (!q || (r.sku || '').toLowerCase().includes(q) || (r.title || '').toLowerCase().includes(q))
    && (v === 'all' || (v === 'unchecked' ? !r.checked : v === 'problems' ? r.issues.length : v === 'ok' ? r.checked && r.status === 'ok' && !r.issues.length : r.issues.some(i => i.code === v))));
}
const ftCan = r => r.issues.some(i => i.code === 'fewer');
function drawFitment() {
  if (!FTD) return;
  const f = F(), all = FTD.rows.filter(r => AIDX[r.account_id] !== undefined && f.a.has(AIDX[r.account_id])), chk = all.filter(r => r.checked && r.status === 'ok');
  const has = c => all.filter(r => r.issues.some(i => i.code === c)).length;
  const stat = (k, v, sub) => `<div class="stat"><small>${k}</small><b>${v}</b>${sub ? `<span>${sub}</span>` : ''}</div>`;
  $('ftStats').innerHTML = stat('Checked', n0(chk.length), `of ${n0(all.length)} listings`) + stat('No fitment', n0(has('none')), 'in categories that take it') +
    stat('Make mismatch', n0(has('make')), 'title vs fitment') + stat('Fewer rows', n0(has('fewer')), 'than the same SKU elsewhere') +
    stat('Years differ', n0(has('years')), 'title vs fitment') + stat('Title misses fitment', n0(has('model')), 'main make/model');
  const rows = ftRows();
  if (!rows.length && !chk.length && $('ftView').value !== 'unchecked') ftState.empty = 'Nothing checked yet: click Check listings above to read the fitment from eBay.';
  else ftState.empty = 'No listings for this selection.';
  table($('ftTable'), [
    { h: '', l: 1, v: r => ftCan(r) ? 0 : 1, f: r => ftCan(r) ? `<input type="checkbox" class="ft-sel" data-k="${esc(r.k)}" ${ftOff.has(r.k) ? '' : 'checked'} aria-label="Copy fitment to ${esc(r.sku || r.item_id)}">` : '' },
    { h: 'Listing', l: 1, cl: 'prod', v: r => r.title || '', f: r => `<span class="t">${esc(r.title || r.item_id)}</span><span class="s"><span class="dot" style="background:${ACC[r.a].color}"></span>${esc(ACC[r.a].name)} · ${esc(r.sku || 'No SKU')} · <a href="https://www.ebay.co.uk/itm/${esc(r.item_id)}" target="_blank" rel="noopener">${esc(r.item_id)}</a></span>` },
    { h: 'Fitment rows', v: r => r.rows ?? -1, f: r => r.rows == null ? (r.status === 'error' ? '<span class="neg">error</span>' : '<span class="muted">not checked</span>') : r.rows ? `<a href="#" class="ft-open" data-k="${esc(r.k)}">${n0(r.rows)}</a>` : (r.supports === false ? '<span class="muted">0 · category has none</span>' : '0') },
    { h: 'Main fitment', l: 1, v: r => r.fit[0] ? r.fit[0].make + ' ' + r.fit[0].model : '', f: r => r.fit[0] ? `${esc(r.fit[0].make)} ${esc(r.fit[0].model)}${r.fit[0].y0 ? ` <span class="muted">${r.fit[0].y0}–${r.fit[0].y1}</span>` : ''}${r.fit.length > 1 ? `<span class="sub">+ ${r.fit.length - 1} more make/model${r.fit.length > 2 ? 's' : ''}</span>` : ''}` : '–' },
    { h: 'Problems', l: 1, cl: 'prod', v: r => -r.level, f: r => r.status === 'error' ? `<span class="neg">${esc(r.message || '')}</span>` : r.issues.length ? r.issues.map(i => `<div style="margin:2px 0"><span class="chip ${FTC[i.code][1]}">${FTC[i.code][0]}</span> <span class="muted">${esc(i.text)}</span></div>`).join('') : r.checked ? '<span class="chip k">OK</span>' : '' },
    { h: 'Checked', v: r => r.checked || '', f: r => r.checked ? `<span class="muted">${ago(r.checked)}</span>` : '–' }],
    ftState.sort ? rows : rows.sort((x, y) => y.level - x.level || (y.sold || 0) - (x.sold || 0)), null, ftState);
  const t = $('ftTable');
  t.querySelectorAll('.ft-sel').forEach(b => b.onchange = () => { b.checked ? ftOff.delete(b.dataset.k) : ftOff.add(b.dataset.k); ftCount(); });
  t.querySelectorAll('.ft-open').forEach(a => a.onclick = e => { e.preventDefault(); ftOpen = ftOpen === a.dataset.k ? null : a.dataset.k; drawFitment(); });
  if (ftOpen) {
    const ri = (ftState.rows || []).findIndex(r => r.k === ftOpen), tr = t.querySelector(`tbody tr[data-ri="${ri}"]`), r = ftState.rows[ri];
    if (r && tr) tr.insertAdjacentHTML('afterend', `<tr><td></td><td colspan="5" class="l"><table class="mini" style="width:auto;margin:6px 0 10px"><thead><tr><th class="l">Make</th><th class="l">Model</th><th class="l">Years</th><th>Rows</th></tr></thead><tbody>${r.fit.slice(0, 40).map(x => `<tr><td class="l">${esc(x.make)}</td><td class="l">${esc(x.model || '–')}</td><td class="l">${x.y0 ? x.y0 + '–' + x.y1 : '–'}</td><td>${n0(x.n)}</td></tr>`).join('')}${r.fit.length > 40 ? `<tr><td colspan="4" class="l muted">and ${r.fit.length - 40} more</td></tr>` : ''}</tbody></table></td></tr>`);
  }
  const tg = ftTargets(), un = tg.filter(r => !r.checked).length;
  $('ftCheck').textContent = un ? `Check ${n0(tg.length)} listings (${n0(un)} not checked yet)` : `Check ${n0(tg.length)} listings again`; $('ftCheck').classList.toggle('primary', un > 0); $('ftCheck').disabled = !tg.length || FTD.progress.running;
  ftCount();
}
function ftChosen() { return ftRows().filter(r => ftCan(r) && !ftOff.has(r.k)); }
function ftCount() { const n = ftChosen().length; $('ftSel').textContent = n ? `${n0(n)} ticked to copy` : ''; $('ftCopy').disabled = !n; $('ftCopy').textContent = n ? `Copy fitment to ${n0(n)} listing${n === 1 ? '' : 's'}` : 'Copy fitment'; }
['ftView', 'ftSearch'].forEach(id => $(id).addEventListener('input', () => { ftOpen = null; drawFitment(); }));
$('ftCheck').onclick = async () => {
  const b = $('ftCheck'), rs = ftTargets(); if (!rs.length) return;
  if (rs.length > 50 && b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = `Click again to read ${n0(rs.length)} listings from eBay`; setTimeout(() => { b.dataset.sure = ''; drawFitment(); }, 6000); return; }
  b.dataset.sure = '';
  try { const r = await post('/api/fitment/check', { items: rs.map(x => ({ account_id: x.account_id, item_id: x.item_id })) }); toast(`Checking ${n0(r.queued)} listings…`); setTimeout(renderFitment, 1500); } catch (e) { toast(e.message); }
};
$('ftCopy').onclick = async () => {
  const b = $('ftCopy'), ch = ftChosen(); if (!ch.length) return;
  if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = `Click again to change the fitment of ${n0(ch.length)} listings on eBay`; setTimeout(() => { b.dataset.sure = ''; ftCount(); }, 6000); return; }
  b.dataset.sure = '';
  try { const r = await post('/api/fitment/copy', { items: ch.map(x => ({ account_id: x.account_id, item_id: x.item_id })) }); toast(`Copying fitment to ${n0(r.changed)} listings. Follow it or undo it on Bulk edit → Recent edits.`); ftOff = new Set(); setTimeout(renderFitment, 6000); } catch (e) { toast(e.message); }
};

// ---------------------------------------------------------------- seller standards
let SSD = null;
const SSL = { TOP_RATED: ['Top Rated', 'k'], ABOVE_STANDARD: ['Above standard', 'b'], BELOW_STANDARD: ['Below standard', 'm'] };
const SSR = { LOW: ['Low', 'k'], AVERAGE: ['Average', 'b'], MEDIUM: ['Average', 'b'], HIGH: ['High', 'ret'], VERY_HIGH: ['Very high', 'm'] };
const ssChip = (l, map = SSL) => l ? `<span class="chip ${(map[l] || [0, 'b'])[1]}">${esc((map[l] || [l.replace(/_/g, ' ').toLowerCase()])[0])}</span>` : '<span class="muted">–</span>';
const ssIsRate = m => /RATE|PERCENT/i.test((m.key || '') + ' ' + (m.type || ''));
const ssVal = m => m == null || m.value == null ? '–' : m.na ? '<span class="muted">not counted</span>' : ssIsRate(m) ? `${(+m.value).toFixed(2)}%` : n0(m.value);
async function renderStandards() {
  try { SSD = await api('/api/standards'); } catch (e) { toast(e.message); return; }
  const f = F(), accs = SSD.accounts.filter(a => AIDX[a.account_id] !== undefined && f.a.has(AIDX[a.account_id]));
  const last = accs.map(a => a.state && a.state.last_check).filter(Boolean).sort().pop();
  $('ssStatus').textContent = last ? `Read from eBay ${ago(last)}.` : 'Not read from eBay yet: click Refresh from eBay.';
  const warns = accs.flatMap(a => a.warn.map(w => `<li><b>${esc(a.name)}:</b> ${esc(w)}</li>`));
  $('ssWarn').innerHTML = warns.length ? `<div style="margin:0 16px 14px;padding:10px 14px;border-radius:8px;background:var(--warn-soft);color:var(--warn)"><b>Needs attention</b><ul style="margin:6px 0 0;padding-left:18px">${warns.join('')}</ul></div>`
    : accs.some(a => a.profiles.length) ? '<p style="margin:0 16px 14px"><span class="chip k">All good</span> <span class="muted">No account is heading down a level and no service rate is high.</span></p>' : '';
  $('ssAccounts').innerHTML = accs.map(ssAccount).join('') || '<div class="panel" style="margin-top:14px"><p class="empty">No eBay accounts connected.</p></div>';
}
function ssAccount(a) {
  const st = a.state, head = `<div class="panel-head"><div><h2><span class="dot" style="background:${ACC[AIDX[a.account_id]].color}"></span> ${esc(a.name)}</h2>`;
  if (!st) return `<div class="panel" style="margin-top:14px">${head}<p>Not read yet.</p></div></div></div>`;
  if (st.last_status !== 'ok') return `<div class="panel" style="margin-top:14px">${head}<p class="${st.last_status === 'scope' ? '' : 'neg'}">${esc(st.last_message || '')}</p></div></div></div>`;
  const progs = [...new Set(a.profiles.map(p => p.program))].sort((x, y) => (y === 'PROGRAM_UK') - (x === 'PROGRAM_UK'));
  const opened = Object.entries(a.open || {}).map(([k, n]) => `${n0(n)} open ${k === 'return' ? 'return' : k === 'inquiry' ? 'not-received request' : k}${n === 1 ? '' : 's'}`).join(', ');
  return `<div class="panel" style="margin-top:14px">${head}<p>${opened ? `${esc(opened)}: each one closed without your help can become a defect. <a href="#" onclick="show('returns');return false">Open Returns</a>` : 'No open returns or cases.'}</p></div></div>
    ${progs.map(pg => ssProgram(a, pg)).join('')}${ssService(a)}</div>`;
}
function ssProgram(a, pg) {
  const cur = a.profiles.find(p => p.program === pg && p.cycle === 'CURRENT'), prj = a.profiles.find(p => p.program === pg && p.cycle === 'PROJECTED');
  const keys = [...new Map([...(cur ? cur.metrics : []), ...(prj ? prj.metrics : [])].map(m => [m.key, m])).values()];
  const mOf = (p, k) => p ? p.metrics.find(m => m.key === k) : null;
  const band = m => m && (m.lower != null || m.upper != null) ? (ssIsRate(m) ? [m.lower, m.upper].map(v => v == null ? '…' : (+v).toFixed(2) + '%') : [m.lower, m.upper].map(v => v == null ? '…' : n0(v))).join(' – ') : '';
  const name = { PROGRAM_UK: 'eBay UK', PROGRAM_US: 'eBay US', PROGRAM_DE: 'eBay Germany', PROGRAM_GLOBAL: 'Global (all other sites)' }[pg] || pg;
  return `<div style="padding:10px 16px 4px"><div style="display:flex;gap:16px;flex-wrap:wrap;align-items:baseline">
      <h3 style="margin:0;font-size:15px">${esc(name)}</h3>
      <span>Now: ${ssChip(cur && cur.level)}</span><span>Next evaluation${prj && prj.eval_month ? ' (' + esc(prj.eval_month) + ')' : ''}: ${ssChip(prj && prj.level)}</span>
      <span class="muted">${cur && cur.eval_date ? 'evaluated ' + esc(nice(cur.eval_date)) : ''}</span></div></div>
    ${!keys.length ? '<div style="height:8px"></div>' : `<div class="tbl-wrap"><table><thead><tr><th class="l">Metric</th><th>Now</th><th class="l"></th><th>Projected</th><th class="l"></th><th class="l">Range for that level</th><th class="l">Period</th></tr></thead><tbody>
    ${keys.length ? keys.map(k => { const c = mOf(cur, k.key), p = mOf(prj, k.key), m = p || c; return `<tr><td class="l">${esc(k.name)}</td>
      <td>${ssVal(c)}${c && c.den != null ? `<span class="sub">${n0(c.num || 0)} of ${n0(c.den)}</span>` : ''}</td><td class="l">${c && c.level ? ssChip(c.level) : ''}</td>
      <td>${ssVal(p)}${p && p.den != null ? `<span class="sub">${n0(p.num || 0)} of ${n0(p.den)}</span>` : ''}</td><td class="l">${p && p.level ? ssChip(p.level) : ''}</td>
      <td class="l muted">${esc(band(m))}</td><td class="l muted">${m && m.from ? esc(nice(m.from)) + ' – ' + esc(nice(m.to)) : ''}</td></tr>`; }).join('') : ''}
    </tbody></table></div>`}`;
}
function ssService(a) {
  const kinds = [['ITEM_NOT_AS_DESCRIBED', 'Not as described'], ['ITEM_NOT_RECEIVED', 'Not received']];
  const rows = kinds.flatMap(([k, label]) => ['CURRENT', 'PROJECTED'].map(c => [k, label, c, a.service.find(s => s.kind === k && s.cycle === c)]));
  return `<div style="padding:14px 16px 4px"><h3 style="margin:0;font-size:15px">Compared with similar sellers</h3><p class="muted" style="margin:4px 0 0">eBay compares your rate with sellers of similar items. "Very high" can lead to selling limits.</p></div>
    <div class="tbl-wrap"><table><thead><tr><th class="l">Problem</th><th class="l">Period</th><th class="l">Where</th><th>Your rate</th><th>Similar sellers</th><th>Cases</th><th>Sales</th><th class="l">Rating</th></tr></thead><tbody>
    ${rows.map(([k, label, c, s]) => !s ? '' : s.dims == null ? `<tr><td class="l">${label}</td><td class="l">${c === 'CURRENT' ? 'Now' : 'Projected'}</td><td class="l muted" colspan="6">${esc(s.error || 'Not enough sales to rate yet')}</td></tr>`
      : !s.dims.length ? `<tr><td class="l">${label}</td><td class="l">${c === 'CURRENT' ? 'Now' : 'Projected'}</td><td class="l muted" colspan="6">Nothing to rate in this period</td></tr>`
      : s.dims.map((d, i) => `<tr><td class="l">${i ? '' : label}</td><td class="l">${i ? '' : (c === 'CURRENT' ? 'Now' : 'Projected') + (s.start ? `<span class="sub">${esc(nice(s.start))} – ${esc(nice(s.end))}</span>` : '')}</td>
        <td class="l">${esc(d.name || d.value || '')}</td><td>${d.rate != null ? (+d.rate).toFixed(2) + '%' : '–'}</td><td>${d.avg != null ? (+d.avg).toFixed(2) + '%' : '–'}</td>
        <td>${d.count != null ? n0(d.count) : '–'}</td><td>${d.txns != null ? n0(d.txns) : '–'}</td><td class="l">${ssChip(d.rating, SSR)}${d.adjustment ? `<span class="sub">${esc(d.adjustment)}</span>` : ''}</td></tr>`).join('')).join('')}
    </tbody></table></div>`;
}
$('ssRefresh').onclick = async () => {
  const b = $('ssRefresh'); b.disabled = true; b.textContent = 'Reading from eBay…';
  try { await api('/api/standards/check', { method: 'POST' }); await renderStandards(); toast('Updated'); } catch (e) { toast(e.message); }
  b.disabled = false; b.textContent = 'Refresh from eBay';
};

// ---------------------------------------------------------------- alerts
let ALD = null, alMine = null;
const alSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const alIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const alStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
function alDeviceName() {
  const u = navigator.userAgent;
  const os = /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad' : /Android/.test(u) ? 'Android' : /Mac/.test(u) ? 'Mac' : /Windows/.test(u) ? 'Windows' : 'Computer';
  const br = /Edg\//.test(u) ? 'Edge' : /Chrome\//.test(u) && !/Edg\//.test(u) ? 'Chrome' : /Firefox\//.test(u) ? 'Firefox' : /Safari\//.test(u) ? 'Safari' : 'Browser';
  return `${os} · ${br}`;
}
function alKey(b64) { const p = '='.repeat((4 - b64.length % 4) % 4), raw = atob((b64 + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, c => c.charCodeAt(0)); }
async function alReg() { return navigator.serviceWorker.register('/sw.js', { scope: '/' }); }
async function alCurrent() {
  if (!alSupported()) return null;
  try { const r = await navigator.serviceWorker.getRegistration('/'); return r ? await r.pushManager.getSubscription() : null; } catch (e) { return null; }
}
async function renderAlerts() {
  try { ALD = await api('/api/alerts'); } catch (e) { toast(e.message); return; }
  const cur = await alCurrent();
  alMine = cur ? ALD.subs.find(s => s.endpoint === cur.endpoint) : null;
  const box = $('alDevice');
  if (!alSupported()) {
    box.innerHTML = alIOS() && !alStandalone()
      ? `<p><b>On iPhone and iPad, alerts work once Partsledger is on your Home Screen.</b></p><ol style="margin:6px 0 0;padding-left:20px"><li>In Safari, tap the Share button, then <b>Add to Home Screen</b>.</li><li>Open Partsledger from the new icon and log in.</li><li>Come back to this page and tap <b>Turn on alerts</b>.</li></ol>`
      : '<p>This browser can\'t show alerts. Use Chrome, Edge, Firefox or Safari (on iPhone, from the Home Screen).</p>';
  } else if (Notification.permission === 'denied') {
    box.innerHTML = '<p class="neg">Notifications are blocked for this site in this browser. Allow them in the browser\'s site settings, then reload this page.</p>';
  } else if (!alMine) {
    box.innerHTML = `<p>Alerts are <b>off</b> on this device (${esc(alDeviceName())}).</p><button class="btn primary" type="button" id="alOn">Turn on alerts on this device</button>`;
    $('alOn').onclick = alTurnOn;
  } else {
    const p = alMine.prefs;
    box.innerHTML = `<p><span class="chip k">On</span> on this device (${esc(alMine.device || alDeviceName())}).</p>
      <div class="form-row" style="padding:6px 0 0">${Object.entries(ALD.kinds).map(([k, l]) => `<label class="chk" style="display:flex;gap:6px;align-items:center"><input type="checkbox" class="al-pref" data-k="${k}" ${p[k] ? 'checked' : ''}> ${esc(l)}</label>`).join('')}
        <div class="f"><label for="alMin">Only sales of at least £</label><input type="number" id="alMin" min="0" step="1" value="${+p.min_sale || 0}" style="width:90px"></div>
        <button class="btn" type="button" id="alTest">Send a test alert</button><button class="btn" type="button" id="alOff">Turn off on this device</button></div>`;
    box.querySelectorAll('.al-pref').forEach(c => c.onchange = () => alPrefs({ [c.dataset.k]: c.checked }));
    $('alMin').onchange = () => alPrefs({ min_sale: +$('alMin').value || 0 });
    $('alTest').onclick = async () => { try { await post('/api/alerts/test', { id: alMine.id }); toast('Test alert sent: it should appear in a few seconds'); } catch (e) { toast(e.message); } };
    $('alOff').onclick = alTurnOff;
  }
  const st = { on: ['On', 'k'], off: ['Off', 'b'], error: ['Error', 'm'] };
  $('alAcc').innerHTML = `<thead><tr><th class="l">Account</th><th class="l">Instant from eBay</th><th class="l">Last nudge from eBay</th></tr></thead><tbody>${ALD.accounts.map(a => `<tr>
    <td class="l">${esc(a.name)}</td><td class="l">${a.notify_status ? `<span class="chip ${st[a.notify_status][1]}">${st[a.notify_status][0]}</span> <span class="muted">${esc(a.notify_message || '')}</span>` : '<span class="muted">Not turned on: alerts come from the 2-minute check</span>'}</td>
    <td class="l muted">${a.last_poke ? ago(a.last_poke) + ` · ${n0(a.pokes)} so far` : '–'}</td></tr>`).join('')}</tbody>`;
  $('alSubs').innerHTML = ALD.subs.length ? `<thead><tr><th class="l">Device</th><th class="l">Who</th><th class="l">Gets</th><th class="l">Last alert delivered</th><th></th></tr></thead><tbody>${ALD.subs.map(s => `<tr>
    <td class="l">${esc(s.device || 'Device')}${alMine && alMine.id === s.id ? ' <span class="chip b">this one</span>' : ''}</td><td class="l">${esc((s.user_email || '').split('@')[0])}</td>
    <td class="l muted">${Object.entries(ALD.kinds).filter(([k]) => s.prefs[k]).map(([, l]) => esc(l)).join(', ') || 'nothing'}${s.prefs.min_sale ? ` · sales from £${s.prefs.min_sale}` : ''}</td>
    <td class="l">${s.last_ok ? ago(s.last_ok) : '<span class="muted">not yet</span>'}${s.fails ? `<span class="sub neg">${esc(s.last_error || '')}</span>` : ''}</td>
    <td><button class="link al-rm" type="button" data-id="${s.id}">Remove</button></td></tr>`).join('')}</tbody>` : '<tbody><tr><td class="empty">No devices yet. Turn alerts on above, on your phone and on your computer.</td></tr></tbody>';
  $('alSubs').querySelectorAll('.al-rm').forEach(b => b.onclick = async () => { try { await post('/api/alerts/remove', { id: +b.dataset.id }); renderAlerts(); } catch (e) { toast(e.message); } });
  const kc = { sale: 'k', question: 'b', return: 'ret', standards: 'm' };
  $('alLog').innerHTML = ALD.log.length ? `<thead><tr><th class="l">When (UTC)</th><th class="l">What</th><th class="l">Alert</th><th>Devices</th></tr></thead><tbody>${ALD.log.map(l => `<tr>
    <td class="l">${esc((l.at || '').slice(0, 16))}${l.source === 'instant' ? '<span class="sub">instant</span>' : ''}</td><td class="l"><span class="chip ${kc[l.kind] || 'b'}">${esc(ALD.kinds[l.kind] || l.kind)}</span></td>
    <td class="l prod"><a href="${esc(l.url || '#')}" onclick="show('${esc((l.url || '#').split('#')[1] || 'dash')}');return false"><span class="t">${esc(l.title || '')}</span></a><span class="s">${esc(l.body || '')}</span></td><td>${n0(l.sent)}</td></tr>`).join('')}</tbody>` : '<tbody><tr><td class="empty">No alerts yet.</td></tr></tbody>';
}
async function alTurnOn() {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Notifications weren\'t allowed, so alerts can\'t be shown on this device.'); renderAlerts(); return; }
    const reg = await alReg(); await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: alKey(ALD.key) });
    const r = await post('/api/alerts/subscribe', { subscription: sub.toJSON(), device: alDeviceName() });
    toast(r.delivered ? 'Alerts are on. A first alert is on its way.' : 'Alerts are on, but the first alert didn\'t go through; try Send a test alert.');
  } catch (e) { toast('Couldn\'t turn alerts on: ' + e.message); }
  renderAlerts();
}
async function alTurnOff() {
  try { const sub = await alCurrent(); if (sub) { await post('/api/alerts/remove', { endpoint: sub.endpoint }); await sub.unsubscribe(); } toast('Alerts are off on this device'); } catch (e) { toast(e.message); }
  renderAlerts();
}
async function alPrefs(p) { try { await post('/api/alerts/prefs', { id: alMine.id, prefs: p }); renderAlerts(); } catch (e) { toast(e.message); } }
async function alEbay(enable) {
  const b = enable ? $('alEbayOn') : $('alEbayOff'); b.disabled = true;
  try { await post('/api/alerts/ebay', { enable, accounts: ALD.accounts.map(a => a.id) }); toast(enable ? 'eBay will now tell the app straight away' : 'Instant notifications turned off'); } catch (e) { toast(e.message); }
  b.disabled = false; renderAlerts();
}
$('alEbayOn').onclick = () => alEbay(true);
$('alEbayOff').onclick = () => alEbay(false);
if (alSupported()) navigator.serviceWorker.getRegistration('/').then(r => r && r.update()).catch(() => { });
window.addEventListener('hashchange', () => { const h = location.hash.slice(1); if (titles[h] && h !== page) show(h); });

// ---------------------------------------------------------------- wiring
const titles = { dash: 'Dashboard', orders: 'Sold items', traffic: 'Traffic', edit: 'Bulk edit', stock: 'Stock sync', msgs: 'Messages', ads: 'Ads', returns: 'Returns', payouts: 'Payouts', offers: 'Offers', promos: 'Discounts', compete: 'Competitors', fitment: 'Fitment', standards: 'Seller standards', alerts: 'Alerts', cogs: 'COGS', charts: 'Charts', uploads: 'Uploads', ebay: 'eBay', users: 'Users' };
let page = 'dash';
function show(p) {
  page = p; document.querySelectorAll('[data-p]').forEach(s => s.hidden = s.id !== 'p-' + p);
  document.querySelectorAll('#nav button').forEach(b => b.dataset.page === p ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'));
  $('pageTitle').textContent = titles[p]; $('filters').hidden = p === 'uploads' || p === 'users' || p === 'ebay' || p === 'alerts';
  renderAll(); try { history.replaceState(null, '', '#' + p); } catch (e) { }
}
document.querySelectorAll('#nav button').forEach(b => b.onclick = () => show(b.dataset.page));
function renderAll() {
  if (!D) return;
  const f = F(); $('customDates').hidden = $('fPeriod').value !== 'custom';
  $('rangeNote').textContent = `${nice(f.r[0])} – ${nice(f.r[1])}` + (ACC.some(a => f.a.has(a.i) && !a.hasData) ? ' · some selected accounts have no data yet' : '') + (!f.allG ? ' · other fees hidden when filtering by group' : '');
  if (page === 'dash') { renderTileMenu(); renderTiles(); renderProducts(); }
  if (page === 'orders') renderOrders();
  if (page === 'traffic') renderTraffic();
  if (page === 'edit') renderEdit();
  if (page === 'stock') renderStock();
  if (page === 'msgs') renderMsgs(true);
  if (page === 'ads') renderAds2();
  if (page === 'returns') renderReturns();
  if (page === 'payouts') renderPayouts();
  if (page === 'offers') renderOffers();
  if (page === 'promos') renderPromos();
  if (page === 'compete') renderCompete();
  if (page === 'fitment') renderFitment();
  if (page === 'standards') renderStandards();
  if (page === 'alerts') renderAlerts();
  if (page === 'cogs') { renderBands(); renderCogs(); }
  if (page === 'charts') renderCharts();
  if (page === 'uploads') renderUploads();
  if (page === 'users') { renderUsers(); renderLog(); }
  if (page === 'ebay') renderEbay();
}
['fPeriod', 'fFrom', 'fTo'].forEach(id => $(id).addEventListener('change', () => { ordState.limit = 100; activeTile = null; renderAll(); }));
$('tileSet').onchange = e => { tileSet = e.target.value; try { localStorage.setItem('pl_tiles', tileSet); } catch (err) { } activeTile = null; renderTiles(); };
['prodSearch', 'ordSearch'].forEach(id => $(id).addEventListener('input', renderAll));
new MutationObserver(() => page === 'charts' && renderCharts()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => page === 'charts' && renderCharts());

async function load() {
  D = await api('/api/data'); ME = D.me; TODAY = D.today;
  ACC = D.accounts.map((a, i) => ({ ...a, i })); AIDX = Object.fromEntries(ACC.map(a => [a.id, a.i]));
  I = D.items.map(r => ({ d: r[0], a: AIDX[r[1]], o: r[2], id: r[3], sku: r[4], g: r[5], t: r[6], q: r[7], s: r[8], fee: r[9], ad: r[10], po: r[11], rf: r[12], uc: r[13], src: r[14], ret: r[15] }));
  OH = D.overheads.map(r => ({ d: r[0], a: AIDX[r[1]], k: r[2], v: r[3] }));
  D.minDate = I.reduce((m, x) => x.d < m ? x.d : m, D.asOf);
  const accIdx = Object.fromEntries(D.accounts.map((a, i) => [a.id, i]));
  COGS = D.cogs.map(c => ({ ...c, prices: Object.fromEntries(c.prices.map((p, i) => [i, p])) }));
  groups = [...new Set(I.map(x => x.g).concat(COGS.map(c => c.group)))].sort();
  const gUnits = {}; I.forEach(x => gUnits[x.g] = (gUnits[x.g] || 0) + x.q);
  selAcc = buildMS('accMenu', 'msAcc', ACC.map(a => ({ v: a.name, html: `<span class="dot" style="background:${a.color}"></span>${esc(a.name)}`, note: a.hasData ? '' : 'no data yet' })), 'All accounts', 'accounts');
  selGrp = buildMS('grpMenu', 'msGrp', groups.map(g => ({ v: g, html: `<span class="sku">${esc(g)}</span>`, note: gUnits[g] ? n0(gUnits[g]) + ' sold' : '' })), 'All product groups', 'groups');
  $('upAcc').innerHTML = '<option value="">Work it out from the file</option>' + ACC.filter(a => a.channel === 'ebay').map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
  $('whoami').textContent = `${ME.name} (${ME.email})`;
  $('msgBadge').textContent = D.msgOpen || ''; $('msgBadge').hidden = !D.msgOpen;
  $('ssBadge').textContent = D.stdWarn ? '!' : ''; $('ssBadge').hidden = !D.stdWarn; $('ssBadge').title = D.stdWarn ? 'Seller standards need attention' : '';
  $('sideFoot').innerHTML = `<strong>Motoviano Ltd</strong>${ACC.map(a => esc(a.name) + (a.hasData ? '' : ' (no data yet)')).join('<br>')}<br>${I.length ? 'Data up to ' + nice(D.asOf) : 'No data yet'}`;
  if (!$('cFrom').value) $('cFrom').value = TODAY;
  if (!$('fFrom').value) { $('fFrom').value = D.minDate; $('fTo').value = D.asOf; }
  renderAll();
}
const start = (location.hash || '').slice(1);
load().then(() => show(titles[start] ? start : (D.items.length ? 'dash' : 'uploads'))).catch(e => { if (e.message !== 'login') toast(e.message); });
