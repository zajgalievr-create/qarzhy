(() => {
"use strict";

/* ═══════════ constants ═══════════ */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MEMBER_COLORS = 6;
const CURRENCIES = ["₸","₽","$","€","сом","лв"];
const CAT_OUT = ["Азық-түлік","Пәтер ақысы","Коммуналдық","Интернет","Тұрмыстық","Көлік","Дәріхана","Ойын-сауық","Оқу","Басқа"];
const CAT_IN  = ["Стипендия","Жалақы","Ата-анадан","Сыйлық","Басқа табыс"];
const MONTHS  = ["қаңтар","ақпан","наурыз","сәуір","мамыр","маусым","шілде","тамыз","қыркүйек","қазан","қараша","желтоқсан"];
const WEEKDAYS = ["жексенбі","дүйсенбі","сейсенбі","сәрсенбі","бейсенбі","жұма","сенбі"];
const LS_KEY = "ortaq-qalta.v1";

/* ═══════════ tiny helpers ═══════════ */
const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const clampInt = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : 0; };
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; };
const ymOf = (iso) => (iso || todayISO()).slice(0, 7);
const randId = (n=16) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return Array.from(a, b => b.toString(16).padStart(2,"0")).join(""); };
const randCode = () => { const a = new Uint8Array(6); crypto.getRandomValues(a); return Array.from(a, b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join(""); };

function groupDigits(n){
  const s = String(Math.abs(n));
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}
function money(n, opts = {}){
  const v = clampInt(n);
  const sign = opts.signed && v > 0 ? "+" : v < 0 ? "−" : "";
  return `${sign}${groupDigits(v)} ${state.currency}`;
}
function monthLabel(ym){
  const [y, m] = ym.split("-").map(Number);
  const now = new Date();
  const suffix = y === now.getFullYear() ? "" : ` ${y}`;
  return `${MONTHS[m-1]}${suffix}`;
}
function dayLabel(iso){
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m-1, d);
  const t = new Date(); t.setHours(0,0,0,0);
  const diff = Math.round((dt - t) / 86400000);
  if (diff === 0) return "Бүгін";
  if (diff === -1) return "Кеше";
  if (diff > -7 && diff < 0) return WEEKDAYS[dt.getDay()];
  return `${d} ${MONTHS[m-1]}`;
}
function initials(name){
  const s = String(name || "?").trim();
  return s ? s[0].toUpperCase() : "?";
}
let toastTimer = null;
function toast(msg){
  const el = $("#toast");
  el.textContent = msg; el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}
async function copyText(text, okMsg){
  try { await navigator.clipboard.writeText(text); toast(okMsg); }
  catch { toast("Көшіру мүмкін болмады — қолмен белгілеңіз"); }
}

/* ═══════════ local profile ═══════════ */
function loadLocal(){
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(LS_KEY) || "null"); } catch { raw = null; }
  const l = raw && typeof raw === "object" ? raw : {};
  if (!l.profileId) l.profileId = randId(8);
  if (!l.soloKey)   l.soloKey   = randId(12);
  if (!l.tab)       l.tab       = "shared";
  return l;
}
function saveLocal(){
  try { localStorage.setItem(LS_KEY, JSON.stringify(local)); } catch { /* private mode */ }
}
const local = loadLocal();

/* ═══════════ app state ═══════════ */
const state = {
  db: null,
  storeKind: "local",   // "claude" (ортақ база) | "local" (localStorage)
  dbResolved: false,
  house: null,          // {name, currency}
  members: [],          // [{id,name,colorIdx}]
  expenses: [],         // [{id,title,amount,payerId,mode,participants,exact,category,date,createdAt}]
  settlements: [],      // [{id,fromId,toId,amount,date,createdAt}]
  soloProfile: null,    // {currency}
  soloMonth: null,      // {txns:[...]}
  ym: ymOf(todayISO()),
  sharedYm: ymOf(todayISO()),
  currency: "₸",
  loading: true,
};
const subs = { house: [], solo: [] };
function dropSubs(key){ subs[key].forEach(u => { try { u(); } catch {} }); subs[key] = []; }

/* ═══════════ finance math ═══════════ */
function shareMap(e){
  const out = {};
  const amt = clampInt(e.amount);
  if (e.mode === "exact" && e.exact && typeof e.exact === "object"){
    for (const [id, v] of Object.entries(e.exact)){
      const n = clampInt(v);
      if (n) out[id] = (out[id] || 0) + n;
    }
    return out;
  }
  const ps = Array.isArray(e.participants) ? e.participants.filter(Boolean) : [];
  if (!ps.length || !amt) return out;
  const base = Math.floor(amt / ps.length);
  const rem  = amt - base * ps.length;
  ps.forEach((id, i) => { out[id] = (out[id] || 0) + base + (i < rem ? 1 : 0); });
  return out;
}
function computeBalances(){
  const bal = {};
  const touch = (id) => { if (id && !(id in bal)) bal[id] = 0; };
  state.members.forEach(m => touch(m.id));
  for (const e of state.expenses){
    touch(e.payerId);
    if (e.payerId) bal[e.payerId] += clampInt(e.amount);
    for (const [id, v] of Object.entries(shareMap(e))){ touch(id); bal[id] -= v; }
  }
  for (const s of state.settlements){
    touch(s.fromId); touch(s.toId);
    const amt = clampInt(s.amount);
    if (s.fromId) bal[s.fromId] += amt;
    if (s.toId)   bal[s.toId]   -= amt;
  }
  return bal;
}
/* greedy minimal transfers: largest debtor pays largest creditor */
function settleUp(bal){
  const cred = [], deb = [];
  for (const [id, v] of Object.entries(bal)){
    if (v > 0) cred.push({ id, v });
    else if (v < 0) deb.push({ id, v: -v });
  }
  cred.sort((a, b) => b.v - a.v);
  deb.sort((a, b) => b.v - a.v);
  const out = [];
  let i = 0, j = 0;
  while (i < deb.length && j < cred.length){
    const amt = Math.min(deb[i].v, cred[j].v);
    if (amt > 0) out.push({ from: deb[i].id, to: cred[j].id, amount: amt });
    deb[i].v -= amt; cred[j].v -= amt;
    if (deb[i].v <= 0) i++;
    if (cred[j].v <= 0) j++;
  }
  return out;
}
function memberById(id){
  return state.members.find(m => m.id === id) || { id, name: "Белгісіз", colorIdx: 0, gone: true };
}
function myMember(){ return state.members.find(m => m.id === local.profileId) || null; }

/* ═══════════ db wiring ═══════════ */
async function connectDb(){
  let res = { kind: "local", db: null };
  try { res = await OQStore.create(); } catch (e){ console.warn("store", e); }
  state.db = res.db;
  state.storeKind = res.kind;
  state.dbResolved = true;
  if (state.db && local.houseCode) watchHouse(local.houseCode);
  watchSolo();
  state.loading = false;
  render();
}
function onErr(where){
  return (e) => {
    if (e && (e.code === "revoked" || e.code === "not_granted")) state.db = null;
    console.warn("db " + where, e);
    render();
  };
}
function watchHouse(code){
  dropSubs("house");
  const db = state.db;
  if (!db || !code) { state.house = null; state.members = []; state.expenses = []; state.settlements = []; return; }
  subs.house.push(db.doc(`houses/${code}`).onSnapshot(snap => {
    state.house = snap.exists ? snap.data() : null;
    if (state.house && state.house.currency) state.currency = state.house.currency;
    render();
  }, onErr("house")));
  subs.house.push(db.collection(`houses/${code}/members`).onSnapshot(snap => {
    state.members = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
    render();
  }, onErr("members")));
  subs.house.push(db.collection(`houses/${code}/expenses`).orderBy("createdAt", "desc").limit(1000)
    .onSnapshot(snap => { state.expenses = snap.docs.map(d => ({ id: d.id, ...d.data() })); render(); }, onErr("expenses")));
  subs.house.push(db.collection(`houses/${code}/settlements`).orderBy("createdAt", "desc").limit(500)
    .onSnapshot(snap => { state.settlements = snap.docs.map(d => ({ id: d.id, ...d.data() })); render(); }, onErr("settlements")));
}

/* ═══════════ solo ledger (db when available, localStorage otherwise) ═══════════ */
function soloLocalAll(){ return (local.soloData && typeof local.soloData === "object") ? local.soloData : (local.soloData = {}); }
function watchSolo(){
  dropSubs("solo");
  const db = state.db, key = local.soloKey, ym = state.ym;
  if (!db){
    state.soloProfile = local.soloProfile || null;
    state.soloMonth = soloLocalAll()[ym] || { txns: [] };
    return;
  }
  subs.solo.push(db.doc(`solo/${key}`).onSnapshot(snap => {
    state.soloProfile = snap.exists ? snap.data() : null;
    render();
  }, onErr("solo")));
  subs.solo.push(db.doc(`solo/${key}`).collection("months").doc(ym).onSnapshot(snap => {
    state.soloMonth = snap.exists ? snap.data() : { txns: [] };
    render();
  }, onErr("solo month")));
}
function soloTxns(){
  const t = state.soloMonth && Array.isArray(state.soloMonth.txns) ? state.soloMonth.txns : [];
  return t.slice().sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || 0) - (a.createdAt || 0));
}
async function saveSoloMonth(ym, txns){
  if (state.db){
    await state.db.doc(`solo/${local.soloKey}`).collection("months").doc(ym).set({ txns });
  } else {
    soloLocalAll()[ym] = { txns };
    saveLocal();
    if (ym === state.ym) state.soloMonth = { txns };
    render();
  }
}
async function addSoloTxn(txn){
  const ym = ymOf(txn.date);
  let existing;
  if (state.db){
    const snap = await state.db.doc(`solo/${local.soloKey}`).collection("months").doc(ym).get();
    existing = snap.exists && Array.isArray(snap.data().txns) ? snap.data().txns : [];
  } else {
    existing = (soloLocalAll()[ym] || { txns: [] }).txns || [];
  }
  await saveSoloMonth(ym, existing.concat([txn]));
}
async function removeSoloTxn(id){
  const ym = state.ym;
  const rest = soloTxns().filter(t => t.id !== id);
  await saveSoloMonth(ym, rest);
}

/* ═══════════ view fragments ═══════════ */
function avatar(m, cls = ""){
  return `<span class="ava ${cls}" style="--c:var(--m${(m.colorIdx || 0) % MEMBER_COLORS})">${esc(initials(m.name))}</span>`;
}
function rankedBars(rows, total){
  if (!rows.length) return "";
  const max = rows[0].value || 1;
  return `<div class="bars">` + rows.map((r, i) => {
    const pct = Math.max(30, 100 - i * 11);
    const share = total ? Math.round(r.value / total * 100) : 0;
    return `<div class="bar" style="--tint:color-mix(in oklab, var(--accent) ${pct}%, var(--surface-3))">
      <div class="row"><span class="n">${esc(r.label)}</span><span class="p">${share}%</span><span class="v">${money(r.value)}</span></div>
      <div class="track"><div class="fill" style="width:${Math.max(2, Math.round(r.value / max * 100))}%"></div></div>
    </div>`;
  }).join("") + `</div>`;
}
function categoryRows(items, getCat, getAmt){
  const totals = new Map();
  for (const it of items){
    const c = getCat(it) || "Басқа";
    totals.set(c, (totals.get(c) || 0) + clampInt(getAmt(it)));
  }
  return Array.from(totals, ([label, value]) => ({ label, value }))
    .filter(r => r.value > 0)
    .sort((a, b) => b.value - a.value);
}
function monthBar(ym, onPrev, onNext, canNext){
  return `<div class="monthbar">
    <button data-act="${onPrev}" aria-label="Алдыңғы ай">‹</button>
    <span class="m">${esc(monthLabel(ym))}</span>
    <button data-act="${onNext}" aria-label="Келесі ай" ${canNext ? "" : "disabled"}>›</button>
  </div>`;
}
function storeName(){
  if (state.storeKind === "firebase") return "Firebase";
  if (state.storeKind === "claude")   return "Claude базасы";
  return "Осы браузер";
}
function storeHint(){
  if (state.storeKind === "firebase") return "Ортақ қоймаға қосылған — ноут, телефон және пәтерлестерің бір деректі көреді.";
  if (state.storeKind === "claude")   return "Claude платформасының ортақ базасында сақталуда.";
  return "Бәрі осы браузерде сақталған. Екінші құрылғыға көшіру үшін файлға шығарып, сол жерде кері жүкте.";
}
function localOnlyNotice(){
  if (state.storeKind !== "local") return "";
  return `<div class="notice">Дерек осы браузерде ғана сақталуда — сервер әлі қосылмаған. Сондықтан ноутпен телефон бір-бірін көрмейді. Баптаудан деректі файлға шығарып, екінші құрылғыға тасуға болады.</div>`;
}
function emptyBlock(title, text, btn){
  return `<div class="empty"><h3>${esc(title)}</h3><p>${esc(text)}</p>${btn || ""}</div>`;
}

/* ═══════════ onboarding ═══════════ */
function viewOnboarding(){
  return `<div class="stack">
    <div class="hero tone-flat">
      <span class="eyebrow">Бастау</span>
      <h1 style="font-size:24px; letter-spacing:-.02em">Ақшаны бірге санаған оңай</h1>
      <p class="cap">Пәтерлес достарыңмен ортақ шығынды бөлісіп жүр, немесе тек өз есебіңді жүргіз. Атыңды жазсаң болғаны.</p>
    </div>
    <div class="card">
      <form class="form" id="onboardForm" style="display:flex; flex-direction:column; gap:14px">
        <div class="field">
          <label for="obName">Сенің атың</label>
          <input class="input" id="obName" maxlength="24" required autocomplete="given-name" placeholder="Мысалы: Аяулым">
        </div>
        <button class="btn primary wide" type="submit">Жалғастыру</button>
      </form>
    </div>
  </div>`;
}

/* ═══════════ shared tab ═══════════ */
function viewShared(){
  if (!state.dbResolved) return `<div class="empty"><p>Жүктелуде…</p></div>`;
  if (!state.db){
    return `<div class="stack">
      <div class="notice">Қойма қосылмады — браузер localStorage-ды бөгеп тұр болуы мүмкін (инкогнито немесе сайт деректері өшірулі).</div>
    </div>`;
  }
  if (!local.houseCode || !state.house){
    return `<div class="stack">
      ${localOnlyNotice()}
      ${local.houseCode && !state.house ? `<div class="notice">«${esc(local.houseCode)}» коды бойынша үй табылмады. Ол жойылған болуы мүмкін.</div>` : ""}
      ${emptyBlock("Әзірге үй жоқ", "Үй құрып, кодты пәтерлестеріңе жібер. Немесе олардың кодымен қосыл.",
        `<div style="display:flex; gap:10px; margin-top:6px; flex-wrap:wrap; justify-content:center">
           <button class="btn primary" data-act="createHouse">Үй құру</button>
           <button class="btn ghost" data-act="joinHouse">Кодпен қосылу</button>
           <button class="btn ghost" data-act="seedDemo">Демо көру</button>
         </div>`)}
    </div>`;
  }

  const bal = computeBalances();
  const mine = bal[local.profileId] || 0;
  const tone = mine > 0 ? "tone-pos" : mine < 0 ? "tone-neg" : "tone-flat";
  const cap = mine > 0 ? "Осыншаны саған қайтаруға тиіс." : mine < 0 ? "Осыншаны сен беруге тиіссің." : "Бәрі тең — ешкім ешкімге қарыз емес.";
  const transfers = settleUp(bal);

  const monthExp = state.expenses.filter(e => ymOf(e.date) === state.sharedYm);
  const monthTotal = monthExp.reduce((s, e) => s + clampInt(e.amount), 0);
  const cats = categoryRows(monthExp, e => e.category, e => e.amount);
  const nextYm = addMonths(state.sharedYm, 1);
  const canNext = nextYm <= ymOf(todayISO());

  const feed = buildFeed();

  return `<div class="stack">
    ${localOnlyNotice()}
    <div class="hero ${tone}">
      <span class="eyebrow">Сенің балансың</span>
      <span class="big">${money(mine, { signed: true })}</span>
      <p class="cap">${esc(cap)}</p>
    </div>

    ${transfers.length ? `<section class="section">
      <div class="section-head"><h2>Есеп-қисап</h2><span class="eyebrow">${transfers.length} аударым</span></div>
      <div class="settle">${transfers.map(t => {
        const f = memberById(t.from), to = memberById(t.to);
        const isMine = t.from === local.profileId || t.to === local.profileId;
        return `<div class="settle-row${isMine ? " mine" : ""}">
          <span class="pair">
            <span class="who">${avatar(f, "sm")}<span>${esc(f.name)}</span></span>
            <span class="arrow">→</span>
            <span class="who">${avatar(to, "sm")}<span>${esc(to.name)}</span></span>
          </span>
          <span class="amt">${money(t.amount)}</span>
          <button class="go" data-act="settle" data-from="${esc(t.from)}" data-to="${esc(t.to)}" data-amount="${t.amount}">Төледі</button>
        </div>`;
      }).join("")}</div>
    </section>` : ""}

    <section class="section">
      <div class="section-head"><h2>Тұрғындар</h2><button class="btn sm ghost" data-act="invite">Шақыру</button></div>
      <div class="people">${state.members.map(m => {
        const v = bal[m.id] || 0;
        const c = v > 0 ? "var(--pos)" : v < 0 ? "var(--neg)" : "var(--ink-3)";
        return `<span class="person">${avatar(m)}<span>${esc(m.name)}</span><span class="bal" style="color:${c}">${money(v, { signed: true })}</span></span>`;
      }).join("")}</div>
    </section>

    <section class="section">
      <div class="section-head"><h2>Айлық шығын</h2><span class="eyebrow">${monthExp.length} жазба</span></div>
      <div class="card" style="display:flex; flex-direction:column; gap:16px">
        ${monthBar(state.sharedYm, "sharedPrev", "sharedNext", canNext)}
        <div class="grid-2">
          <div class="tile" style="background:var(--surface-2); border-color:transparent"><span class="eyebrow">Барлығы</span><span class="v">${money(monthTotal)}</span></div>
          <div class="tile" style="background:var(--surface-2); border-color:transparent"><span class="eyebrow">Бір адамға</span><span class="v">${money(state.members.length ? Math.round(monthTotal / state.members.length) : 0)}</span></div>
        </div>
        ${cats.length ? rankedBars(cats, monthTotal) : `<p class="muted" style="font-size:13.5px">Бұл айда жазба жоқ.</p>`}
      </div>
    </section>

    <section class="section">
      <div class="section-head"><h2>Жазбалар</h2><span class="eyebrow">${feed.length} дана</span></div>
      ${feed.length ? renderFeed(feed) : emptyBlock("Әзірге бос", "Бірінші шығынды қосып көр — төменнен «Қосу» бас.", "")}
    </section>
  </div>`;
}

function buildFeed(){
  const rows = [];
  for (const e of state.expenses) rows.push({ kind: "expense", ...e });
  for (const s of state.settlements) rows.push({ kind: "settle", ...s });
  rows.sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || 0) - (a.createdAt || 0));
  return rows.slice(0, 200);
}
function renderFeed(rows){
  const days = [];
  let cur = null;
  for (const r of rows){
    const d = r.date || todayISO();
    if (!cur || cur.date !== d){ cur = { date: d, items: [], total: 0 }; days.push(cur); }
    cur.items.push(r);
    if (r.kind === "expense") cur.total += clampInt(r.amount);
  }
  return days.map(day => `<div class="daygroup">
    <div class="daylabel"><span class="eyebrow">${esc(dayLabel(day.date))}</span><span class="eyebrow">${day.total ? money(day.total) : ""}</span></div>
    <div class="entries">${day.items.map(r => {
      if (r.kind === "settle"){
        const f = memberById(r.fromId), t = memberById(r.toId);
        return `<button class="entry" data-act="openSettle" data-id="${esc(r.id)}">
          <span class="tagdot settle"></span>
          <span class="body"><span class="t">${esc(f.name)} → ${esc(t.name)}</span><span class="s">Қарызды жабу</span></span>
          <span class="a settle">${money(r.amount)}</span></button>`;
      }
      const payer = memberById(r.payerId);
      const shares = shareMap(r);
      const mineShare = shares[local.profileId] || 0;
      const sub = `${payer.name} төледі · ${Object.keys(shares).length} адам${mineShare ? ` · сенікі ${money(mineShare)}` : ""}`;
      return `<button class="entry" data-act="openExpense" data-id="${esc(r.id)}">
        <span class="tagdot"></span>
        <span class="body"><span class="t">${esc(r.title || r.category || "Шығын")}</span><span class="s">${esc(sub)}</span></span>
        <span class="a">${money(r.amount)}</span></button>`;
    }).join("")}</div>
  </div>`).join("");
}

function addMonths(ym, delta){
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
}

/* ═══════════ personal tab ═══════════ */
function viewPersonal(){
  const txns = soloTxns();
  const income  = txns.filter(t => t.type === "in").reduce((s, t) => s + clampInt(t.amount), 0);
  const outflow = txns.filter(t => t.type !== "in").reduce((s, t) => s + clampInt(t.amount), 0);
  const left = income - outflow;
  const tone = left > 0 ? "tone-pos" : left < 0 ? "tone-neg" : "tone-flat";
  const cap = income
    ? (left >= 0 ? `Табысыңның ${Math.round(outflow / income * 100)}%-ын жұмсадың.` : "Табысыңнан асып кеттің.")
    : "Айлық табысыңды қосып қойсаң, қалдық есептеледі.";
  const cats = categoryRows(txns.filter(t => t.type !== "in"), t => t.category, t => t.amount);
  const canNext = addMonths(state.ym, 1) <= ymOf(todayISO());

  const days = [];
  let cur = null;
  for (const t of txns){
    const d = t.date || todayISO();
    if (!cur || cur.date !== d){ cur = { date: d, items: [] }; days.push(cur); }
    cur.items.push(t);
  }

  return `<div class="stack">
    ${localOnlyNotice()}
    <div class="card" style="display:flex; flex-direction:column; gap:14px; padding:14px 16px">
      ${monthBar(state.ym, "soloPrev", "soloNext", canNext)}
    </div>
    <div class="hero ${tone}">
      <span class="eyebrow">Айдың қалдығы</span>
      <span class="big">${money(left, { signed: true })}</span>
      <p class="cap">${esc(cap)}</p>
    </div>
    <div class="grid-2">
      <div class="tile"><span class="eyebrow">Табыс</span><span class="v" style="color:var(--pos)">${money(income)}</span></div>
      <div class="tile"><span class="eyebrow">Шығын</span><span class="v">${money(outflow)}</span></div>
    </div>

    ${cats.length ? `<section class="section">
      <div class="section-head"><h2>Не көп кетті</h2><span class="eyebrow">санат бойынша</span></div>
      <div class="card">${rankedBars(cats, outflow)}</div>
    </section>` : ""}

    <section class="section">
      <div class="section-head"><h2>Жазбалар</h2><span class="eyebrow">${txns.length} дана</span></div>
      ${txns.length ? days.map(day => `<div class="daygroup">
        <div class="daylabel"><span class="eyebrow">${esc(dayLabel(day.date))}</span></div>
        <div class="entries">${day.items.map(t => `<button class="entry" data-act="openSolo" data-id="${esc(t.id)}">
          <span class="tagdot ${t.type === "in" ? "in" : ""}"></span>
          <span class="body"><span class="t">${esc(t.title || t.category || (t.type === "in" ? "Табыс" : "Шығын"))}</span><span class="s">${esc(t.category || "")}</span></span>
          <span class="a ${t.type === "in" ? "in" : ""}">${t.type === "in" ? "+" : ""}${money(t.amount)}</span></button>`).join("")}</div>
      </div>`).join("") : emptyBlock("Бұл ай әлі бос", "Төменнен «Қосу» басып, бірінші жазбаңды енгіз.", "")}
    </section>
  </div>`;
}

/* ═══════════ settings tab ═══════════ */
function viewSettings(){
  const me = myMember();
  const colorIdx = me ? (me.colorIdx || 0) : (local.colorIdx || 0);
  return `<div class="stack">
    <section class="section">
      <div class="section-head"><h2>Мен</h2></div>
      <div class="card" style="display:flex; flex-direction:column; gap:14px">
        <div class="field">
          <label for="setName">Аты</label>
          <input class="input" id="setName" maxlength="24" value="${esc(local.name || "")}">
        </div>
        <div class="field">
          <label>Түсім</label>
          <div class="chips">${Array.from({ length: MEMBER_COLORS }, (_, i) => `
            <button class="chip text-only" data-act="setColor" data-i="${i}" aria-pressed="${i === colorIdx}"
              style="padding:6px"><span class="ava" style="--c:var(--m${i})">${esc(initials(local.name))}</span></button>`).join("")}</div>
        </div>
        <div class="field">
          <label for="setCur">Валюта</label>
          <select class="input" id="setCur">${CURRENCIES.map(c => `<option value="${esc(c)}" ${c === state.currency ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>
        </div>
        <button class="btn primary wide" data-act="saveProfile">Сақтау</button>
      </div>
    </section>

    <section class="section">
      <div class="section-head"><h2>Үй</h2></div>
      ${local.houseCode && state.house ? `<div class="card" style="display:flex; flex-direction:column; gap:14px">
        <div class="field">
          <label for="setHouse">Үйдің аты</label>
          <input class="input" id="setHouse" maxlength="32" value="${esc(state.house.name || "")}">
        </div>
        <div class="code-box">
          <div style="display:flex; flex-direction:column; gap:2px">
            <span class="eyebrow" style="color:inherit; opacity:.7">Қосылу коды</span>
            <span class="c">${esc(local.houseCode)}</span>
          </div>
          <button class="btn sm ghost" data-act="invite" style="margin-left:auto; border-color:currentColor; color:inherit">Көшіру</button>
        </div>
        <div class="list">
          ${state.members.map(m => `<div class="rowlink" style="cursor:default">${avatar(m)}<span>${esc(m.name)}</span>${m.id === local.profileId ? `<span class="r">сен</span>` : ""}</div>`).join("")}
        </div>
        <div style="display:flex; gap:10px">
          <button class="btn ghost" data-act="saveHouse" style="flex:1">Атын сақтау</button>
          <button class="btn danger" data-act="leaveHouse" style="flex:1">Үйден шығу</button>
        </div>
      </div>` : `<div class="card" style="display:flex; gap:10px; flex-wrap:wrap">
        <button class="btn primary" data-act="createHouse" style="flex:1">Үй құру</button>
        <button class="btn ghost" data-act="joinHouse" style="flex:1">Кодпен қосылу</button>
      </div>`}
    </section>

    <section class="section">
      <div class="section-head"><h2>Жеке есеп кілті</h2></div>
      <div class="card" style="display:flex; flex-direction:column; gap:12px">
        <p class="muted" style="font-size:13px; max-width:52ch">Жеке жазбаларың осы кілтпен байланысқан. Басқа құрылғыда сол есепті ашу үшін кілтті көшіріп ал.</p>
        <div class="code-box" style="background:var(--surface-2); color:var(--ink)">
          <span class="num" style="font-size:13px; word-break:break-all">${esc(local.soloKey)}</span>
          <button class="btn sm ghost" data-act="copyKey" style="margin-left:auto">Көшіру</button>
        </div>
        <button class="btn ghost wide" data-act="restoreKey">Басқа кілтпен кіру</button>
      </div>
    </section>

    <section class="section">
      <div class="section-head"><h2>Дерек</h2><span class="eyebrow">${esc(storeName())}</span></div>
      <div class="card" style="display:flex; flex-direction:column; gap:12px">
        <p class="muted" style="font-size:13px; max-width:52ch">${esc(storeHint())}</p>
        ${state.storeKind === "local" ? `
        <div style="display:flex; gap:10px; flex-wrap:wrap">
          <button class="btn ghost" data-act="exportData" style="flex:1">Файлға шығару</button>
          <button class="btn ghost" data-act="importData" style="flex:1">Файлдан жүктеу</button>
        </div>` : ""}
        <button class="btn ghost wide" data-act="seedDemo">Демо дерек қосу</button>
        ${state.storeKind === "local" ? `<button class="btn danger wide" data-act="wipeData">Барлық деректі өшіру</button>` : ""}
        <input type="file" id="importFile" accept="application/json,.json" class="hidden">
      </div>
    </section>

    <section class="section">
      <div class="section-head"><h2>Тақырып</h2></div>
      <div class="seg" id="themeSeg">
        <button data-act="theme" data-v="auto"  aria-pressed="${(local.theme || "auto") === "auto"}">Жүйе</button>
        <button data-act="theme" data-v="light" aria-pressed="${local.theme === "light"}">Ашық</button>
        <button data-act="theme" data-v="dark"  aria-pressed="${local.theme === "dark"}">Күңгірт</button>
      </div>
    </section>
  </div>`;
}

/* ═══════════ render ═══════════ */
function render(){
  const view = $("#view");
  const onboarding = !local.name;
  $("#tabs").classList.toggle("hidden", onboarding);
  $("#topRight").innerHTML = onboarding ? "" :
    (local.houseCode && state.house
      ? `<button class="house-chip" data-act="invite"><span class="ava sm" style="--c:var(--m${((myMember() && myMember().colorIdx) || local.colorIdx || 0) % MEMBER_COLORS})">${esc(initials(local.name))}</span><b>${esc(state.house.name || local.houseCode)}</b></button>`
      : `<span class="house-chip"><span class="ava sm" style="--c:var(--m0)">${esc(initials(local.name))}</span><b>${esc(local.name)}</b></span>`);

  if (onboarding){ view.innerHTML = viewOnboarding(); $("#fab").classList.add("hidden"); return; }

  $$("#tabs button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === local.tab)));
  view.innerHTML = local.tab === "personal" ? viewPersonal() : local.tab === "settings" ? viewSettings() : viewShared();

  const fab = $("#fab");
  const showFab = (local.tab === "shared" && state.db && local.houseCode && state.house) || local.tab === "personal";
  fab.classList.toggle("hidden", !showFab);
  fab.textContent = local.tab === "personal" ? "+ Жазба" : "+ Шығын";
}

/* ═══════════ sheet ═══════════ */
let sheetOpen = false, sheetSeq = 0;
function openSheet(html, onMount){
  const sheet = $("#sheet"), backdrop = $("#backdrop");
  const seq = ++sheetSeq;
  sheet.innerHTML = `<div class="grip"></div>` + html;
  backdrop.classList.add("open");
  sheetOpen = true;
  /* a frame callback can fire late (hidden tab) — only open if still current */
  requestAnimationFrame(() => { if (sheetSeq === seq && sheetOpen) sheet.classList.add("open"); });
  if (onMount) onMount(sheet);
  const first = sheet.querySelector("input:not([type=hidden]), select, button.btn");
  if (first && first.tagName === "INPUT") setTimeout(() => first.focus(), 260);
}
function closeSheet(){
  sheetSeq++;
  sheetOpen = false;
  $("#sheet").classList.remove("open");
  $("#backdrop").classList.remove("open");
}
function fieldDate(id, value){
  return `<div class="field"><label for="${id}">Күні</label><input class="input" type="date" id="${id}" value="${esc(value)}" max="${esc(todayISO())}"></div>`;
}
function catSelect(id, list, selected){
  return `<div class="field"><label for="${id}">Санат</label><select class="input" id="${id}">${
    list.map(c => `<option ${c === selected ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></div>`;
}

/* ── house sheets ── */
function sheetCreateHouse(){
  openSheet(`<h3>Үй құру</h3>
    <form class="form" id="fCreate">
      <div class="field"><label for="hName">Үйдің аты</label>
        <input class="input" id="hName" maxlength="32" required placeholder="Мысалы: 12-пәтер"></div>
      <div class="field"><label for="hCur">Валюта</label>
        <select class="input" id="hCur">${CURRENCIES.map(c => `<option ${c === state.currency ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></div>
      <div class="actions"><button class="btn ghost" type="button" data-act="close">Болмайды</button>
        <button class="btn primary" type="submit">Құру</button></div>
    </form>`, (s) => {
    $("#fCreate", s).addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const btn = ev.target.querySelector('button[type="submit"]');
      btn.disabled = true; btn.textContent = "Құрылуда…";
      try { await createHouse($("#hName", s).value.trim(), $("#hCur", s).value); closeSheet(); }
      catch (err){ btn.disabled = false; btn.textContent = "Құру"; toast(dbMsg(err)); }
    });
  });
}
function sheetJoinHouse(){
  openSheet(`<h3>Үйге қосылу</h3>
    <form class="form" id="fJoin">
      <div class="field"><label for="jCode">Қосылу коды</label>
        <input class="input num" id="jCode" maxlength="6" required autocapitalize="characters"
          style="text-transform:uppercase; letter-spacing:.2em; font-size:20px" placeholder="ABC123"></div>
      <div class="actions"><button class="btn ghost" type="button" data-act="close">Болмайды</button>
        <button class="btn primary" type="submit">Қосылу</button></div>
    </form>`, (s) => {
    $("#fJoin", s).addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const btn = ev.target.querySelector('button[type="submit"]');
      btn.disabled = true; btn.textContent = "Тексерілуде…";
      try { await joinHouse($("#jCode", s).value.trim().toUpperCase()); closeSheet(); }
      catch (err){ btn.disabled = false; btn.textContent = "Қосылу"; toast(err && err.userMessage ? err.userMessage : dbMsg(err)); }
    });
  });
}

/* ── expense sheet ── */
function sheetExpense(){
  const ms = state.members;
  openSheet(`<h3>Шығын қосу</h3>
    <form class="form" id="fExp">
      <div class="field"><label for="eAmt">Сома</label>
        <input class="input money" id="eAmt" inputmode="numeric" required placeholder="0"></div>
      <div class="field"><label for="eTitle">Не үшін</label>
        <input class="input" id="eTitle" maxlength="48" placeholder="Мысалы: Magnum-нан азық"></div>
      ${catSelect("eCat", CAT_OUT, "Азық-түлік")}
      <div class="field"><label for="ePayer">Кім төледі</label>
        <select class="input" id="ePayer">${ms.map(m => `<option value="${esc(m.id)}" ${m.id === local.profileId ? "selected" : ""}>${esc(m.name)}</option>`).join("")}</select></div>
      <div class="field"><label>Бөлу тәсілі</label>
        <div class="seg" id="eMode">
          <button type="button" data-mode="equal" aria-pressed="true">Тең бөлу</button>
          <button type="button" data-mode="exact" aria-pressed="false">Нақты сома</button>
        </div></div>
      <div class="field"><label>Кімге бөлінеді</label>
        <div class="chips" id="eWho">${ms.map(m => `<button type="button" class="chip" data-id="${esc(m.id)}" aria-pressed="true">${avatar(m, "sm")}${esc(m.name)}</button>`).join("")}</div>
      </div>
      <div class="field hidden" id="eExactWrap"><label>Әркімнің үлесі</label>
        <div style="display:flex; flex-direction:column; gap:8px" id="eExact">${ms.map(m => `
          <div class="split-row" data-id="${esc(m.id)}">${avatar(m, "sm")}<span style="font-size:13.5px">${esc(m.name)}</span>
            <input class="input" inputmode="numeric" data-exact="${esc(m.id)}" placeholder="0"></div>`).join("")}</div>
        <p class="muted num" id="eExactSum" style="font-size:12px; margin-top:6px"></p>
      </div>
      ${fieldDate("eDate", todayISO())}
      <div class="actions"><button class="btn ghost" type="button" data-act="close">Болмайды</button>
        <button class="btn primary" type="submit">Сақтау</button></div>
    </form>`, (s) => {
    let mode = "equal";
    const wrap = $("#eExactWrap", s), whoBox = $("#eWho", s);
    const sumLine = $("#eExactSum", s);
    const refreshSum = () => {
      const total = clampInt($("#eAmt", s).value);
      const sum = $$("[data-exact]", s).reduce((a, i) => a + clampInt(i.value), 0);
      const diff = total - sum;
      sumLine.textContent = diff === 0 ? `Дәл келді: ${money(sum)}` :
        diff > 0 ? `${money(diff)} бөлінбей қалды` : `${money(-diff)} артық`;
      sumLine.style.color = diff === 0 ? "var(--pos)" : "var(--ink-3)";
    };
    $$("#eMode button", s).forEach(b => b.addEventListener("click", () => {
      mode = b.dataset.mode;
      $$("#eMode button", s).forEach(x => x.setAttribute("aria-pressed", String(x === b)));
      wrap.classList.toggle("hidden", mode !== "exact");
      whoBox.parentElement.classList.toggle("hidden", mode === "exact");
      refreshSum();
    }));
    whoBox.addEventListener("click", (ev) => {
      const c = ev.target.closest(".chip"); if (!c) return;
      c.setAttribute("aria-pressed", c.getAttribute("aria-pressed") === "true" ? "false" : "true");
    });
    $("#eAmt", s).addEventListener("input", refreshSum);
    $("#eExact", s).addEventListener("input", refreshSum);
    $("#fExp", s).addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const amount = clampInt($("#eAmt", s).value);
      if (amount <= 0) return toast("Соманы енгіз");
      const data = {
        title: $("#eTitle", s).value.trim(), amount,
        category: $("#eCat", s).value, payerId: $("#ePayer", s).value,
        date: $("#eDate", s).value || todayISO(), mode,
        createdAt: Date.now(), createdBy: local.profileId,
        participants: [], exact: {},
      };
      if (mode === "exact"){
        let sum = 0;
        $$("[data-exact]", s).forEach(i => { const v = clampInt(i.value); if (v > 0){ data.exact[i.dataset.exact] = v; sum += v; } });
        if (sum !== amount) return toast(`Үлестердің қосындысы ${money(sum)} — сомаға тең емес`);
      } else {
        data.participants = $$("#eWho .chip", s).filter(c => c.getAttribute("aria-pressed") === "true").map(c => c.dataset.id);
        if (!data.participants.length) return toast("Кемінде бір адам таңда");
      }
      const btn = ev.target.querySelector('button[type="submit"]');
      btn.disabled = true; btn.textContent = "Сақталуда…";
      try { await state.db.collection(`houses/${local.houseCode}/expenses`).add(data); closeSheet(); }
      catch (err){ btn.disabled = false; btn.textContent = "Сақтау"; toast(dbMsg(err)); }
    });
    refreshSum();
  });
}

/* ── settle sheet ── */
function sheetSettle(pre = {}){
  const ms = state.members;
  openSheet(`<h3>Қарызды жабу</h3>
    <form class="form" id="fSet">
      <div class="field"><label for="sFrom">Кім берді</label>
        <select class="input" id="sFrom">${ms.map(m => `<option value="${esc(m.id)}" ${m.id === (pre.from || local.profileId) ? "selected" : ""}>${esc(m.name)}</option>`).join("")}</select></div>
      <div class="field"><label for="sTo">Кімге</label>
        <select class="input" id="sTo">${ms.map(m => `<option value="${esc(m.id)}" ${m.id === pre.to ? "selected" : ""}>${esc(m.name)}</option>`).join("")}</select></div>
      <div class="field"><label for="sAmt">Сома</label>
        <input class="input money" id="sAmt" inputmode="numeric" required value="${pre.amount ? esc(pre.amount) : ""}" placeholder="0"></div>
      ${fieldDate("sDate", todayISO())}
      <div class="actions"><button class="btn ghost" type="button" data-act="close">Болмайды</button>
        <button class="btn primary" type="submit">Жабылды деп белгілеу</button></div>
    </form>`, (s) => {
    $("#fSet", s).addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const fromId = $("#sFrom", s).value, toId = $("#sTo", s).value, amount = clampInt($("#sAmt", s).value);
      if (fromId === toId) return toast("Екі жақ бірдей болмауы керек");
      if (amount <= 0) return toast("Соманы енгіз");
      const btn = ev.target.querySelector('button[type="submit"]');
      btn.disabled = true; btn.textContent = "Сақталуда…";
      try {
        await state.db.collection(`houses/${local.houseCode}/settlements`)
          .add({ fromId, toId, amount, date: $("#sDate", s).value || todayISO(), createdAt: Date.now(), createdBy: local.profileId });
        closeSheet(); toast("Жабылды");
      } catch (err){ btn.disabled = false; btn.textContent = "Жабылды деп белгілеу"; toast(dbMsg(err)); }
    });
  });
}

/* ── solo sheet ── */
function sheetSolo(){
  openSheet(`<h3>Жеке жазба</h3>
    <form class="form" id="fSolo">
      <div class="field"><label>Түрі</label>
        <div class="seg" id="tType">
          <button type="button" data-t="out" aria-pressed="true">Шығын</button>
          <button type="button" data-t="in"  aria-pressed="false">Табыс</button>
        </div></div>
      <div class="field"><label for="tAmt">Сома</label>
        <input class="input money" id="tAmt" inputmode="numeric" required placeholder="0"></div>
      <div class="field"><label for="tTitle">Не үшін</label>
        <input class="input" id="tTitle" maxlength="48" placeholder="Мысалы: Түскі ас"></div>
      <div id="tCatWrap">${catSelect("tCat", CAT_OUT, "Азық-түлік")}</div>
      ${fieldDate("tDate", todayISO())}
      <div class="actions"><button class="btn ghost" type="button" data-act="close">Болмайды</button>
        <button class="btn primary" type="submit">Сақтау</button></div>
    </form>`, (s) => {
    let type = "out";
    $$("#tType button", s).forEach(b => b.addEventListener("click", () => {
      type = b.dataset.t;
      $$("#tType button", s).forEach(x => x.setAttribute("aria-pressed", String(x === b)));
      $("#tCatWrap", s).innerHTML = catSelect("tCat", type === "in" ? CAT_IN : CAT_OUT, type === "in" ? "Стипендия" : "Азық-түлік");
    }));
    $("#fSolo", s).addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const amount = clampInt($("#tAmt", s).value);
      if (amount <= 0) return toast("Соманы енгіз");
      const btn = ev.target.querySelector('button[type="submit"]');
      btn.disabled = true; btn.textContent = "Сақталуда…";
      const date = $("#tDate", s).value || todayISO();
      try {
        await addSoloTxn({ id: randId(6), type, amount, title: $("#tTitle", s).value.trim(), category: $("#tCat", s).value, date, createdAt: Date.now() });
        if (ymOf(date) !== state.ym){ state.ym = ymOf(date); watchSolo(); }
        closeSheet(); render();
      } catch (err){ btn.disabled = false; btn.textContent = "Сақтау"; toast(dbMsg(err)); }
    });
  });
}

/* ── detail sheets ── */
function sheetExpenseDetail(id){
  const e = state.expenses.find(x => x.id === id); if (!e) return;
  const shares = shareMap(e);
  const payer = memberById(e.payerId);
  openSheet(`<h3>${esc(e.title || e.category || "Шығын")}</h3>
    <div class="form">
      <div class="hero tone-flat" style="box-shadow:none">
        <span class="eyebrow">${esc(e.category || "")} · ${esc(dayLabel(e.date || todayISO()))}</span>
        <span class="big" style="font-size:30px">${money(e.amount)}</span>
        <p class="cap">${esc(payer.name)} төледі</p>
      </div>
      <div class="list">${Object.entries(shares).map(([mid, v]) => {
        const m = memberById(mid);
        return `<div class="rowlink" style="cursor:default">${avatar(m, "sm")}<span>${esc(m.name)}</span><span class="r">${money(v)}</span></div>`;
      }).join("")}</div>
      <div class="actions"><button class="btn ghost" type="button" data-act="close">Жабу</button>
        <button class="btn danger" data-act="delExpense" data-id="${esc(e.id)}">Жою</button></div>
    </div>`);
}
function sheetSettleDetail(id){
  const s0 = state.settlements.find(x => x.id === id); if (!s0) return;
  const f = memberById(s0.fromId), t = memberById(s0.toId);
  openSheet(`<h3>Қарызды жабу</h3>
    <div class="form">
      <div class="hero tone-flat" style="box-shadow:none">
        <span class="eyebrow">${esc(dayLabel(s0.date || todayISO()))}</span>
        <span class="big" style="font-size:30px">${money(s0.amount)}</span>
        <p class="cap">${esc(f.name)} → ${esc(t.name)}</p>
      </div>
      <div class="actions"><button class="btn ghost" type="button" data-act="close">Жабу</button>
        <button class="btn danger" data-act="delSettle" data-id="${esc(s0.id)}">Жою</button></div>
    </div>`);
}
function sheetSoloDetail(id){
  const t = soloTxns().find(x => x.id === id); if (!t) return;
  openSheet(`<h3>${esc(t.title || t.category || "Жазба")}</h3>
    <div class="form">
      <div class="hero ${t.type === "in" ? "tone-pos" : "tone-flat"}" style="box-shadow:none">
        <span class="eyebrow">${esc(t.category || "")} · ${esc(dayLabel(t.date || todayISO()))}</span>
        <span class="big" style="font-size:30px">${t.type === "in" ? "+" : ""}${money(t.amount)}</span>
      </div>
      <div class="actions"><button class="btn ghost" type="button" data-act="close">Жабу</button>
        <button class="btn danger" data-act="delSolo" data-id="${esc(t.id)}">Жою</button></div>
    </div>`);
}
function sheetRestoreKey(){
  openSheet(`<h3>Басқа кілтпен кіру</h3>
    <form class="form" id="fKey">
      <p class="muted" style="font-size:13.5px">Бұрынғы құрылғыдағы кілтті қойсаң, сол жеке есеп ашылады. Қазіргі кілтің ауысады.</p>
      <div class="field"><label for="kVal">Кілт</label>
        <input class="input num" id="kVal" required placeholder="a1b2c3…" style="font-size:14px"></div>
      <div class="actions"><button class="btn ghost" type="button" data-act="close">Болмайды</button>
        <button class="btn primary" type="submit">Ауыстыру</button></div>
    </form>`, (s) => {
    $("#fKey", s).addEventListener("submit", (ev) => {
      ev.preventDefault();
      const v = $("#kVal", s).value.trim().toLowerCase();
      if (!/^[a-z0-9]{6,64}$/.test(v)) return toast("Кілт тек әріп пен саннан тұрады");
      local.soloKey = v; saveLocal(); watchSolo(); closeSheet(); render(); toast("Кілт ауысты");
    });
  });
}

/* ═══════════ actions ═══════════ */
function dbMsg(err){
  const c = err && err.code;
  if (c === "quota_exceeded")   return "Орын толды — ескі жазбаларды жойып көр";
  if (c === "resource_exhausted") return "Тым жиі сұраныс — сәл кідір";
  if (c === "invalid_argument") return "Деректе қате бар";
  if (c === "revoked" || c === "not_granted") return "Ортақ базаға қолжетім жоқ";
  return "Сақталмады — қайта көр";
}
function requireDb(){
  if (!state.db){ toast("Ортақ база қосылмаған"); return false; }
  return true;
}
async function createHouse(name, currency){
  if (!requireDb()) throw new Error("nodb");
  let code = null;
  for (let i = 0; i < 6 && !code; i++){
    const c = randCode();
    const snap = await state.db.doc(`houses/${c}`).get();
    if (!snap.exists) code = c;
  }
  if (!code) throw new Error("code");
  await state.db.doc(`houses/${code}`).set({
    name: name || "Біздің үй", currency, createdAt: Date.now(), createdBy: local.profileId,
  });
  await state.db.doc(`houses/${code}/members/${local.profileId}`).set({
    name: local.name, colorIdx: local.colorIdx || 0, joinedAt: Date.now(),
  });
  local.houseCode = code; local.currency = currency; state.currency = currency; saveLocal();
  watchHouse(code); render();
  toast(`Үй құрылды · код ${code}`);
}
async function joinHouse(code){
  if (!requireDb()) throw new Error("nodb");
  if (!/^[A-Z0-9]{4,8}$/.test(code)){ const e = new Error("bad"); e.userMessage = "Код 6 таңбадан тұрады"; throw e; }
  const snap = await state.db.doc(`houses/${code}`).get();
  if (!snap.exists){ const e = new Error("nf"); e.userMessage = "Мұндай код табылмады"; throw e; }
  let idx = local.colorIdx;
  if (idx == null){
    const existing = await state.db.collection(`houses/${code}/members`).get();
    idx = existing.size % MEMBER_COLORS;
  }
  await state.db.doc(`houses/${code}/members/${local.profileId}`).set({
    name: local.name, colorIdx: idx, joinedAt: Date.now(),
  });
  local.houseCode = code; local.colorIdx = idx; saveLocal();
  watchHouse(code); render();
  toast("Үйге қосылдың");
}
async function leaveHouse(){
  const code = local.houseCode;
  if (code && state.db){
    try { await state.db.doc(`houses/${code}/members/${local.profileId}`).delete(); } catch {}
  }
  delete local.houseCode; saveLocal();
  dropSubs("house");
  state.house = null; state.members = []; state.expenses = []; state.settlements = [];
  render(); toast("Үйден шықтың");
}
async function syncMember(patch){
  if (!state.db || !local.houseCode || !state.house) return;
  const ref = state.db.doc(`houses/${local.houseCode}/members/${local.profileId}`);
  const snap = await ref.get();
  const base = snap.exists ? snap.data() : { joinedAt: Date.now() };
  await ref.set({ ...base, ...patch });
}
/* ═══════════ демо дерек ═══════════ */
function shiftDays(n){
  const d = new Date(); d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function firstOfMonth(offset){
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + offset);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-01`;
}
async function seedDemo(){
  if (!requireDb()) return;
  const db = state.db;
  const me = local.profileId;
  const myName = local.name || "Мен";
  let code = null;
  for (let i = 0; i < 6 && !code; i++){
    const c = randCode();
    const snap = await db.doc(`houses/${c}`).get();
    if (!snap.exists) code = c;
  }
  if (!code) return toast("Код табылмады — қайта көр");

  await db.doc(`houses/${code}`).set({
    name: "Абай 12 — 40-пәтер", currency: state.currency,
    createdAt: Date.now(), createdBy: me, demo: true,
  });
  const people = [
    [me, myName, local.colorIdx || 0],
    ["m_dias", "Диас", 1],
    ["m_zhanel", "Жәнел", 2],
    ["m_nurbek", "Нұрбек", 3],
  ];
  for (let i = 0; i < people.length; i++){
    const [id, name, colorIdx] = people[i];
    await db.doc(`houses/${code}/members/${id}`).set({ name, colorIdx, joinedAt: Date.now() + i });
  }
  const all = people.map(p => p[0]);
  const trio = [me, "m_dias", "m_zhanel"];
  const expenses = [
    { title: "Пәтер ақысы",            amount: 180000, category: "Пәтер ақысы",  payerId: me,          date: firstOfMonth(0),  participants: all },
    { title: "Magnum — апталық азық",  amount: 24600,  category: "Азық-түлік",   payerId: "m_dias",    date: shiftDays(-5),    participants: all },
    { title: "Жарық, су, газ",         amount: 12800,  category: "Коммуналдық",  payerId: "m_zhanel",  date: shiftDays(-4),    participants: all },
    { title: "Интернет",               amount: 9000,   category: "Интернет",     payerId: "m_nurbek",  date: shiftDays(-3),    participants: all },
    { title: "Small — азық",           amount: 16200,  category: "Азық-түлік",   payerId: me,          date: shiftDays(-2),    participants: all },
    { title: "Тазалық құралдары",      amount: 7400,   category: "Тұрмыстық",    payerId: "m_dias",    date: shiftDays(-2),    participants: all },
    { title: "Кино — үшеуміз",         amount: 8400,   category: "Ойын-сауық",   payerId: "m_zhanel",  date: shiftDays(-1),    participants: trio },
    { title: "Такси — базарға",        amount: 3400,   category: "Көлік",        payerId: me,          date: shiftDays(-1),    participants: [me, "m_dias"] },
    { title: "Дәріхана",               amount: 2900,   category: "Дәріхана",     payerId: "m_nurbek",  date: shiftDays(0),     participants: all },
    /* нақты сомамен бөлінген мысал: сүт пен ет әркімге әртүрлі */
    { title: "Ет базары",              amount: 21000,  category: "Азық-түлік",   payerId: "m_dias",    date: shiftDays(0),
      mode: "exact", exact: { [me]: 7000, m_dias: 6000, m_zhanel: 4000, m_nurbek: 4000 } },
    { title: "Тамыз пәтер ақысы",      amount: 180000, category: "Пәтер ақысы",  payerId: "m_zhanel",  date: firstOfMonth(-1), participants: all },
    { title: "Тамыз — коммуналдық",    amount: 14100,  category: "Коммуналдық",  payerId: me,          date: firstOfMonth(-1), participants: all },
  ];
  for (let i = 0; i < expenses.length; i++){
    const e = expenses[i];
    await db.collection(`houses/${code}/expenses`).add({
      title: e.title, amount: e.amount, category: e.category, payerId: e.payerId, date: e.date,
      mode: e.mode || "equal", participants: e.participants || [], exact: e.exact || {},
      createdAt: Date.now() + i, createdBy: me,
    });
  }
  await db.collection(`houses/${code}/settlements`).add({
    fromId: "m_nurbek", toId: me, amount: 20000, date: shiftDays(-1),
    createdAt: Date.now() + 100, createdBy: me,
  });

  /* жеке журнал — ағымдағы ай */
  const ym = ymOf(todayISO());
  const solo = [
    { type: "in",  amount: 86000, title: "Стипендия",          category: "Стипендия",   date: firstOfMonth(0) },
    { type: "in",  amount: 40000, title: "Ата-анадан",         category: "Ата-анадан",  date: shiftDays(-6) },
    { type: "out", amount: 45000, title: "Пәтердегі үлесім",   category: "Пәтер ақысы", date: firstOfMonth(0) },
    { type: "out", amount: 18400, title: "Азық-түлік",         category: "Азық-түлік",  date: shiftDays(-5) },
    { type: "out", amount: 6200,  title: "Коммуналдық",        category: "Коммуналдық", date: shiftDays(-4) },
    { type: "out", amount: 4500,  title: "Автобус картасы",    category: "Көлік",       date: shiftDays(-3) },
    { type: "out", amount: 3800,  title: "Оқулық",             category: "Оқу",         date: shiftDays(-2) },
    { type: "out", amount: 2100,  title: "Дәрі",               category: "Дәріхана",    date: shiftDays(-1) },
  ].map((t, i) => ({ ...t, id: randId(6), createdAt: Date.now() + i }));
  await saveSoloMonth(ym, solo);

  local.houseCode = code;
  if (!local.name) local.name = myName;
  saveLocal();
  state.ym = ym; state.sharedYm = ym;
  watchHouse(code); watchSolo();
  local.tab = "shared";
  render();
  toast("Демо дерек қосылды");
}

function inviteText(){
  return `Қаржы — «${(state.house && state.house.name) || "үй"}» есебіне қосыл.\nСілтеме: ${location.href}\nҚосылу коды: ${local.houseCode}`;
}

/* ═══════════ theme ═══════════ */
function applyTheme(){
  const t = local.theme || "auto";
  if (t === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
}

/* ═══════════ events ═══════════ */
document.addEventListener("click", async (ev) => {
  const tabBtn = ev.target.closest("#tabs button");
  if (tabBtn){ local.tab = tabBtn.dataset.tab; saveLocal(); render(); return; }
  if (ev.target.closest("#fab")){
    if (local.tab === "personal") sheetSolo();
    else if (requireDb()) sheetExpense();
    return;
  }
  if (ev.target.id === "backdrop"){ closeSheet(); return; }

  const el = ev.target.closest("[data-act]");
  if (!el) return;
  const act = el.dataset.act;

  if (act === "close"){ closeSheet(); return; }
  if (act === "createHouse"){ if (requireDb()) sheetCreateHouse(); return; }
  if (act === "joinHouse"){ if (requireDb()) sheetJoinHouse(); return; }
  if (act === "invite"){ copyText(inviteText(), "Шақыру көшірілді"); return; }
  if (act === "copyKey"){ copyText(local.soloKey, "Кілт көшірілді"); return; }
  if (act === "restoreKey"){ sheetRestoreKey(); return; }
  if (act === "settle"){ sheetSettle({ from: el.dataset.from, to: el.dataset.to, amount: el.dataset.amount }); return; }
  if (act === "openExpense"){ sheetExpenseDetail(el.dataset.id); return; }
  if (act === "openSettle"){ sheetSettleDetail(el.dataset.id); return; }
  if (act === "openSolo"){ sheetSoloDetail(el.dataset.id); return; }

  if (act === "sharedPrev"){ state.sharedYm = addMonths(state.sharedYm, -1); render(); return; }
  if (act === "sharedNext"){ state.sharedYm = addMonths(state.sharedYm, 1); render(); return; }
  if (act === "soloPrev"){ state.ym = addMonths(state.ym, -1); watchSolo(); render(); return; }
  if (act === "soloNext"){ state.ym = addMonths(state.ym, 1); watchSolo(); render(); return; }

  if (act === "theme"){ local.theme = el.dataset.v; saveLocal(); applyTheme(); render(); return; }

  if (act === "exportData"){
    const payload = JSON.stringify({ app: "qarzhy", v: 1, exportedAt: new Date().toISOString(),
      profile: local, store: JSON.parse(OQStore.exportLocal()) }, null, 2);
    const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url; a.download = `qarzhy-${todayISO()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("Файл жүктелді");
    return;
  }
  if (act === "importData"){ $("#importFile").click(); return; }
  if (act === "seedDemo"){
    if (local.houseCode && state.house && el.dataset.confirm !== "1"){
      el.dataset.confirm = "1"; el.textContent = "Жаңа демо үй құрылады — жалғастырамыз ба?"; return;
    }
    el.disabled = true; el.textContent = "Қосылуда…";
    try { await seedDemo(); } catch (e){ toast(dbMsg(e)); el.disabled = false; el.textContent = "Демо дерек қосу"; }
    return;
  }
  if (act === "wipeData"){
    if (el.dataset.confirm !== "1"){ el.dataset.confirm = "1"; el.textContent = "Шынымен бәрін өшіресің бе?"; return; }
    OQStore.wipeLocal();
    try { localStorage.removeItem(LS_KEY); } catch {}
    location.reload();
    return;
  }

  if (act === "setColor"){
    local.colorIdx = Number(el.dataset.i) || 0; saveLocal();
    try { await syncMember({ colorIdx: local.colorIdx }); } catch (e){ toast(dbMsg(e)); }
    render(); return;
  }
  if (act === "saveProfile"){
    const name = ($("#setName").value || "").trim();
    const cur  = $("#setCur").value;
    if (!name) return toast("Атыңды жаз");
    local.name = name; local.currency = cur; state.currency = cur; saveLocal();
    try {
      await syncMember({ name, colorIdx: local.colorIdx || 0 });
      if (state.db && local.houseCode && state.house) await state.db.doc(`houses/${local.houseCode}`).update({ currency: cur });
    } catch (e){ toast(dbMsg(e)); }
    render(); toast("Сақталды"); return;
  }
  if (act === "saveHouse"){
    const name = ($("#setHouse").value || "").trim();
    if (!name) return toast("Үйдің атын жаз");
    try { await state.db.doc(`houses/${local.houseCode}`).update({ name }); toast("Сақталды"); }
    catch (e){ toast(dbMsg(e)); }
    return;
  }
  if (act === "leaveHouse"){
    if (el.dataset.confirm !== "1"){ el.dataset.confirm = "1"; el.textContent = "Шынымен шығасың ба?"; return; }
    await leaveHouse(); return;
  }
  if (act === "delExpense"){
    try { await state.db.doc(`houses/${local.houseCode}/expenses/${el.dataset.id}`).delete(); closeSheet(); toast("Жойылды"); }
    catch (e){ toast(dbMsg(e)); }
    return;
  }
  if (act === "delSettle"){
    try { await state.db.doc(`houses/${local.houseCode}/settlements/${el.dataset.id}`).delete(); closeSheet(); toast("Жойылды"); }
    catch (e){ toast(dbMsg(e)); }
    return;
  }
  if (act === "delSolo"){
    try { await removeSoloTxn(el.dataset.id); closeSheet(); toast("Жойылды"); }
    catch (e){ toast(dbMsg(e)); }
    return;
  }
});

document.addEventListener("submit", (ev) => {
  if (ev.target.id !== "onboardForm") return;
  ev.preventDefault();
  const v = ($("#obName").value || "").trim();
  if (!v) return;
  local.name = v; saveLocal(); render();
});
document.addEventListener("change", (ev) => {
  if (ev.target.id !== "importFile") return;
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(String(reader.result));
      /* "ortaq-qalta" — атау ауысқанға дейінгі файлдар */
      if (!parsed || (parsed.app !== "qarzhy" && parsed.app !== "ortaq-qalta")) throw new Error("bad");
      OQStore.importLocal(JSON.stringify(parsed.store || {}));
      if (parsed.profile && typeof parsed.profile === "object"){
        localStorage.setItem(LS_KEY, JSON.stringify(parsed.profile));
      }
      location.reload();
    } catch { toast("Файл жарамсыз"); }
  };
  reader.readAsText(file);
});
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") closeSheet(); });

/* ═══════════ init ═══════════ */
if (local.currency) state.currency = local.currency;
applyTheme();
render();
connectDb();

})();
