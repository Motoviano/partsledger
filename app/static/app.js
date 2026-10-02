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
async function api(url, opt = {}) {
  const r = await fetch(url, opt);
  if (r.status === 401) { location.href = '/login'; throw new Error('login'); }
  const j = r.headers.get('content-type')?.includes('json') ? await r.json() : {};
  if (!r.ok) throw new Error(j.error || 'Something went wrong.');
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
      <td class="l prod">${sy && sy.last_tx_sync ? `${esc(sy.last_tx_sync.slice(0, 16))} UTC · ${sy.last_status === 'ok' ? '' : '<span class="chip m">Error</span> '}${esc(sy.last_message || '')}` : (c ? 'Waiting for first sync' : '–')}</td>
      <td>${ME.is_admin ? `<a class="btn" href="/ebay/connect/${a.id}">${c ? 'Reconnect' : 'Connect'}</a>${c ? ` <button class="link danger" type="button" data-disc="${a.id}">Disconnect</button>` : ''}` : ''}</td></tr>`;
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
$('syncNow').onclick = async () => { try { await api('/api/ebay/sync', { method: 'POST' }); toast('Syncing with eBay… this takes a minute'); setTimeout(async () => { await load(); }, 45000); setTimeout(renderEbay, 8000); } catch (e) { toast(e.message); } };
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

// ---------------------------------------------------------------- wiring
const titles = { dash: 'Dashboard', orders: 'Sold items', cogs: 'COGS', charts: 'Charts', uploads: 'Uploads', ebay: 'eBay', users: 'Users' };
let page = 'dash';
function show(p) {
  page = p; document.querySelectorAll('[data-p]').forEach(s => s.hidden = s.id !== 'p-' + p);
  document.querySelectorAll('#nav button').forEach(b => b.dataset.page === p ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'));
  $('pageTitle').textContent = titles[p]; $('filters').hidden = p === 'uploads' || p === 'users' || p === 'ebay';
  renderAll(); try { history.replaceState(null, '', '#' + p); } catch (e) { }
}
document.querySelectorAll('#nav button').forEach(b => b.onclick = () => show(b.dataset.page));
function renderAll() {
  if (!D) return;
  const f = F(); $('customDates').hidden = $('fPeriod').value !== 'custom';
  $('rangeNote').textContent = `${nice(f.r[0])} – ${nice(f.r[1])}` + (ACC.some(a => f.a.has(a.i) && !a.hasData) ? ' · some selected accounts have no data yet' : '') + (!f.allG ? ' · other fees hidden when filtering by group' : '');
  if (page === 'dash') { renderTileMenu(); renderTiles(); renderProducts(); }
  if (page === 'orders') renderOrders();
  if (page === 'cogs') { renderBands(); renderCogs(); }
  if (page === 'charts') renderCharts();
  if (page === 'uploads') renderUploads();
  if (page === 'users') renderUsers();
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
  $('sideFoot').innerHTML = `<strong>Motoviano Ltd</strong>${ACC.map(a => esc(a.name) + (a.hasData ? '' : ' (no data yet)')).join('<br>')}<br>${I.length ? 'Data up to ' + nice(D.asOf) : 'No data yet'}`;
  if (!$('cFrom').value) $('cFrom').value = TODAY;
  if (!$('fFrom').value) { $('fFrom').value = D.minDate; $('fTo').value = D.asOf; }
  renderAll();
}
const start = (location.hash || '').slice(1);
load().then(() => show(titles[start] ? start : (D.items.length ? 'dash' : 'uploads'))).catch(e => { if (e.message !== 'login') toast(e.message); });
