// 17/10 : envoi des notifications préparées par le robot (envoi.enc), lancé APRÈS l'enregistrement de l'état sur
// la branche site. Si l'enregistrement a échoué, cette étape ne tourne pas : rien n'est envoyé, et le passage suivant
// recalcule les mêmes alertes (pas de notification perdue, pas de doublon).
// Abonnements expirés : notés dans out/historique.enc (le workflow le renvoie alors sur la branche site).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { cle, chiffre, dechiffre } from './chiffre.mjs';
import { vapidKeys, envoyer } from './alertes.mjs';
const say = m => console.log(m);
const MDP = process.env.MOT_DE_PASSE;
if(!existsSync('envoi.enc') || !MDP){ say('aucune notification à envoyer'); process.exit(0); }
const key = await cle(MDP, JSON.parse(readFileSync('sel.json', 'utf8')));
const liste = JSON.parse(await dechiffre(key, readFileSync('envoi.enc', 'utf8')));
const r = await envoyer(liste, vapidKeys(MDP));
say(`notifications : ${r.ok} envoyée(s), ${r.ko} en échec`);
if(r.morts.length && existsSync('out/historique.enc')){
  const H = JSON.parse(await dechiffre(key, readFileSync('out/historique.enc', 'utf8')));
  const M = (H.subMorts && !Array.isArray(H.subMorts)) ? H.subMorts : {}; r.morts.forEach(e => { M[e] = Date.now(); });
  H.subMorts = Object.fromEntries(Object.entries(M).slice(-50));
  writeFileSync('out/historique.enc', await chiffre(key, JSON.stringify(H)));
  writeFileSync('morts.flag', '1');
  say(`${r.morts.length} abonnement(s) expiré(s) mis de côté`);
}
