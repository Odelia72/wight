/* מד מדף — service worker: offline shell + daily background check */
const CACHE = 'shelf-v2';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;                 // fonts etc. go straight to network
  e.respondWith(
    fetch(e.request).then(r => {
      const copy = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});

/* ---- the daily wake-up ---- */
self.addEventListener('periodicsync', e => { if (e.tag === 'shelf-check') e.waitUntil(check()); });
self.addEventListener('sync', e => { if (e.tag === 'shelf-check') e.waitUntil(check()); });
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({type:'window'}).then(cs => cs[0] ? cs[0].focus() : self.clients.openWindow('./')));
});

const DAY = 86400000;
const D = { serum:[.98,1.03,1.08], cream:[.88,.95,1.02], rich:[.85,.92,.99], eye:[.90,.97,1.04],
  oil:[.84,.89,.93], gel:[.98,1.02,1.06], mask:[1.02,1.15,1.30], cleanser:[.97,1.02,1.07],
  spf:[.98,1.05,1.12], toner:[.99,1.00,1.02], body:[.92,.98,1.04] };
const DOSE = { cream:[.45,50], rich:[.5,50], serum:[.35,30], eye:[.12,15], oil:[.3,30], gel:[.7,50],
  mask:[7,100], cleanser:[1.8,150], spf:[1.2,50], toner:[2.5,200], body:[7,250] };
function doseOf(p){
  if (p.doseMl > 0) return p.doseMl;
  const [base, ref] = DOSE[p.type] || DOSE.cream;
  const v = base * Math.pow((p.ml || ref) / ref, 0.6);
  return Math.min(base * 3, Math.max(base * 0.4, v));
}
const RES = { jar:.02, tube:.06, pump:.08, dropper:.04, spray:.05 };

function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('shelf-life', 1);
    r.onsuccess = e => res(e.target.result); r.onerror = e => rej(e.target.error);
  });
}
function read(d, store, key) {
  return new Promise(res => {
    const s = d.transaction(store, 'readonly').objectStore(store);
    const rq = key === undefined ? s.getAll() : s.get(key);
    rq.onsuccess = () => res(rq.result); rq.onerror = () => res(null);
  });
}
function write(d, p) {
  return new Promise(res => {
    const t = d.transaction('products', 'readwrite'); t.objectStore('products').put(p);
    t.oncomplete = res; t.onerror = res;
  });
}

async function check() {
  const d = await db().catch(() => null); if (!d) return;
  const products = (await read(d, 'products')) || [];
  const settings = (await read(d, 'meta', 'settings'))?.v || { leadDays: 30 };
  const learned  = (await read(d, 'meta', 'learned'))?.v  || {};

  for (const p of products) {
    if (p.status !== 'open') continue;          // סגורים במלאי לא מתריעים
    let dens = D[p.type] || D.cream;
    const smp = learned[p.type];
    if (smp && smp.length >= 2) { const m = smp.reduce((a,b)=>a+b,0)/smp.length; dens = [m*.97, m, m*1.03]; }

    let content = p.ml * dens[1] * 1.02;
    if (p.emptyWeight != null) content = Math.max(1, p.initialGross - p.emptyWeight);

    const ws = [{ w: p.initialGross, t: p.openedAt || p.weighedAt || p.startDate }, ...(p.weighings || [])].sort((a,b)=>a.t-b.t);
    const last = ws[ws.length - 1];
    const used = Math.max(0, p.initialGross - last.w);
    const days = (last.t - ws[0].t) / DAY;

    let gPerDay = null;
    if (used >= 2 && days >= 4) gPerDay = used / days;
    else if (p.usesPerWeek) gPerDay = p.usesPerWeek * doseOf(p) * dens[1] / 7;
    if (!gPerDay) continue;

    const res = RES[p.vessel || 'jar'];
    // project forward from the last weighing to today
    const elapsed = (Date.now() - last.t) / DAY;
    const usable = Math.max(0, content - used - content * res - gPerDay * elapsed);
    const daysLeft = Math.round(usable / gPerDay);

    if (daysLeft > (settings.leadDays || 30)) continue;
    if (p.notifiedAt && Date.now() - p.notifiedAt < 20 * DAY) continue;

    await self.registration.showNotification(p.name, {
      body: daysLeft <= 0 ? 'לפי החישוב נגמר' : `נשארו בערך ${daysLeft} ימים`,
      icon: './icon-192.png', badge: './icon-192.png', tag: p.id, lang: 'he', dir: 'rtl'
    });
    p.notifiedAt = Date.now();
    await write(d, p);
  }
}
