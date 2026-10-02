// Robot horaire : ouvre l'application chiffrée dans un navigateur sans écran, la laisse récupérer
// les données, puis enregistre l'état (chiffré) pour que la page s'ouvre déjà à jour.
// Rien de lisible n'est jamais écrit ni affiché : tout ce qui sort d'ici est chiffré.
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { cle, chiffre, dechiffre } from './chiffre.mjs';
import { vapidKeys, enregistrer, alertes, envoyer } from './alertes.mjs';

const t0 = Date.now();
const say = m => console.log(`[${Math.round((Date.now()-t0)/1000)} s] ${m}`);
const MDP = process.env.MOT_DE_PASSE;
if(!existsSync('app.enc')){ say("aucune application publiée pour l'instant : rien à faire"); process.exit(0); }
if(!MDP){ say('secret MOT_DE_PASSE pas encore configuré : rien à faire'); process.exit(0); }

// mêmes familles de données que la page reprend (jamais de clé, jamais de donnée personnelle)
const KEEP_LS = /^mt_(sv_hist|history|learned_dates|etf_flows_hist|data_freshness|snapshot_temps|onchain_|halving_|yfull_|full_|resultcache_|france_result_cache|domcache_|sigmax_|guide_hyst|last_revision)/;

const key = await cle(MDP, JSON.parse(readFileSync('sel.json', 'utf8')));
let html;
try{ html = await dechiffre(key, readFileSync('app.enc', 'utf8')); }catch(e){ say('déchiffrement impossible (mot de passe différent de celui de la publication ?)'); process.exit(1); }
let prev = null;
if(existsSync('site/data.enc')){ try{ prev = JSON.parse(await dechiffre(key, readFileSync('site/data.enc', 'utf8'))); }catch(e){ say('état précédent illisible : on repart de zéro'); } }
// tes données personnelles (stock de métaux…) : lues seulement pour calculer la valeur du jour, jamais recopiées en clair
const PERSO = /^mt_(metals_(or|argent|cuivre)|metal_objectif_|dca_plan|fonds_euros)/;
let perso = {};
if(existsSync('coffre.enc')){ try{ perso = JSON.parse(await dechiffre(key, readFileSync('coffre.enc', 'utf8'))).data || {}; }catch(e){ say('coffre illisible'); } }
let subs = [];
if(existsSync('abonnements.enc')){ try{ subs = JSON.parse(await dechiffre(key, readFileSync('abonnements.enc', 'utf8'))).subs || []; }catch(e){ say('abonnements illisibles'); } }
let H = { v:1, days:{}, alerts:{} };
if(existsSync('site/historique.enc')){ try{ H = JSON.parse(await dechiffre(key, readFileSync('site/historique.enc', 'utf8'))); }catch(e){ say('historique illisible : on repart de zéro'); } }
const vapid = vapidKeys(MDP);

const srv = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type':'text/html; charset=utf-8', 'cache-control':'no-store' });
  res.end(req.url.startsWith('/app') ? html : '<!doctype html><meta charset="utf-8"><title>-</title>');
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;

const browser = await chromium.launch({
  executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true,
  args: ['--disable-web-security', '--disable-features=IsolateOrigins,site-per-process', '--no-first-run'],
});
let code = 0;
try{
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    locale: 'fr-FR', timezoneId: 'Europe/Paris', viewport: { width: 1300, height: 900 },
  });
  await ctx.addInitScript(() => { window.__GMS_ROBOT = true; try{ window.Notification = undefined; }catch(e){} });
  const page = await ctx.newPage();
  page.on('dialog', d => d.dismiss().catch(() => {}));
  let inflight = 0, lastNet = Date.now();
  page.on('request', () => { inflight++; lastNet = Date.now(); });
  const done = () => { inflight = Math.max(0, inflight-1); lastNet = Date.now(); };
  page.on('requestfinished', done); page.on('requestfailed', done);
  const idle = async (quiet, max) => { const s = Date.now(); while(Date.now()-s < max){ if(inflight===0 && Date.now()-lastNet > quiet) return; await page.waitForTimeout(500); } };

  // 1) on remet l'état de l'heure précédente (caches, historiques) avant d'ouvrir l'application
  await page.goto(base + '/vide');
  await page.evaluate(async snap => {
    localStorage.clear();
    localStorage.setItem('mt_anim', '0'); localStorage.setItem('mt_economy_mode', '0'); localStorage.setItem('mt_scheduler_off', '1');
    if(!snap) return;
    Object.entries(snap.ls || {}).forEach(([k, v]) => { try{ localStorage.setItem(k, v); }catch(e){} });
    await new Promise(res => { const rq = indexedDB.open('mt_cache_db', 1); rq.onupgradeneeded = () => rq.result.createObjectStore('cache');
      rq.onsuccess = () => { const tx = rq.result.transaction('cache', 'readwrite'), st = tx.objectStore('cache'); Object.entries(snap.idb || {}).forEach(([k, v]) => { try{ st.put(v, k); }catch(e){} }); tx.oncomplete = res; tx.onerror = res; };
      rq.onerror = res; });
  }, prev);
  await page.evaluate(({ perso, re }) => { const R = new RegExp(re); Object.entries(perso).forEach(([k, v]) => { if(R.test(k)) try{ localStorage.setItem(k, v); }catch(e){} }); }, { perso, re: PERSO.source });

  // 2) l'application se lance et récupère ce qui doit l'être (le calendrier de publication évite les requêtes inutiles)
  await page.goto(base + '/app', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => (window.__lastRefreshAllAt || 0) > 0, null, { timeout: 120000, polling: 1000 });
  await page.waitForFunction(() => typeof refreshing !== 'undefined' && !refreshing, null, { timeout: 360000, polling: 2000 });
  say('actualisation principale terminée');
  for(const tab of ['crypto', 'cross', 'mymetals', 'france', 'traditional']){
    await page.evaluate(t => { try{ switchTab(t); }catch(e){} }, tab);
    await idle(5000, 45000);
    await page.evaluate(() => { try{ window.__svHistLast = {}; renderSimpleViews(true); }catch(e){} });
  }
  // onglet Prévision : probabilités calculées ici pour que la page s'ouvre déjà avec
  await page.evaluate(() => { try{ if(typeof pvCompute==='function') pvCompute(false); }catch(e){} });
  await page.waitForFunction(() => !window.__pv || window.__pv.done, null, { timeout: 240000, polling: 2000 }).catch(() => say('prévision : pas finie à temps'));
  say('prévision calculée');
  // relevé du jour : températures, probabilités, sources en panne, valeur de ton stock
  const jour = await page.evaluate(() => {
    const o = { t:{}, pv:{}, fails:[], mv:null };
    for(const k of ['traditional','crypto','metals','france','cross']){ try{ const v = svModel(k).temp; if(v!=null && isFinite(v)) o.t[k] = Math.round(v*10)/10; }catch(e){} }
    try{ const R = window.__pv && window.__pv.res; if(R) Object.values(R).forEach(x => { if(!x || x.missing || !x.bear) return; const rel = s => s && s.auc!=null && s.auc >= 0.65;
      o.pv[x.id] = { label: x.label, b: Math.round(x.bear.now.p*100), u: Math.round(x.bull.now.p*100), sb: x.bear.now.sc, su: x.bull.now.sc, baseB: Math.round(x.bear.st.base*100), baseU: Math.round(x.bull.st.base*100), relB: rel(x.bear.st), relU: rel(x.bull.st), phase: x.phase ? x.phase.k : null, dd: x.phase ? Math.round(x.phase.dd) : null }; }); }catch(e){}
    try{ const dots = [...document.querySelectorAll('.fresh-dot.fail')]; o.fails = [...new Set(dots.map(el => { const c = el.closest('.card, .gauge-card, [class*=card]'); const k = c && c.querySelector('.k, h3, .title-row'); return ((k && k.textContent) || el.id).replace(/\s+/g,' ').trim().slice(0, 50); }))]; }catch(e){}
    try{ if(typeof renderMyMetals==='function') renderMyMetals(); const h = JSON.parse(localStorage.getItem('mt_metals_value_history')||'[]'); const last = h[h.length-1]; if(last && last.date === new Date().toISOString().slice(0,10) && last.value > 0) o.mv = { value: Math.round(last.value*100)/100, cost: last.cost!=null ? Math.round(last.cost*100)/100 : null }; }catch(e){}
    return o;
  });
  enregistrer(H, jour);
  const al = alertes(H, jour, subs);
  say(`relevé du jour enregistré (${Object.keys(H.days).length} jours) ; alertes : ${Object.entries(al.counts).map(([k, n]) => k + ' ' + n).join(', ')}`);
  if(al.out.length && !process.env.DIAG){ const r = await envoyer(al.out, vapid); say(`notifications : ${r.ok} envoyée(s), ${r.ko} en échec`); }
  await page.evaluate(() => { try{ snapshotHistory(); }catch(e){} });
  await idle(6000, 30000);
  await page.waitForTimeout(3000); // écritures différées (fraîcheur, historiques)

  // diagnostic détaillé : UNIQUEMENT dans le dépôt privé (variable DIAG), jamais dans le dépôt public
  if(process.env.DIAG){
    const d = await page.evaluate(() => {
      const dots = [...document.querySelectorAll('.fresh-dot')];
      const name = el => { const c = el.closest('.card, .gauge-card, [class*=card]'); const k = c && c.querySelector('.k, h3, .title-row'); return ((k && k.textContent) || el.id).replace(/\s+/g,' ').trim().slice(0, 60); };
      const bad = dots.filter(e => e.classList.contains('fail')).map(e => name(e) + ' → ' + (e.title||'').replace(/^.*?\)\s*:?\s*/, '').slice(0, 90));
      const pend = dots.filter(e => e.classList.contains('pending')).map(name);
      return { ok: dots.filter(e => e.classList.contains('ok')).length, bad, pend, etf: (document.getElementById('etfflow-value')?.textContent||'') + ' | ' + (document.getElementById('etfflow-detail')?.textContent||'') };
    });
    const esc = t => String(t).replace(/%/g,'%25').replace(/\r/g,'').replace(/\n/g,'%0A');
    console.log('::notice title=Bilan::' + esc(`${d.ok} indicateurs à jour, ${d.bad.length} en échec, ${d.pend.length} en attente\nFlux ETF : ${d.etf}`));
    console.log('::notice title=Echecs::' + esc(d.bad.join('\n') || 'aucun'));
    console.log('::notice title=En attente::' + esc(d.pend.join('\n') || 'aucun'));
    const soso = await page.evaluate(async () => {
      const k = (localStorage.getItem('mt_sosovalue_key')||'').trim(); if(!k) return 'pas de clé SoSoValue';
      try{ const r = await fetch('https://openapi.sosovalue.com/openapi/v1/etfs/summary-history?symbol=BTC&country_code=US', { headers:{ 'x-soso-api-key': k } }); const t = await r.text(); return r.status + ' ' + t.slice(0, 600); }catch(e){ return 'erreur ' + e.message; }
    });
    console.log('::notice title=SoSoValue::' + esc(soso));
    const pv = await page.evaluate(() => { const P = window.__pv; if(!P || !P.res) return 'non calculée'; return (P.err && P.err.length ? 'manquant : ' + P.err.join(', ') + '\n' : '') + Object.values(P.res).filter(R => R && (R.bear || R.missing)).map(R => R.missing ? R.label + ' : indisponible ' + (R.why||'') : `${R.label} : baisse ${Math.round(R.bear.now.p*100)} % (fiab. ${Math.round((R.bear.st.auc||0)*100)}) · hausse ${Math.round(R.bull.now.p*100)} % (fiab. ${Math.round((R.bull.st.auc||0)*100)}) · ${R.phase ? R.phase.t : ''}`).join('\n'); });
    console.log('::notice title=Prevision::' + esc(pv));
    const fed = await page.evaluate(() => JSON.stringify(window.__fedOutlook || window.__fedProbs || null));
    console.log('::notice title=Fed::' + esc(fed));
  }
  // 3) on récupère l'état (filtré) et on le chiffre
  const st = await page.evaluate(async reSrc => {
    const re = new RegExp(reSrc), ls = {};
    for(let i=0;i<localStorage.length;i++){ const k = localStorage.key(i); if(re.test(k)) ls[k] = localStorage.getItem(k); }
    const idb = await new Promise(res => { const rq = indexedDB.open('mt_cache_db', 1); rq.onupgradeneeded = () => rq.result.createObjectStore('cache');
      rq.onsuccess = () => { const s = rq.result.transaction('cache', 'readonly').objectStore('cache'); const a = s.getAllKeys(), b = s.getAll(); let n = 0;
        const fin = () => { if(++n < 2) return; const o = {}, lim = Date.now() - 12*86400000; a.result.forEach((k, i) => { const v = b.result[i]; if(v && v.ts && v.ts < lim) return; if(String(k).startsWith('mt_netcache_') && v && typeof v.text==='string' && v.text.length > 40000) return; /* pages brutes volumineuses : déjà lues, inutile de les envoyer au téléphone */ o[k] = v; }); res(o); };
        a.onsuccess = fin; b.onsuccess = fin; a.onerror = () => res({}); };
      rq.onerror = () => res({}); });
    return { ls, idb };
  }, KEEP_LS.source);
  const snap = { v: 1, at: Date.now(), ls: st.ls, idb: st.idb, vapid: vapid.publicKey };
  mkdirSync('out', { recursive: true });
  writeFileSync('out/data.enc', await chiffre(key, JSON.stringify(snap)));
  writeFileSync('out/historique.enc', await chiffre(key, JSON.stringify(H)));
  copyFileSync('app.enc', 'out/app.enc'); copyFileSync('index.html', 'out/index.html'); copyFileSync('sel.json', 'out/sel.json');
  if(existsSync('static')) for(const f of readdirSync('static')) copyFileSync('static/'+f, 'out/'+f); // icônes, manifeste, service worker
  writeFileSync('out/.nojekyll', '');
  say(`état enregistré : ${Object.keys(st.ls).length} historiques, ${Object.keys(st.idb).length} données en cache`);
}catch(e){
  say('échec : ' + String(e && e.message || e).split('\n')[0].slice(0, 160));
  code = 1;
}finally{
  await browser.close().catch(() => {}); srv.close();
}
process.exit(code);
