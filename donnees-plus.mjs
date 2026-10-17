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
