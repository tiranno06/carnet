// 17/10 : données relevées par le robot (côté serveur) parce que les navigateurs ne peuvent pas les lire directement :
// - or des banques centrales : stocks déclarés au FMI, pays par pays, chaque mois (achats nets en tonnes) ;
// - or des ETF : stock d'or du plus grand fonds (SPDR GLD), chaque jour depuis 2004 ;
// - achats et ventes des dirigeants d'entreprises américaines (déclarations officielles, via openinsider.com).
import { inflateRawSync } from 'node:zlib';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const OZ_T = 32150.7466; // onces dans une tonne
const lire = async (url, binaire) => { const r = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(90000) }); if(!r.ok) throw new Error(url.split('/')[2] + ' ' + r.status); return binaire ? Buffer.from(await r.arrayBuffer()) : r.text(); };
const moisPlus = (k, n) => { const [y, m] = k.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7); };

// ---- or des banques centrales (FMI, données IRFCL : volume d'or en onces) ----
export async function releveOrBanques(){
  const t = await lire('https://api.imf.org/external/sdmx/2.1/data/IMF.STA,IRFCL/.IRFCLDT1_IRFCL56V_FTO.S1XS1311.M?startPeriod=2005-01');
  const net = {}, pays = {}, exclus = [];
  for(const [, a, b] of t.matchAll(/<Series ([^>]*)>([\s\S]*?)<\/Series>/g)){
    const c = (a.match(/COUNTRY="([^"]+)"/) || [])[1]; if(!c || !/^[A-Z]{3}$/.test(c)) continue; // pas les regroupements (zone euro…)
    const o = [...b.matchAll(/TIME_PERIOD="(\d{4})-M(\d{2})"[^>]*OBS_VALUE="([^"]+)"/g)].map(m => [m[1] + '-' + m[2], +m[3]]).sort();
    if(!o.length || Math.max(...o.map(x => x[1])) > 3e8){ exclus.push(c); continue; } // unité visiblement fausse (plus que les États-Unis)
    for(let i = 1; i < o.length; i++){ const [ka, va] = o[i - 1], [kb, vb] = o[i];
      if(va <= 0 || moisPlus(ka, 1) !== kb) continue;
      if(Math.abs(vb / va - 1) > 0.25 && Math.abs(vb - va) > 2e6) continue; // saut aberrant (changement de méthode)
      net[kb] = (net[kb] || 0) + (vb - va) / OZ_T; pays[kb] = (pays[kb] || 0) + 1; }
  }
  const ks = Object.keys(net).sort(); if(ks.length < 60) throw new Error('FMI : historique trop court');
  // le dernier mois n'est gardé que si assez de pays ont déjà répondu (sinon il paraîtrait faussement faible)
  const ref = Math.max(...ks.slice(-14, -2).map(k => pays[k])); while(ks.length && pays[ks[ks.length - 1]] < ref * 0.85) ks.pop();
  const mois = {}; ks.forEach(k => { mois[k] = Math.round(net[k] * 10) / 10; });
  return { at: Date.now(), mois, pays: pays[ks[ks.length - 1]], exclus: exclus.length };
}

// ---- or des ETF (fichier Excel du SPDR Gold Trust) ----
// .xlsx = archive zip : on lit les textes partagés et les feuilles, puis la colonne « Tonnes of Gold »
function zipFichiers(buf){
  const out = {}; let e = -1;
  for(let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) if(buf.readUInt32LE(i) === 0x06054b50){ e = i; break; }
  if(e < 0) throw new Error('fichier Excel illisible');
  let p = buf.readUInt32LE(e + 16); const n = buf.readUInt16LE(e + 10);
  for(let k = 0; k < n; k++){
    const meth = buf.readUInt16LE(p + 10), cs = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const nom = buf.subarray(p + 46, p + 46 + nl).toString('utf8'), deb = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28), d = buf.subarray(deb, deb + cs);
    if(/^xl\/(sharedStrings|worksheets\/sheet\d+)\.xml$/.test(nom)) out[nom] = (meth === 0 ? d : inflateRawSync(d)).toString('utf8');
    p += 46 + nl + xl + cl;
  }
  return out;
}
const MOIS_EN = { Jan:1, Feb:2, Mar:3, Apr:4, May:5, Jun:6, Jul:7, Aug:8, Sep:9, Oct:10, Nov:11, Dec:12 };
export function lireGld(buf){
  const F = zipFichiers(buf), ss = [...(F['xl/sharedStrings.xml'] || '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => m[1].replace(/<[^>]+>/g, ''));
  const val = c => { const v = (c.match(/<v>([^<]*)<\/v>/) || [])[1]; if(v == null) return (c.match(/<t[^>]*>([^<]*)<\/t>/) || [])[1] ?? null; return /t="s"/.test(c) ? ss[+v] : v; };
  for(const [nom, x] of Object.entries(F)){ if(!nom.includes('worksheets')) continue;
    let iT = -1; const jours = [];
    for(const [, ligne] of x.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)){
      const cel = [...ligne.matchAll(/<c r="([A-Z]+)\d+"([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)].map(m => ({ col: m[1], v: val(m[2] + '>' + (m[3] || '')) }));
      if(iT < 0){ const h = cel.find(c => /Tonnes of Gold/i.test(c.v || '')); if(h) iT = h.col; continue; }
      const d = (cel.find(c => c.col === 'A') || {}).v, t = parseFloat((cel.find(c => c.col === iT) || {}).v);
      const m = String(d || '').match(/^(\d{1,2})-([A-Z][a-z]{2})-(\d{4})$/); if(!m || !isFinite(t) || t <= 0) continue;
      jours.push([`${m[3]}-${String(MOIS_EN[m[2]]).padStart(2, '0')}-${m[1].padStart(2, '0')}`, t]);
    }
    if(jours.length > 1000){ const mois = {}; jours.forEach(([d, t]) => { mois[d.slice(0, 7)] = Math.round(t * 10) / 10; }); return { mois, recents: jours.slice(-40).map(([d, t]) => [d, Math.round(t * 10) / 10]) }; }
  }
  throw new Error('GLD : colonne des tonnes introuvable');
}
export async function releveOrEtf(){ return { at: Date.now(), ...lireGld(await lire('https://api.spdrgoldshares.com/api/v1/historical-archive?product=gld&exchange=NYSE&lang=en', true)) }; }

// ---- achats et ventes des dirigeants (openinsider.com) ----
function lignesInities(h){
  const out = [];
  for(const [, tr] of h.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)){
    const td = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim());
    // la colonne « Trade Type » change de place selon la page (colonnes société et secteur en plus sur les listes du marché)
    const iT = td.findIndex(x => /^[PS] - /.test(x)); if(iT < 6 || td.length < iT + 6) continue;
    out.push({ d: td[2], s: td[3].split(/[>\s]/).pop(), qui: td[iT - 2], t: td[iT][0], v: Math.abs(parseFloat(td[iT + 5].replace(/[$,+]/g, ''))) || 0 });
  }
  return out;
}
// tout le marché : nombre d'achats et de ventes déclarés sur 7 jours (le rapport achats / total est gardé semaine après semaine)
export async function releveInitiesMarche(avant){
  const [p, s] = await Promise.all(['xp=1', 'xs=1'].map(q => lire(`http://openinsider.com/screener?s=&fd=7&${q}&cnt=2000`).then(lignesInities)));
  const nP = p.filter(x => x.t === 'P').length, nS = s.filter(x => x.t === 'S').length; if(nP + nS < 20) throw new Error('openinsider : trop peu de lignes');
  const jour = new Date().toISOString().slice(0, 10), hist = ((avant && avant.hist) || []).filter(x => x.d < jour).slice(-160);
  if(!hist.length || Date.parse(jour) - Date.parse(hist[hist.length - 1].d) >= 6.5 * 86400000) hist.push({ d: jour, p: nP, s: nS });
  return { at: Date.now(), p: nP, s: nS, vp: Math.round(p.filter(x => x.t === 'P').reduce((a, x) => a + x.v, 0)), vs: Math.round(s.filter(x => x.t === 'S').reduce((a, x) => a + x.v, 0)), hist };
}
// actions américaines de ta liste de suivi : achats et ventes des 6 derniers mois (les ETF n'ont pas de dirigeants : ignorés)
export async function releveInitiesListe(symboles){
  const out = { at: Date.now(), s: {} };
  for(const s of symboles.filter(x => /^[A-Z]{1,5}$/.test(x)).slice(0, 15)){
    try{ const L = lignesInities(await lire(`http://openinsider.com/screener?s=${s}&fd=182&xp=1&xs=1&cnt=500`)).filter(x => x.s === s);
      const P = L.filter(x => x.t === 'P'), S = L.filter(x => x.t === 'S');
      out.s[s] = { p: P.length, s: S.length, vp: Math.round(P.reduce((a, x) => a + x.v, 0)), vs: Math.round(S.reduce((a, x) => a + x.v, 0)), der: P.length ? P[0].d : null, qui: P.length ? P[0].qui.slice(0, 60) : null };
    }catch(e){}
    await new Promise(r => setTimeout(r, 1200));
  }
  return out;
}

// ---- défaillances d'entreprises en France (INSEE, nombre mensuel corrigé des variations saisonnières) ----
export async function releveDefaillances(){
  const t = await lire('https://bdm.insee.fr/series/sdmx/data/SERIES_BDM/001656092?startPeriod=2005-01');
  const mois = {}; for(const m of t.matchAll(/TIME_PERIOD="(\d{4}-\d{2})" OBS_VALUE="([\d.]+)"/g)) mois[m[1]] = +m[2];
  if(Object.keys(mois).length < 120) throw new Error('INSEE : historique trop court');
  return { at: Date.now(), mois };
}

// ---- Europe et France (17/10) : inflation hors tabac (INSEE), €STR, stress financier (BCE), taux des crédits immobiliers ----
async function bce(cle){
  const t = await lire(`https://data-api.ecb.europa.eu/service/data/${cle}?format=csvdata`), L = t.trim().split(/\r?\n/), h = L[0].split(','), iT = h.indexOf('TIME_PERIOD'), iV = h.indexOf('OBS_VALUE');
  if(iT < 0 || iV < 0) throw new Error('BCE : format inattendu'); return L.slice(1).map(l => l.split(',')).map(c => [c[iT], +c[iV]]).filter(x => x[0] && isFinite(x[1]));
}
const moyMois = rows => { const S = {}, N = {}; rows.forEach(([d, v]) => { const k = d.slice(0, 7); S[k] = (S[k] || 0) + v; N[k] = (N[k] || 0) + 1; }); const o = {}; Object.keys(S).forEach(k => { o[k] = Math.round(S[k] / N[k] * 10000) / 10000; }); return o; };
export async function releveEurope(){
  const o = { at: Date.now() };
  try{ const t = await lire('https://bdm.insee.fr/series/sdmx/data/SERIES_BDM/011814056'); const m = {}; for(const x of t.matchAll(/TIME_PERIOD="(\d{4}-\d{2})" OBS_VALUE="([\d.]+)"/g)) m[x[1]] = +x[2]; if(Object.keys(m).length > 200) o.ipc = m; }catch(e){}
  try{ const r = await bce('EST/B.EU000A2X2A25.WT'); o.estr = moyMois(r); o.estrDer = r[r.length - 1]; }catch(e){}
  try{ const r = await bce('CISS/D.U2.Z0Z.4F.EC.SS_CIN.IDX'); o.ciss = moyMois(r); o.cissDer = r[r.length - 1]; }catch(e){}
  try{ const r = await bce('MIR/M.FR.B.A2C.A.R.A.2250.EUR.N'); o.immo = Object.fromEntries(r); }catch(e){}
  if(!o.ipc && !o.estr && !o.ciss && !o.immo) throw new Error('INSEE et BCE injoignables');
  return o;
}

// ---- 23/10 : nouvelles données (relevées une fois par jour, chacune de son côté ; prev = relevé précédent, pour garder l'historique accumulé) ----
// taux à 1 an de la zone euro (BCE), confiance des ménages, climat des affaires, prix des logements anciens (INSEE), prix à la pompe
// en France (bulletin pétrolier hebdomadaire de la Commission européenne), prix de l'or à Shanghai (SGE), or et argent dans les coffres
// de Londres (LBMA), réseau Bitcoin (blockchain.info), dollars numériques (DefiLlama), taux de financement des paris sur le Bitcoin (OKX),
// part du Bitcoin dans toute la crypto (CoinGecko, notée chaque jour)
const insee = async id => { const t = await lire(`https://bdm.insee.fr/series/sdmx/data/SERIES_BDM/${id}?startPeriod=1990-01`), o = {};
  for(const m of t.matchAll(/TIME_PERIOD="(\d{4}-(?:\d{2}|Q\d))" OBS_VALUE="([\d.\-]+)"/g)) o[m[1]] = +m[2]; if(Object.keys(o).length < 40) throw new Error('INSEE ' + id + ' : trop court'); return o; };
const garder = (o, n) => Object.fromEntries(Object.entries(o).sort((a, b) => a[0] < b[0] ? -1 : 1).slice(-n));
export function lireCarburants(buf){ // feuille « Prices with taxes » : colonnes FR_price_with_tax_euro95 et _diesel, en € pour 1 000 litres
  const F = zipFichiers(buf), ss = [...(F['xl/sharedStrings.xml'] || '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => m[1].replace(/<[^>]+>/g, ''));
  const x = F['xl/worksheets/sheet1.xml']; if(!x) throw new Error('bulletin pétrolier illisible');
  let cE = null, cD = null; const out = [];
  for(const [, ligne] of x.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)){
    const cel = {}; for(const m of ligne.matchAll(/<c r="([A-Z]+)\d+"([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)){ const v = ((m[3] || '').match(/<v>([^<]*)<\/v>/) || [])[1]; if(v != null) cel[m[1]] = /t="s"/.test(m[2]) ? ss[+v] : v; }
    if(!cE){ for(const [c, v] of Object.entries(cel)){ if(v === 'FR_price_with_tax_euro95') cE = c; if(v === 'FR_price_with_tax_diesel') cD = c; } continue; }
    const j = +cel.A, e = parseFloat(cel[cE]), d = parseFloat(cel[cD]); if(!(j > 30000 && j < 80000) || !(e > 300)) continue;
    out.push([new Date(Date.UTC(1899, 11, 30) + j*86400000).toISOString().slice(0, 10), +(e/1000).toFixed(3), isFinite(d) ? +(d/1000).toFixed(3) : null]);
  }
  if(out.length < 200) throw new Error('prix à la pompe : historique trop court'); return out.sort((a, b) => a[0] < b[0] ? -1 : 1);
}
export async function releveNouveaux(prev){
  const o = { ...(prev || {}) }, vieux = (k, h = 20) => !o[k] || !o[k].at || Date.now() - o[k].at > h*3600000, err = [];
  const essai = async (k, f, h) => { if(!vieux(k, h)) return; try{ o[k] = { ...(await f(o[k])), at: Date.now() }; }catch(e){ err.push(k + ' : ' + e.message); } };
  await essai('eu1a', async () => { const r = await bce('YC/B.U2.EUR.4F.G_N_A.SV_C_YM.SR_1Y'); return { mois: moyMois(r), der: r[r.length - 1] }; });
  await essai('insee', async () => ({ menages: await insee('001587668'), affaires: await insee('001565530'), logements: await insee('010567059') }));
  await essai('carbu', async () => ({ sem: lireCarburants(await lire('https://energy.ec.europa.eu/document/download/906e60ca-8b6a-44e7-8589-652854d2fd3f_en?filename=Weekly_Oil_Bulletin_Prices_History_maticni_4web.xlsx', true)).slice(-1100) }), 70);
  await essai('sge', async () => { const r = await fetch('https://en.sge.com.cn/graph/DayilyJzj', { method: 'POST', headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded' }, body: 'start=&end=', signal: AbortSignal.timeout(60000) });
    if(!r.ok) throw new Error('SGE ' + r.status); const d = await r.json(), z = (d.zp || []).filter(x => x && x[1] > 0).map(x => [new Date(x[0] + 8*3600000).toISOString().slice(0, 10), x[1]]);
    if(z.length < 500) throw new Error('SGE : historique trop court'); return { jours: z.slice(-2600) }; });
  await essai('lbma', async p => { const t = (await lire('https://www.lbma.org.uk/prices-and-data/london-vault-data')).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    const m = t.match(/As at end (\w+) (\d{4}), the amount of gold held in London vaults was ([\d,.]+) tonnes(?: \(a ([\d.]+)% (increase|decrease))?[\s\S]{0,300}?([\d,.]+) tonnes of silver(?: \(a ([\d.]+)% (increase|decrease))?/i); if(!m) throw new Error('LBMA : page changée');
    const mo = { january:1, february:2, march:3, april:4, may:5, june:6, july:7, august:8, september:9, october:10, november:11, december:12 }[m[1].toLowerCase()]; if(!mo) throw new Error('LBMA : mois illisible');
    const k = `${m[2]}-${String(mo).padStart(2, '0')}`, hist = { ...((p && p.hist) || {}) }; const pc = (v, sens) => v == null ? null : (sens === 'decrease' ? -1 : 1)*+v; hist[k] = { or: +m[3].replace(/,/g, ''), orPc: pc(m[4], m[5]), ag: +m[6].replace(/,/g, ''), agPc: pc(m[7], m[8]) }; return { hist: garder(hist, 240) }; });
  await essai('btc', async () => { const ch = async n => { const d = JSON.parse(await lire(`https://api.blockchain.info/charts/${n}?timespan=3years&format=json&sampled=true`)); return (d.values || []).map(v => [new Date(v.x*1000).toISOString().slice(0, 10), +(+v.y).toPrecision(5)]); };
    return { hash: await ch('hash-rate'), frais: await ch('transaction-fees-usd'), adr: await ch('n-unique-addresses') }; });
  await essai('stable', async () => { const d = JSON.parse(await lire('https://stablecoins.llama.fi/stablecoincharts/all')), L = d.map(x => [new Date(+x.date*1000).toISOString().slice(0, 10), Math.round((x.totalCirculatingUSD && x.totalCirculatingUSD.peggedUSD) || 0)/1e6]).filter(x => x[1] > 0);
    if(L.length < 365) throw new Error('DefiLlama : historique trop court'); const mois = {}; L.forEach(([d, v]) => { mois[d.slice(0, 7)] = Math.round(v); }); return { mois, jours: L.slice(-400).map(([d, v]) => [d, Math.round(v)]) }; });
  await essai('fin', async () => { const d = JSON.parse(await lire('https://www.okx.com/api/v5/public/funding-rate-history?instId=BTC-USDT-SWAP&limit=100')), L = (d.data || []).map(x => [+x.fundingTime, +x.realizedRate || +x.fundingRate]).filter(x => isFinite(x[1])).sort((a, b) => a[0] - b[0]);
    if(L.length < 20) throw new Error('OKX : trop peu de relevés'); return { pts: L.map(([t, r]) => [new Date(t).toISOString().slice(0, 16), +(r*100).toFixed(5)]) }; }, 6);
  await essai('dom', async p => { const d = JSON.parse(await lire('https://api.coingecko.com/api/v3/global')).data, b = d && d.market_cap_percentage && d.market_cap_percentage.btc; if(!(b > 0)) throw new Error('CoinGecko : part du Bitcoin absente');
    const hist = { ...((p && p.hist) || {}) }; hist[new Date().toISOString().slice(0, 10)] = +b.toFixed(2); return { hist: garder(hist, 1100), stable: d.market_cap_percentage.usdt != null ? +(d.market_cap_percentage.usdt + (d.market_cap_percentage.usdc || 0)).toFixed(2) : null }; }, 12);
  // 30/10 : liquidations sur le Bitcoin (OKX ne donne que les dernières 24 h : le robot additionne jour par jour, à chaque passage)
  await essai('liq', async p => liqReleve(p), 0.2);
  // 30/10 : ton des communiqués de la Fed et de la BCE (mots qui poussent vers des taux plus hauts ou plus bas), relu toutes les 6 h
  await essai('ton', async p => tonReleve(p), 6);
  return { o, err };
}
const jourParis = t => new Date(t).toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
async function liqReleve(p){
  const prev = p || {}, j = { ...(prev.j || {}) }, inc = new Set(prev.inc || []), der0 = prev.der || 0, maint = Date.now();
  let der = der0, plusVieux = Infinity;
  // contrat USDT : 0,01 BTC (valeur = taille × 0,01 × prix) ; contrat USD : 100 $ par contrat
  for(const [uly, val] of [['BTC-USDT', (sz, px) => sz*0.01*px], ['BTC-USD', sz => sz*100]]){
    let apres = null, fin = false;
    for(let page = 0; page < 70 && !fin; page++){
      const d = JSON.parse(await lire(`https://www.okx.com/api/v5/public/liquidation-orders?instType=SWAP&uly=${uly}&state=filled&limit=100` + (apres ? `&after=${apres}` : '')));
      if(d.code !== '0') throw new Error('OKX liquidations : ' + (d.msg || d.code));
      const L = (d.data && d.data[0] && d.data[0].details) || []; if(!L.length) break;
      for(const x of L){ const t = +x.ts; if(t <= der0){ fin = true; continue; } const v = val(+x.sz, +x.bkPx); if(!(v > 0)) continue;
        const k = jourParis(t), c = j[k] || (j[k] = { l: 0, s: 0 }); x.posSide === 'long' ? c.l += v : c.s += v; der = Math.max(der, t); plusVieux = Math.min(plusVieux, t); }
      apres = Math.min(...L.map(x => +x.ts)); await new Promise(r => setTimeout(r, 150));
    }
  }
  // journées pas entièrement couvertes (premier relevé, ou robot arrêté plus de 24 h) : marquées incomplètes
  const debut = der0 || (isFinite(plusVieux) ? plusVieux : maint);
  if(!der0) inc.add(jourParis(debut));
  else if(isFinite(plusVieux) && plusVieux - der0 > 3600000){ for(let t = der0; t <= plusVieux; t += 3600000) inc.add(jourParis(t)); inc.add(jourParis(plusVieux)); }
  Object.values(j).forEach(c => { c.l = Math.round(c.l); c.s = Math.round(c.s); });
  const jj = garder(j, 800), garde = new Set(Object.keys(jj));
  return { j: jj, inc: [...inc].filter(k => garde.has(k)).sort(), der: Math.max(der, der0), debut: prev.debut || debut };
}

// ---- ton des banques centrales (30/10) : chaque communiqué de décision est lu une seule fois, puis gardé ----
// mots et expressions comptés (en anglais, langue des communiqués) ; « ferme » = vers des taux plus hauts, « accommodant » = vers des taux plus bas
// décisions sur les taux (comptent triple) puis vocabulaire ; mots de simple description répétés à chaque communiqué écartés (ex. « purchase programme » de la BCE)
export const TON_DEC_HAUT = /decided (?:today )?to (?:raise|increase) (?:the target range|the three key|the key ecb|the interest rates?|the deposit facility)/g;
export const TON_DEC_BAS = /decided (?:today )?to (?:lower|reduce|cut) (?:the target range|the three key|the key ecb|the interest rates?|the deposit facility)/g;
export const TON_FERME = ['additional policy firming', 'further policy firming', 'tighten', 'sufficiently restrictive', 'remains elevated', 'elevated inflation', 'upside risks to inflation', 'upside risks to the inflation',
  'inflationary pressures', 'price pressures', 'vigilant', 'robust', 'strong', 'solid pace', 'remains tight', 'tight labour market', 'tight labor market', 'wage growth', 'reduce its holdings', 'end net asset purchases',
  'end net purchases', 'too high for too long', 'reducing its holdings'];
export const TON_DOUX = ['accommodative', 'accommodation', 'easing', 'downside risks', 'weakened', 'weakening', 'slowed', 'slowing', 'moderated', 'softened', 'has moved up', 'risks to employment', 'support the economy',
  'net asset purchases', 'net purchases under', 'increase its holdings', 'patient', 'subdued', 'disinflation', 'inflation has eased', 'subsided', 'muted', 'uncertainties', 'act as appropriate to sustain'];
const tonTexte = h => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#8217;|&rsquo;|’/g, "'").replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ');
export function tonMesure(t){
  t = t.toLowerCase(); const compte = L => { const o = {}; L.forEach(m => { const n = t.split(m).length - 1; if(n) o[m] = n; }); return o; };
  const f = compte(TON_FERME), d = compte(TON_DOUX);
  if(d['net asset purchases'] && f['end net asset purchases']) d['net asset purchases'] -= f['end net asset purchases']; Object.keys(d).forEach(k => { if(d[k] <= 0) delete d[k]; });
  const h = (t.match(TON_DEC_HAUT) || []).length + (t.match(/will be (?:increased|raised) by \d+ basis points/g) || []).length, b = (t.match(TON_DEC_BAS) || []).length + (t.match(/will be (?:decreased|lowered|reduced) by \d+ basis points/g) || []).length, dec = h > b ? 1 : b > h ? -1 : 0;
  const nf = Object.values(f).reduce((x, y) => x + y, 0) + 3*h, nd = Object.values(d).reduce((x, y) => x + y, 0) + 3*b;
  // + 4 au dénominateur : un communiqué avec très peu de mots repérés reste proche de zéro au lieu de sauter à ±100
  return { s: Math.round((nf - nd) / (nf + nd + 4) * 100), nf, nd, dec, mf: (h ? ['hausse de taux décidée'] : []).concat(Object.keys(f)), md: (b ? ['baisse de taux décidée'] : []).concat(Object.keys(d)) };
}
async function tonReleve(p){
  const prev = p || {}, fed = { ...(prev.fed || {}) }, bce = { ...(prev.bce || {}) }, an = new Date().getUTCFullYear(); let nouveaux = 0;
  const pause = () => new Promise(r => setTimeout(r, 300));
  // Fed : calendrier (5 dernières années) + archives depuis 2018
  const liensFed = new Set(); const ajFed = h => (h.match(/\/newsevents\/pressreleases\/monetary\d{8}a\.htm/g) || []).forEach(x => liensFed.add(x));
  ajFed(await lire('https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm'));
  for(let y = 2018; y <= an - 5; y++){ try{ ajFed(await lire(`https://www.federalreserve.gov/monetarypolicy/fomchistorical${y}.htm`)); }catch(e){} await pause(); }
  for(const u of [...liensFed].sort()){ const d = u.match(/(\d{4})(\d\d)(\d\d)a/), k = `${d[1]}-${d[2]}-${d[3]}`; if(fed[k] || k < '2018' || nouveaux >= 40) continue;
    try{ const t = tonTexte(await lire('https://www.federalreserve.gov' + u)); if(!/federal funds rate/i.test(t)) continue; const a = t.indexOf('Share'), b = t.search(/Voting for/i);
      fed[k] = tonMesure(t.slice(a > 0 && a < 2000 ? a : 0, b > 0 ? b : undefined)); nouveaux++; }catch(e){} await pause(); }
  // BCE : décisions de politique monétaire depuis 2017 (une page par année)
  for(let y = 2017; y <= an; y++){ let h = ''; try{ h = await lire(`https://www.ecb.europa.eu/press/govcdec/mopo/${y}/html/index_include.en.html`); }catch(e){ continue; }
    for(const u of [...new Set(h.match(/\/press\/pr\/date\/\d{4}\/html\/ecb\.mp\d{6}[^"]*\.en\.html/g) || [])].sort()){ const d = u.match(/mp(\d\d)(\d\d)(\d\d)/), k = `20${d[1]}-${d[2]}-${d[3]}`; if(bce[k] || nouveaux >= 40) continue;
      try{ const t = tonTexte(await lire('https://www.ecb.europa.eu' + u)); const a = t.search(/PRESS RELEASE/), b = t.search(/(CONTACT|Media contacts|Reproduction is permitted)/); if(!/interest rate/i.test(t)) continue;
        bce[k] = tonMesure(t.slice(a > 0 ? a : 0, b > a ? b : undefined)); nouveaux++; }catch(e){} await pause(); }
    await pause(); }
  if(Object.keys(fed).length < 10 && Object.keys(bce).length < 10) throw new Error('communiqués des banques centrales illisibles');
  return { fed, bce };
}
