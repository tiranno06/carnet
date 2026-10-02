// Historique quotidien (températures, probabilités, valeur de ton stock) et notifications du robot.
// Tout ce qui est écrit est chiffré avec ton mot de passe ; les notifications sont chiffrées de bout en
// bout (Web Push). Le journal public n'affiche que des nombres, jamais de contenu.
import { createHash, createECDH } from 'node:crypto';

const b64u = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Clés « VAPID » (identité du robot auprès des services de notification), déduites du mot de passe :
// toujours les mêmes, sans nouveau secret à configurer. La clé publique est fournie à la page.
export function vapidKeys(motDePasse){
  const d = createHash('sha256').update('carnet-vapid|' + motDePasse).digest();
  const ec = createECDH('prime256v1'); ec.setPrivateKey(d);
  return { publicKey: b64u(ec.getPublicKey()), privateKey: b64u(d) };
}

const LAB = { traditional:'📈 Actions', crypto:'◈ Crypto', metals:'🥇 Or & métaux', france:'🇫🇷 France', cross:'🔀 Risque combiné' };
const ZW = ['🟢 vert (favorable)', '🟡 jaune (rien de spécial)', '🔴 rouge (prudence)'];
const zoneOf = t => t >= 66 ? 2 : (t >= 33 ? 1 : 0);
// changement de zone seulement si la limite est franchie d'au moins 3 points (évite les allers-retours)
function zoneWithMargin(t, prevZ){
  const z = zoneOf(t); if(prevZ == null || z === prevZ) return z;
  const limit = z > prevZ ? (z === 2 ? 66 : 33) : (z === 1 ? 66 : 33);
  return Math.abs(t - limit) >= 3 ? z : prevZ;
}
function parisNow(){ const s = new Date().toLocaleString('sv-SE', { timeZone:'Europe/Paris' }); return { date: s.slice(0, 10), hour: +s.slice(11, 13), day: new Date(s.replace(' ', 'T')).getDay() }; }

// st = { t:{traditional,…}, pv:{ id:{ label, b, u, sb, su, nb, nu, baseB, baseU, relB, relU, phase, dd } }, fails:[noms], mv:{value,cost}|null }
export function enregistrer(H, st){
  H.v = 1; H.days = H.days || {}; H.alerts = H.alerts || {};
  const { date } = parisNow();
  const pv = {}; Object.entries(st.pv || {}).forEach(([id, x]) => { pv[id] = { b: x.b, u: x.u, sb: x.sb, su: x.su }; });
  H.days[date] = { t: st.t, pv, ...(st.mv ? { mv: st.mv } : {}) };
  return H;
}

export function alertes(H, st, subs){
  const A = H.alerts = H.alerts || {}; const now = parisNow();
  const msgs = { zones: [], prevision: [], hebdo: [], pannes: [] };
  // 1. zones des températures
  A.z = A.z || {};
  Object.entries(st.t || {}).forEach(([k, t]) => {
    if(t == null) return; const prevZ = A.z[k]; const z = zoneWithMargin(t, prevZ);
    if(prevZ != null && z !== prevZ) msgs.zones.push(`${LAB[k] || k} passe en ${ZW[z]} : ${Math.round(t)}/100`);
    A.z[k] = z;
  });
  // 2. prévision : seuil de 3 signaux franchi (marchés jugés fiables), début / fin d'un marché baissier
  A.pv = A.pv || {};
  Object.entries(st.pv || {}).forEach(([id, x]) => {
    const p = A.pv[id] || {};
    if(x.relB && p.sb != null){
      if(x.sb >= 3 && p.sb < 3) msgs.prevision.push(`🐻 ${x.label} : ${x.sb} signaux de baisse allumés — risque de forte baisse ${x.b} % sur 12 mois (d'habitude ${x.baseB} %)`);
      else if(x.sb < 3 && p.sb >= 3) msgs.prevision.push(`${x.label} : les signaux de baisse retombent (${x.sb}) — risque ${x.b} %`);
    }
    if(x.relU && p.su != null && x.su >= 3 && p.su < 3) msgs.prevision.push(`🐂 ${x.label} : ${x.su} signaux de hausse allumés — chance de forte hausse ${x.u} % (d'habitude ${x.baseU} %)`);
    if(p.phase && x.phase && p.phase !== x.phase){
      if(x.phase === 'bear') msgs.prevision.push(`🐻 ${x.label} : marché baissier en cours (${x.dd} % sous le plus haut d'un an)`);
      else if(p.phase === 'bear' && (x.phase === 'rec' || x.phase === 'bull')) msgs.prevision.push(`🌱 ${x.label} : sortie du marché baissier, la tendance redevient haussière`);
    }
    A.pv[id] = { sb: x.sb, su: x.su, phase: x.phase };
  });
  // 3. sources en panne depuis 3 passages de suite
  A.f = A.f || {}; const cur = new Set(st.fails || []);
  Object.keys(A.f).forEach(n => { if(!cur.has(n)) delete A.f[n]; });
  cur.forEach(n => { A.f[n] = (A.f[n] || 0) + 1; if(A.f[n] === 3) msgs.pannes.push(n); });
  // 4. résumé du dimanche matin (une fois par semaine)
  if(now.day === 0 && now.hour >= 9 && A.weekly !== now.date){
    A.weekly = now.date;
    const d7 = Object.keys(H.days || {}).filter(d => d <= new Date(Date.now() - 6.5*86400000).toISOString().slice(0, 10)).sort().pop();
    const old = d7 ? H.days[d7] : null;
    const lines = Object.entries(st.t || {}).filter(([, t]) => t != null).map(([k, t]) => { const o = old?.t?.[k]; const d = o != null ? Math.round(t - o) : null; return `${LAB[k] || k} ${Math.round(t)}${d != null ? (d === 0 ? ' (=)' : ` (${d > 0 ? '+' : ''}${d})`) : ''}`; });
    const pvl = Object.values(st.pv || {}).filter(x => x.relB).map(x => `${x.label} : baisse ${x.b} %, hausse ${x.u} %`);
    msgs.hebdo.push('Températures : ' + lines.join(' · ') + (pvl.length ? '\nPrévision 12 mois : ' + pvl.join(' · ') : ''));
  }
  // préparation des notifications, par appareil et selon ses préférences
  A.seen = A.seen || [];
  const out = [];
  for(const s of subs || []){
    if(!s || !s.endpoint || !s.keys) continue;
    const pr = Object.assign({ zones:true, prevision:true, hebdo:true, pannes:true }, s.prefs || {});
    if(!A.seen.includes(s.id)){ out.push({ s, title:'✅ Carnet : notifications activées', body:`Ce ${s.label || 'appareil'} recevra les alertes importantes, même quand le Carnet est fermé.`, url:'./', tag:'carnet-bienvenue' }); }
    const parts = [];
    if(pr.zones && msgs.zones.length) parts.push(...msgs.zones);
    if(pr.prevision && msgs.prevision.length) parts.push(...msgs.prevision);
    if(parts.length) out.push({ s, title: parts.length === 1 ? 'Carnet : un changement' : `Carnet : ${parts.length} changements`, body: parts.join('\n'), url: msgs.prevision.length && pr.prevision ? './?vue=prevision' : './', tag:'carnet-alerte' });
    if(pr.hebdo && msgs.hebdo.length) out.push({ s, title:'📅 Carnet : résumé de la semaine', body: msgs.hebdo[0], url:'./', tag:'carnet-hebdo' });
    if(pr.pannes && msgs.pannes.length) out.push({ s, title:'⚠️ Carnet : source de données en panne', body: msgs.pannes.join(', ') + ' — en échec depuis 3 passages du robot.', url:'./', tag:'carnet-panne' });
  }
  A.seen = (subs || []).map(s => s && s.id).filter(Boolean);
  return { out, counts: Object.fromEntries(Object.entries(msgs).map(([k, v]) => [k, v.length])) };
}

export async function envoyer(liste, vapid){
  if(!liste.length) return { ok: 0, ko: 0 };
  const webpush = (await import('web-push')).default;
  webpush.setVapidDetails('https://tiranno06.github.io/carnet/', vapid.publicKey, vapid.privateKey);
  let ok = 0, ko = 0;
  for(const n of liste){
    try{ await webpush.sendNotification({ endpoint: n.s.endpoint, keys: n.s.keys }, JSON.stringify({ title: n.title, body: n.body, url: n.url, tag: n.tag }), { TTL: 12*3600, urgency: 'normal' }); ok++; }
    catch(e){ ko++; }
  }
  return { ok, ko };
}
