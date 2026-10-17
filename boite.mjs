// 17/10 : range dans la branche « coffre » ce que tes appareils ont déposé dans la boîte aux lettres du relais Cloudflare.
// Les appareils n'ont ainsi plus besoin de jeton GitHub pour synchroniser. Ce qui ne se déchiffre pas avec ton mot de
// passe est ignoré (personne d'autre ne peut fabriquer un contenu valable). Fusion donnée par donnée, la plus récente gagne.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { cle, chiffre, dechiffre } from './chiffre.mjs';
const { MOT_DE_PASSE, GH_TOKEN, REPO } = process.env;
const say = m => console.log('boîte aux lettres : ' + m);
if(!MOT_DE_PASSE || !GH_TOKEN){ say('rien à faire'); process.exit(0); }
const key = await cle(MOT_DE_PASSE, JSON.parse(readFileSync('sel.json', 'utf8')));
const BOITE = 'https://carnet-relais.tiranno06.workers.dev/boite/';
const api = (p, o = {}) => fetch(`https://api.github.com/repos/${REPO}/${p}`, { ...o, headers: { Authorization: 'Bearer ' + GH_TOKEN, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' } });
const lireBoite = async nom => { try{ const r = await fetch(BOITE + nom, { signal: AbortSignal.timeout(20000) }); if(!r.ok) return null; return JSON.parse(await dechiffre(key, await r.text())); }catch(e){ return null; } };
const lireFichier = async f => { try{ return existsSync(f) ? JSON.parse(await dechiffre(key, readFileSync(f, 'utf8'))) : null; }catch(e){ return null; } };
const AUTO = k => k === 'mt_metals_value_history';
function hist(a, b){ const m = {}, put = h => { if(!h || !h.date) return; const o = m[h.date]; if(!o || (o.robot && !h.robot)) m[h.date] = h; };
  let A = [], B = []; try{ A = JSON.parse(a || '[]'); }catch(e){} try{ B = JSON.parse(b || '[]'); }catch(e){}
  (Array.isArray(A) ? A : []).forEach(put); (Array.isArray(B) ? B : []).forEach(put); return JSON.stringify(Object.keys(m).sort().slice(-730).map(d => m[d])); }
function combine(a, b){ // même règle que gmsCombine dans l'appli
  if(!a) return b; if(!b) return a;
  const A = a.data || {}, B = b.data || {}, AK = a.kat || {}, BK = b.kat || {}, data = {}, kat = {};
  for(const k of new Set([...Object.keys(A), ...Object.keys(B), ...Object.keys(AK), ...Object.keys(BK)])){
    if(k === 'mt_gh_token' || k === 'mt_gh_token_at') continue;
    if(AUTO(k)){ const v = hist(A[k], B[k]); if(v !== '[]') data[k] = v; continue; }
    const ta = +AK[k] || 0, tb = +BK[k] || 0, S = tb > ta ? [B, tb] : [A, ta];
    if(k in S[0]) data[k] = S[0][k]; else if(k in A) data[k] = A[k]; else if(k in B) data[k] = B[k];
    if(S[1]) kat[k] = S[1];
  }
  const ta = +(A.mt_gh_token_at || 0), tb = +(B.mt_gh_token_at || 0), T = tb > ta ? B : A; if(T.mt_gh_token){ data.mt_gh_token = T.mt_gh_token; data.mt_gh_token_at = T.mt_gh_token_at; }
  return { v: 2, at: Math.max(+a.at || 0, +b.at || 0), data, kat };
}
function subs(a, b){ const m = {}; [...((a && a.subs) || []), ...((b && b.subs) || [])].forEach(s => { if(!s || !s.id) return; const o = m[s.id]; if(!o || (+s.at || 0) >= (+o.at || 0)) m[s.id] = s; }); return { v: 1, at: Math.max(+(a && a.at) || 0, +(b && b.at) || 0), subs: Object.values(m) }; }
async function ranger(nom, fichier, fusion){
  const boite = await lireBoite(nom); if(!boite){ say(`${nom} : rien de nouveau`); return; }
  const actuel = await lireFichier(fichier), nouveau = fusion(actuel, boite);
  if(actuel && JSON.stringify(nouveau) === JSON.stringify(actuel)){ say(`${nom} : déjà rangé`); return; }
  const enc = await chiffre(key, JSON.stringify(nouveau));
  for(let essai = 0; essai < 3; essai++){
    const g = await api(`contents/${fichier}?ref=coffre`); const sha = g.ok ? (await g.json()).sha : undefined;
    const r = await api(`contents/${fichier}`, { method: 'PUT', body: JSON.stringify({ message: nom, branch: 'coffre', content: Buffer.from(enc).toString('base64'), ...(sha ? { sha } : {}) }) });
    if(r.ok){ writeFileSync(fichier, enc); say(`${nom} : rangé dans la branche coffre`); return; }
    if(r.status !== 409 && r.status !== 422){ say(`${nom} : écriture refusée (${r.status})`); return; }
  }
  say(`${nom} : conflit, nouvel essai au prochain passage`);
}
await ranger('coffre', 'coffre.enc', combine);
await ranger('abonnements', 'abonnements.enc', subs);
