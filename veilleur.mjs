// Veilleur : vérifie chaque heure que le robot tourne bien. Si un passage reste coincé (plus d'une heure en
// attente ou en cours), il l'annule et relance le robot ; si les données ont plus de 3 h, il t'envoie une
// notification (chiffrée de bout en bout). Le journal public n'affiche aucun contenu.
import { readFileSync, existsSync } from 'node:fs';
import { cle, dechiffre } from './chiffre.mjs';
import { vapidKeys, envoyer } from './alertes.mjs';
const { GH_TOKEN, REPO, MOT_DE_PASSE } = process.env;
const say = m => console.log('::notice title=Veilleur::' + m);
const api = async (path, opts = {}) => { const r = await fetch(`https://api.github.com/repos/${REPO}/${path}`, { ...opts, headers: { Authorization: 'Bearer ' + GH_TOKEN, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' } }); return r; };
const json = async path => { const r = await api(path); if(!r.ok) throw new Error(path + ' → ' + r.status); return r.json(); };
const now = Date.now(), H = 3600000;

// 1. passages coincés
let relance = false;
const actifs = [];
for(const st of ['waiting', 'queued', 'pending', 'requested', 'in_progress']){
  try{ const j = await json(`actions/workflows/robot.yml/runs?status=${st}&per_page=20`); actifs.push(...j.workflow_runs); }catch(e){ say('lecture des passages impossible (' + st + ')'); }
}
const coinces = actifs.filter(r => now - Date.parse(r.run_started_at || r.created_at) > (r.status === 'in_progress' ? 0.5*H : H));
for(const r of coinces){
  const age = Math.round((now - Date.parse(r.created_at))/60000);
  let ok = (await api(`actions/runs/${r.id}/cancel`, { method: 'POST' })).ok;
  await new Promise(s => setTimeout(s, 20000));
  const après = await json(`actions/runs/${r.id}`).catch(() => null);
  if(!après || après.status !== 'completed'){ ok = (await api(`actions/runs/${r.id}/force-cancel`, { method: 'POST' })).ok; }
  say(`passage du robot coincé depuis ${age} min (${r.status}) : ${ok ? 'annulé' : 'annulation refusée'}`);
  relance = true;
}
// 2. relance si plus rien n'est prévu
if(relance){
  await new Promise(s => setTimeout(s, 10000));
  const reste = (await json('actions/workflows/robot.yml/runs?status=queued&per_page=5').catch(() => ({ workflow_runs: [] }))).workflow_runs.length
              + (await json('actions/workflows/robot.yml/runs?status=in_progress&per_page=5').catch(() => ({ workflow_runs: [] }))).workflow_runs.length;
  if(!reste){ const d = await api('actions/workflows/robot.yml/dispatches', { method: 'POST', body: JSON.stringify({ ref: 'main' }) }); say(d.ok ? 'robot relancé' : 'relance du robot refusée'); }
  else say('un passage du robot est déjà en route');
}
// 3. fraîcheur des données (date du dernier dépôt du robot)
let ageH = null;
try{ const b = await json('branches/site'); ageH = (now - Date.parse(b.commit.commit.committer.date)) / H; }catch(e){ say('date des données illisible'); }
if(ageH == null){ process.exit(0); }
say(`données mises à jour il y a ${ageH.toFixed(1)} h`);
// une seule notification par heure de retard « ronde » : à 3 h, puis toutes les 24 h tant que ça dure
if(ageH >= 3 && (ageH - 3) % 24 < 1){
  if(!MOT_DE_PASSE || !existsSync('abonnements.enc')){ say('pas d\'appareil abonné aux notifications'); process.exit(0); }
  try{
    const key = await cle(MOT_DE_PASSE, JSON.parse(readFileSync('sel.json', 'utf8')));
    const subs = JSON.parse(await dechiffre(key, readFileSync('abonnements.enc', 'utf8'))).subs || [];
    const h = Math.floor(ageH);
    const liste = subs.filter(s => s && s.endpoint && s.keys && (!s.prefs || s.prefs.pannes !== false)).map(s => ({ s,
      title: '⚠️ Carnet : le robot est en retard',
      body: `Les données n'ont pas été mises à jour depuis ${h} h.` + (relance ? ' Un passage coincé a été annulé et le robot relancé.' : ' Le tableau affiche les dernières valeurs connues.'),
      url: './', tag: 'carnet-veilleur' }));
    const r = await envoyer(liste, vapidKeys(MOT_DE_PASSE));
    say(`notifications : ${r.ok} envoyée(s), ${r.ko} en échec`);
  }catch(e){ say('notification impossible'); }
}
