// LUME — conta e sincronização (Firebase Auth + Firestore).
// Sincroniza: estante (lista de PDFs), progresso de leitura e anotações.
// Os arquivos PDF continuam no aparelho; cada PDF é identificado pelo conteúdo (SHA-256),
// então o mesmo arquivo adicionado em outro aparelho recupera página e notas.
const FB_VERSION = '12.18.0';
const FB = `https://www.gstatic.com/firebasejs/${FB_VERSION}`;
const PROGRESS_KEY = 'lume-progress';
const NOTES_KEY = 'leitor-ia-notes';

const L = () => window.__lume;
const isNative = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const cloud = {
  fb: null, auth: null, db: null, user: null,
  remoteDocs: [], idToFp: {}, lastSync: null, syncing: false, status: '',
  timers: {}
};

/* ---------- progresso local ---------- */
function readProgress() { try { return JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}'); } catch { return {}; } }
function writeProgress(p) { try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(p)); } catch {} }
export function getLocalProgress(docId) { return readProgress()[docId] || null; }
function setLocalProgress(docId, page, at = new Date().toISOString()) {
  if (!docId) return; const p = readProgress(); p[docId] = { page, at }; writeProgress(p);
}

/* ---------- impressão digital do PDF ---------- */
async function fingerprint(blob) {
  const buf = await blob.arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 40);
}
async function ensureFingerprints() {
  const lume = L(); const docs = await lume.dbAll(); const map = {};
  for (const d of docs) {
    if (!d.fp && d.blob) { try { d.fp = await fingerprint(d.blob); await lume.dbPut(d); } catch {} }
    if (d.fp) map[d.id] = d.fp;
  }
  cloud.idToFp = map;
  return docs;
}

// Progresso mais recente entre o aparelho e a conta (usado ao abrir um PDF)
async function resolveProgress(doc) {
  try {
    if (!doc.fp && doc.blob) { doc.fp = await fingerprint(doc.blob); await L().dbPut(doc); }
    if (doc.fp) cloud.idToFp[doc.id] = doc.fp;
    let best = getLocalProgress(doc.id);
    if (cloud.user && doc.fp) {
      let r = cloud.remoteDocs.find(d => d.fp === doc.fp);
      if (!r) { try { const snap = await cloud.fb.fs.getDocs(userDocs()); snap.forEach(d => { if (d.id === doc.fp) r = d.data(); }); } catch {} }
      if (r && r.progressAt && (!best || r.progressAt > best.at)) best = { page: r.page || 1, at: r.progressAt };
    }
    if (best) setLocalProgress(doc.id, best.page, best.at);
    return best;
  } catch { return getLocalProgress(doc.id); }
}

/* ---------- notas ---------- */
function readNotes() { try { return JSON.parse(localStorage.getItem(NOTES_KEY) || '[]'); } catch { return []; } }
function writeNotes(notes) {
  localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
  const lume = L(); if (lume) lume.state.notes = notes;
}
function newId() { return (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`); }
function normalizeNotes() {
  const notes = readNotes(); let changed = false;
  const fpToId = Object.fromEntries(Object.entries(cloud.idToFp).map(([id, fp]) => [fp, id]));
  for (const n of notes) {
    if (!n.id) { n.id = newId(); changed = true; }
    if (!n.fp && n.docId && cloud.idToFp[n.docId]) { n.fp = cloud.idToFp[n.docId]; changed = true; }
    if (n.fp && fpToId[n.fp] && n.docId !== fpToId[n.fp]) { n.docId = fpToId[n.fp]; changed = true; }
  }
  if (changed) writeNotes(notes);
  return notes;
}

/* ---------- Firebase ---------- */
async function loadFirebase() {
  if (cloud.fb) return cloud.fb;
  const [app, auth, fs] = await Promise.all([
    import(`${FB}/firebase-app.js`), import(`${FB}/firebase-auth.js`), import(`${FB}/firebase-firestore.js`)
  ]);
  const config = L().DEFAULT_FIREBASE_CONFIG;
  const instance = app.getApps().find(a => a.name === 'lume-cloud') || app.initializeApp(config, 'lume-cloud');
  cloud.auth = auth.getAuth(instance);
  cloud.db = fs.getFirestore(instance);
  cloud.fb = { auth, fs };
  return cloud.fb;
}
const userDocs = () => cloud.fb.fs.collection(cloud.db, 'users', cloud.user.uid, 'docs');
const userNotes = () => cloud.fb.fs.collection(cloud.db, 'users', cloud.user.uid, 'notes');
const docRef = fp => cloud.fb.fs.doc(cloud.db, 'users', cloud.user.uid, 'docs', fp);
const noteRef = id => cloud.fb.fs.doc(cloud.db, 'users', cloud.user.uid, 'notes', id);

function friendlyError(e) {
  const code = String(e?.code || e?.message || e);
  const map = {
    'auth/invalid-credential': 'E-mail ou senha incorretos.',
    'auth/wrong-password': 'E-mail ou senha incorretos.',
    'auth/user-not-found': 'Não existe conta com este e-mail.',
    'auth/invalid-email': 'E-mail inválido.',
    'auth/email-already-in-use': 'Já existe uma conta com este e-mail. Use “Entrar”.',
    'auth/weak-password': 'Senha fraca: use pelo menos 6 caracteres.',
    'auth/missing-password': 'Digite a senha.',
    'auth/too-many-requests': 'Muitas tentativas. Aguarde alguns minutos.',
    'auth/network-request-failed': 'Sem conexão com a internet.',
    'auth/operation-not-allowed': 'Login por e-mail não está ativado no Firebase (Authentication → Sign-in method).',
    'auth/configuration-not-found': 'Authentication não está ativado no projeto Firebase.',
    'auth/popup-closed-by-user': 'Janela do Google fechada.',
    'auth/unauthorized-domain': 'Este endereço não está autorizado no Firebase (Authentication → Settings → Authorized domains).',
    'permission-denied': 'O banco de dados recusou o acesso. Confira as regras do Firestore.',
    'unavailable': 'Servidor indisponível ou sem internet.',
    'failed-precondition': 'Firestore ainda não foi criado no projeto Firebase.',
    'not-found': 'Firestore ainda não foi criado no projeto Firebase.'
  };
  for (const k of Object.keys(map)) if (code.includes(k)) return map[k];
  if (/Failed to fetch|import|dynamically imported/i.test(code)) return 'Sem internet para conectar à conta.';
  return 'Erro: ' + code;
}

/* ---------- sincronização ---------- */
async function syncAll() {
  if (!cloud.user || cloud.syncing) return;
  cloud.syncing = true; setStatus('Sincronizando…');
  try {
    const { fs } = cloud.fb; const lume = L();
    const localDocs = await ensureFingerprints();
    const progress = readProgress();

    const [docsSnap, notesSnap] = await Promise.all([fs.getDocs(userDocs()), fs.getDocs(userNotes())]);
    const remote = {}; docsSnap.forEach(d => { remote[d.id] = d.data(); });
    const remoteNotes = {}; notesSnap.forEach(d => { remoteNotes[d.id] = d.data(); });

    // Estante + progresso
    const localFps = new Set();
    for (const d of localDocs) {
      if (!d.fp) continue; localFps.add(d.fp);
      const r = remote[d.fp]; const lp = progress[d.id];
      if (r && r.progressAt && (!lp || r.progressAt > lp.at)) {
        setLocalProgress(d.id, r.page || 1, r.progressAt);
        continue;
      }
      const payload = {
        name: d.name, size: d.size || 0, pages: d.pages || 0,
        addedAt: d.addedAt || new Date().toISOString(), lastOpened: d.lastOpened || d.addedAt || new Date().toISOString(),
        page: lp?.page || r?.page || 1, progressAt: lp?.at || r?.progressAt || ''
      };
      const differs = !r || r.page !== payload.page || r.progressAt !== payload.progressAt || r.name !== payload.name || r.lastOpened !== payload.lastOpened;
      if (differs) await fs.setDoc(docRef(d.fp), payload, { merge: true });
    }
    cloud.remoteDocs = Object.entries(remote).filter(([fp]) => !localFps.has(fp)).map(([fp, v]) => ({ fp, ...v }));

    // Notas (união por id)
    const notes = normalizeNotes(); const have = new Set(notes.map(n => n.id));
    const fpToId = Object.fromEntries(Object.entries(cloud.idToFp).map(([id, fp]) => [fp, id]));
    let added = 0;
    for (const [id, n] of Object.entries(remoteNotes)) {
      if (have.has(id)) continue;
      notes.unshift({ id, fp: n.fp || '', docId: (n.fp && fpToId[n.fp]) || (n.fp ? 'fp:' + n.fp : ''), docName: n.docName || '', page: n.page || 1, text: n.text || '', createdAt: n.createdAt || new Date().toISOString() });
      added++;
    }
    if (added) { notes.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))); writeNotes(notes); }
    for (const n of notes) {
      if (remoteNotes[n.id] || !n.fp) continue;
      await fs.setDoc(noteRef(n.id), { fp: n.fp, docName: n.docName || '', page: n.page || 1, text: n.text || '', createdAt: n.createdAt || new Date().toISOString() });
    }

    cloud.lastSync = new Date(); setStatus(`Sincronizado às ${cloud.lastSync.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`);
    lume.renderShelf();
  } catch (e) {
    console.warn('LUME sync', e); setStatus(friendlyError(e));
  } finally { cloud.syncing = false; renderAccount(); }
}
function later(key, fn, ms) { clearTimeout(cloud.timers[key]); cloud.timers[key] = setTimeout(fn, ms); }

/* ---------- ganchos chamados pelo app ---------- */
const hooks = {
  pageChanged(docId, page) {
    if (!docId) return; setLocalProgress(docId, page);
    if (!cloud.user) return;
    later('page', async () => {
      const fp = cloud.idToFp[docId]; if (!fp) return;
      const p = getLocalProgress(docId);
      try { await cloud.fb.fs.setDoc(docRef(fp), { page: p.page, progressAt: p.at, lastOpened: p.at }, { merge: true }); } catch (e) { console.warn(e); }
    }, 3000);
  },
  notesChanged() { normalizeNotes(); if (cloud.user) later('sync', syncAll, 1500); },
  libraryChanged() { if (cloud.user) later('sync', syncAll, 1500); else ensureFingerprints().then(normalizeNotes).catch(() => {}); },
  async docDeleted(docId) {
    const fp = cloud.idToFp[docId]; const p = readProgress(); delete p[docId]; writeProgress(p);
    if (!fp || !cloud.user) return;
    try { await cloud.fb.fs.deleteDoc(docRef(fp)); } catch (e) { console.warn(e); }
  },
  decorateShelf() {
    const shelf = document.querySelector('#shelf'); if (!shelf || !cloud.user || !cloud.remoteDocs.length) return;
    shelf.querySelector('.empty-shelf')?.remove();
    const html = cloud.remoteDocs.map(d => `<article class="book-card cloud-only"><div class="book-cover"></div><div><div class="book-name" title="${esc(d.name)}">☁ ${esc(d.name)}</div><div class="book-meta">${d.pages ? `${d.pages} pág. • ` : ''}parou na pág. ${d.page || 1}<br>Na sua conta — adicione o PDF neste aparelho para continuar</div></div><div class="book-actions"><button class="book-open" data-cloud-add>Adicionar</button></div></article>`).join('');
    shelf.insertAdjacentHTML('beforeend', html);
    shelf.querySelectorAll('[data-cloud-add]').forEach(b => b.onclick = () => document.querySelector('#pdfInput').click());
  }
};

/* ---------- interface ---------- */
function setStatus(msg) { cloud.status = msg; const el = document.querySelector('#cloudStatus'); if (el) el.textContent = msg; }
function injectUI() {
  const css = `
  .cloud-btn{position:relative}
  .cloud-btn.on::after{content:'';position:absolute;top:6px;right:6px;width:8px;height:8px;border-radius:50%;background:#22c55e}
  #cloudDialog{border:0;border-radius:18px;padding:0;width:min(420px,92vw);background:var(--surface,#fff);color:inherit;box-shadow:0 20px 60px rgba(0,0,0,.3)}
  #cloudDialog::backdrop{background:rgba(15,23,42,.45)}
  #cloudDialog .cd-body{padding:20px}
  #cloudDialog h3{margin:2px 0 6px;font-size:20px}
  #cloudDialog p{margin:0 0 14px;font-size:13px;line-height:1.45;opacity:.8}
  #cloudDialog input{width:100%;box-sizing:border-box;padding:12px;margin:0 0 10px;border:1px solid var(--line,#d6dbe4);border-radius:12px;font-size:15px;background:transparent;color:inherit}
  #cloudDialog .cd-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px}
  #cloudDialog .cd-row button{flex:1;min-width:120px}
  #cloudDialog .cd-link{background:none;border:0;color:var(--accent,#2563eb);padding:8px 0;font-size:13px;cursor:pointer}
  #cloudStatus{font-size:12px;margin-top:12px;min-height:16px;opacity:.85}
  #cloudDialog .cd-close{float:right}
  #cloudDialog .cd-sec{padding:12px;border:1px solid var(--line,#d6dbe4);border-radius:12px;background:transparent;color:inherit;font-size:14px;font-weight:600;cursor:pointer}
  .cloud-head-actions{display:flex;gap:8px;align-items:center}
  .book-card.cloud-only{opacity:.85;border-style:dashed}`;
  document.head.insertAdjacentHTML('beforeend', `<style>${css}</style>`);
  const settings = document.querySelector('#settingsBtn');
  const btn = document.createElement('button');
  btn.id = 'cloudBtn'; btn.className = 'icon-btn cloud-btn'; btn.type = 'button';
  btn.title = 'Conta'; btn.setAttribute('aria-label', 'Conta e sincronização'); btn.textContent = '👤';
  const group = document.createElement('div'); group.className = 'cloud-head-actions';
  settings.parentNode.insertBefore(group, settings); group.append(btn, settings);
  const dlg = document.createElement('dialog'); dlg.id = 'cloudDialog'; document.body.appendChild(dlg);
  btn.onclick = () => { renderAccount(); dlg.showModal(); };
}
function renderAccount() {
  const dlg = document.querySelector('#cloudDialog'); if (!dlg) return;
  document.querySelector('#cloudBtn')?.classList.toggle('on', !!cloud.user);
  if (cloud.user) {
    dlg.innerHTML = `<div class="cd-body"><button class="icon-btn cd-close" data-close>×</button>
      <div class="eyebrow">LUME • CONTA</div><h3>Conectado</h3>
      <p>${esc(cloud.user.email || '')}<br>Estante, anotações e progresso sincronizados entre seus aparelhos. Os PDFs ficam em cada aparelho.</p>
      <div class="cd-row"><button class="primary-btn" id="cdSync">Sincronizar agora</button><button class="cd-sec" id="cdOut">Sair</button></div>
      <div id="cloudStatus">${esc(cloud.status)}</div></div>`;
    dlg.querySelector('#cdSync').onclick = syncAll;
    dlg.querySelector('#cdOut').onclick = async () => { await cloud.fb.auth.signOut(cloud.auth); };
  } else {
    dlg.innerHTML = `<div class="cd-body"><button class="icon-btn cd-close" data-close>×</button>
      <div class="eyebrow">LUME • CONTA</div><h3>Entrar</h3>
      <p>Entre para acessar sua estante, anotações e progresso de leitura em qualquer aparelho.</p>
      <input id="cdEmail" type="email" autocomplete="email" placeholder="E-mail">
      <input id="cdPass" type="password" autocomplete="current-password" placeholder="Senha (mín. 6 caracteres)">
      <div class="cd-row"><button class="primary-btn" id="cdIn">Entrar</button><button class="cd-sec" id="cdNew">Criar conta</button></div>
      ${isNative() ? '' : '<div class="cd-row"><button class="cd-sec" id="cdGoogle">Entrar com Google</button></div>'}
      <button class="cd-link" id="cdReset">Esqueci a senha</button>
      <div id="cloudStatus">${esc(cloud.status)}</div></div>`;
    const email = () => dlg.querySelector('#cdEmail').value.trim(), pass = () => dlg.querySelector('#cdPass').value;
    const run = async fn => { setStatus('Conectando…'); try { const { auth } = await loadFirebase(); await fn(auth); } catch (e) { setStatus(friendlyError(e)); } };
    dlg.querySelector('#cdIn').onclick = () => run(a => a.signInWithEmailAndPassword(cloud.auth, email(), pass()));
    dlg.querySelector('#cdNew').onclick = () => run(a => a.createUserWithEmailAndPassword(cloud.auth, email(), pass()));
    dlg.querySelector('#cdReset').onclick = () => run(async a => { if (!email()) throw new Error('auth/invalid-email'); await a.sendPasswordResetEmail(cloud.auth, email()); setStatus('Enviamos um e-mail para redefinir a senha.'); });
    const g = dlg.querySelector('#cdGoogle');
    if (g) g.onclick = () => run(a => a.signInWithPopup(cloud.auth, new a.GoogleAuthProvider()));
  }
  dlg.querySelector('[data-close]').onclick = () => dlg.close();
}

async function connect() {
  try {
    const { auth } = await loadFirebase();
    auth.onAuthStateChanged(cloud.auth, user => {
      cloud.user = user || null;
      if (!user) { cloud.remoteDocs = []; setStatus(''); L().renderShelf(); }
      renderAccount();
      if (user) syncAll();
    });
  } catch (e) {
    console.warn('LUME cloud offline', e);
    window.addEventListener('online', connect, { once: true });
  }
}

function start() {
  window.LUMECloud = hooks;
  window.LUMEProgress = { get: getLocalProgress, resolve: resolveProgress };
  injectUI(); renderAccount();
  ensureFingerprints().then(normalizeNotes).catch(() => {});
  connect();
  window.addEventListener('online', () => { if (cloud.user) syncAll(); });
}
if (window.__lume) start(); else window.addEventListener('lume-ready', start, { once: true });
