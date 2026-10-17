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
];
const MARCHANDS = {
  aucoffre: { nom:'AuCOFFRE', url: p => 'https://www.aucoffre.com/' + p },
  bdor: { nom:'BDOR', url: p => 'https://www.bdor.fr/produits-d-investissement-or/cours-prix-pieces-d-or/' + p },
  abacor: { nom:'Abacor', url: p => 'https://www.abacor.fr/produit/' + p + '/' },
};
const lire = async url => { const r = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'fr-FR,fr;q=0.9' }, redirect: 'follow', signal: AbortSignal.timeout(20000) }); if(!r.ok) throw new Error('HTTP ' + r.status); return r.text(); };
const texte = h => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, '|').replace(/&nbsp;|&#160;/g, ' ').replace(/&eacute;/g, 'é').replace(/&amp;/g, '&').replace(/\s+/g, ' ').replace(/(\| ?)+/g, '|');
const euros = s => { const v = parseFloat(String(s).replace(/[\s  ]/g, '').replace(',', '.')); return isFinite(v) && v > 0 ? v : null; };
// prix des données structurées schema.org (le premier « price » plausible)
function prixStructure(h){ for(const m of h.matchAll(/"price"\s*:\s*"?([\d.]+)"?/g)){ const v = parseFloat(m[1]); if(v > 20 && v < 100000) return v; } return null; }
// liste AuCOFFRE : « Acheter | nom | catégorie | flèche | % | … | prix € »
function prixListe(h, re){ const S = texte(h).split('|').map(x => x.trim());
  for(let i = 0; i < S.length - 2; i++) if(S[i] === 'Acheter' && re.test(S[i+1])){ for(let j = i + 2; j < Math.min(i + 9, S.length); j++){ if(/^[\d\s  ]+,\d\d €$/.test(S[j])) return euros(S[j].replace('€', '')); } }
  return null; }
export async function relevePieces(){
  const pages = {}, out = { at: Date.now(), pieces: {} }; let ok = 0, ko = 0;
  const page = async url => pages[url] || (pages[url] = lire(url));
  for(const P of PIECES){
    const L = [];
    for(const [m, src] of Object.entries(P.s)){
      try{
        const url = MARCHANDS[m].url(Array.isArray(src) ? src[0] : src), h = await page(url);
        const prix = Array.isArray(src) ? prixListe(h, src[1]) : prixStructure(h);
        if(prix){ L.push({ m: MARCHANDS[m].nom, prix, url }); ok++; } else ko++;
      }catch(e){ ko++; }
    }
    if(L.length) out.pieces[P.id] = { nom: P.nom, fin: P.fin, offres: L.sort((a, b) => a.prix - b.prix) };
  }
  out.ok = ok; out.ko = ko;
  return out;
}
