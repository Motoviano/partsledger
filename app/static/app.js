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
    specific: 'Adds or changes one item specific. The listing\'s other specifics stay as they are. Several values: separate them with |.',
  }[fld];
}
['edField', 'edPriceHow', 'edTitleHow'].forEach(id => $(id).addEventListener('change', () => { edShowOpts(); $('edPrevPanel').hidden = true; }));

// Step 1: the listings themselves. Ticks say which ones a bulk change touches; typed values are one-off changes.
let edOff = new Set(), edTyped = new Map(), edTrInfo = null, edMode = 'bulk';
const edKey = r => r.aid + '|' + r.id;
const edLState = { sort: null, limit: 100, render: () => drawList(), empty: 'No listings match these filters.' };
function edPicked() {
  const f = F(), pre = $('edPrefix').value.trim().toLowerCase(), q = $('edSearch').value.trim().toLowerCase(), st = $('edStock').value, tf = $('edTraffic').value;
  return EL.rows.map(r => ({ a: AIDX[r[0]], aid: r[0], id: r[1], sku: r[2], g: r[3], t: r[4], price: r[5], qty: r[6], sold: r[7], ad: r[8] }))
    .filter(r => r.a !== undefined && f.a.has(r.a) && (f.allG || f.g.has(r.g)) &&
      (!pre || r.sku.toLowerCase().startsWith(pre)) && (!q || r.t.toLowerCase().includes(q) || r.sku.toLowerCase().includes(q) || r.id.includes(q)) &&
      (st === 'all' || (st === 'in' ? r.qty > 0 : r.qty === 0)) &&
      (!tf || (() => { const fl = edTrInfo && edTrInfo.get(edKey(r))?.flag; return tf === 'attn' ? ['noimp', 'lowctr', 'nosale'].includes(fl) : fl === tf; })()));
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
  $('edTypedBtn').disabled = !typedN; $('edTypedBtn').textContent = typedN ? `Review typed changes (${typedN})` : 'Review typed changes';
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
    { h: 'Traffic', l: 1, v: r => r.tr?.flag || '', f: r => r.tr && r.tr.flag ? `<span class="chip ${FLAGS[r.tr.flag].chip}">${FLAGS[r.tr.flag].name}</span>` : '' }];
  table($('edList'), cols, rows, null, edLState);
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
      const n = [...edTyped.values()].filter(v => Object.keys(v).length).length; $('edTypedBtn').disabled = !n; $('edTypedBtn').textContent = n ? `Review typed changes (${n})` : 'Review typed changes';
    });
    if (inp.dataset.f !== 'title') inp.addEventListener('change', () => { set(); drawList(); });  // refresh the profit column
  });
}
['edPrefix', 'edSearch'].forEach(id => $(id).addEventListener('input', () => { $('edPrevPanel').hidden = true; edLState.limit = 100; drawList(); }));
['edStock', 'edTraffic'].forEach(id => $(id).addEventListener('change', () => { $('edPrevPanel').hidden = true; edLState.limit = 100; drawList(); }));
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
const FLD_NAME = { price: 'Price', qty: 'Stock', title: 'Title', specific: 'Item specific' };
function edFmt(fld, v) { return v == null ? '–' : fld === 'price' ? gbp(v) : fld === 'qty' ? n0(v) : fld === 'specific' ? `${esc(v.name)}: <b>${esc(v.value)}</b>` : esc(v); }
function drawEdit() {
  const cols = [
    { h: `<input type="checkbox" id="edAll" aria-label="Select all" checked>`, l: 1, v: () => 0, f: r => `<input type="checkbox" class="ed-sel" data-k="${r.aid}|${esc(r.id)}|${r.fld}" ${r.ok ? 'checked' : 'disabled'} aria-label="Select ${esc(r.sku || r.id)}">` },
    { h: 'Listing', l: 1, cl: 'prod', v: r => r.sku, f: r => `<span class="t">${esc(r.fld === 'title' ? r.cur : r.t)}</span><span class="s"><span class="dot" style="background:${ACC[r.a].color}"></span>${esc(ACC[r.a].name)} · ${esc(r.sku || 'No SKU')} · <a href="https://www.ebay.co.uk/itm/${esc(r.id)}" target="_blank" rel="noopener">${esc(r.id)}</a></span>` },
    { h: 'Change', l: 1, v: r => r.fld, f: r => FLD_NAME[r.fld] },
    { h: 'Now', l: 1, cl: 'prod', v: r => typeof r.cur === 'number' ? r.cur : String(r.cur ?? ''), f: r => r.fld === 'specific' ? '<span class="muted">read when applied</span>' : r.fld === 'title' ? `<span class="oldv">${esc(r.cur)}</span>` : edFmt(r.fld, r.cur) },
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
  const summary = edMode === 'typed' ? `Typed changes on ${nList} listing${nList === 1 ? '' : 's'}`
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
  const fmt = (f, v) => { try { v = JSON.parse(v); } catch (e) { } return f === 'specific' ? (v && v.name ? `${esc(v.name)}: ${esc(v.value ?? (v.restore ? v.restore.join(', ') : 'not set'))}` : Array.isArray(v) ? esc(v.join(', ')) : '–') : edFmt(f, v); };
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

// ---------------------------------------------------------------- wiring
const titles = { dash: 'Dashboard', orders: 'Sold items', traffic: 'Traffic', edit: 'Bulk edit', stock: 'Stock sync', cogs: 'COGS', charts: 'Charts', uploads: 'Uploads', ebay: 'eBay', users: 'Users' };
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
  if (page === 'traffic') renderTraffic();
  if (page === 'edit') renderEdit();
  if (page === 'stock') renderStock();
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
