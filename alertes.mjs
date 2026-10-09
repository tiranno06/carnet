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
  H.days[date] = Object.assign(H.days[date] || {}, { t: st.t, pv }, st.mv ? { mv: st.mv } : {}, st.raw ? { raw: st.raw } : {});
  // 09/10 (n°8) : suivi réel de la règle de DCA — 1er relevé du mois gardé tel quel, dernier relevé mis à jour
  if(st.dca && st.dca.world){ const mo = date.slice(0, 7); H.dca = H.dca || {}; if(!H.dca[mo]) H.dca[mo] = { d: date, m: st.dca.m, rule: st.dca.rule, world: st.dca.world }; H.dcaLast = { d: date, world: st.dca.world }; }
  // 09/10 (n°10) : bulletin du matin, préparé au premier passage après 6 h (heure de Paris)
  if(st.matin && st.matin.length && parisNow().hour >= 6 && (!H.matin || H.matin.date !== date)) H.matin = { date, at: Date.now(), lines: st.matin };
  if(st.bul){ H.bul = { date, notes: st.bul }; H.bulHist = H.bulHist || {}; H.bulHist[date.slice(0, 7)] = st.bul; } // dernier bulletin de notes (n°10) + 09/10 : notes de chaque mois
  // 09/10 (n°9) : santé des sources — par jour, nombre de passages et échecs de chaque source (35 derniers jours)
  if(st.allSrc && st.allSrc.length){
    const S = H.sante = H.sante || { jours:{}, vu:{} }; S.der = S.der || {}; const j = S.jours[date] = S.jours[date] || { n: 0, f: {} };
    j.n++; (st.fails || []).forEach(n => { j.f[n] = (j.f[n] || 0) + 1; });
    st.allSrc.forEach(n => { if(!S.vu[n]) S.vu[n] = date; S.der[n] = date; });
    const lim = new Date(Date.now() - 35*86400000).toISOString().slice(0, 10); Object.keys(S.jours).forEach(d => { if(d < lim) delete S.jours[d]; });
  }
  // scores de chaque indicateur, jour par jour (les 60 derniers jours de l'appareil du robot, puis l'historique s'allonge)
  Object.entries(st.sv || {}).forEach(([d, v]) => { if(/^\d{4}-\d{2}-\d{2}$/.test(d) && v) (H.days[d] = H.days[d] || {}).sv = v; });
  return H;
}

export function alertes(H, st, subs){
  const A = H.alerts = H.alerts || {}; const now = parisNow();
  const msgs = { zones: [], prevision: [], hebdo: [], pannes: [], agenda: [], matin: [], xc: [] };
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
  // 3 bis (09/10, n°13). contrôles de cohérence : deux sources en désaccord 3 passages de suite
  A.xc = A.xc || {}; const curX = new Set(st.xc || []);
  Object.keys(A.xc).forEach(n => { if(!curX.has(n)) delete A.xc[n]; });
  curX.forEach(n => { A.xc[n] = (A.xc[n] || 0) + 1; if(A.xc[n] === 3) msgs.xc.push(n); });
  // 3 ter (09/10, n°3). annonces importantes de demain : un rappel le soir (premier passage après 18 h)
  if(now.hour >= 18 && A.agenda !== now.date && (st.eco || []).some(e => e.imp >= 2)){
    A.agenda = now.date;
    msgs.agenda.push((st.eco || []).filter(e => e.imp >= 2).map(e => `${e.i || '📅'} ${e.h ? e.h + ' : ' : ''}${e.n}. ${e.w || ''}`).join('\n'));
  }
  // 3 quater (09/10, n°10). bulletin du matin : notification une fois par jour (si tu l'as activée)
  if(H.matin && H.matin.date === now.date && A.matin !== now.date){ A.matin = now.date; msgs.matin.push(H.matin.lines.join('\n')); }
  // 4. résumé du dimanche matin (une fois par semaine)
  if(now.day === 0 && now.hour >= 9 && A.weekly !== now.date){
    A.weekly = now.date;
    const d7 = Object.keys(H.days || {}).filter(d => d <= new Date(Date.now() - 6.5*86400000).toISOString().slice(0, 10)).sort().pop();
    const old = d7 ? H.days[d7] : null;
    const lines = Object.entries(st.t || {}).filter(([, t]) => t != null).map(([k, t]) => { const o = old?.t?.[k]; const d = o != null ? Math.round(t - o) : null; return `${LAB[k] || k} ${Math.round(t)}${d != null ? (d === 0 ? ' (=)' : ` (${d > 0 ? '+' : ''}${d})`) : ''}`; });
    const pvl = Object.values(st.pv || {}).filter(x => x.relB).map(x => `${x.label} : baisse ${x.b} %, hausse ${x.u} %`);
    msgs.hebdo.push('Températures : ' + lines.join(' · ') + (pvl.length ? '\nPrévision 12 mois : ' + pvl.join(' · ') : ''));
  }
  // 5. bulletin de notes de la Prévision : une fois par mois (au premier passage du mois, à partir de 9 h)
  msgs.bulletin = [];
  const mois = now.date.slice(0, 7);
  if(st.bul && Object.keys(st.bul).length && A.bul !== mois && now.hour >= 9){
    A.bul = mois;
    const n = v => v==null ? '—' : v + '/20';
    const lines = Object.values(st.bul).map(x => `${x.l} : baisse ${n(x.b)}, hausse ${n(x.u)}${x.lb!=null ? ` (vraies prévisions : ${n(x.lb)} / ${n(x.lu)})` : ''}`);
    msgs.bulletin.push('10/20 = pas mieux que la moyenne, 20/20 = parfait.\n' + lines.join('\n'));
  }
  // préparation des notifications, par appareil et selon ses préférences
  A.seen = A.seen || [];
  const out = [];
  for(const s of subs || []){
    if(!s || !s.endpoint || !s.keys) continue;
    const pr = Object.assign({ zones:true, prevision:true, hebdo:true, pannes:true, agenda:true, matin:false }, s.prefs || {});
    if(!A.seen.includes(s.id)){ out.push({ s, title:'✅ Carnet : notifications activées', body:`Ce ${s.label || 'appareil'} recevra les alertes importantes, même quand le Carnet est fermé.`, url:'./', tag:'carnet-bienvenue' }); }
    const parts = [];
    if(pr.zones && msgs.zones.length) parts.push(...msgs.zones);
    if(pr.prevision && msgs.prevision.length) parts.push(...msgs.prevision);
    if(parts.length) out.push({ s, title: parts.length === 1 ? 'Carnet : un changement' : `Carnet : ${parts.length} changements`, body: parts.join('\n'), url: msgs.prevision.length && pr.prevision ? './?vue=prevision' : './', tag:'carnet-alerte' });
    if(pr.hebdo && msgs.hebdo.length) out.push({ s, title:'📅 Carnet : résumé de la semaine', body: msgs.hebdo[0], url:'./', tag:'carnet-hebdo' });
    if(pr.hebdo && msgs.bulletin.length) out.push({ s, title:'📝 Carnet : bulletin de notes de la Prévision', body: msgs.bulletin[0], url:'./?vue=prevision', tag:'carnet-bulletin' });
    if(pr.pannes && msgs.pannes.length) out.push({ s, title:'⚠️ Carnet : source de données en panne', body: msgs.pannes.join(', ') + ' — en échec depuis 3 passages du robot.', url:'./', tag:'carnet-panne' });
    if(pr.pannes && msgs.xc.length) out.push({ s, title:'🔎 Carnet : deux sources ne sont pas d\'accord', body: msgs.xc.join(', ') + ' — écart anormal depuis 3 passages du robot. Détail : Réglages › Diagnostic › contrôle croisé.', url:'./', tag:'carnet-xc' });
    if(pr.agenda && msgs.agenda.length) out.push({ s, title:'📅 Carnet : demain, annonce importante', body: msgs.agenda[0], url:'./', tag:'carnet-agenda' });
    if(pr.matin && msgs.matin.length) out.push({ s, title:'☀️ Carnet : le bulletin du matin', body: msgs.matin[0], url:'./', tag:'carnet-matin' });
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
