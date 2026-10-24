// Robot horaire : ouvre l'application chiffrée dans un navigateur sans écran, la laisse récupérer
// les données, puis enregistre l'état (chiffré) pour que la page s'ouvre déjà à jour.
// Rien de lisible n'est jamais écrit ni affiché : tout ce qui sort d'ici est chiffré.
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { cle, chiffre, dechiffre } from './chiffre.mjs';
import { vapidKeys, enregistrer, alertes } from './alertes.mjs';
import { relevePieces, releveSitesUtilisateur } from './pieces.mjs';
import { releveOrBanques, releveOrEtf, releveInitiesMarche, releveInitiesListe, releveDefaillances, releveEurope, releveNouveaux } from './donnees-plus.mjs';

const t0 = Date.now();
const say = m => console.log(`[${Math.round((Date.now()-t0)/1000)} s] ${m}`);
const MDP = process.env.MOT_DE_PASSE;
if(!existsSync('app.enc')){ say("aucune application publiée pour l'instant : rien à faire"); process.exit(0); }
if(!MDP){ say('secret MOT_DE_PASSE pas encore configuré : rien à faire'); process.exit(0); }

// mêmes familles de données que la page reprend (jamais de clé, jamais de donnée personnelle)
const KEEP_LS = /^mt_(sv_hist|history|learned_dates|etf_flows_hist|data_freshness|snapshot_temps|onchain_|halving_|yfull_|full_|resultcache_|france_result_cache|domcache_|sigmax_|guide_hyst|last_revision|oi_hist|fred_repl|autorepair|av_quota|bls_quota|tiingo_quota|dailyquota_|quota_usage_|fmp_blocked_until|jina_exhausted_until|key_issues|paid_service_health|format_ko|wl_deep|pieces_prix|pieces_hist|or_plus|inities|wl_inities|wl_projournal|wl_bpa|scan)/;
// 16/10 : les compteurs de quotas des services gratuits sont gardés d'un passage à l'autre (le robot passe bien plus souvent)

const key = await cle(MDP, JSON.parse(readFileSync('sel.json', 'utf8')));
let html;
try{ html = await dechiffre(key, readFileSync('app.enc', 'utf8')); }catch(e){ say('déchiffrement impossible (mot de passe différent de celui de la publication ?)'); process.exit(1); }
// 17/10 : intégrité des fichiers du site (empreintes calculées à la publication et rangées dans l'appli chiffrée)
let integrite = null;
try{ const m = html.match(/\(\/\*__EMPREINTES__\*\/(\{[^)]*\})\)/), E = m ? JSON.parse(m[1]) : {};
  if(Object.keys(E).length){ const { createHash } = await import('node:crypto'); integrite = Object.keys(E).filter(f => !existsSync(f) || createHash('sha256').update(readFileSync(f)).digest('hex') !== E[f]); }
}catch(e){}
let prev = null;
// 17/10 : un état présent mais illisible arrête le robot (avant, il repartait de zéro et écrasait tout l'historique)
if(existsSync('site/data.enc')){ try{ prev = JSON.parse(await dechiffre(key, readFileSync('site/data.enc', 'utf8'))); }catch(e){ say('état précédent illisible : passage arrêté pour ne rien effacer'); process.exit(1); } }
// tes données personnelles (stock de métaux…) : lues seulement pour calculer la valeur du jour, jamais recopiées en clair
const PERSO = /^mt_(metals_(or|argent|cuivre)|metal_objectif_|dca_plan|fonds_euros|watchlist|trad_rule|temp_exclus|temp_util|pieces_choix|pieces_sites|pieces_cibles|fisc_dates|pro_dessins)/; // 16/10 : + ta règle pour les actions, tes choix d'indicateurs comptés dans les températures
let perso = {};
if(existsSync('coffre.enc')){ try{ perso = JSON.parse(await dechiffre(key, readFileSync('coffre.enc', 'utf8'))).data || {}; }catch(e){ say('coffre illisible : passage arrêté'); process.exit(1); } }
let subs = [];
if(existsSync('abonnements.enc')){ try{ subs = JSON.parse(await dechiffre(key, readFileSync('abonnements.enc', 'utf8'))).subs || []; }catch(e){ say('abonnements illisibles'); } }
// 24/10 : avis déposé (chiffré, branche coffre) par la publication quand elle échoue, ou par Claude (tâches programmées) : envoyé en notification
let avis = null; if(existsSync('avis.enc')){ try{ avis = JSON.parse(await dechiffre(key, readFileSync('avis.enc', 'utf8'))); }catch(e){ say('avis illisible'); } }
let H = { v:1, days:{}, alerts:{} };
if(existsSync('site/historique.enc')){ try{ H = JSON.parse(await dechiffre(key, readFileSync('site/historique.enc', 'utf8'))); }catch(e){ say('historique illisible : passage arrêté pour ne rien effacer'); process.exit(1); } }
const vapid = vapidKeys(MDP);

const srv = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type':'text/html; charset=utf-8', 'cache-control':'no-store' });
  res.end(req.url.startsWith('/app') ? html : '<!doctype html><meta charset="utf-8"><title>-</title>');
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const browser = await chromium.launch({
  executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true,
  args: ['--disable-web-security', '--disable-features=IsolateOrigins,site-per-process', '--no-first-run'],
});
let code = 0;
try{
  const ctx = await browser.newContext({
    userAgent: UA,
    locale: 'fr-FR', timezoneId: 'Europe/Paris', viewport: { width: 1300, height: 900 },
  });
  await ctx.addInitScript(() => { window.__GMS_ROBOT = true; try{ window.Notification = undefined; }catch(e){} });
  // 04/10 (n°5) : ici, pas besoin des intermédiaires gratuits (seep, allorigins, corsmirror…) : le robot lit
  // directement le site visé et rend la réponse à la page. Si le site refuse, on repasse par l'intermédiaire.
  const RELAIS = [
    [/^https:\/\/seep\.eu\.org\/(https?:\/\/.+)$/, m => m[1]],
    [/^https:\/\/api\.allorigins\.win\/raw\?url=([^&]+)/, m => decodeURIComponent(m[1])],
    [/^https:\/\/corsmirror\.com\/v1\?url=([^&]+)/, m => decodeURIComponent(m[1])],
    [/^https:\/\/cors-get-proxy\.sirjosh\.workers\.dev\/\?url=([^&]+)/, m => decodeURIComponent(m[1])],
    [/^https:\/\/corsmirror\.onrender\.com\/v1\/cors\?url=([^&]+)/, m => decodeURIComponent(m[1])],
  ];
  const direct = { ok: 0, repli: 0 };
  await ctx.route(/^https:\/\/(seep\.eu\.org|api\.allorigins\.win|corsmirror\.com|cors-get-proxy\.sirjosh\.workers\.dev|corsmirror\.onrender\.com)\//, async route => {
    const rq = route.request(); let cible = null;
    for(const [re, f] of RELAIS){ const m = rq.url().match(re); if(m){ try{ cible = f(m); }catch(e){} break; } }
    if(!cible || rq.method() !== 'GET') return route.continue().catch(() => {});
    try{
      const r = await route.fetch({ url: cible, headers: { 'user-agent': UA, 'accept': '*/*', 'accept-language': 'fr-FR,fr;q=0.9,en;q=0.8' }, timeout: 15000 });
      if(r.status() >= 400){ direct.repli++; return route.continue().catch(() => {}); }
      direct.ok++;
      return route.fulfill({ status: r.status(), body: await r.body(), headers: { 'content-type': r.headers()['content-type'] || 'text/plain; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'no-store' } });
    }catch(e){ direct.repli++; return route.continue().catch(() => {}); }
  });
  // 16/10 : fichiers que le site refuse à un navigateur mais accepte d'un serveur (FINRA : historique de la dette sur marge)
  await ctx.route(/^https:\/\/www\.finra\.org\/.*\.xlsx$/, async route => {
    try{ const r = await route.fetch({ headers: { 'user-agent': 'Mozilla/5.0', 'accept': '*/*' }, timeout: 20000 });
      return route.fulfill({ status: r.status(), body: await r.body(), headers: { 'content-type': 'application/octet-stream', 'access-control-allow-origin': '*', 'cache-control': 'no-store' } }); }
    catch(e){ return route.continue().catch(() => {}); }
  });
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
    localStorage.setItem('mt_anim', '0'); localStorage.setItem('mt_economy_mode', '0'); localStorage.setItem('mt_scheduler_off', '1'); localStorage.setItem('mt_ultra_simple', '0'); // 03/10 : vue complète, pour que chaque onglet charge ses données
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
  // 24/10 : les relevés hors de la page (pièces, or des banques centrales et des ETF, dirigeants, données en plus) tournent
  // pendant la visite des onglets et le calcul des prévisions, au lieu d'attendre la fin ; l'état n'est enregistré qu'une fois finis.
  const releves = (async () => {
  // 17/10 : prix des pièces d'or chez les marchands (toutes les 6 h), repris par la page (Mes Métaux)
  try{
    // 20/10 : + les sites ajoutés par le propriétaire (lus avec le navigateur, 3 min au plus par passage) ; relevé refait
    // tout de suite si la liste des pièces ou des sites a changé
    const avant = await page.evaluate(() => { try{ return JSON.parse(localStorage.getItem('mt_pieces_prix') || 'null'); }catch(e){ return null; } });
    const conf = await page.evaluate(() => { try{ return piecesConfigRobot(); }catch(e){ return null; } });
    const complet = !avant || Date.now() - (avant.at || 0) > 6*3600000 || (conf && avant.sig !== conf.sig);
    // sites personnels en échec (hors sites qui bloquent les robots) : nouvel essai au bout d'1 h, sans tout relever
    const aRefaire = !complet && conf ? conf.sites.filter(x => { let h = ''; try{ h = new URL(x.url).hostname.replace(/^www\./, ''); }catch(e){} const r = (avant.sites || {})[h]; return r && r.err && !/protégé/.test(r.err) && Date.now() - (r.at || 0) > 3600000; }) : [];
    if(aRefaire.length){
      const P = avant; P.sites = P.sites || {}; let nS = 0;
      const R = await releveSitesUtilisateur(page.context(), { ...conf, sites: aRefaire }, P.sites, 120000);
      for(const [h, r] of Object.entries(R)){ const offres = r.produits.length ? await page.evaluate(L => { try{ return piecesRapprocher(L); }catch(e){ return []; } }, r.produits) : [];
        P.sites[h] = { nom: r.nom, url: r.url, at: Date.now(), err: r.err || (r.produits.length && !offres.length ? 'aucune de tes pièces reconnue' : null), n: r.produits.length, offres: offres.length ? offres : ((P.sites[h] || {}).offres || []) }; nS++;
        say(`pièces — nouvel essai d'un site personnel : ${r.err ? r.err : `${r.produits.length} annonce(s) lue(s), ${offres.length} pièce(s) reconnue(s)`}`); }
      await page.evaluate(v => { localStorage.setItem('mt_pieces_prix', v); try{ piecesHistNoter(); }catch(e){} }, JSON.stringify(P));
    }
    if(complet){
      const P = await relevePieces((conf && conf.off) || []), garde = new Set(((conf && conf.sites) || []).map(x => { try{ return new URL(x.url).hostname.replace(/^www\./, ''); }catch(e){ return ''; } }));
      P.sites = Object.fromEntries(Object.entries((avant && avant.sites) || {}).filter(([h]) => garde.has(h)));
      let nS = 0;
      if(conf && conf.sites.length){
        const R = await releveSitesUtilisateur(page.context(), conf, P.sites, 240000);
        for(const [h, r] of Object.entries(R)){
          const offres = r.produits.length ? await page.evaluate(L => { try{ return piecesRapprocher(L); }catch(e){ return []; } }, r.produits) : [];
          const ancien = P.sites[h] || {};
          P.sites[h] = { nom: r.nom, url: r.url, at: Date.now(), err: r.err || (r.produits.length && !offres.length ? 'aucune de tes pièces reconnue' : null), n: r.produits.length, offres: offres.length ? offres : (r.err ? (ancien.offres || []) : []) };
          nS++; say(`pièces — site personnel n°${nS} : ${r.err ? r.err : `${r.produits.length} annonce(s) lue(s), ${offres.length} pièce(s) reconnue(s)`}`); // jamais le nom du site : le journal est public
        }
      }
      P.sig = conf ? conf.sig : null;
      if(P.ok || nS){ await page.evaluate(v => { localStorage.setItem('mt_pieces_prix', v); try{ piecesHistNoter(); }catch(e){} }, JSON.stringify(P)); }
      say(`prix des pièces : ${P.ok} relevé(s) chez les marchands intégrés, ${P.ko} manquant(s), ${nS} site(s) personnel(s) lu(s)`);
    }
  }catch(e){ say('prix des pièces : relevé impossible'); }
  // 17/10 : or des banques centrales (FMI) et des ETF (GLD) une fois par jour ; achats des dirigeants toutes les 6 h
  try{
    const lit = k => page.evaluate(k => { try{ return JSON.parse(localStorage.getItem(k) || 'null'); }catch(e){ return null; } }, k);
    const ecrit = (k, v) => page.evaluate(([k, v]) => localStorage.setItem(k, v), [k, JSON.stringify(v)]);
    const O = (await lit('mt_or_plus')) || {}; let neuf = false;
    if(!O.bc || Date.now() - O.bc.at > 20*3600000){ try{ O.bc = await releveOrBanques(); neuf = true; }catch(e){ say('or des banques centrales : ' + e.message); } }
    if(!O.etf || Date.now() - O.etf.at > 20*3600000){ try{ O.etf = await releveOrEtf(); neuf = true; }catch(e){ say('or des ETF : ' + e.message); } }
    if(!O.eu || Date.now() - O.eu.at > 20*3600000){ try{ O.eu = await releveEurope(); neuf = true; }catch(e){ say('Europe (INSEE, BCE) : ' + e.message); } }
    if(!O.def || Date.now() - O.def.at > 20*3600000){ try{ O.def = await releveDefaillances(); neuf = true; }catch(e){ say('défaillances d\'entreprises : ' + e.message); } }
    // 23/10 : nouvelles données (taux, INSEE, carburants, or de Shanghai et de Londres, crypto), chacune une fois par jour
    try{ const N = await releveNouveaux(O.nv); if(JSON.stringify(N.o) !== JSON.stringify(O.nv || {})){ O.nv = N.o; neuf = true; } if(N.err.length) say('nouvelles données : ' + N.err.join(' ; ')); }catch(e){ say('nouvelles données : relevé impossible'); }
    if(neuf) await ecrit('mt_or_plus', O);
    const I = await lit('mt_inities');
    if(!I || Date.now() - I.at > 6*3600000){
      try{ await ecrit('mt_inities', await releveInitiesMarche(I)); }catch(e){ say('dirigeants (marché) : ' + e.message); }
      try{ const syms = await page.evaluate(() => { try{ return wlLoad().map(x => x.s); }catch(e){ return []; } }); await ecrit('mt_wl_inities', await releveInitiesListe(syms)); }catch(e){ say('dirigeants (liste de suivi) : relevé impossible'); }
    }
  }catch(e){ say('or et dirigeants : relevé impossible'); }
  })().catch(e => say('relevés : ' + String(e && e.message || e).slice(0, 80)));
  await page.evaluate(() => { try{ if(localStorage.getItem('mt_ultra_simple')==='1') applyUltraSimpleView(false); }catch(e){} }); // sinon switchTab ne fait rien
  for(const tab of ['crypto', 'cross', 'mymetals', 'france', 'traditional']){
    await page.evaluate(t => { try{ switchTab(t); }catch(e){} }, tab);
    await idle(5000, 45000);
    await page.evaluate(() => { try{ window.__svHistLast = {}; renderSimpleViews(true); }catch(e){} });
  }
  // onglet Prévision : probabilités calculées ici pour que la page s'ouvre déjà avec
  await page.evaluate(() => { try{ if(typeof pvCompute==='function') pvCompute(false); }catch(e){} });
  await page.waitForFunction(() => !window.__pv || window.__pv.done, null, { timeout: 240000, polling: 2000 }).catch(() => say('prévision : pas finie à temps'));
  say('prévision calculée');
  // 16/10 : tests sur le passé recalculés ici une fois par semaine (le plus ancien d'abord, un seul par passage,
  // 3 min au plus) : les appareils les reçoivent tout prêts au lieu de les refaire eux-mêmes
  try{
    const bt = await page.evaluate(async () => {
      const L = [['backtest-trad-v4', 'runTemperatureBacktest'], ['backtest-crypto-v2', 'runCryptoBacktest'], ['backtest-gold-v3', 'runGoldBacktest'], ['backtest-guide-v4', 'runGuideBacktest']];
      const age = []; for(const [k, f] of L){ if(typeof window[f] !== 'function') continue; let c = null; try{ c = await idbGet('mt_dailycache_'+k); }catch(e){} const a = c ? Date.now() - c.ts : Infinity; if(a > 6*86400000) age.push([a, k, f]); }
      if(!age.length) return null; age.sort((x, y) => y[0] - x[0]); const [, k, f] = age[0];
      try{ await Promise.race([window[f](true), new Promise(r => setTimeout(r, 180000))]); }catch(e){ return k + ' : échec'; }
      return k;
    });
    if(bt) say('test sur le passé recalculé : ' + bt);
  }catch(e){}
  say(`lectures directes sans intermédiaire : ${direct.ok} (repli sur l'intermédiaire : ${direct.repli})`);
  // 09/10 : données du Guide (indice Monde) et contrôles de cohérence, utilisés par le relevé ci-dessous
  await page.evaluate(async () => { try{ if(!window.__coursLastD && typeof coursLiveData==='function') window.__coursLastD = await coursLiveData(); }catch(e){} try{ if(!window.__xcheckAt && typeof runCrossChecks==='function') await runCrossChecks(); }catch(e){} }).catch(() => {});
  // 09/10 (n°10) : ta liste de suivi — mesures du jour et alertes (le contenu reste chiffré, seul un nombre va au journal)
  let wl = null; // 17/10 : null = mesure impossible (les alertes de la liste ne sont alors pas remises à zéro)
  try{ wl = await page.evaluate(async () => { try{ return typeof wlComputeAll==='function' ? await wlComputeAll() : null; }catch(e){ return null; } }); }catch(e){}
  // relevé du jour : températures, probabilités, sources en panne, valeur de ton stock
  const jour = await page.evaluate(() => {
    const o = { t:{}, pv:{}, fails:[], mv:null };
    try{ o.sv = JSON.parse(localStorage.getItem('mt_sv_hist')||'{}'); }catch(e){}
    for(const k of ['traditional','crypto','metals','france','cross']){ try{ const v = svModel(k).temp; if(v!=null && isFinite(v)) o.t[k] = Math.round(v*10)/10; }catch(e){} }
    try{ const R = window.__pv && window.__pv.res; if(R) Object.values(R).forEach(x => { if(!x || x.missing || !x.bear) return; const rel = s => s && s.auc!=null && s.auc >= 0.65;
      o.pv[x.id] = { label: x.label, b: Math.round(x.bear.now.p*100), u: Math.round(x.bull.now.p*100), sb: x.bear.now.sc, su: x.bull.now.sc, baseB: Math.round(x.bear.st.base*100), baseU: Math.round(x.bull.st.base*100), relB: rel(x.bear.st), relU: rel(x.bull.st), phase: x.phase ? x.phase.k : null, dd: x.phase ? Math.round(x.phase.dd) : null }; }); }catch(e){}
    // 09/10 (n°9) : toutes les sources suivies (en échec ou non), pour la santé des sources sur 30 jours
    try{ o.allSrc = [...new Set([...document.querySelectorAll('.fresh-dot.ok, .fresh-dot.fail')].map(el => { const c = el.closest('.card, .gauge-card, [class*=card]'); const k = c && c.querySelector('.k, h3, .title-row'); return ((k && k.textContent) || el.id).replace(/\s+/g,' ').trim().slice(0, 50); }))]; }catch(e){}
    try{ const dots = [...document.querySelectorAll('.fresh-dot.fail')]; o.fails = [...new Set(dots.map(el => { const c = el.closest('.card, .gauge-card, [class*=card]'); const k = c && c.querySelector('.k, h3, .title-row'); return ((k && k.textContent) || el.id).replace(/\s+/g,' ').trim().slice(0, 50); }))]; }catch(e){}
    // 09/10 (n°6) : valeur brute de chaque indicateur (historique « maison », pour pouvoir un jour tester ceux qui n'ont pas d'historique gratuit)
    try{ o.raw = {}; for(const k of ['traditional','crypto','france']){ const R = {}; svModel(k, true).rows.filter(r => !r.info).forEach(r => { const m = String(r.value||'').replace(/\s/g,'').replace(',', '.').match(/[-+−]?\d+(\.\d+)?/); if(m){ const v = parseFloat(m[0].replace('−','-')); if(isFinite(v)) R[r.name] = v; } }); o.raw[k] = R; } }catch(e){}
    // 09/10 (n°8) : de quoi suivre ta règle de DCA en vrai (multiplicateur du jour + cours des ETF)
    try{ const D = window.__coursLastD || {}; const lastV = a => a && a.length ? a[a.length-1].value : null; o.dca = { m: typeof dcaMultiplier==='function' ? dcaMultiplier() : null, rule: typeof dcaRule==='function' ? dcaRule() : null, world: lastV(D.world), spx: lastV(D.spx), btc: window.__marketData?.btc?.price ?? null, gold: window.__marketData?.gold?.price ?? null }; }catch(e){}
    // 09/10 (n°3) : annonces importantes de demain
    try{ const dm = new Date(); dm.setHours(0,0,0,0); dm.setDate(dm.getDate()+1); o.eco = ecoEvents(2).filter(e => +e.date === +dm).map(e => { const K = ECO_KINDS[e.kind] || {}; return { k: e.kind, n: K.name, i: K.ico, imp: K.imp, h: ecoParisTime(e.date, K.et || [8,30]), w: K.why }; }); }catch(e){}
    // 16/10 : résumé « Que faire ce mois-ci ? » (envoyé le 1er du mois)
    try{ o.mois = typeof moisLines==='function' ? moisLines() : null; }catch(e){}
    // 16/10 : pages dont la présentation a changé (mises de côté, source de secours utilisée)
    try{ o.fmt = Object.entries(JSON.parse(localStorage.getItem('mt_format_ko')||'{}')).filter(([, e]) => e && e.n >= 3).map(([k]) => k.split('?')[0].slice(0, 70)); }catch(e){}
    // 17/10 : séries encore anormalement anciennes après les essais de réparation (source d'origine, remplaçante FRED, relais de marché)
    try{ o.retard = typeof getStaleDataList==='function' ? getStaleDataList().map(x => (x.label || x.key).slice(0, 60)) : null; }catch(e){}
    // 09/10 (n°13) : contrôles de cohérence en désaccord
    try{ o.xc = (window.__xcheck || []).filter(x => x && x.ok === false).map(x => x.name.replace(/\s*\(\d{2}\/\d{2}\/\d{4}\)/, '')); }catch(e){}
    // 09/10 (n°10) : bulletin du matin (5 lignes)
    try{ o.matin = typeof matinLines==='function' ? matinLines() : null; }catch(e){}
    try{ if(typeof renderMyMetals==='function') renderMyMetals(); const h = JSON.parse(localStorage.getItem('mt_metals_value_history')||'[]'); const last = h[h.length-1]; if(last && last.date === (typeof parisDay==='function' ? parisDay() : new Date().toISOString().slice(0,10)) && last.value > 0) o.mv = { value: Math.round(last.value*100)/100, cost: last.cost!=null ? Math.round(last.cost*100)/100 : null }; }catch(e){}
    return o;
  });
  // 04/10 (n°10) : bulletin de notes de la Prévision (test honnête + vraies prévisions relevées par le robot)
  try{
    const pvDays = {}; Object.entries(H.days || {}).forEach(([d, x]) => { if(x && x.pv) pvDays[d] = { pv: x.pv }; });
    jour.bul = await page.evaluate(days => { try{ const B = pvBulletin(null, { days }); const o = {}; Object.entries(B).forEach(([id, x]) => { o[id] = { l: x.label, b: x.test.bear ? x.test.bear.note : null, u: x.test.bull ? x.test.bull.note : null, lb: x.live.bear && x.live.bear.note!=null ? x.live.bear.note : null, lu: x.live.bull && x.live.bull.note!=null ? x.live.bull.note : null }; }); return o; }catch(e){ return null; } }, pvDays);
  }catch(e){}
  jour.wl = wl;
  // 17/10 : désaccords entre le prix et les indicateurs (prix sur 3 mois chargés à la demande)
  try{ jour.div = await page.evaluate(async () => { try{ await divCharger(); return divTous(); }catch(e){ return null; } }); }catch(e){}
  // 09/10 (n°12) : liens « Vérifier sur… » contrôlés une fois par semaine (4 à la fois, sans rafale)
  try{
    const L = await page.evaluate(() => { const o = {}; document.querySelectorAll('a[href^="http"]').forEach(a => { if(!/v[ée]rifier/i.test(a.textContent)) return; const c = a.closest('.card, .gauge-card, [class*=card]'); const k = c && c.querySelector('.k, h3, .title-row'); const n = ((k && k.textContent) || a.textContent).replace(/\s+/g,' ').trim().slice(0, 60); if(!o[a.href]) o[a.href] = n; }); return Object.entries(o).map(([u, n]) => ({ u, n: n.split('·')[0].trim() })); });
    // une fois par semaine, ou tout de suite si un lien signalé cassé a été corrigé entre-temps
    if(!H.liens || Date.now() - H.liens.at > 6.5*86400000 || (H.liens.pb || []).some(x => x.c === 'casse' && !L.some(y => y.u === x.u))){
      const pb = []; let i = 0;
      const one = async ({ u, n }) => { try{ const r = await fetch(u, { headers: { 'user-agent': UA, 'accept': 'text/html,*/*', 'accept-language': 'fr-FR,fr;q=0.9' }, redirect: 'follow', signal: AbortSignal.timeout(12000) });
          if(r.status >= 400) pb.push({ n, u, c: [401, 403, 429, 999].includes(r.status) || (r.status === 503 && /cloudflare/i.test(r.headers.get('server')||'')) ? 'bloque' : 'casse', h: 'HTTP ' + r.status });
          try{ await r.body?.cancel(); }catch(e){}
        }catch(e){ const m = String(e && (e.cause && e.cause.code || e.name) || e); pb.push({ n, u, c: /ENOTFOUND|EAI_AGAIN|CERT|ECONNREFUSED/.test(m) ? 'casse' : 'injoignable', h: m.slice(0, 30) }); } };
      await Promise.all([0, 1, 2, 3].map(async () => { while(i < L.length){ const x = L[i++]; await one(x); await new Promise(r => setTimeout(r, 400)); } }));
      const avant = new Set(((H.liens && H.liens.pb) || []).filter(x => x.c === 'casse').map(x => x.u));
      jour.liensNouv = pb.filter(x => x.c === 'casse' && !avant.has(x.u)).map(x => x.n);
      H.liens = { at: Date.now(), n: L.length, pb };
      say(`liens de vérification : ${L.length} contrôlés, ${pb.filter(x => x.c==='casse').length} cassés, ${pb.filter(x => x.c!=='casse').length} refusent les robots ou ne répondent pas`);
    }
  }catch(e){ say('contrôle des liens impossible'); }
  jour.integrite = integrite; jour.avis = avis;
  // 17/10 : pièces dont la prime est anormalement basse (d'après l'historique des relevés précédents)
  try{ jour.affaires = await page.evaluate(() => { try{ return piecesAffaires(); }catch(e){ return null; } }); }catch(e){}
  try{ jour.cibles = await page.evaluate(() => { try{ return piecesCiblesAtteintes(); }catch(e){ return null; } }); }catch(e){} // 23/10 : tes prix cibles par pièce
  // 20/10 : analyse pro : feu de tendance des lignes suivies, tes lignes tracées franchies, retour dans un bloc d'ordres
  try{ jour.pro = await page.evaluate(async () => { try{ return await proAlertesRobot(); }catch(e){ return null; } }); }catch(e){}
  // 24/10 : scanner de marchés et rotation (une fois par jour, une soixantaine de marchés publics, rien de personnel)
  if(Date.now() - t0 < 200000) try{ const r = await page.evaluate(async () => { try{ return await Promise.race([scanLancer(), new Promise(ok => setTimeout(() => ok({ err: 'trop long, repris au prochain passage' }), 180000))]); }catch(e){ return { err: e.message }; } }); if(r && !r.deja) say(`scanner de marchés : ${r.err ? r.err : `${r.ok} marchés lus, ${r.ko} manquants`}`); }catch(e){}
  enregistrer(H, jour);
  const al = alertes(H, jour, subs);
  say(`relevé du jour enregistré (${Object.keys(H.days).length} jours) ; alertes : ${Object.entries(al.counts).map(([k, n]) => k + ' ' + n).join(', ')}`);
  // 16/10 : les notifications partent à la fin, une fois l'état enregistré (plus de doublons si le passage échoue avant)
  const aEnvoyer = al.out.length && !process.env.DIAG ? al.out : [];
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
    const bp = await page.evaluate(() => { const b = window.__pv && window.__pv.res && window.__pv.res.bonprix; return b ? JSON.stringify({ now: b.now && Math.round(b.now.s), zones: b.zones.map(z => z.k+' '+z.n+' '+Math.round(z.g*10)/10), alerte: Math.round((b.alert.g||0)*10)/10 }) : 'absent'; });
    console.log('::notice title=BonPrix::' + esc(bp));
    const noms = await page.evaluate(() => ['traditional','crypto','metals','france','cross'].map(k => { try{ const M = svModel(k); return k + ' : ' + M.fams.map(f => '[' + f.name + '] ' + f.rows.map(r => r.name).join(' | ')).join(' ; '); }catch(e){ return k + ' : ' + e.message; } }).join('\n'));
    console.log('::notice title=Indicateurs::' + esc(noms));
    const repl = await page.evaluate(async () => { const out = []; for(const id of ['TWEXBMTH','DEXUSEU']){ try{ out.push(id + ' → ' + JSON.stringify(await fredFindReplacement(id, true))); }catch(e){ out.push(id + ' : ' + e.message); } } return out.join('\n'); });
    console.log('::notice title=Remplacements FRED::' + esc(repl));
    const bul = (jour && jour.bul) ? Object.values(jour.bul).map(x => `${x.l} ${x.b}/${x.u}`).join(' · ') : 'absent';
    console.log('::notice title=Direct::' + esc(`lectures directes sans intermédiaire : ${direct.ok}, repli : ${direct.repli}\nBulletin : ${bul}`));
  }
  // 16/10 : séries anormalement anciennes → recherche automatique d'une remplaçante (au plus 1 fois/semaine par série ;
  // le résultat, gardé dans mt_fred_repl, est repris par la page) — ici les sites répondent sans passerelle
  // 24/10 : + veille active : fiches FRED relues (toutes les 3 h par série) ; une série retirée ou plus mise à jour par la Fed
  // est recherchée tout de suite, sans attendre le seuil de retard
  try{ const R = await page.evaluate(async () => { let n = 0, v = null; try{ v = await fredVeille(); }catch(e){} try{ getStaleDataList(); for(const p of Object.values(window.__fredReplBusy || {})){ try{ if(await Promise.race([p, new Promise(r => setTimeout(r, 60000))])) n++; }catch(e){} } }catch(e){} return { n, lus: v ? v.lus : 0, sus: v ? v.suspectes : [] }; });
    if(R.sus.length) say(`veille FRED : ${R.lus} fiche(s) relue(s), série(s) retirée(s) ou plus mise(s) à jour par la Fed : ${R.sus.join(', ')}`);
    if(R.n) say(`${R.n} série(s) retirée(s) remplacée(s) automatiquement`); }catch(e){}
  await releves; // 24/10 : relevés lancés en parallèle plus haut (pièces, or, dirigeants, données en plus)
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
  // 17/10 : les notifications sont seulement PRÉPARÉES ici (fichier chiffré envoi.enc, hors du site) ; elles partent
  // dans l'étape suivante du workflow (envoyer.mjs), une fois l'état réellement enregistré sur la branche site.
  if(aEnvoyer.length){ writeFileSync('envoi.enc', await chiffre(key, JSON.stringify(aEnvoyer))); say(`notifications préparées : ${aEnvoyer.length}`); }
  writeFileSync('out/historique.enc', await chiffre(key, JSON.stringify(H)));
  // 17/10 : accès invité (second mot de passe choisi dans Réglages). Fichiers chiffrés avec le mot de passe invité, en lecture
  // seule, sans tes clés d'accès aux sites, avec seulement ce que tu as choisi de montrer. Accès coupé = fichiers non écrits.
  try{
    const I = perso.mt_invite ? JSON.parse(perso.mt_invite) : null;
    if(I && I.actif && typeof I.pw === 'string' && I.pw.length >= 8){
      const sansCles = html.replace(/\(\/\*__CLES_API__\*\/\{[^)]*\}\)/, '(/*__CLES_API__*/{})');
      if(sansCles === html && !html.includes('(/*__CLES_API__*/{})')){ say('accès invité : en attente de la prochaine publication de l\'appli'); }
      else {
        const kg = await cle(I.pw, JSON.parse(readFileSync('sel.json', 'utf8'))), voir = Object.assign({ metaux:false, plan:false, suivi:false }, I.voir || {});
        const montre = k => /^mt_(temp_exclus|temp_util|ind_hidden)$/.test(k) || (voir.metaux && /^mt_(metals_(or|argent|cuivre)|metal_objectif_|metals_value_history|pieces_choix|pieces_cibles)/.test(k))
          || (voir.plan && /^mt_(dca_plan|fonds_euros|trad_rule)$/.test(k)) || (voir.suivi && /^mt_(watchlist|pro_dessins)$/.test(k));
        const persoG = Object.fromEntries(Object.entries(perso).filter(([k]) => montre(k)));
        const HG = { v: 1, days: {}, bul: H.bul, bulHist: H.bulHist, sante: H.sante, liens: H.liens, ...(voir.plan ? { dca: H.dca, dcaLast: H.dcaLast, matin: H.matin } : {}), ...(voir.suivi ? { wlv: H.wlv } : {}) };
        Object.entries(H.days || {}).forEach(([d, x]) => { if(!x) return; const { mv, ...reste } = x; HG.days[d] = voir.metaux && mv ? { ...reste, mv } : reste; });
        writeFileSync('out/invite-app.enc', await chiffre(kg, sansCles));
        // liste de suivi non partagée : rien qui la révèle (analyses mt_wl_…, données en cache portant un de ses codes)
        let codes = []; try{ codes = JSON.parse(perso.mt_watchlist || '[]').map(x => x && x.s).filter(s => s && s.length >= 3); }catch(e){}
        const cache = o => voir.suivi ? o : Object.fromEntries(Object.entries(o || {}).filter(([k]) => !/^mt_wl_/.test(k) && !codes.some(s => k.includes(s))));
        writeFileSync('out/invite-data.enc', await chiffre(kg, JSON.stringify({ v: 1, at: snap.at, ls: cache(snap.ls), idb: cache(snap.idb), perso: persoG, invite: voir })));
        writeFileSync('out/invite-hist.enc', await chiffre(kg, JSON.stringify(HG)));
        say('accès invité : fichiers préparés');
      }
    }
  }catch(e){ say('accès invité : préparation impossible'); }
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
