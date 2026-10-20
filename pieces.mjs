// 17/10 : prix affichés de pièces d'or courantes chez plusieurs marchands français (relevés par le robot, côté serveur).
// Chaque marchand a sa façon d'écrire ses prix : données structurées « price » des pages produits, ou liste de la catégorie.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
export const PIECES = [
  { id:'napoleon20', nom:'Napoléon 20 Francs', fin:5.806, s:{ aucoffre:['or/napoleon', /^Napoléon 20F$/], bdor:'20-francs-napoleon-or', abacor:'piece-d-or-20-francs-napoleon' } },
  { id:'demiNapoleon', nom:'Demi-Napoléon 10 Francs', fin:2.903, s:{ aucoffre:['or/napoleon', /^Demi-Napoléon 10F$/], bdor:'10-francs-napoleon-or', abacor:'piece-d-or-10-francs-napoleon' } },
  { id:'suisse20', nom:'20 Francs Suisse (Vreneli)', fin:5.806, s:{ aucoffre:['or/vreneli', /^20 Francs Suisse$/], bdor:'20-francs-suisse-or', abacor:'piece-d-or-20-francs-suisse' } },
  { id:'souverain', nom:'Souverain', fin:7.322, s:{ aucoffre:['or/souverain', /^Souverain$/], bdor:'souverain-or', abacor:'piece-d-or-souverain' } },
  { id:'krugerrand', nom:'Krugerrand 1 once', fin:31.103, s:{ aucoffre:['or/krugerrand', /^Krugerrand 1 once$/], bdor:'krugerrand', abacor:'piece-d-or-krugerrand' } },
  { id:'dollar20', nom:'20 Dollars US', fin:30.093, s:{ bdor:'20-dollars-or', abacor:'piece-20-dollars-us' } },
  { id:'pesos50', nom:'50 Pesos mexicains', fin:37.5, s:{ bdor:'50-pesos-or' } },
  // 17/10 : pièces d'argent (fin = grammes d'argent pur ; adresse complète quand elle commence par « / »)
  { id:'ag5fSemeuse', metal:'argent', nom:'5 Francs Semeuse (argent)', fin:10.02, s:{ bdor:'/produits-d-investissement-or/cours-prix-pieces-d-argent/5-francs-semeuse-argent', abacor:'piece-d-argent-5-francs-semeuse' } },
  { id:'ag10fHercule', metal:'argent', nom:'10 Francs Hercule (argent)', fin:22.5, s:{ bdor:'/produits-d-investissement-or/cours-prix-pieces-d-argent/10-francs-hercule-argent', abacor:'piece-d-argent-10-francs-hercule' } },
  { id:'ag50fHercule', metal:'argent', nom:'50 Francs Hercule (argent)', fin:27, s:{ bdor:'/produits-d-investissement-or/cours-prix-pieces-d-argent/50-francs-hercule-argent', abacor:'piece-d-argent-50-francs-hercule' } },
  { id:'agMaple', metal:'argent', nom:'Maple Leaf 1 once (argent)', fin:31.103, s:{ bdor:'/produits-d-investissement-or/cours-prix-pieces-d-argent/maple-leaf-argent' } },
  { id:'agPhilharmonique', metal:'argent', nom:'Philharmonique 1 once (argent)', fin:31.103, s:{ bdor:'/produits-d-investissement-or/cours-prix-pieces-d-argent/vienna-philharmonic-argent' } },
  { id:'agBritannia', metal:'argent', nom:'Britannia 1 once (argent)', fin:31.103, s:{ bdor:'/produits-d-investissement-or/cours-prix-pieces-d-argent/britannia-argent' } },
];
const MARCHANDS = {
  aucoffre: { nom:'AuCOFFRE', url: p => 'https://www.aucoffre.com/' + p },
  bdor: { nom:'BDOR', url: p => p.startsWith('/') ? 'https://www.bdor.fr' + p : 'https://www.bdor.fr/produits-d-investissement-or/cours-prix-pieces-d-or/' + p },
  abacor: { nom:'Abacor', url: p => 'https://www.abacor.fr/produit/' + p + '/' },
};
const lire = async url => { const r = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'fr-FR,fr;q=0.9' }, redirect: 'follow', signal: AbortSignal.timeout(20000) }); if(!r.ok) throw new Error('HTTP ' + r.status); return r.text(); };
const texte = h => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, '|').replace(/&nbsp;|&#160;/g, ' ').replace(/&eacute;/g, 'é').replace(/&amp;/g, '&').replace(/\s+/g, ' ').replace(/(\| ?)+/g, '|');
const euros = s => { const v = parseFloat(String(s).replace(/[\s  ]/g, '').replace(',', '.')); return isFinite(v) && v > 0 ? v : null; };
// prix des données structurées schema.org (le premier « price » plausible)
function prixStructure(h){ for(const m of h.matchAll(/"price"\s*:\s*"?([\d.]+)"?/g)){ const v = parseFloat(m[1]); if(v > 5 && v < 100000) return v; } return null; }
// liste AuCOFFRE : « Acheter | nom | catégorie | flèche | % | … | prix € »
function prixListe(h, re){ const S = texte(h).split('|').map(x => x.trim());
  for(let i = 0; i < S.length - 2; i++) if(S[i] === 'Acheter' && re.test(S[i+1])){ for(let j = i + 2; j < Math.min(i + 9, S.length); j++){ if(/^[\d\s  ]+,\d\d €$/.test(S[j])) return euros(S[j].replace('€', '')); } }
  return null; }
export async function relevePieces(off = []){
  const pages = {}, out = { at: Date.now(), pieces: {} }; let ok = 0, ko = 0;
  const page = async url => pages[url] || (pages[url] = lire(url));
  for(const P of PIECES){
    const L = [];
    for(const [m, src] of Object.entries(P.s)){
      if(off.includes(m)) continue;
      try{
        const url = MARCHANDS[m].url(Array.isArray(src) ? src[0] : src), h = await page(url);
        const prix = Array.isArray(src) ? prixListe(h, src[1]) : prixStructure(h);
        if(prix){ L.push({ m: MARCHANDS[m].nom, prix, url }); ok++; } else ko++;
      }catch(e){ ko++; }
    }
    if(L.length) out.pieces[P.id] = { nom: P.nom, fin: P.fin, metal: P.metal || 'or', offres: L.sort((a, b) => a.prix - b.prix) };
  }
  out.ok = ok; out.ko = ko;
  return out;
}

// ==== 20/10 : sites ajoutés par le propriétaire, lus avec le navigateur du robot ====
// Pour chaque site : page de départ + jusqu'à 12 pages de la même adresse dont le lien parle de pièces (en priorité celles
// qui portent le nom d'une pièce suivie). Sur chaque page : les produits décrits en données structurées (schema.org) et
// les blocs « titre + lien + prix en € ». eBay (boutique /str/…) : recherche des pièces suivies dans la boutique, en
// « Achat immédiat » seulement. La reconnaissance des pièces et le calcul de la prime sont faits ensuite par l'appli.
function extrairePage(){
  const prixRe = /(\d{1,3}(?:[ .  ]\d{3})*[.,]\d{2}|\d+[.,]\d{2}|\d{1,3}(?:[ .  ]\d{3})+|\d+)\s*(?:€|EUR)|(?:€|EUR)\s*(\d{1,3}(?:[ .,  ]\d{3})*(?:[.,]\d{2})?)/;
  const lit = s => { s = String(s).replace(/[\s  ]/g, ''); if(/,\d{2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.'); else if(/\.\d{2}$/.test(s)) s = s.replace(/,/g, ''); else s = s.replace(/[.,]/g, ''); const v = parseFloat(s); return v > 0 && v < 200000 ? v : null; };
  const net = t => String(t || '').replace(/\s+/g, ' ').trim(), out = [];
  document.querySelectorAll('script[type="application/ld+json"]').forEach(sc => { try{
    const walk = o => { if(!o || typeof o !== 'object') return; if(Array.isArray(o)) return o.forEach(walk);
      if(/Product/i.test([].concat(o['@type'] || []).join(' '))){ [].concat(o.offers || []).forEach(f => { [].concat(f.offers || f).forEach(g => { const v = parseFloat(g.price || g.lowPrice); if(v > 0 && (!g.priceCurrency || g.priceCurrency === 'EUR')) out.push({ t: net(o.name), prix: v, url: o.url || g.url || location.href }); }); }); }
      Object.values(o).forEach(walk); };
    walk(JSON.parse(sc.textContent)); }catch(e){} });
  const feuilles = [...document.querySelectorAll('body *')].filter(e => e.children.length <= 3 && e.textContent.length < 50 && prixRe.test(e.textContent) && e.offsetParent !== null);
  for(const e of feuilles.slice(0, 600)){
    if(/barr|strike|old|ancien|regular|was|uvp|statt/i.test((e.className || '') + ' ' + e.tagName) || e.closest('del,s,strike')) continue;
    let c = e, a = null;
    for(let i = 0; i < 7; i++){ c = c.parentElement; if(!c || c === document.body) break;
      const liens = [...c.querySelectorAll('a[href]')].filter(x => net(x.textContent).length > 8 && !/javascript:/.test(x.href));
      if(liens.length){ const n = (c.textContent.match(new RegExp(prixRe.source, 'g')) || []).length; if(n <= 4) a = liens.sort((x, y) => net(y.textContent).length - net(x.textContent).length)[0]; break; } }
    if(!a) continue;
    // la « carte » entière de l'annonce (le plus grand bloc qui ne parle que de ce produit) : enchère → pas un prix d'achat
    let carte = c; const moi = a.href.split('?')[0];
    for(let i = 0; i < 4; i++){ const P = carte.parentElement; if(!P || P === document.body) break;
      const autres = new Set([...P.querySelectorAll('a[href]')].map(x => x.href.split('?')[0]).filter(u => u !== moi && /\/(itm|produit|product)\/|,a\.html|\/p\//.test(u)));
      if(autres.size) break; carte = P; }
    if(/\bench[eè]res?\b|\bmiser\b|e-auction|\bbids?\b|\bgebote?\b|offre la plus [ée]lev[ée]e|temps restant/i.test(carte.textContent)) continue;
    const m = e.textContent.match(prixRe), v = lit(m[1] || m[2]); if(!v) continue;
    let t = net(a.textContent); const h = c.querySelector('h1,h2,h3,h4,[class*=title],[class*=titre],[class*=name],[class*=nom]'); if(h && net(h.textContent).length > t.length && net(h.textContent).length < 220) t = net(h.textContent);
    out.push({ t: t.slice(0, 220), prix: v, url: a.href });
  }
  // page d'un seul produit : le titre principal et le premier prix visible
  const h1 = document.querySelector('h1'); if(h1 && !out.some(o => o.url === location.href)){ const z = h1.closest('main,article,[class*=product],[id*=product]') || document.body; const m = (z.innerText || '').match(prixRe); if(m){ const v = lit(m[1] || m[2]); if(v) out.push({ t: net(h1.textContent).slice(0, 220), prix: v, url: location.href }); } }
  const liens = [...document.querySelectorAll('a[href]')].map(a => ({ u: a.href.split('#')[0], t: net(a.textContent).slice(0, 80) })).filter(l => /^https?:/.test(l.u));
  return { titre: document.title, produits: out, liens };
}
const PROTEGE = /just a moment|un instant|attention required|access denied|acc[eè]s refus|verifying|v[ée]rification de s[ée]curit[ée]|captcha|are you a robot|pardon our interruption|mesure de s[ée]curit[ée]|security measure/i;
async function lirePage(ctx, url){
  const p = await ctx.newPage();
  try{ await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); await p.waitForTimeout(1500);
    // la page peut mettre du temps à afficher ses prix (navigateur occupé) : on attend qu'un prix en euros apparaisse (8 s au plus)
    try{ await p.waitForFunction(() => /\d[\d\s.\u00a0\u202f]*,\d\d\s*(€|EUR)/.test(document.body ? document.body.innerText : ''), null, { timeout: 8000 }); }catch(e){}
    try{ await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await p.waitForTimeout(1200); }catch(e){}
    let R = await p.evaluate(extrairePage);
    if(PROTEGE.test(R.titre) && !R.produits.length){ await p.waitForTimeout(8000); R = await p.evaluate(extrairePage); if(PROTEGE.test(R.titre) && !R.produits.length) throw new Error('site protégé contre les robots'); }
    return R;
  }finally{ try{ await p.close(); }catch(e){} }
}
const MOTS_PIECES = /pi[eè]ce|monnaie|coin|m[uü]nze|gold|silber|silver|\bor\b|argent|napol|souverain|sovereign|kruger|vreneli|lingot|barren|bullion|investissement|anlage|categor|collection|rubrique|boutique|shop|catalog/i;
export async function releveSitesUtilisateur(ctx, conf, anciens = {}, budgetMs = 200000){
  const t0 = Date.now(), res = {}, mots = (conf.mots || []).map(m => m.toLowerCase());
  const sites = [...(conf.sites || [])].sort((a, b) => ((anciens[hote(a.url)] || {}).at || 0) - ((anciens[hote(b.url)] || {}).at || 0));
  for(const S of sites){
    const h = hote(S.url); if(!h) continue;
    if(Date.now() - t0 > budgetMs) break;
    const ts = Date.now(), produits = [], vus = new Set(); let err = null;
    try{
      const eb = S.url.match(/ebay\.[a-z.]+\/str\/([^/?#]+)/i);
      if(eb){
        // eBay refuse les recherches automatiques mais montre la boutique : on lit ses pages (enchères écartées)
        for(let pg = 1; pg <= 8; pg++){ if(Date.now() - ts > 90000) break;
          const u = pg === 1 ? S.url : `https://www.ebay.fr/str/${encodeURIComponent(eb[1])}?_pgn=${pg}`; // page 1 : l'adresse normale (les options déclenchent la vérification anti-robot)
          let R; try{ R = await lirePage(ctx, u); }catch(e){ if(pg === 1) throw e; break; }
          const avant = produits.length; R.produits.filter(p => /\/itm\//.test(p.url)).forEach(p => produits.push({ ...p, url: p.url.split('?')[0] }));
          if(produits.length === avant) break;
        }
      } else {
        const file = [S.url], score = l => (mots.some(m => m.split(' ').filter(w => w.length > 3).every(w => (l.t + ' ' + l.u).toLowerCase().includes(w))) ? 5 : 0) + (MOTS_PIECES.test(l.t + ' ' + l.u) ? 1 : 0);
        let n = 0;
        while(file.length && n < 13 && Date.now() - ts < 80000){
          const u = file.shift(); if(vus.has(u)) continue; vus.add(u); n++;
          let R; try{ R = await lirePage(ctx, u); }catch(e){ if(n === 1) throw e; continue; }
          R.produits.forEach(p => produits.push(p));
          const nouveaux = R.liens.filter(l => hote(l.u) === h && !vus.has(l.u) && !/panier|cart|compte|account|login|connexion|contact|cgv|mentions|cookie|blog|faq|\.(pdf|jpg|png)$/i.test(l.u)).map(l => ({ ...l, s: score(l) })).filter(l => l.s > 0).sort((a, b) => b.s - a.s);
          nouveaux.slice(0, 30).forEach(l => { if(!file.includes(l.u)) file.push(l.u); });
          file.sort((a, b) => score(nouveaux.find(l => l.u === b) || { t: '', u: b }) - score(nouveaux.find(l => l.u === a) || { t: '', u: a }));
        }
      }
      if(!produits.length && !err) err = 'aucun prix trouvé sur ce site';
    }catch(e){ err = String(e.message || e).slice(0, 80); }
    const uniq = []; const cle = new Set(); produits.forEach(p => { const k = p.url + '|' + p.prix; if(!cle.has(k) && p.t){ cle.add(k); uniq.push(p); } });
    res[h] = { nom: S.nom || h, url: S.url, err: uniq.length ? null : err, produits: uniq.slice(0, 1500) };
  }
  return res;
}
const hote = u => { try{ return new URL(u).hostname.replace(/^www\./, ''); }catch(e){ return ''; } };
