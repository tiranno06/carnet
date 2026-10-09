// Veilleur : vérifie que le robot et la publication du site tournent bien.
//  • un passage coincé (plus d'1 h en attente, ou en cours depuis plus de 30 min) est annulé, puis relancé ;
//  • données de plus de 12 h → une notification (puis une par jour tant que ça dure) ;
//  • quand tout repart après une alerte → une notification « ✅ le robot est reparti » ;
//  • signe de vie : GitHub coupe les tâches programmées d'un dépôt sans activité depuis 60 jours.
// Notifications chiffrées de bout en bout ; le journal public n'affiche aucune donnée.
import { readFileSync, existsSync } from 'node:fs';
import { cle, dechiffre } from './chiffre.mjs';
import { vapidKeys, envoyer } from './alertes.mjs';
const { GH_TOKEN, REPO, MOT_DE_PASSE } = process.env;
const say = m => console.log('::notice title=Veilleur::' + m);
const api = (path, opts = {}) => fetch(`https://api.github.com/repos/${REPO}/${path}`, { ...opts, headers: { Authorization: 'Bearer ' + GH_TOKEN, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' } });
const json = async path => { const r = await api(path); if(!r.ok) throw new Error(path + ' → ' + r.status); return r.json(); };
const pause = ms => new Promise(s => setTimeout(s, ms));
const now = Date.now(), H = 3600000;
const SEUIL = 12; // heures. GitHub saute souvent des passages programmés : 3 à 9 h sans passage arrive normalement.

// ---- état mémorisé (branche « veilleur », fichier etat.json : seulement des dates) ----
let etat = {}, etatSha = null;
try{ const f = await json('contents/etat.json?ref=veilleur'); etatSha = f.sha; etat = JSON.parse(Buffer.from(f.content, 'base64').toString('utf8')); }catch(e){}
async function sauver(){
  const body = { message: 'veilleur', branch: 'veilleur', content: Buffer.from(JSON.stringify(etat)).toString('base64'), ...(etatSha ? { sha: etatSha } : {}) };
  let r = await api('contents/etat.json', { method: 'PUT', body: JSON.stringify(body) });
  if(r.status === 404 || r.status === 422){ // branche pas encore créée
    const main = await json('git/ref/heads/main');
    await api('git/refs', { method: 'POST', body: JSON.stringify({ ref: 'refs/heads/veilleur', sha: main.object.sha }) });
    r = await api('contents/etat.json', { method: 'PUT', body: JSON.stringify(body) });
  }
  if(!r.ok) say('état non enregistré (' + r.status + ')');
}

// ---- 1. passages coincés (robot et publication du site) ----
const relancer = new Set();
for(const wf of ['robot.yml', 'site.yml']){
  const actifs = [];
  for(const st of ['waiting', 'queued', 'pending', 'requested', 'in_progress']){
    try{ actifs.push(...(await json(`actions/workflows/${wf}/runs?status=${st}&per_page=20`)).workflow_runs); }catch(e){}
  }
  for(const r of actifs.filter(r => now - Date.parse(r.run_started_at || r.created_at) > (r.status === 'in_progress' ? 0.5*H : H))){
    const age = Math.round((now - Date.parse(r.created_at))/60000);
    let ok = (await api(`actions/runs/${r.id}/cancel`, { method: 'POST' })).ok;
    await pause(20000);
    const après = await json(`actions/runs/${r.id}`).catch(() => null);
    if(!après || après.status !== 'completed') ok = (await api(`actions/runs/${r.id}/force-cancel`, { method: 'POST' })).ok;
    say(`${wf === 'robot.yml' ? 'robot' : 'publication du site'} coincé depuis ${age} min (${r.status}) : ${ok ? 'annulé' : 'annulation refusée'}`);
    relancer.add(wf);
  }
}
// publication du site en retard sur les données du robot (lancement raté) → relance
let dataTs = null, siteTs = null;
try{ dataTs = Date.parse((await json('branches/site')).commit.commit.committer.date); }catch(e){ say('date des données illisible'); }
try{ const r = (await json('actions/workflows/site.yml/runs?status=success&per_page=1')).workflow_runs[0]; if(r) siteTs = Date.parse(r.updated_at); }catch(e){}
if(dataTs && siteTs && dataTs - siteTs > 0.75*H) relancer.add('site.yml');
for(const wf of relancer){
  await pause(5000);
  let reste = 0; for(const st of ['queued', 'in_progress']){ try{ reste += (await json(`actions/workflows/${wf}/runs?status=${st}&per_page=5`)).workflow_runs.length; }catch(e){} }
  if(reste){ say(`${wf} : un passage est déjà en route`); continue; }
  const d = await api(`actions/workflows/${wf}/dispatches`, { method: 'POST', body: JSON.stringify({ ref: 'main' }) });
  say(`${wf === 'robot.yml' ? 'robot' : 'publication du site'} ${d.ok ? 'relancé' : 'relance refusée (' + d.status + ')'}`);
}

// ---- 2. fraîcheur de ce que tu vois (dernière publication réussie du site, sinon dernières données) ----
const vu = siteTs && dataTs ? Math.min(siteTs, dataTs) : (siteTs || dataTs);
let modif = false;
if(vu){
  const ageH = (now - vu) / H;
  say(`données visibles mises à jour il y a ${ageH.toFixed(1)} h`);
  let msg = null;
  if(ageH >= SEUIL && (!etat.alerte || now - etat.alerte >= 24*H)){
    msg = { title: '⚠️ Carnet : le robot est en retard', body: `Les données n'ont pas été mises à jour depuis ${Math.floor(ageH)} h.` + (relancer.size ? ' Un passage coincé a été annulé et relancé.' : ' Le tableau affiche les dernières valeurs connues.'), tag: 'carnet-veilleur' };
    etat.alerte = now; etat.debut = etat.debut || vu; modif = true;
  } else if(ageH < 3 && etat.alerte){
    const duree = Math.round((vu - (etat.debut || etat.alerte)) / H);
    msg = { title: '✅ Carnet : le robot est reparti', body: `Les données sont de nouveau à jour${duree > 0 ? ` (interruption d'environ ${duree} h)` : ''}.`, tag: 'carnet-veilleur' };
    etat = {}; modif = true;
  }
  if(msg){
    if(!MOT_DE_PASSE || !existsSync('abonnements.enc')) say("pas d'appareil abonné aux notifications");
    else try{
      const key = await cle(MOT_DE_PASSE, JSON.parse(readFileSync('sel.json', 'utf8')));
      const subs = JSON.parse(await dechiffre(key, readFileSync('abonnements.enc', 'utf8'))).subs || [];
      const liste = subs.filter(s => s && s.endpoint && s.keys && (!s.prefs || s.prefs.pannes !== false)).map(s => ({ s, ...msg, url: './' }));
      const r = await envoyer(liste, vapidKeys(MOT_DE_PASSE));
      say(`notifications : ${r.ok} envoyée(s), ${r.ko} en échec`);
    }catch(e){ say('notification impossible'); }
  }
}

// ---- 3. signe de vie (une fois par mois au plus) ----
try{
  const main = await json('commits/main');
  if(now - Date.parse(main.commit.committer.date) > 45*24*H){
    const c = await (await api('git/commits', { method: 'POST', body: JSON.stringify({ message: 'signe de vie (tâches programmées gardées actives)', tree: main.commit.tree.sha, parents: [main.sha] }) })).json();
    const r = await api('git/refs/heads/main', { method: 'PATCH', body: JSON.stringify({ sha: c.sha }) });
    say(r.ok ? 'signe de vie déposé' : 'signe de vie refusé (' + r.status + ')');
  }
}catch(e){ say('signe de vie : vérification impossible'); }

if(modif) await sauver();
