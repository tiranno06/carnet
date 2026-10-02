// Chiffrement commun (robot, publication) — identique à celui de la page : PBKDF2-SHA256 → AES-GCM 256, contenu compressé gzip.
import { gzipSync, gunzipSync } from 'node:zlib';
const { subtle } = globalThis.crypto;
export async function cle(motDePasse, sel){
  const base = await subtle.importKey('raw', new TextEncoder().encode(motDePasse), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name:'PBKDF2', salt:Buffer.from(sel.sel, 'base64'), iterations:sel.iter, hash:'SHA-256' }, base, { name:'AES-GCM', length:256 }, false, ['encrypt','decrypt']);
}
export async function chiffre(key, texte){
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name:'AES-GCM', iv }, key, gzipSync(Buffer.from(texte, 'utf8'), { level:9 }));
  return JSON.stringify({ v:1, iv:Buffer.from(iv).toString('base64'), ct:Buffer.from(ct).toString('base64') });
}
export async function dechiffre(key, txt){
  const f = JSON.parse(txt);
  const pt = await subtle.decrypt({ name:'AES-GCM', iv:Buffer.from(f.iv, 'base64') }, key, Buffer.from(f.ct, 'base64'));
  return gunzipSync(Buffer.from(pt)).toString('utf8');
}
