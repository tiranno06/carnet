// Historique quotidien (températures, probabilités, valeur de ton stock) et notifications du robot.
// Tout ce qui est écrit est chiffré avec ton mot de passe ; les notifications sont chiffrées de bout en
// bout (Web Push). Le journal public n'affiche que des nombres, jamais de contenu.
import { createHash, createECDH, pbkdf2Sync } from 'node:crypto';

const b64u = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Clés « VAPID » (identité du robot auprès des services de notification), déduites du mot de passe :
// toujours les mêmes, sans nouveau secret à configurer. La clé publique est fournie à la page.
// 16/10 : calcul lent (600 000 tours, comme le chiffrement) : la clé publique, vue par les services de notification,
// ne permet plus de deviner rapidement le mot de passe. L'ancienne clé (calcul rapide) reste utilisée en secours
// pour les appareils pas encore réabonnés (ils se réabonnent tout seuls à leur prochaine ouverture).
const paire = d => { const ec = createECDH('prime256v1'); ec.setPrivateKey(d); return { publicKey: b64u(ec.getPublicKey()), privateKey: b64u(d) }; };
export function vapidKeys(motDePasse){
  const k = paire(pbkdf2Sync(motDePasse, 'carnet-vapid-v2', 600000, 32, 'sha256'));
  // 17/10 : secours retiré automatiquement après le 15/11/2026 (tous les appareils ouverts d'ici là se seront réabonnés)
  if(Date.now() < Date.UTC(2026, 10, 15)) k.ancienne = paire(createHash('sha256').update('carnet-vapid|' + motDePasse).digest());
  return k;
}
export const empreinte = endpoint => createHash('sha256').update(String(endpoint)).digest('hex').slice(0, 16);

const LAB = { traditional:'📈 Actions', crypto:'◈ Crypto', metals:'🥇 Or & métaux', france:'🇫🇷 France', cross:'🔀 Risque combiné' };
const ZW = ['🟢 vert (favorable)', '🟡 jaune (rien de spécial)', '🔴 rouge (prudence)'];
const VERDICT = { bon:"🟢 plutôt favorable (d'après le passé)", neutre:'🟡 rien de spécial', prudence:"🔴 n'en rachète pas plus" };
const zoneOf = t => t >= 66 ? 2 : (t >= 33 ? 1 : 0);
// changement de zone seulement si la limite est franchie d'au moins 3 points (évite les allers-retours)
function zoneWithMargin(t, prevZ){
  const z = zoneOf(t); if(prevZ == null || z === prevZ) return z;
  const limit = z > prevZ ? (z === 2 ? 66 : 33) : (z === 1 ? 66 : 33);
  return Math.abs(t - limit) >= 3 ? z : prevZ;
}
const parisDate = t => new Date(t).toLocaleString('sv-SE', { timeZone:'Europe/Paris' }).slice(0, 10);
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
  // 17/10 : journal des verdicts « Que faire ? » de la liste de suivi (un relevé à chaque changement, avec le prix du jour),
  // pour le bulletin de notes du Carnet ; st.wl absent = mesure impossible ce passage-ci, on ne note rien
  if(Array.isArray(st.wl)){ H.wlv = H.wlv || []; const der = {}; H.wlv.forEach(x => { der[x.s] = x; });
    st.wl.forEach(x => { if(!x || !x.s || !x.v || x.v === 'na' || !(x.p > 0)) return; if(!der[x.s] || der[x.s].v !== x.v) H.wlv.push({ d: date, s: x.s, n: x.n, v: x.v, p: x.p }); });
    if(H.wlv.length > 400) H.wlv = H.wlv.slice(-400); }
  // 17/10 : intégrité des fichiers du site (lue par la Santé du Carnet)
  if(Array.isArray(st.integrite)) H.integrite = { at: Date.now(), ko: st.integrite.slice(0, 20) };
  // scores de chaque indicateur, jour par jour (les 60 derniers jours de l'appareil du robot, puis l'historique s'allonge)
  Object.entries(st.sv || {}).forEach(([d, v]) => { if(/^\d{4}-\d{2}-\d{2}$/.test(d) && v) (H.days[d] = H.days[d] || {}).sv = v; });
  return H;
}

export function alertes(H, st, subs){
  const A = H.alerts = H.alerts || {}; const now = parisNow();
  const msgs = { zones: [], prevision: [], hebdo: [], pannes: [], agenda: [], matin: [], xc: [], susp: [], wl: [], wlv: [], liens: [] };
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
  // 3 quinquies (09/10, n°5). valeurs suspectes : variation du jour > 3 fois la plus grosse variation relevée (≥ 20 jours)
  A.susp = A.susp || {};
  try{ const days = Object.keys(H.days || {}).filter(d => d < now.date && H.days[d] && H.days[d].raw).sort();
    Object.entries(st.raw || {}).forEach(([k, R]) => Object.entries(R || {}).forEach(([n, x]) => {
      const s = days.map(d => H.days[d].raw[k] ? H.days[d].raw[k][n] : null).filter(v => v != null && isFinite(v)); if(s.length < 20) return;
      let mx = 0; for(let i = 1; i < s.length; i++) mx = Math.max(mx, Math.abs(s[i] - s[i-1])); const last = s[s.length-1], j = Math.abs(x - last);
      if(mx > 0 && j > 3*mx && j > 0.02*Math.abs(last)){ const id = k + '|' + n; if(!A.susp[id] || A.susp[id] < parisDate(Date.now() - 7*86400000)){ A.susp[id] = now.date; msgs.susp.push(n); } }
    })); }catch(e){}
  // 3 sexies (09/10, n°10). liste de suivi : alerte quand un élément PASSE sous ton seuil (pas à chaque passage)
  // 17/10 : st.wl absent = mesure impossible ce passage-ci → on ne touche pas à la mémoire (sinon tout repartirait en double)
  A.wl = A.wl || {};
  if(Array.isArray(st.wl)){ const vusWl = new Set();
    st.wl.forEach(x => { vusWl.add(x.s); const on = (x.al || []).length > 0; if(on && !A.wl[x.s]) msgs.wl.push(`${x.n} : ${x.al.join(' ; ')}`); A.wl[x.s] = on; });
    Object.keys(A.wl).forEach(s => { if(!vusWl.has(s)) delete A.wl[s]; });
    // 17/10 : verdict « Que faire ? » qui change (🟡 → 🟢…) : prévenu une fois, au changement
    A.wlv = A.wlv || {};
    st.wl.forEach(x => { if(!x.v || x.v === 'na') return; const avant = A.wlv[x.s]; if(avant && avant !== x.v) msgs.wlv.push(`${x.n} : ${VERDICT[avant] || avant} → ${VERDICT[x.v] || x.v}`); A.wlv[x.s] = x.v; });
    Object.keys(A.wlv).forEach(s => { if(!vusWl.has(s)) delete A.wlv[s]; }); }
  // 3 octies (16/10). sites dont la présentation a changé : prévenu une fois par page (et quand elle revient)
  A.fmt = A.fmt || {}; msgs.format = [];
  if(Array.isArray(st.fmt)){ const fNow = new Set(st.fmt);
    fNow.forEach(k => { if(!A.fmt[k]){ A.fmt[k] = now.date; msgs.format.push(k); } });
    Object.keys(A.fmt).forEach(k => { if(!fNow.has(k)) delete A.fmt[k]; }); }
  // 3 nonies (17/10). série toujours en retard après 1 jour de réparations automatiques : prévenu une fois (et quand c'est réglé)
  msgs.retard = []; msgs.repare = [];
  if(Array.isArray(st.retard)){ A.retard = A.retard || {}; const R = new Set(st.retard);
    R.forEach(n => { const e = A.retard[n] || (A.retard[n] = { d: Date.now() }); if(!e.dit && Date.now() - e.d > 24*3600000){ e.dit = 1; msgs.retard.push(n); } });
    Object.keys(A.retard).forEach(n => { if(!R.has(n)){ if(A.retard[n].dit) msgs.repare.push(n); delete A.retard[n]; } }); }
  // 3 decies (17/10). désaccord entre le prix et les indicateurs : prévenu quand il apparaît (ou change de sens)
  msgs.div = [];
  if(st.div && typeof st.div === 'object'){ A.div = A.div || {}; const NOMS = { traditional:'📈 Actions', france:'🇫🇷 France', metals:'🥇 Or', crypto:'◈ Bitcoin' };
    const pc = v => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1).replace('.', ',') + ' %';
    Object.entries(st.div).forEach(([k, r]) => { if(!r) return; const s = r.sens || null;
      if(s && s !== A.div[k]) msgs.div.push(`${NOMS[k] || k} : ${s === 'baisse' ? `le prix monte (${pc(r.evo)} en ${r.jours} j) mais ${r.pires.length} indicateurs sur ${r.n} se dégradent` : `le prix baisse (${pc(r.evo)} en ${r.jours} j) mais ${r.mieux.length} indicateurs sur ${r.n} s'améliorent`}`);
      A.div[k] = s; }); }
  // 3 terdecies (20/10). analyse pro : changement du feu de tendance (10 mois) d'une ligne suivie ; tes lignes tracées
  // franchies ; retour dans un bloc d'ordres acheteur. Chaque événement n'est envoyé qu'une fois.
  msgs.pro = [];
  if(st.pro && typeof st.pro === 'object'){ A.proFeu = A.proFeu || {}; A.proEv = A.proEv || {};
    Object.entries(st.pro.feu || {}).forEach(([s, x]) => { if(!x || !x.e) return; const av = A.proFeu[s]; if(av && av !== x.e) msgs.pro.push(`${x.nom} : feu de tendance ${x.e > 0 ? '🟢 repassé au vert (au-dessus de sa moyenne des 10 mois)' : '🔴 passé au rouge (sous sa moyenne des 10 mois)'}`); A.proFeu[s] = x.e; });
    (st.pro.evts || []).forEach(e => { if(!e || !e.cle || A.proEv[e.cle]) return; A.proEv[e.cle] = Date.now(); msgs.pro.push(e.txt); });
    Object.keys(A.proEv).forEach(k => { if(Date.now() - A.proEv[k] > 30*86400000) delete A.proEv[k]; }); }
  // 3 undecies (17/10). bonne affaire sur une pièce d'or : prévenu quand elle apparaît (à nouveau après 7 jours au plus tôt)
  msgs.affaires = [];
  if(Array.isArray(st.affaires)){ A.aff = A.aff || {}; const vus = new Set();
    st.affaires.forEach(x => { if(!x || !x.id) return; vus.add(x.id); if(!A.aff[x.id] || Date.now() - A.aff[x.id] > 7*86400000){ A.aff[x.id] = Date.now(); msgs.affaires.push(`${x.nom} chez ${x.m} : prime ${String(x.prime.toFixed(1)).replace('.', ',')} % (d'habitude ${String(x.med.toFixed(1)).replace('.', ',')} %)`); } });
    Object.keys(A.aff).forEach(id => { if(!vus.has(id) && Date.now() - A.aff[id] > 7*86400000) delete A.aff[id]; }); }
  // 3 duodecies (17/10). fichiers du site différents de la publication : prévenu après 3 passages de suite (évite une fausse
  // alerte pendant les quelques minutes où une mise à jour du robot précède la nouvelle publication)
  msgs.integrite = [];
  if(Array.isArray(st.integrite)){ const sig = st.integrite.slice().sort().join(','); A.integ = A.integ || { n: 0, sig: '', dit: '' };
    if(!sig){ A.integ = { n: 0, sig: '', dit: '' }; }
    else { A.integ.n = A.integ.sig === sig ? A.integ.n + 1 : 1; A.integ.sig = sig; if(A.integ.n >= 3 && A.integ.dit !== sig){ A.integ.dit = sig; msgs.integrite.push(st.integrite.slice(0, 6).join(', ')); } } }
  // 3 septies (09/10, n°12). nouveaux liens de vérification cassés
  if((st.liensNouv || []).length) msgs.liens.push(st.liensNouv.join(', '));
  // 4. résumé du dimanche matin (une fois par semaine)
  if(now.day === 0 && now.hour >= 9 && A.weekly !== now.date){
    A.weekly = now.date;
    const d7 = Object.keys(H.days || {}).filter(d => d <= parisDate(Date.now() - 6.5*86400000)).sort().pop();
    const old = d7 ? H.days[d7] : null;
    const lines = Object.entries(st.t || {}).filter(([, t]) => t != null).map(([k, t]) => { const o = old?.t?.[k]; const d = o != null ? Math.round(t - o) : null; return `${LAB[k] || k} ${Math.round(t)}${d != null ? (d === 0 ? ' (=)' : ` (${d > 0 ? '+' : ''}${d})`) : ''}`; });
    const pvl = Object.values(st.pv || {}).filter(x => x.relB).map(x => `${x.label} : baisse ${x.b} %, hausse ${x.u} %`);
    msgs.hebdo.push('Températures : ' + lines.join(' · ') + (pvl.length ? '\nPrévision 12 mois : ' + pvl.join(' · ') : ''));
  }
  // 4 bis (16/10). « Que faire ce mois-ci ? » : le 1er du mois, à partir de 9 h
  msgs.mois = [];
  if(now.date.slice(8) === '01' && now.hour >= 9 && A.mois !== now.date.slice(0, 7) && (st.mois || []).length){ A.mois = now.date.slice(0, 7); msgs.mois.push(st.mois.join('\n')); }
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
  // 16/10 : abonnements expirés (appareil réinitialisé, navigateur désinstallé…) mis de côté, sauf s'ils ont été refaits depuis
  const morts = (H.subMorts && !Array.isArray(H.subMorts)) ? H.subMorts : {};
  for(const s of subs || []){
    if(!s || !s.endpoint || !s.keys) continue;
    const mort = morts[empreinte(s.endpoint)]; if(mort && !((s.at || 0) > mort)) continue;
    const pr = Object.assign({ zones:true, prevision:true, hebdo:true, pannes:true, agenda:true, matin:false, suivi:true }, s.prefs || {});
    if(!A.seen.includes(s.id)){ out.push({ s, title:'✅ Carnet : notifications activées', body:`Ce ${s.label || 'appareil'} recevra les alertes importantes, même quand le Carnet est fermé.`, url:'./', tag:'carnet-bienvenue' }); }
    const parts = [];
    if(pr.zones && msgs.zones.length) parts.push(...msgs.zones);
    if(pr.prevision && msgs.prevision.length) parts.push(...msgs.prevision);
    if(parts.length) out.push({ s, title: parts.length === 1 ? 'Carnet : un changement' : `Carnet : ${parts.length} changements`, body: parts.join('\n'), url: msgs.prevision.length && pr.prevision ? './?vue=prevision' : './', tag:'carnet-alerte' });
    if(msgs.integrite.length) out.push({ s, title:'🛡️ Carnet : fichiers du site modifiés', body: 'Différents de la dernière publication : ' + msgs.integrite[0] + ". Si ce n'est pas une mise à jour de ta part ou de Claude, demande une vérification à Claude Code avant de saisir ton mot de passe.", url:'./', tag:'carnet-integrite' });
    if(pr.zones && msgs.affaires.length) out.push({ s, title:'🔥 Carnet : bonne affaire sur une pièce d\'or', body: msgs.affaires.join('\n') + '\nPrix affiché hors livraison ; vérifie sur le site avant d\'acheter.', url:'./?vue=mymetals', tag:'carnet-affaire' });
    if(pr.zones && msgs.div.length) out.push({ s, title:"🔀 Carnet : le prix et les indicateurs ne sont pas d'accord", body: msgs.div.join('\n') + '\nPas un signal d\'achat ou de vente : un moment pour ne rien décider sur un coup de tête.', url:'./', tag:'carnet-desaccord' });
    if(pr.hebdo && msgs.hebdo.length) out.push({ s, title:'📅 Carnet : résumé de la semaine', body: msgs.hebdo[0], url:'./', tag:'carnet-hebdo' });
    if(pr.hebdo && msgs.mois.length) out.push({ s, title:'🗓️ Carnet : que faire ce mois-ci ?', body: msgs.mois[0], url:'./', tag:'carnet-mois' });
    if(pr.hebdo && msgs.bulletin.length) out.push({ s, title:'📝 Carnet : bulletin de notes de la Prévision', body: msgs.bulletin[0], url:'./?vue=prevision', tag:'carnet-bulletin' });
    if(pr.pannes && msgs.pannes.length) out.push({ s, title:'⚠️ Carnet : source de données en panne', body: msgs.pannes.join(', ') + ' — en échec depuis 3 passages du robot.', url:'./', tag:'carnet-panne' });
    if(pr.pannes && msgs.xc.length) out.push({ s, title:'🔎 Carnet : deux sources ne sont pas d\'accord', body: msgs.xc.join(', ') + ' — écart anormal depuis 3 passages du robot. Détail : Réglages › Diagnostic › contrôle croisé.', url:'./', tag:'carnet-xc' });
    if(pr.pannes && msgs.susp.length) out.push({ s, title:'⚠️ Carnet : valeur à vérifier', body: msgs.susp.slice(0, 5).join(', ') + ' — variation du jour bien plus forte que tout ce qui a été relevé. Erreur de source ou vrai événement ?', url:'./', tag:'carnet-susp' });
    if(pr.suivi && msgs.wl.length) out.push({ s, title: msgs.wl.length === 1 ? '👀 Carnet : ta liste de suivi' : `👀 Carnet : ${msgs.wl.length} alertes de ta liste de suivi`, body: msgs.wl.join('\n'), url:'./', tag:'carnet-suivi' });
    if(pr.suivi && msgs.pro.length) out.push({ s, title: msgs.pro.length === 1 ? '📐 Carnet : analyse pro' : `📐 Carnet : ${msgs.pro.length} alertes de l'analyse pro`, body: msgs.pro.slice(0, 6).join('\n') + '\nÀ regarder dans l\'onglet 📐 Analyse pro : ce n\'est pas un ordre d\'achat ou de vente.', url: './?vue=pro', tag: 'carnet-pro' });
    if(pr.suivi && msgs.wlv.length) out.push({ s, title: msgs.wlv.length === 1 ? '👀 Carnet : un verdict de ta liste de suivi a changé' : `👀 Carnet : ${msgs.wlv.length} verdicts de ta liste de suivi ont changé`, body: msgs.wlv.join('\n') + '\nCe que disait le passé, pas une garantie.', url:'./', tag:'carnet-wlv' });
    if(pr.pannes && msgs.retard.length) out.push({ s, title:'🕰️ Carnet : donnée toujours en retard', body: msgs.retard.join(', ') + " — pas de nouvelle publication depuis bien plus longtemps que d'habitude, et aucune source de remplacement trouvée depuis 1 jour. Le Carnet continue de chercher ; demande « révision du tableau de bord » à Claude Code si ça dure.", url:'./', tag:'carnet-retard' });
    if(pr.pannes && msgs.repare.length) out.push({ s, title:'✅ Carnet : donnée de nouveau à jour', body: msgs.repare.join(', '), url:'./', tag:'carnet-retard' });
    if(pr.pannes && msgs.format.length) out.push({ s, title:'🧩 Carnet : un site a changé sa présentation', body: msgs.format.join(', ') + ' — le Carnet ne reconnaît plus la page : il utilise la source de secours (ou la dernière valeur connue) et réessaie toutes les 6 h.', url:'./', tag:'carnet-format' });
    if(pr.pannes && msgs.liens.length) out.push({ s, title:'🔗 Carnet : lien de vérification cassé', body: msgs.liens[0] + ' — détail dans Réglages › Avancé › Liens de vérification.', url:'./', tag:'carnet-liens' });
    if(pr.agenda && msgs.agenda.length) out.push({ s, title:'📅 Carnet : demain, annonce importante', body: msgs.agenda[0], url:'./', tag:'carnet-agenda' });
    if(pr.matin && msgs.matin.length) out.push({ s, title:'☀️ Carnet : le bulletin du matin', body: msgs.matin[0], url:'./', tag:'carnet-matin' });
  }
  // 16/10 : pastille de l'icône = lignes de la liste de suivi dont le seuil est atteint
  const badge = (st.wl || []).filter(x => (x.al || []).length || x.v === 'bon').length; out.forEach(o => { o.badge = badge; });
  if((subs || []).length) A.seen = subs.map(s => s && s.id).filter(Boolean); // 17/10 : abonnements illisibles ce passage-ci → mémoire gardée
  return { out, counts: Object.fromEntries(Object.entries(msgs).map(([k, v]) => [k, v.length])) };
}

export async function envoyer(liste, vapid){
  if(!liste.length) return { ok: 0, ko: 0, morts: [] };
  const webpush = (await import('web-push')).default;
  const det = k => ({ subject: 'https://tiranno06.github.io/carnet/', publicKey: k.publicKey, privateKey: k.privateKey });
  let ok = 0, ko = 0; const morts = [];
  for(const n of liste){
    const sub = { endpoint: n.s.endpoint, keys: n.s.keys }, msg = JSON.stringify({ title: n.title, body: n.body, url: n.url, tag: n.tag, ...(typeof n.badge === 'number' ? { badge: n.badge } : {}) });
    const go = k => webpush.sendNotification(sub, msg, { TTL: 12*3600, urgency: 'normal', vapidDetails: det(k) });
    try{ await go(vapid); ok++; }
    catch(e){
      let err = e;
      if(vapid.ancienne && (e.statusCode === 401 || e.statusCode === 403)){ try{ await go(vapid.ancienne); ok++; continue; }catch(e2){ err = e2; } }
      ko++; if(err.statusCode === 404 || err.statusCode === 410) morts.push(empreinte(n.s.endpoint));
    }
  }
  return { ok, ko, morts };
}
