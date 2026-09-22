/*
 * Қаржы — дерек қоймасы.
 *
 * Бір ғана API, екі қорек көзі:
 *   • claude  — артефакт ретінде ашылғанда, нақты уақыттағы ортақ база;
 *   • local   — браузердің localStorage-і (Vercel, Chrome, file://).
 *
 * API әдейі Firestore-ға ұқсас жасалған: кейін нағыз бұлт қоймасын
 * қосқанда app.js-ті түртудің қажеті болмайды.
 *
 *   const { kind, db } = await OQStore.create();
 *   db.doc("houses/ABC123").onSnapshot(snap => …)
 *   db.collection("houses/ABC123/expenses").orderBy("createdAt","desc").limit(50)
 */
window.OQStore = (() => {
  "use strict";

  /* Кілт әдейі ескі атауда қалды: оны ауыстырсақ, бұрын сақталған дерек жоғалады. */
  const KEY = "ortaq-qalta.store.v1";
  const listeners = [];
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const err = (code, message) => ({ code, message });

  /* ── raw persistence ───────────────────────────────────────────── */
  function readAll(){
    try { const v = JSON.parse(localStorage.getItem(KEY) || "{}"); return v && typeof v === "object" ? v : {}; }
    catch { return {}; }
  }
  function writeAll(all){
    try { localStorage.setItem(KEY, JSON.stringify(all)); }
    catch (e){
      if (e && /quota/i.test(e.name || e.message || "")) throw err("quota_exceeded", "Браузердің орны толды");
      throw err("unavailable", "Сақтау мүмкін болмады");
    }
  }
  function notify(){ listeners.slice().forEach(l => { try { l.fire(); } catch (e){ console.error(e); } }); }
  /* басқа қойындыдағы өзгеріс */
  window.addEventListener("storage", (e) => { if (e.key === KEY) notify(); });

  /* ── path helpers ──────────────────────────────────────────────── */
  const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
  function checkPath(path, wantDoc){
    const parts = String(path).split("/");
    if (parts.length > 16) throw new TypeError(`Жол тым терең: ${path}`);
    for (const p of parts){
      if (!SEG.test(p) || p === "." || p === "..") throw new TypeError(`Жарамсыз сегмент "${p}" (${path})`);
    }
    const even = parts.length % 2 === 0;
    if (wantDoc && !even) throw new TypeError(`Құжат жолы жұп сегменттен тұруы керек: ${path}`);
    if (!wantDoc && even) throw new TypeError(`Коллекция жолы тақ сегменттен тұруы керек: ${path}`);
    return parts;
  }

  /* ── snapshots ─────────────────────────────────────────────────── */
  const META = { fromCache: false, hasPendingWrites: false };
  function docSnap(all, path){
    const has = Object.prototype.hasOwnProperty.call(all, path);
    return {
      id: path.split("/").pop(),
      exists: has,
      data: () => has ? clone(all[path]) : undefined,
      metadata: META,
    };
  }

  /* ── query ─────────────────────────────────────────────────────── */
  const OPS = {
    "==": (a, b) => a === b,   "!=": (a, b) => a !== b,
    "<":  (a, b) => a < b,     "<=": (a, b) => a <= b,
    ">":  (a, b) => a > b,     ">=": (a, b) => a >= b,
    "in": (a, b) => Array.isArray(b) && b.includes(a),
    "not-in": (a, b) => Array.isArray(b) && !b.includes(a),
    "array-contains": (a, b) => Array.isArray(a) && a.includes(b),
  };
  function runQuery(col, ops){
    const all = readAll();
    let rows = [];
    for (const path of Object.keys(all)){
      const parts = path.split("/");
      if (parts.slice(0, -1).join("/") !== col) continue;
      rows.push({ path, id: parts[parts.length - 1], v: all[path] });
    }
    for (const [field, op, value] of ops.where || []){
      const fn = OPS[op];
      if (!fn) throw err("invalid_argument", `Белгісіз оператор: ${op}`);
      rows = rows.filter(r => fn(r.v ? r.v[field] : undefined, value));
    }
    if (ops.order){
      const [f, dir] = ops.order;
      const k = dir === "desc" ? -1 : 1;
      rows.sort((a, b) => {
        const x = a.v ? a.v[f] : undefined, y = b.v ? b.v[f] : undefined;
        if (x === undefined && y === undefined) return 0;
        if (x === undefined) return 1;          /* өрісі жоқтар соңында */
        if (y === undefined) return -1;
        return (x > y ? 1 : x < y ? -1 : 0) * k;
      });
    } else {
      rows.sort((a, b) => a.id.localeCompare(b.id));
    }
    if (ops.limit) rows = rows.slice(0, ops.limit);
    const docs = rows.map(r => docSnap(all, r.path));
    return { docs, size: docs.length, empty: docs.length === 0, docChanges: () => [], metadata: META };
  }

  function makeQuery(col, ops){
    return {
      path: col,
      where: (field, op, value) => makeQuery(col, { ...ops, where: (ops.where || []).concat([[field, op, value]]) }),
      orderBy: (field, dir) => makeQuery(col, { ...ops, order: [field, dir || "asc"] }),
      limit: (n) => makeQuery(col, { ...ops, limit: n }),
      get: async () => runQuery(col, ops),
      onSnapshot: (next, onError) => subscribe(() => runQuery(col, ops), next, onError),
      doc: (id) => makeDoc(col + "/" + (id || newId())),
      add: async (data) => { const ref = makeDoc(col + "/" + newId()); await ref.set(data); return ref; },
    };
  }

  function subscribe(read, next, onError){
    const l = { fire: () => { try { next(read()); } catch (e){ if (onError) onError(e); } } };
    listeners.push(l);
    setTimeout(() => l.fire(), 0);
    return () => { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); };
  }
  function newId(){
    const a = new Uint8Array(8);
    crypto.getRandomValues(a);
    return Array.from(a, b => b.toString(16).padStart(2, "0")).join("");
  }

  function makeDoc(path){
    checkPath(path, true);
    return {
      id: path.split("/").pop(),
      path,
      get: async () => docSnap(readAll(), path),
      set: async (data) => {
        if (!data || typeof data !== "object" || Array.isArray(data)) throw err("invalid_argument", "Құжат объект болуы керек");
        const all = readAll(); all[path] = clone(data); writeAll(all); notify();
      },
      update: async (data) => {
        const all = readAll();
        if (!Object.prototype.hasOwnProperty.call(all, path)) throw err("invalid_argument", "Мұндай құжат жоқ");
        all[path] = { ...all[path], ...clone(data) }; writeAll(all); notify();
      },
      delete: async () => { const all = readAll(); delete all[path]; writeAll(all); notify(); },
      acquire: async () => ({ acquired: true }),
      collection: (sub) => makeQuery(path + "/" + sub, {}),
      onSnapshot: (next, onError) => subscribe(() => docSnap(readAll(), path), next, onError),
    };
  }

  const localDb = {
    doc: (path) => makeDoc(path),
    collection: (path) => { checkPath(path, false); return makeQuery(path, {}); },
  };

  /* барлық дерегін өшіру — Баптаудағы «Барлығын тазалау» үшін */
  function wipeLocal(){ try { localStorage.removeItem(KEY); } catch {} notify(); }
  function exportLocal(){ return JSON.stringify(readAll(), null, 2); }
  function importLocal(json){
    const obj = JSON.parse(json);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("bad");
    writeAll(obj); notify();
  }

  /* ── Firestore: Vercel мен Chrome үшін нағыз синхрон ───────────── */
  const FB = "12.19.0";
  const FB_URL = (m) => "https://www.gstatic.com/firebasejs/" + FB + "/firebase-" + m + ".js";

  /* Firestore undefined мәнді қабылдамайды */
  function strip(v){
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === "object"){
      const out = {};
      for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = strip(x);
      return out;
    }
    return v;
  }
  const FS_CODES = {
    "permission-denied": "invalid_argument",
    "not-found": "invalid_argument",
    "invalid-argument": "invalid_argument",
    "failed-precondition": "invalid_argument",
    "resource-exhausted": "resource_exhausted",
    "unauthenticated": "not_granted",
    "unavailable": "unavailable",
  };
  const fsErr = (e) => err(FS_CODES[e && e.code] || "unavailable", (e && e.message) || "Firestore қатесі");
  const meta = (s) => ({
    fromCache: !!(s && s.metadata && s.metadata.fromCache),
    hasPendingWrites: !!(s && s.metadata && s.metadata.hasPendingWrites),
  });

  function firestoreDb(fs, M){
    const wrapDoc = (snap) => ({
      id: snap.id,
      exists: typeof snap.exists === "function" ? snap.exists() : !!snap.exists,
      data: () => snap.data(),
      metadata: meta(snap),
    });
    const wrapQuery = (snap) => ({
      docs: snap.docs.map(wrapDoc),
      size: snap.size,
      empty: snap.empty,
      docChanges: () => snap.docChanges().map(c => ({
        type: c.type, doc: wrapDoc(c.doc), oldIndex: c.oldIndex, newIndex: c.newIndex,
      })),
      metadata: meta(snap),
    });

    function makeQ(col, ops){
      const built = () => {
        const parts = [];
        for (const [f, op, v] of ops.where || []) parts.push(M.where(f, op, v));
        if (ops.order) parts.push(M.orderBy(ops.order[0], ops.order[1]));
        if (ops.limit) parts.push(M.limit(ops.limit));
        return M.query(M.collection(fs, col), ...parts);
      };
      return {
        path: col,
        where: (f, op, v) => makeQ(col, { ...ops, where: (ops.where || []).concat([[f, op, v]]) }),
        orderBy: (f, dir) => makeQ(col, { ...ops, order: [f, dir || "asc"] }),
        limit: (n) => makeQ(col, { ...ops, limit: n }),
        get: async () => { try { return wrapQuery(await M.getDocs(built())); } catch (e){ throw fsErr(e); } },
        onSnapshot: (next, onError) => M.onSnapshot(built(),
          (s) => next(wrapQuery(s)),
          (e) => { if (onError) onError(fsErr(e)); else console.error(e); }),
        doc: (id) => makeD(col + "/" + (id || M.doc(M.collection(fs, col)).id)),
        add: async (data) => {
          try { const r = await M.addDoc(M.collection(fs, col), strip(data)); return makeD(col + "/" + r.id); }
          catch (e){ throw fsErr(e); }
        },
      };
    }
    function makeD(path){
      checkPath(path, true);
      const ref = () => M.doc(fs, path);
      return {
        id: path.split("/").pop(),
        path,
        get: async () => { try { return wrapDoc(await M.getDoc(ref())); } catch (e){ throw fsErr(e); } },
        set: async (data) => { try { await M.setDoc(ref(), strip(data)); } catch (e){ throw fsErr(e); } },
        update: async (data) => { try { await M.updateDoc(ref(), strip(data)); } catch (e){ throw fsErr(e); } },
        delete: async () => { try { await M.deleteDoc(ref()); } catch (e){ throw fsErr(e); } },
        acquire: async () => ({ acquired: true }),
        collection: (sub) => makeQ(path + "/" + sub, {}),
        onSnapshot: (next, onError) => M.onSnapshot(ref(),
          (s) => next(wrapDoc(s)),
          (e) => { if (onError) onError(fsErr(e)); else console.error(e); }),
      };
    }
    return { doc: makeD, collection: (p) => { checkPath(p, false); return makeQ(p, {}); } };
  }

  function hasFirebaseConfig(){
    const c = window.OQ_FIREBASE_CONFIG;
    return !!(c && typeof c === "object" && c.apiKey && c.projectId && !/ОСЫ_ЖЕРГЕ/.test(c.apiKey));
  }
  async function connectFirestore(){
    const [appMod, authMod, fsMod] = await Promise.all([
      import(FB_URL("app")), import(FB_URL("auth")), import(FB_URL("firestore")),
    ]);
    const app = appMod.initializeApp(window.OQ_FIREBASE_CONFIG);
    /* аноним кіру: логин экраны жоқ, бірақ ережелерде auth талап етіледі */
    await authMod.signInAnonymously(authMod.getAuth(app));
    return firestoreDb(fsMod.getFirestore(app), fsMod);
  }

  async function create(){
    if (window.claude && typeof window.claude.use === "function"){
      try {
        const db = await window.claude.use("db");
        if (db) return { kind: "claude", db };
      } catch { /* артефакт емес — локальға түсеміз */ }
    }
    if (hasFirebaseConfig()){
      try { return { kind: "firebase", db: await connectFirestore() }; }
      catch (e){ console.warn("Firebase қосылмады — localStorage-қа түстік:", e); }
    }
    return { kind: "local", db: localDb };
  }

  return { create, wipeLocal, exportLocal, importLocal };
})();
