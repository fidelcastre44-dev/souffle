'use strict';
/* Souffle — appli personnelle de sevrage tabac et joints.
   Données locales d'abord, sauvegarde automatique dans un dépôt GitHub privé. */

const DAY = 86400000;
const FACTORS = [0.85, 0.70, 0.55, 0.40, 0.30, 0.20, 0.10];
const FLOOR = 3;
const DATA_KEY = 'souffle-data';
const SETTINGS_KEY = 'souffle-settings';
const LAPSE_TAGS = ['Soirée', 'Alcool', 'Stress', 'Ennui', 'Après un repas', 'Entourage qui fume', 'Trajet', 'Autre'];

/* ---------- Storage ---------- */
function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
}
function freshData() {
  return {
    v: 1, updatedAt: 0, events: [], days: {}, measure: null, plan: null, busy: [],
    lapses: [], cravings: [], dailyCravings: {}, eve: {}, history: [], lastKind: 'cig', welcomed: false
  };
}
let data = Object.assign(freshData(), load(DATA_KEY, {}));
let settings = Object.assign({ wake: '10:00', sleep: '02:00', ghOwner: '', ghRepo: 'sevrage-data', ghToken: '', ghPath: 'data.json', lastSync: 0, sha: '', syncError: '' }, load(SETTINGS_KEY, {}));

function saveData(touch = true) {
  if (touch) data.updatedAt = Date.now();
  try { localStorage.setItem(DATA_KEY, JSON.stringify(data)); } catch (e) {}
  if (touch) scheduleSync();
}
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {} }

/* ---------- Time helpers ---------- */
const pad = (n) => String(n).padStart(2, '0');
function calKey(ms) { const d = new Date(ms); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function keyDate(key) { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d).getTime(); }
function addDays(key, n) { const [y, m, d] = key.split('-').map(Number); return calKey(new Date(y, m - 1, d + n, 12).getTime()); }
function diffDays(a, b) { return Math.round((keyDate(b) - keyDate(a)) / DAY); }
function parseHM(s) { if (!s) return null; const [h, m] = s.split(':').map(Number); return h * 60 + m; }
function hm(min) { min = ((Math.round(min) % 1440) + 1440) % 1440; return pad(Math.floor(min / 60)) + ':' + pad(min % 60); }
function fmtTime(ms) { const d = new Date(ms); return d.getHours() + ' h ' + pad(d.getMinutes()); }
function fmtDur(min) { min = Math.max(0, Math.round(min)); const h = Math.floor(min / 60), m = min % 60; return h ? (h + ' h ' + (m ? pad(m) : '')).trim() : m + ' min'; }
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const WDAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
function fmtDate(key, withDay = false) { const d = new Date(keyDate(key)); return (withDay ? WDAYS[d.getDay()] + ' ' : '') + (d.getDate() === 1 ? '1er' : d.getDate()) + ' ' + MONTHS[d.getMonth()]; }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/* Sommeil et réveil : moyennes des jours renseignés, sinon réglages par défaut. */
function normSleep(m) { return m < 720 ? m + 1440 : m; }
function avgWake() {
  const v = Object.values(data.days).map((d) => parseHM(d.wake)).filter((x) => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : parseHM(settings.wake);
}
function avgSleep() {
  const v = Object.values(data.days).map((d) => parseHM(d.sleep)).filter((x) => x != null).map(normSleep);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : normSleep(parseHM(settings.sleep));
}
/* Une journée va du lever au coucher. Sans lever saisi, elle bascule à l'heure de coucher habituelle. */
function boundaryMin() { const s = avgSleep(); return s > 1440 ? Math.min(s - 1440, Math.max(0, avgWake() - 30)) : 0; }
function dayStart(key) {
  const w = data.days[key] && parseHM(data.days[key].wake);
  return keyDate(key) + (w != null ? w : boundaryMin()) * 60000;
}
function dayOf(ms) {
  let k = calKey(ms);
  for (let i = 0; i < 3; i++) {
    if (ms < dayStart(k)) k = addDays(k, -1);
    else if (ms >= dayStart(addDays(k, 1))) k = addDays(k, 1);
    else break;
  }
  return k;
}
function wakeMinFor(key) { const w = data.days[key] && parseHM(data.days[key].wake); return w != null ? w : avgWake(); }
function awakeMinutes(key) {
  const w = wakeMinFor(key);
  const sRaw = data.days[key] && parseHM(data.days[key].sleep);
  const s = sRaw != null ? normSleep(sRaw) : avgSleep();
  const d = s - w;
  return d >= 240 ? d : 960;
}
const today = () => dayOf(Date.now());

/* ---------- Events ---------- */
function eventsOn(key) { return data.events.filter((e) => dayOf(e.t) === key); }
function countOn(key) { return eventsOn(key).length; }
function addEvent(kind, extra = {}) {
  data.events.push(Object.assign({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), t: Date.now(), kind }, extra));
  data.lastKind = kind;
  saveData();
}

/* ---------- Mesure ---------- */
function ensureMeasure() { if (!data.measure) { data.measure = { start: today() }; saveData(false); } }
function measureInfo() {
  const start = data.measure.start;
  const t = today();
  const completed = Math.max(0, diffDays(start, t));
  const keys = [];
  for (let i = 0; i < completed; i++) keys.push(addDays(start, i));
  const filled = keys.filter((k) => countOn(k) > 0 || (data.days[k] && data.days[k].confirmed));
  const counts = filled.map(countOn);
  const mean = counts.length ? counts.reduce((a, b) => a + b, 0) / counts.length : 0;
  const sd = counts.length ? Math.sqrt(counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length) : 0;
  return {
    completed, dayNum: completed + 1, filled: filled.length, mean, sd,
    cv: mean ? sd / mean : 0,
    min: counts.length ? Math.min(...counts) : 0, max: counts.length ? Math.max(...counts) : 0
  };
}
/* Moyenne sur les 14 dernières journées renseignées avant une date. */
function baselineBefore(endKey) {
  const counts = [];
  let k = addDays(endKey, -1);
  const floorKey = data.measure ? data.measure.start : endKey;
  while (counts.length < 14 && diffDays(floorKey, k) >= 0) {
    if (countOn(k) > 0 || (data.days[k] && data.days[k].confirmed)) counts.push(countOn(k));
    k = addDays(k, -1);
  }
  return counts.length ? counts.reduce((a, b) => a + b, 0) / counts.length : 0;
}

/* ---------- Plan ---------- */
function buildCaps(baseline) {
  if (baseline <= FLOOR) { const c = Math.max(1, Math.round(baseline)); return Array(7).fill(c); }
  const pal = FACTORS.map((f) => Math.max(FLOOR, Math.round(baseline * f)));
  const firstFloor = pal.findIndex((c) => c === FLOOR);
  const n = firstFloor === -1 ? pal.length : Math.min(pal.length, firstFloor + 2);
  const caps = [];
  for (let i = 0; i < n; i++) caps.push(pal[i], pal[i], pal[i]);
  return caps;
}
function quitKey() { return data.plan ? addDays(data.plan.start, data.plan.caps.length) : null; }
function phase() {
  if (!data.plan) return 'mesure';
  const t = today();
  if (diffDays(t, data.plan.start) > 0) return 'attente';
  if (diffDays(t, quitKey()) > 0) return 'reduction';
  return 'arret';
}
/* Au démarrage réel, les plafonds sont recalculés sur la moyenne la plus récente, sans changer la date du jour J. */
function refreshPlanAtStart() {
  if (!data.plan || data.plan.refreshed) return;
  if (diffDays(today(), data.plan.start) > 0) return;
  const b = baselineBefore(data.plan.start);
  if (b > 0 && Math.abs(b - data.plan.baseline) >= 0.5) {
    const fresh = buildCaps(b);
    const L = data.plan.caps.length;
    const caps = [];
    for (let i = 0; i < L; i++) caps.push(fresh[Math.min(i, fresh.length - 1)]);
    data.plan.caps = caps;
    data.plan.baseline = b;
  }
  data.plan.refreshed = true;
  saveData();
}
function inBusy(key) { return data.busy.some((p) => diffDays(p.from, key) >= 0 && diffDays(key, p.to) >= 0); }
function proposeStart(capsLen) {
  const t = today();
  for (let s = 1; s <= 30; s++) {
    const start = addDays(t, s);
    const J = addDays(start, capsLen);
    let ok = true;
    for (let i = 0; i < 14; i++) if (inBusy(addDays(J, i))) { ok = false; break; }
    if (ok) return { start, ok: true };
  }
  return { start: addDays(t, 1), ok: false };
}

/* ---------- Arrêt ---------- */
function streakStart() {
  const qStart = dayStart(quitKey());
  const lapseTimes = data.events.filter((e) => e.t >= qStart).map((e) => e.t);
  return lapseTimes.length ? Math.max(qStart, Math.max(...lapseTimes)) : qStart;
}
function recentLapses(days = 14) { const lim = Date.now() - days * DAY; return data.lapses.filter((l) => l.t >= lim).length; }
function isRelapse() {
  const q = quitKey(); if (!q) return false;
  const t = today();
  for (let i = 0; i < 3; i++) { const k = addDays(t, -i); if (diffDays(q, k) < 0 || countOn(k) === 0) return false; }
  return true;
}

/* ---------- UI state ---------- */
let tab = 'home';
let kindSel = data.lastKind || 'cig';
const $ = (s, r = document) => r.querySelector(s);
const view = () => $('#view');

function toast(msg) {
  const el = document.createElement('div'); el.className = 'toast'; el.textContent = msg;
  document.body.appendChild(el); setTimeout(() => el.remove(), 2600);
}

function render() {
  document.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-current', b.dataset.tab === tab ? 'page' : 'false'));
  if (tab === 'home') view().innerHTML = renderHome();
  else if (tab === 'stats') view().innerHTML = renderStats();
  else if (tab === 'help') view().innerHTML = renderHelp();
  else view().innerHTML = renderSettings();
  if (tab === 'stats') { const c = $('.chart'); if (c) c.scrollLeft = c.scrollWidth; }
}

function kindSeg() {
  return `<div class="seg" role="group" aria-label="Type de prise">
    <button type="button" data-action="kind" data-kind="cig" aria-pressed="${kindSel === 'cig'}">Cigarette</button>
    <button type="button" data-action="kind" data-kind="joint" aria-pressed="${kindSel === 'joint'}">Joint</button>
  </div>`;
}
function wakeLine(key) {
  const d = data.days[key] || {};
  const w = d.wake ? 'Levé à ' + d.wake.replace(':', ' h ') : 'Lever non saisi';
  return `<div class="row-between small"><span class="muted">${w}</span><button type="button" class="link" data-action="hours">Mes heures</button></div>`;
}
function lastEventsList(key) {
  const ev = eventsOn(key).slice().sort((x, y) => y.t - x.t).slice(0, 4);
  if (!ev.length) return '<p class="muted small">Aucune prise notée pour l’instant.</p>';
  return '<div class="list">' + ev.map((e) => `<div class="item"><span>${e.manual ? 'ajoutée' : fmtTime(e.t)}</span><span class="muted">${e.kind === 'joint' ? 'Joint' : 'Cigarette'}</span></div>`).join('') + '</div>';
}
function catchupPrompt(key) {
  const now = Date.now();
  const late = now > keyDate(key) + (wakeMinFor(key) + awakeMinutes(key) * 0.8) * 60000;
  const done = data.days[key] && data.days[key].confirmed;
  if (!late || done) return '';
  return `<div class="card row-between"><span>Tu en as oublié aujourd’hui ?</span><button type="button" class="link" data-action="catchup" data-day="${key}">Vérifier</button></div>`;
}

/* ---------- Home ---------- */
function renderHome() {
  ensureMeasure();
  refreshPlanAtStart();
  const ph = phase();
  let html = '';
  if (!data.welcomed) html += welcomeCard();
  if (ph === 'mesure') html += homeMeasure();
  else if (ph === 'attente') html += homeWait();
  else if (ph === 'reduction') html += homeReduction();
  else html += homeQuit();
  return `<div class="stack">${html}</div>`;
}
function welcomeCard() {
  return `<div class="card stack-s">
    <h2>Bienvenue</h2>
    <p class="small">Pendant au moins 7 jours, fume comme d’habitude et note chaque prise, cigarette ou joint. Ensuite, Souffle te propose un plan de réduction jusqu’au jour où tu n’inhales plus rien.</p>
    <button type="button" class="link" data-action="welcomed">Compris</button>
  </div>`;
}
function homeMeasure() {
  const m = measureInfo();
  const t = today();
  const segs = Array.from({ length: Math.max(7, Math.min(14, m.dayNum)) }, (_, i) => `<span class="${i < m.completed ? 'done' : i === m.completed ? 'now' : ''}"></span>`).join('');
  const cols = Math.max(7, Math.min(14, m.dayNum));
  let bilan = '';
  if (m.completed >= 7) {
    const forced = m.completed >= 14;
    const suggest = !forced && (m.cv > 0.3 || m.filled < 5);
    bilan = `<div class="card stack-s">
      <h2>${forced ? 'Mesure terminée' : 'Ton bilan'}</h2>
      <div class="grid2">
        <div class="stat"><span class="v">${m.mean.toFixed(1).replace('.', ',')}</span><span class="k">prises par jour en moyenne</span></div>
        <div class="stat"><span class="v">${m.min} à ${m.max}</span><span class="k">jour le plus bas et le plus haut</span></div>
      </div>
      ${suggest ? `<p class="small muted">${m.filled < 5 ? 'Moins de 5 journées renseignées : continuer quelques jours donnera une moyenne plus fiable.' : 'Ta consommation varie beaucoup d’un jour à l’autre. Continuer la mesure donnera une moyenne plus fiable.'}</p>` : ''}
      <button type="button" class="btn btn-quiet" data-action="open-plan" ${m.filled === 0 ? 'disabled' : ''}>Voir mon plan</button>
      ${forced ? '' : `<p class="small muted">Tu peux aussi simplement continuer à noter, jusqu’au jour 14.</p>`}
    </div>`;
  }
  return `
    <div class="stack-s">
      <div class="row-between"><span class="phase">Mesure</span><span class="small muted">Jour ${Math.min(m.dayNum, 14)}${m.completed < 7 ? ' sur 7' : ' sur 14 au plus'}</span></div>
      <div class="progress" style="grid-template-columns: repeat(${cols}, minmax(0, 1fr))">${segs}</div>
    </div>
    ${bilan}
    <div class="hero"><span class="label">Aujourd’hui</span><span class="big">${countOn(t)}</span><span class="label">${countOn(t) > 1 ? 'prises' : 'prise'}</span></div>
    <p class="muted" style="text-align:center">Fume comme d’habitude. Note juste chaque prise, sans te juger.</p>
    ${kindSeg()}
    <button type="button" class="btn btn-primary" data-action="smoke">J’ai fumé</button>
    ${catchupPrompt(t)}
    <div class="stack-s">
      <div class="row-between"><h2>Dernières prises</h2><button type="button" class="link" data-action="undo">Annuler la dernière</button></div>
      ${lastEventsList(t)}
    </div>
    ${wakeLine(t)}`;
}
function homeWait() {
  const t = today();
  const days = diffDays(t, data.plan.start);
  return `
    <span class="phase">En attente</span>
    <div class="hero"><span class="label">Réduction dans</span><span class="big">${days}</span><span class="label">${days > 1 ? 'jours' : 'jour'}, le ${fmtDate(data.plan.start, true)}</span></div>
    <p class="muted" style="text-align:center">Continue de noter tes prises : ta moyenne sera recalculée au démarrage.</p>
    <p class="small muted" style="text-align:center">Jour J prévu le ${fmtDate(quitKey(), true)}.</p>
    ${kindSeg()}
    <button type="button" class="btn btn-primary" data-action="smoke">J’ai fumé</button>
    ${catchupPrompt(t)}
    <div class="stack-s"><div class="row-between"><h2>Aujourd’hui : ${countOn(t)}</h2><button type="button" class="link" data-action="undo">Annuler la dernière</button></div>${lastEventsList(t)}</div>
    ${wakeLine(t)}`;
}
function reductionState() {
  const t = today();
  const idx = diffDays(data.plan.start, t);
  const caps = data.plan.caps;
  const cap = caps[idx];
  const count = countOn(t);
  const interval = awakeMinutes(t) / cap;
  const timed = eventsOn(t).filter((e) => !e.manual);
  const last = timed.length ? Math.max(...timed.map((e) => e.t)) : null;
  const next = last ? last + interval * 60000 : null;
  let nextChange = null;
  for (let i = idx + 1; i < caps.length; i++) if (caps[i] !== cap) { nextChange = { inDays: i - idx, cap: caps[i] }; break; }
  return { t, idx, cap, count, interval, next, nextChange, atFloor: cap <= FLOOR && (idx >= 3 ? caps[idx - 3] <= FLOOR : false) };
}
function homeReduction() {
  const s = reductionState();
  const now = Date.now();
  const total = data.plan.caps.length;
  let heroTop, heroMain, heroSub;
  if (s.count >= s.cap) { heroTop = 'Plafond atteint'; heroMain = `${s.count} sur ${s.cap}`; heroSub = 'Plus de prise jusqu’à demain. L’exercice peut t’aider.'; }
  else if (s.next && now < s.next) { heroTop = 'Possible à partir de'; heroMain = fmtTime(s.next); heroSub = 'dans ' + fmtDur((s.next - now) / 60000); }
  else { heroTop = 'Délai écoulé'; heroMain = 'Tu peux'; heroSub = 'seulement si l’envie est là'; }
  const J = quitKey();
  const isEve = diffDays(s.t, J) === 1;
  return `
    <div class="row-between"><span class="phase">Réduction</span><span class="small muted">Jour ${s.idx + 1} sur ${total}</span></div>
    ${isEve ? eveCard() : ''}
    <div class="hero"><span class="label">${heroTop}</span><span class="mid">${heroMain}</span><span class="label">${heroSub}</span></div>
    <div class="grid2">
      <div class="card stat"><span class="k">Aujourd’hui</span><span class="v">${s.count} <span class="small muted">sur ${s.cap}</span></span></div>
      <div class="card stat"><span class="k">Délai entre deux prises</span><span class="v">${fmtDur(s.interval)}</span></div>
    </div>
    <p class="small muted" style="text-align:center">${s.atFloor ? 'Tu es au plus bas. Ces derniers jours servent à t’habituer avant l’arrêt.' : s.nextChange ? `Prochain palier dans ${s.nextChange.inDays} ${s.nextChange.inDays > 1 ? 'jours' : 'jour'} : ${s.nextChange.cap} prises.` : `Jour J le ${fmtDate(J, true)}.`}</p>
    ${kindSeg()}
    <button type="button" class="btn btn-primary" data-action="smoke">J’ai fumé</button>
    <button type="button" class="btn btn-secondary" data-action="craving">J’ai une envie</button>
    ${catchupPrompt(s.t)}
    <div class="stack-s"><div class="row-between"><h2>Dernières prises</h2><button type="button" class="link" data-action="undo">Annuler la dernière</button></div>${lastEventsList(s.t)}</div>
    <p class="small muted">Tirer plus fort sur moins de prises annule une partie du bénéfice.</p>
    ${wakeLine(s.t)}
    <div class="row-between small"><span class="muted">Jour J : ${fmtDate(J, true)}</span><button type="button" class="link" data-action="adjust">Ajuster mon plan</button></div>`;
}
function eveCard() {
  const items = [
    ['lighters', 'J’ai retiré briquets, tabac et feuilles.'],
    ['moments', 'J’ai repéré mes moments à risque de demain.'],
    ['evening', 'Je sais ce que je fais en soirée, surtout s’il y a de l’alcool.'],
    ['reason', 'J’ai relu ma raison d’arrêter.']
  ];
  const c = data.eve || {};
  return `<div class="card stack-s"><h2>Demain, jour J</h2><div class="checklist">${items.map(([id, label]) => `<label><input type="checkbox" data-action="eve" data-id="${id}" ${c[id] ? 'checked' : ''}><span>${label}</span></label>`).join('')}</div>
    ${data.plan.reason ? `<p class="small muted">Ta raison : ${esc(data.plan.reason)}</p>` : ''}</div>`;
}
function homeQuit() {
  const t = today();
  const start = streakStart();
  const days = Math.floor((Date.now() - start) / DAY);
  const J = quitKey();
  const sinceJ = diffDays(J, t);
  const yesterday = addDays(t, -1);
  const askDaily = sinceJ >= 1 && sinceJ <= 14 && data.dailyCravings[yesterday] == null;
  let banners = '';
  if (isRelapse()) {
    banners += `<div class="card warn stack-s"><h2>Tu fumes de nouveau chaque jour</h2><p class="small">Ta consommation a changé. Le plus simple est de repartir d’une mesure de 7 jours pour refaire un plan juste.</p><button type="button" class="btn btn-quiet" data-action="restart">Recommencer par une mesure</button></div>`;
  } else if (recentLapses() >= 3) {
    banners += `<div class="card warn stack-s"><h2>3 écarts en 2 semaines</h2><p class="small">C’est le moment de te faire aider : un tabacologue au 39 89, des substituts non inhalés, ou un nouveau plan.</p><a class="btn btn-quiet" href="tel:3989">Appeler le 39 89</a><button type="button" class="link" data-action="goto-help">Voir les aides</button><button type="button" class="link" data-action="restart">Refaire un plan</button></div>`;
  }
  const streakDate = calKey(start);
  return `
    <span class="phase">Sans rien inhaler</span>
    ${banners}
    <div class="hero"><span class="big">${days}</span><span class="label">${days > 1 ? 'jours' : 'jour'} sans rien inhaler</span><span class="small muted">depuis le ${fmtDate(dayOf(start))}</span></div>
    ${askDaily ? `<div class="card stack-s"><h2>Tes envies hier, de 0 à 5 ?</h2><div class="scale">${[0, 1, 2, 3, 4, 5].map((n) => `<button type="button" data-action="daily" data-n="${n}" aria-pressed="false">${n}</button>`).join('')}</div></div>` : ''}
    <button type="button" class="btn btn-primary" data-action="craving">J’ai une envie</button>
    <button type="button" class="btn btn-secondary" data-action="lapse">J’ai fumé</button>
    ${sinceJ <= 14 ? `<p class="small muted" style="text-align:center">Les 2 premières semaines sont les plus importantes. Les aides sont dans l’onglet Aides.</p>` : ''}
    <button type="button" class="link" data-action="goto-help" style="align-self:center">Ce qui peut arriver après l’arrêt</button>`;
}

/* ---------- Stats ---------- */
function statsDays() {
  const keys = [];
  if (!data.measure) return keys;
  let first = data.measure.start;
  if (data.events.length) { const fe = dayOf(Math.min(...data.events.map((e) => e.t))); if (diffDays(fe, first) > 0) first = fe; }
  const t = today();
  for (let k = first; diffDays(k, t) >= 0; k = addDays(k, 1)) keys.push(k);
  return keys;
}
function capFor(key) {
  if (!data.plan) return null;
  const i = diffDays(data.plan.start, key);
  if (i < 0) return null;
  return i < data.plan.caps.length ? data.plan.caps[i] : 0;
}
function chartSVG(keys) {
  const bw = 12, gap = 5, h = 180, top = 12, bottom = 24;
  const counts = keys.map((k) => { const ev = eventsOn(k); return { cig: ev.filter((e) => e.kind !== 'joint').length, joint: ev.filter((e) => e.kind === 'joint').length }; });
  const maxV = Math.max(4, ...counts.map((c) => c.cig + c.joint), ...keys.map((k) => capFor(k) || 0));
  const w = Math.max(320, keys.length * (bw + gap) + gap);
  const y = (v) => top + (h - top - bottom) * (1 - v / maxV);
  let bars = '', capPath = '', labels = '';
  keys.forEach((k, i) => {
    const x = gap + i * (bw + gap);
    const c = counts[i];
    const yc = y(c.cig), yj = y(c.cig + c.joint);
    if (c.cig) bars += `<rect x="${x}" y="${yc}" width="${bw}" height="${y(0) - yc}" rx="2" fill="var(--accent)"></rect>`;
    if (c.joint) bars += `<rect x="${x}" y="${yj}" width="${bw}" height="${yc - yj}" rx="2" fill="var(--soft)"></rect>`;
    const cap = capFor(k);
    if (cap != null) capPath += (capPath ? ' L' : 'M') + ` ${x - gap / 2} ${y(cap)} L ${x + bw + gap / 2} ${y(cap)}`;
    const d = new Date(keyDate(k));
    if (d.getDate() === 1 || i === 0 || d.getDay() === 1) labels += `<text x="${x}" y="${h - 6}" font-size="10" fill="var(--muted)">${d.getDate()}/${d.getMonth() + 1}</text>`;
  });
  const J = quitKey();
  let jLine = '';
  if (J) { const ji = keys.indexOf(J); if (ji >= 0) { const x = gap + ji * (bw + gap) - gap / 2; jLine = `<line x1="${x}" x2="${x}" y1="${top}" y2="${y(0)}" stroke="var(--ink)" stroke-width="1.5" stroke-dasharray="3 3"></line><text x="${x + 4}" y="${top + 10}" font-size="11" font-weight="700" fill="var(--ink)">Jour J</text>`; } }
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Prises par jour">
    <line x1="0" x2="${w}" y1="${y(0)}" y2="${y(0)}" stroke="var(--line)"></line>
    ${bars}
    ${capPath ? `<path d="${capPath}" fill="none" stroke="var(--ink)" stroke-width="2"></path>` : ''}
    ${jLine}${labels}
  </svg>`;
}
function cravingSVG() {
  const J = quitKey(); if (!J) return '';
  const entries = Object.entries(data.dailyCravings).filter(([k]) => diffDays(J, k) >= 0).sort(([a], [b]) => (a < b ? -1 : 1));
  if (entries.length < 2) return '';
  const w = 320, h = 110, pad = 14;
  const x = (i) => pad + (w - 2 * pad) * (i / (entries.length - 1));
  const y = (v) => pad + (h - 2 * pad) * (1 - v / 5);
  const d = entries.map(([, v], i) => (i ? 'L' : 'M') + ' ' + x(i) + ' ' + y(v)).join(' ');
  return `<div class="card stack-s"><h2>Intensité de tes envies</h2><svg width="100%" viewBox="0 0 ${w} ${h}" role="img" aria-label="Intensité des envies depuis le jour J">
    <line x1="${pad}" x2="${w - pad}" y1="${y(0)}" y2="${y(0)}" stroke="var(--line)"></line>
    <path d="${d}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round"></path>
    ${entries.map(([, v], i) => `<circle cx="${x(i)}" cy="${y(v)}" r="3.5" fill="var(--accent)"></circle>`).join('')}
  </svg><p class="small muted">De 0 (aucune) à 5 (très forte), d’après tes réponses du matin.</p></div>`;
}
function renderStats() {
  const keys = statsDays();
  const ph = phase();
  const baseline = data.plan ? data.plan.baseline : (data.measure ? measureInfo().mean : 0);
  let avoided = 0;
  if (data.plan) keys.forEach((k) => { if (diffDays(data.plan.start, k) >= 0 && diffDays(k, today()) > 0) avoided += baseline - countOn(k); });
  avoided = Math.max(0, Math.round(avoided));
  const allEv = data.events.length;
  const joints = data.events.filter((e) => e.kind === 'joint').length;
  const third = ph === 'arret'
    ? `<div class="card stat"><span class="v">${Math.floor((Date.now() - streakStart()) / DAY)}</span><span class="k">jours sans rien inhaler</span></div>`
    : `<div class="card stat"><span class="v">${countOn(today())}</span><span class="k">prises aujourd’hui</span></div>`;
  return `<div class="stack">
    <h1>Stats</h1>
    <div class="card stack-s">
      <h2>Prises par jour</h2>
      <div class="chart">${chartSVG(keys)}</div>
      <div class="legend"><span><i style="background:var(--accent)"></i>Cigarettes</span><span><i style="background:var(--soft)"></i>Joints</span>${data.plan ? '<span><i style="background:var(--ink);height:2px;vertical-align:4px"></i>Plafond</span>' : ''}</div>
    </div>
    <div class="grid2">
      <div class="card stat"><span class="v">${baseline ? baseline.toFixed(1).replace('.', ',') : '–'}</span><span class="k">moyenne de départ</span></div>
      ${third}
    </div>
    <div class="card stat"><span class="v">${avoided}</span><span class="k">prises évitées par rapport à ta moyenne de départ</span></div>
    ${allEv ? `<p class="small muted">Les joints représentent ${Math.round((joints / allEv) * 100)} % de tes prises notées.</p>` : ''}
    ${ph === 'arret' ? cravingSVG() : ''}
  </div>`;
}

/* ---------- Aides ---------- */
function renderHelp() {
  return `<div class="stack prose">
    <h1>Aides</h1>
    <div class="card stack-s">
      <h2>Parler à un tabacologue</h2>
      <p class="small">Tabac Info Service met gratuitement en relation avec des tabacologues, avec un suivi personnalisé.</p>
      <a class="btn btn-quiet" href="tel:3989">Appeler le 39 89</a>
    </div>
    <div class="card stack-s">
      <h2>Substituts nicotiniques non inhalés</h2>
      <p class="small">Patch, gomme, pastille ou spray buccal. Les formes à action rapide, comme la gomme ou la pastille, sont associées à de meilleurs résultats pendant une réduction.</p>
      <p class="small">La plupart sont remboursés à 65 % sur ordonnance : médecin, infirmier, sage-femme, dentiste ou kiné peuvent les prescrire. Demande conseil à un pharmacien pour le dosage.</p>
    </div>
    <div class="card stack-s">
      <h2>Après l’arrêt, ce qui peut arriver</h2>
      <p class="small">Envies de fumer, irritabilité, sommeil perturbé, appétit qui augmente, difficulté à se concentrer. Ces effets sont fréquents et passagers : ils sont en général plus marqués les premiers jours, puis s’atténuent.</p>
      <p class="small">Une envie monte, atteint un pic, puis redescend. L’exercice « J’ai une envie » sert à traverser ce moment.</p>
    </div>
    <div class="card stack-s">
      <h2>Médicaments</h2>
      <p class="small">Arrêter de fumer peut modifier l’effet de certains médicaments. Si tu suis un traitement, parles-en à ton médecin ou à ton pharmacien.</p>
    </div>
    <button type="button" class="btn btn-secondary" data-action="craving">Faire l’exercice face à une envie</button>
    <p class="small muted">Souffle n’est pas un dispositif médical et ne remplace pas un avis professionnel.</p>
  </div>`;
}

/* ---------- Réglages ---------- */
function syncStatus() {
  if (!settings.ghToken || !settings.ghOwner) return 'Sauvegarde automatique non configurée.';
  if (settings.syncError) return 'Dernière sauvegarde échouée : ' + settings.syncError;
  if (!settings.lastSync) return 'Pas encore sauvegardé.';
  const min = Math.round((Date.now() - settings.lastSync) / 60000);
  return 'Sauvegardé ' + (min < 1 ? 'à l’instant' : 'il y a ' + fmtDur(min)) + '.';
}
function renderSettings() {
  return `<div class="stack">
    <h1>Réglages</h1>
    <div class="card stack-s">
      <h2>Heures habituelles</h2>
      <p class="small muted">Utilisées tant que tu n’as pas saisi tes heures du jour.</p>
      <div class="grid2">
        <label class="field">Lever<input type="time" id="set-wake" value="${settings.wake}"></label>
        <label class="field">Coucher<input type="time" id="set-sleep" value="${settings.sleep}"></label>
      </div>
      <button type="button" class="btn btn-quiet" data-action="save-hours-default">Enregistrer</button>
    </div>
    <div class="card stack-s">
      <h2>Sauvegarde automatique</h2>
      <p class="small muted">Copie de tes données dans un dépôt GitHub privé, après chaque changement.</p>
      <label class="field">Compte GitHub<input type="text" id="gh-owner" autocomplete="off" autocapitalize="off" value="${esc(settings.ghOwner)}"></label>
      <label class="field">Dépôt privé<input type="text" id="gh-repo" autocomplete="off" autocapitalize="off" value="${esc(settings.ghRepo)}"></label>
      <label class="field">Jeton d’accès<input type="password" id="gh-token" autocomplete="off" value="${esc(settings.ghToken)}"></label>
      <button type="button" class="btn btn-quiet" data-action="save-gh">Enregistrer et sauvegarder</button>
      <p class="small muted" id="sync-status">${esc(syncStatus())}</p>
    </div>
    <div class="card stack-s">
      <h2>Fichier de secours</h2>
      <button type="button" class="btn btn-quiet" data-action="export">Exporter mes données</button>
      <label class="btn btn-quiet" style="cursor:pointer">Importer un fichier<input type="file" id="import-file" accept="application/json" hidden></label>
    </div>
    <div class="card stack-s">
      <h2>Mon plan</h2>
      ${data.plan ? `<p class="small">Début le ${fmtDate(data.plan.start)}, jour J le ${fmtDate(quitKey())}.</p>` : '<p class="small muted">Pas encore de plan : la mesure est en cours.</p>'}
      ${data.plan && phase() !== 'arret' ? '<button type="button" class="link" data-action="adjust">Ajuster mon plan</button>' : ''}
      <button type="button" class="link" data-action="restart">Recommencer par une mesure</button>
    </div>
  </div>`;
}

/* ---------- Sheets ---------- */
function openSheet(title, body, onMount) {
  const root = $('#sheet-root');
  root.innerHTML = `<div class="scrim" data-action="scrim"><div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="sheet-head"><h2>${esc(title)}</h2><button type="button" class="close" data-action="close-sheet" aria-label="Fermer"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
    <div class="sheet-body">${body}</div></div></div>`;
  if (onMount) onMount($('.sheet', root));
}
function closeSheet() { $('#sheet-root').innerHTML = ''; render(); }

/* J'ai fumé pendant la réduction, avant le délai ou au-delà du plafond. */
function smokeFlow() {
  const ph = phase();
  if (ph === 'reduction') {
    const s = reductionState();
    const early = s.next && Date.now() < s.next;
    const over = s.count >= s.cap;
    if (early || over) {
      openSheet(over ? 'Plafond atteint' : 'Avant la fin du délai', `<div class="stack">
        <p>${over ? `Tu as déjà fumé ${s.count} prises sur ${s.cap} aujourd’hui.` : `Prochaine prise prévue à ${fmtTime(s.next)}.`} Tu peux d’abord essayer de laisser passer l’envie.</p>
        <button type="button" class="btn btn-primary" data-action="craving">Faire l’exercice d’abord</button>
        <button type="button" class="btn btn-secondary" data-action="smoke-confirm" data-flag="${over ? 'over' : 'early'}">Noter quand même</button>
      </div>`);
      return;
    }
  }
  addEvent(kindSel);
  toast('Prise notée');
  render();
}

function cravingFlow() {
  let step = 0, before = null, after = null;
  const reason = data.plan && data.plan.reason;
  const steps = () => [
    `<p>Quelle est la force de ton envie, de 1 à 5 ?</p>${scale5('before', before)}`,
    `<h2>Remarquer</h2><p>Dis-toi simplement : « Une envie est là. » Pas besoin de la combattre ni de lui obéir.</p>`,
    `<h2>Situer</h2><p>Où la sens-tu dans ton corps ? Gorge, poitrine, mains, ventre ? À quoi ressemble-t-elle : chaleur, tension, agitation ?</p>`,
    `<h2>Respirer</h2><p>Suis le cercle : inspire quand il grandit, expire quand il rétrécit. Regarde l’envie monter puis redescendre, comme une vague.</p><div class="breath" aria-hidden="true"><i></i></div><p class="small muted">Continue aussi longtemps que tu veux.</p>`,
    `<h2>Ta raison</h2><p>${reason ? '« ' + esc(reason) + ' »' : 'Rappelle-toi pourquoi tu veux arrêter. Tu pourras l’écrire en créant ton plan.'}</p>`,
    `<p>Et maintenant, quelle est la force de ton envie ?</p>${scale5('after', after)}`
  ];
  const draw = () => {
    const body = `<div class="stack">${steps()[step]}
      <div class="row">${step > 0 ? '<button type="button" class="btn btn-quiet" data-cv="prev">Retour</button>' : ''}
      <button type="button" class="btn btn-primary" data-cv="next" ${(step === 0 && before == null) || (step === 5 && after == null) ? 'disabled' : ''}>${step === 5 ? 'Terminer' : 'Suivant'}</button></div></div>`;
    openSheet('J’ai une envie', body, (sheet) => {
      sheet.addEventListener('click', (e) => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.dataset.scale) { if (b.dataset.scale === 'before') before = +b.dataset.n; else after = +b.dataset.n; draw(); }
        if (b.dataset.cv === 'prev') { step--; draw(); }
        if (b.dataset.cv === 'next') {
          if (step === 5) { data.cravings.push({ t: Date.now(), before, after }); saveData(); closeSheet(); toast(after < before ? 'L’envie a baissé. Bien joué.' : 'Envie notée.'); return; }
          step++; draw();
        }
      });
    });
  };
  draw();
}
function scale5(name, val) {
  return `<div class="scale five">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-scale="${name}" data-n="${n}" aria-pressed="${val === n}">${n}</button>`).join('')}</div>`;
}

function lapseFlow() {
  let k = kindSel; const tags = new Set();
  const draw = (note = '') => openSheet('Un écart', `<div class="stack">
      <p>Ça arrive. Le noter honnêtement t’aide à préparer la prochaine fois.</p>
      <div class="seg" role="group" aria-label="Type"><button type="button" data-lk="cig" aria-pressed="${k === 'cig'}">Cigarette</button><button type="button" data-lk="joint" aria-pressed="${k === 'joint'}">Joint</button></div>
      <div class="stack-s"><h2>Le contexte</h2><div class="chips">${LAPSE_TAGS.map((t) => `<button type="button" data-tag="${esc(t)}" aria-pressed="${tags.has(t)}">${esc(t)}</button>`).join('')}</div></div>
      <label class="field">La prochaine fois dans cette situation, je…<textarea id="lapse-next">${esc(note)}</textarea></label>
      <button type="button" class="btn btn-primary" data-lsave="1">Enregistrer</button>
    </div>`, (sheet) => {
      sheet.addEventListener('click', (e) => {
        const b = e.target.closest('button'); if (!b) return;
        const note = $('#lapse-next') ? $('#lapse-next').value : '';
        if (b.dataset.lk) { k = b.dataset.lk; draw(note); }
        if (b.dataset.tag) { tags.has(b.dataset.tag) ? tags.delete(b.dataset.tag) : tags.add(b.dataset.tag); draw(note); }
        if (b.dataset.lsave) {
          const t = Date.now();
          data.events.push({ id: t.toString(36), t, kind: k, lapse: true });
          data.lapses.push({ t, kind: k, tags: [...tags], next: note.trim() });
          saveData(); closeSheet(); toast('Écart noté. Le compteur repart, tu continues.');
        }
      });
    });
  draw();
}

function catchupFlow(key) {
  const draw = () => openSheet('Prises oubliées', `<div class="stack">
    <p>${fmtDate(key, true)} : <strong>${countOn(key)}</strong> ${countOn(key) > 1 ? 'prises notées' : 'prise notée'}.</p>
    ${kindSeg()}
    <div class="grid2"><button type="button" class="btn btn-quiet" data-cu="minus" aria-label="Retirer une prise">Retirer une</button><button type="button" class="btn btn-quiet" data-cu="plus" aria-label="Ajouter une prise">Ajouter une</button></div>
    <button type="button" class="btn btn-primary" data-cu="ok">C’est complet</button>
  </div>`, (sheet) => {
    sheet.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.action === 'kind') { kindSel = b.dataset.kind; draw(); return; }
      if (b.dataset.cu === 'plus') {
        const t = Math.min(Date.now(), dayStart(key) + awakeMinutes(key) * 60000 / 2);
        data.events.push({ id: Date.now().toString(36), t, kind: kindSel, manual: true }); saveData(); draw();
      }
      if (b.dataset.cu === 'minus') {
        const ev = eventsOn(key); if (ev.length) { const last = ev.reduce((a, c) => (c.t > a.t ? c : a)); data.events = data.events.filter((x) => x.id !== last.id); saveData(); } draw();
      }
      if (b.dataset.cu === 'ok') { data.days[key] = Object.assign({}, data.days[key], { confirmed: true }); saveData(); closeSheet(); }
    });
  });
  draw();
}

function hoursFlow() {
  const t = today();
  let key = t;
  const draw = () => {
    const d = data.days[key] || {};
    const first = eventsOn(key).filter((e) => !e.manual).sort((a, b) => a.t - b.t)[0];
    const sugg = !d.wake && first ? hm(Math.floor((new Date(first.t).getHours() * 60 + new Date(first.t).getMinutes()) / 15) * 15) : null;
    openSheet('Mes heures', `<div class="stack">
      <div class="chips">${[0, 1, 2].map((i) => { const k = addDays(t, -i); return `<button type="button" data-hd="${k}" aria-pressed="${k === key}">${i === 0 ? 'Aujourd’hui' : i === 1 ? 'Hier' : fmtDate(k)}</button>`; }).join('')}</div>
      <div class="grid2">
        <label class="field">Lever<input type="time" id="h-wake" value="${d.wake || ''}"></label>
        <label class="field">Coucher<input type="time" id="h-sleep" value="${d.sleep || ''}"></label>
      </div>
      ${sugg ? `<button type="button" class="link" data-hsugg="${sugg}">Première prise vers ${sugg.replace(':', ' h ')} : levé vers ${sugg.replace(':', ' h ')} ?</button>` : ''}
      <p class="small muted">Laisse vide si tu ne sais pas : Souffle utilise tes heures habituelles.</p>
      <button type="button" class="btn btn-primary" data-hsave="1">Enregistrer</button>
    </div>`, (sheet) => {
      sheet.addEventListener('click', (e) => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.dataset.hd) { key = b.dataset.hd; draw(); }
        if (b.dataset.hsugg) { $('#h-wake').value = b.dataset.hsugg; }
        if (b.dataset.hsave) {
          const w = $('#h-wake').value, s = $('#h-sleep').value;
          const rec = Object.assign({}, data.days[key]);
          if (w) rec.wake = w; else delete rec.wake;
          if (s) rec.sleep = s; else delete rec.sleep;
          data.days[key] = rec; saveData(); closeSheet(); toast('Heures enregistrées');
        }
      });
    });
  };
  draw();
}

function planFlow() {
  const m = measureInfo();
  const baseline = baselineBefore(addDays(today(), 0));
  const caps = buildCaps(baseline);
  let reason = (data.plan && data.plan.reason) || '';
  let manualStart = null;
  const draw = () => {
    const prop = proposeStart(caps.length);
    const start = manualStart || prop.start;
    const J = addDays(start, caps.length);
    const jBusy = Array.from({ length: 14 }, (_, i) => addDays(J, i)).some(inBusy);
    const curve = (() => {
      const w = 300, h = 90, bw = w / caps.length;
      const mx = Math.max(...caps, 1);
      return `<svg width="100%" viewBox="0 0 ${w} ${h + 16}" role="img" aria-label="Courbe des plafonds">${caps.map((c, i) => `<rect x="${i * bw + 1}" y="${h - (h * c) / mx}" width="${bw - 2}" height="${(h * c) / mx}" rx="1.5" fill="var(--accent)"></rect>`).join('')}<text x="0" y="${h + 14}" font-size="11" fill="var(--muted)">${caps[0]} prises</text><text x="${w}" y="${h + 14}" font-size="11" text-anchor="end" fill="var(--muted)">${caps[caps.length - 1]} puis 0</text></svg>`;
    })();
    openSheet('Mon plan', `<div class="stack">
      <div class="grid2">
        <div class="stat"><span class="v">${baseline.toFixed(1).replace('.', ',')}</span><span class="k">prises par jour en moyenne</span></div>
        <div class="stat"><span class="v">${caps.length} jours</span><span class="k">de réduction</span></div>
      </div>
      <div class="card stack-s">${curve}<p class="small muted">Un palier tous les 3 jours. Le délai entre deux prises s’allonge à chaque palier.</p></div>
      <div class="card stack-s">
        <h2>Jour J : ${fmtDate(J, true)}</h2>
        <p class="small muted">Début de la réduction le ${fmtDate(start, true)}.</p>
        ${jBusy ? '<p class="small" style="color:var(--warn)">Le jour J ou les 2 semaines suivantes tombent pendant une période chargée.</p>' : ''}
        ${!prop.ok && !manualStart && data.busy.length ? '<p class="small" style="color:var(--warn)">Aucune date dans les 30 jours n’évite tes périodes chargées.</p>' : ''}
        <label class="field">Changer la date de début<input type="date" id="p-start" min="${addDays(today(), 1)}" max="${addDays(today(), 30)}" value="${start}"></label>
      </div>
      <div class="card stack-s">
        <h2>Périodes chargées</h2>
        <p class="small muted">Tournées, fêtes, déplacements. Souffle place le jour J et les 2 semaines qui suivent en dehors.</p>
        ${data.busy.map((p, i) => `<div class="row-between small"><span>Du ${fmtDate(p.from)} au ${fmtDate(p.to)}</span><button type="button" class="link" data-busydel="${i}">Retirer</button></div>`).join('')}
        <div class="grid2"><label class="field">Du<input type="date" id="b-from"></label><label class="field">Au<input type="date" id="b-to"></label></div>
        <button type="button" class="btn btn-quiet" data-busyadd="1">Ajouter la période</button>
      </div>
      <label class="field">Ma raison d’arrêter<textarea id="p-reason" placeholder="En une phrase, pour toi">${esc(reason)}</textarea></label>
      <button type="button" class="btn btn-primary" data-pgo="1">Commencer le ${fmtDate(start)}</button>
      ${m.completed < 14 ? '<button type="button" class="link" data-action="close-sheet">Continuer la mesure</button>' : ''}
    </div>`, (sheet) => {
      sheet.addEventListener('change', (e) => { if (e.target.id === 'p-start' && e.target.value) { reason = $('#p-reason').value; manualStart = e.target.value; draw(); } });
      sheet.addEventListener('click', (e) => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.dataset.busyadd) {
          const f = $('#b-from').value, t = $('#b-to').value; reason = $('#p-reason').value;
          if (f && t && f <= t) { data.busy.push({ from: f, to: t }); saveData(); manualStart = null; draw(); } else toast('Choisis une date de début et de fin.');
        }
        if (b.dataset.busydel) { reason = $('#p-reason').value; data.busy.splice(+b.dataset.busydel, 1); saveData(); manualStart = null; draw(); }
        if (b.dataset.pgo) {
          data.plan = { start, caps, baseline, reason: $('#p-reason').value.trim(), adjustUsed: false, createdAt: Date.now(), refreshed: false };
          data.eve = {};
          saveData(); closeSheet(); toast('Plan créé');
        }
      });
    });
  };
  draw();
}

function adjustFlow() {
  if (!data.plan) return;
  const s = phase() === 'reduction' ? reductionState() : null;
  const J = quitKey();
  if (data.plan.adjustUsed) {
    openSheet('Ajuster mon plan', `<div class="stack"><p>Tu as déjà utilisé ton ajustement. Ton jour J reste le ${fmtDate(J, true)}.</p><p class="small muted">Si c’est difficile, un tabacologue ou des substituts peuvent t’aider à tenir.</p><a class="btn btn-quiet" href="tel:3989">Appeler le 39 89</a>${advanceBlock(J)}</div>`, mountAdvance);
    return;
  }
  openSheet('Ajuster mon plan', `<div class="stack">
    <p>Tu peux décaler ton plan une seule fois, de 7 jours au plus. La nouvelle date sera affichée.</p>
    ${s ? `<button type="button" class="btn btn-quiet" data-adj="extend">Rester 3 jours de plus à ${s.cap} prises</button>` : ''}
    <label class="field">Reporter le jour J de<input type="number" id="adj-days" min="1" max="7" value="3" inputmode="numeric"></label>
    <button type="button" class="btn btn-quiet" data-adj="delay">Reporter le jour J</button>
    ${advanceBlock(J)}
  </div>`, (sheet) => {
    mountAdvance(sheet);
    sheet.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b || !b.dataset.adj) return;
      const caps = data.plan.caps.slice();
      if (b.dataset.adj === 'extend' && s) {
        let end = s.idx; while (end + 1 < caps.length && caps[end + 1] === s.cap) end++;
        caps.splice(end + 1, 0, s.cap, s.cap, s.cap);
      } else if (b.dataset.adj === 'delay') {
        const n = Math.max(1, Math.min(7, parseInt($('#adj-days').value, 10) || 0));
        const last = caps[caps.length - 1]; for (let i = 0; i < n; i++) caps.push(last);
      } else return;
      data.plan.caps = caps; data.plan.adjustUsed = true; saveData(); closeSheet();
      toast('Nouveau jour J : ' + fmtDate(quitKey(), true));
    });
  });
}
function advanceBlock(J) {
  const t = today();
  if (diffDays(t, J) <= 1) return '';
  return `<div class="card stack-s"><h2>Avancer le jour J</h2><p class="small muted">Toujours possible.</p><label class="field">Nouvelle date<input type="date" id="adv-date" min="${addDays(t, 1)}" max="${addDays(J, -1)}"></label><button type="button" class="btn btn-quiet" data-adv="1">Avancer</button></div>`;
}
function mountAdvance(sheet) {
  sheet.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || !b.dataset.adv) return;
    const v = $('#adv-date').value; if (!v) { toast('Choisis une date.'); return; }
    const n = diffDays(data.plan.start, v);
    if (n < 1) { toast('Choisis une date plus tard.'); return; }
    data.plan.caps = data.plan.caps.slice(0, n); saveData(); closeSheet();
    toast('Jour J avancé au ' + fmtDate(quitKey(), true));
  });
}

function restartFlow() {
  openSheet('Recommencer par une mesure', `<div class="stack"><p>Ton plan actuel sera archivé et une nouvelle mesure de 7 jours commencera aujourd’hui. Tout ton historique est conservé.</p>
    <button type="button" class="btn btn-primary" data-rs="1">Recommencer</button></div>`, (sheet) => {
    sheet.addEventListener('click', (e) => {
      if (!e.target.closest('[data-rs]')) return;
      data.history.push({ plan: data.plan, measure: data.measure, archivedAt: Date.now() });
      data.plan = null; data.measure = { start: today() }; data.eve = {};
      saveData(); closeSheet(); toast('Nouvelle mesure commencée');
    });
  });
}

/* ---------- Events (delegation) ---------- */
document.addEventListener('click', (e) => {
  const tabBtn = e.target.closest('[data-tab]');
  if (tabBtn) { tab = tabBtn.dataset.tab; render(); window.scrollTo(0, 0); return; }
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  if (a === 'scrim') { if (e.target === el) closeSheet(); return; }
  if (a === 'close-sheet') { closeSheet(); return; }
  if (a === 'kind' && !el.closest('.sheet')) { kindSel = el.dataset.kind; data.lastKind = kindSel; saveData(false); render(); return; }
  if (a === 'smoke') smokeFlow();
  if (a === 'smoke-confirm') { addEvent(kindSel, { early: true }); closeSheet(); toast('Prise notée'); }
  if (a === 'undo') {
    const ev = eventsOn(today()); if (!ev.length) return;
    const last = ev.reduce((x, c) => (c.t > x.t ? c : x)); data.events = data.events.filter((x) => x.id !== last.id);
    data.lapses = data.lapses.filter((l) => l.t !== last.t); saveData(); render(); toast('Dernière prise annulée');
  }
  if (a === 'craving') { if ($('.sheet')) $('#sheet-root').innerHTML = ''; cravingFlow(); }
  if (a === 'lapse') lapseFlow();
  if (a === 'catchup') catchupFlow(el.dataset.day);
  if (a === 'hours') hoursFlow();
  if (a === 'open-plan') planFlow();
  if (a === 'adjust') adjustFlow();
  if (a === 'restart') restartFlow();
  if (a === 'welcomed') { data.welcomed = true; saveData(); render(); }
  if (a === 'goto-help') { tab = 'help'; render(); window.scrollTo(0, 0); }
  if (a === 'daily') { data.dailyCravings[addDays(today(), -1)] = +el.dataset.n; saveData(); render(); }
  if (a === 'save-hours-default') { settings.wake = $('#set-wake').value || '10:00'; settings.sleep = $('#set-sleep').value || '02:00'; saveSettings(); toast('Heures enregistrées'); render(); }
  if (a === 'save-gh') {
    settings.ghOwner = $('#gh-owner').value.trim(); settings.ghRepo = $('#gh-repo').value.trim() || 'sevrage-data'; settings.ghToken = $('#gh-token').value.trim();
    settings.sha = ''; settings.syncError = ''; saveSettings(); syncNow(true);
  }
  if (a === 'export') exportData();
});
document.addEventListener('change', (e) => {
  if (e.target.matches('[data-action="eve"]')) { data.eve[e.target.dataset.id] = e.target.checked; saveData(); }
  if (e.target.id === 'import-file' && e.target.files[0]) importData(e.target.files[0]);
});

/* ---------- Export / import ---------- */
function exportData() {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'souffle-' + calKey(Date.now()) + '.json';
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function importData(file) {
  const r = new FileReader();
  r.onload = () => {
    try {
      const d = JSON.parse(r.result);
      if (!Array.isArray(d.events)) throw new Error('format');
      data = Object.assign(freshData(), d); saveData(); render(); toast('Données importées');
    } catch (err) { toast('Ce fichier n’est pas une sauvegarde Souffle.'); }
  };
  r.readAsText(file);
}

/* ---------- Sauvegarde GitHub ---------- */
let syncTimer = null, syncing = false;
function ghReady() { return settings.ghOwner && settings.ghRepo && settings.ghToken; }
function scheduleSync() { if (!ghReady()) return; clearTimeout(syncTimer); syncTimer = setTimeout(() => syncNow(false), 4000); }
function ghUrl() { return `https://api.github.com/repos/${encodeURIComponent(settings.ghOwner)}/${encodeURIComponent(settings.ghRepo)}/contents/${settings.ghPath}`; }
function ghHeaders() { return { Authorization: 'Bearer ' + settings.ghToken, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }; }
function toB64(str) { const bytes = new TextEncoder().encode(str); let bin = ''; bytes.forEach((b) => (bin += String.fromCharCode(b))); return btoa(bin); }
function fromB64(b64) { const bin = atob(b64.replace(/\n/g, '')); const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0)); return new TextDecoder().decode(bytes); }
function ghErr(status) {
  if (status === 401) return 'jeton refusé';
  if (status === 403) return 'accès refusé, vérifie les droits du jeton';
  if (status === 404) return 'dépôt introuvable';
  return 'erreur ' + status;
}
async function pullRemote() {
  const res = await fetch(ghUrl() + '?t=' + Date.now(), { headers: ghHeaders(), cache: 'no-store' });
  if (res.status === 404) {
    const repoRes = await fetch(`https://api.github.com/repos/${encodeURIComponent(settings.ghOwner)}/${encodeURIComponent(settings.ghRepo)}`, { headers: ghHeaders() });
    if (!repoRes.ok) throw new Error(ghErr(repoRes.status));
    return null;
  }
  if (!res.ok) throw new Error(ghErr(res.status));
  const j = await res.json();
  return { sha: j.sha, data: JSON.parse(fromB64(j.content)) };
}
async function pushRemote(retry = true) {
  const body = { message: 'Sauvegarde ' + new Date().toISOString(), content: toB64(JSON.stringify(data)) };
  if (settings.sha) body.sha = settings.sha;
  const res = await fetch(ghUrl(), { method: 'PUT', headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders()), body: JSON.stringify(body) });
  if ((res.status === 409 || res.status === 422) && retry) {
    const remote = await pullRemote(); settings.sha = remote ? remote.sha : ''; return pushRemote(false);
  }
  if (!res.ok) throw new Error(ghErr(res.status));
  const j = await res.json(); settings.sha = j.content.sha;
}
async function syncNow(manual) {
  if (!ghReady() || syncing) return;
  if (!navigator.onLine) { if (manual) toast('Hors ligne : la sauvegarde se fera à la reconnexion.'); return; }
  syncing = true;
  try {
    const remote = await pullRemote();
    if (remote) settings.sha = remote.sha;
    const localEmpty = !data.events.length && !data.plan;
    const remoteHas = remote && remote.data && Array.isArray(remote.data.events) && (remote.data.events.length || remote.data.plan);
    if (remote && remote.data && ((remote.data.updatedAt || 0) > (data.updatedAt || 0) || (localEmpty && remoteHas))) {
      data = Object.assign(freshData(), remote.data); saveData(false);
    } else if (!remote || (remote.data.updatedAt || 0) < (data.updatedAt || 0)) {
      await pushRemote();
    }
    settings.lastSync = Date.now(); settings.syncError = '';
    if (manual) toast('Sauvegarde à jour');
  } catch (err) {
    settings.syncError = err.message || 'réseau indisponible';
    if (manual) toast('Sauvegarde impossible : ' + settings.syncError);
  } finally {
    syncing = false; saveSettings();
    if (tab === 'settings') { const st = $('#sync-status'); if (st) st.textContent = syncStatus(); }
    else if (!$('.sheet')) render();
  }
}
window.addEventListener('online', () => syncNow(false));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { syncNow(false); if (!$('.sheet')) render(); } });

/* ---------- Boot ---------- */
ensureMeasure();
render();
syncNow(false);
setInterval(() => { if (!$('.sheet') && tab === 'home') render(); }, 30000);
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
