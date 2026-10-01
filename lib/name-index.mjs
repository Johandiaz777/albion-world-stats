// Índice por nombre de los archivos diarios del scraper: para cada nombre, en qué bytes del archivo
// están sus líneas ([inicio, largo, inicio, largo, ...]). La app pide solo esos bytes (Range) en vez
// de bajar el día entero: buscar un jugador en el Radar bajaba 7 días de kills (~8 MB comprimidos
// cada uno, ~55 MB) y se cortaba en datos móviles; con esto son ~60 KB (medido 01/10/2026).
//
// Funciona porque el scraper solo AGREGA líneas al final del archivo del día (0 líneas borradas en
// los 75 commits del 01/10): una posición ya indexada no se mueve. La app valida cada línea que
// recibe y, si algo no coincide, vuelve a bajar el día entero.
import { shardOf } from './rollup.mjs';

export const NAME_INDEX_VERSION = 1;
/** Kills: misma partición que el índice de jugadores (~6 KB comprimida por parte y día). */
export const KILL_INDEX_SHARDS = 256;
/** Peleas por gremio: ~3 KB comprimida por parte y día. */
export const BATTLE_INDEX_SHARDS = 32;
/** Días que se indexan: la búsqueda de kills del Radar mira 7; "Ver peleas del período" hasta 31. */
export const KILL_INDEX_DAYS = 8;
export const BATTLE_INDEX_DAYS = 32;

/** Asesino y víctima: la búsqueda de la app solo muestra kills donde el nombre es uno de los dos. */
export function killNames(k) {
  const out = new Set();
  if (typeof k?.killerName === 'string' && k.killerName) out.add(k.killerName);
  if (typeof k?.victimName === 'string' && k.victimName) out.add(k.victimName);
  return out;
}

/** Gremios de una pelea. */
export function battleGuildNames(b) {
  const out = new Set();
  for (const g of Array.isArray(b?.guilds) ? b.guilds : []) if (typeof g?.name === 'string' && g.name) out.add(g.name);
  return out;
}

/**
 * `text`: el archivo del día tal como se bajó (UTF-8; las posiciones son en bytes, no en
 * caracteres). Devuelve `{ bytes, shards }`: `bytes` = tamaño indexado (lo que venga después es más
 * nuevo que el índice) y cada parte `{ nombre en minúsculas: [inicio, largo, ...] }`. Las líneas
 * rotas (conflictos de merge del scraper) se saltan.
 */
export function buildNameIndex(text, namesOf, shards) {
  const buf = Buffer.from(text ?? '', 'utf8');
  const out = Array.from({ length: shards }, () => ({}));
  let off = 0;
  while (off < buf.length) {
    let end = buf.indexOf(10, off);
    if (end === -1) end = buf.length;
    if (end > off) {
      let rec = null;
      try {
        rec = JSON.parse(buf.toString('utf8', off, end));
      } catch {
        rec = null;
      }
      if (rec) {
        for (const name of namesOf(rec)) {
          const key = name.toLowerCase();
          (out[shardOf(name, shards)][key] ??= []).push(off, end - off);
        }
      }
    }
    off = end + 1;
  }
  return { bytes: buf.length, shards: out };
}

/** Escribe las partes de un día en `<dir>/<fecha>/<i>.json`, también las vacías: una parte que
 * existe sin el nombre dice "ese día no aparece", una que falta dice "no hay índice". `src`: la URL
 * del archivo indexado (las posiciones valen solo para ese archivo). */
export function writeNameIndex(writeJson, dir, region, date, index, src = null) {
  let bytes = 0;
  index.shards.forEach((n, i) => {
    bytes += writeJson(`${dir}/${date}/${i}.json`, { v: NAME_INDEX_VERSION, region, date, bytes: index.bytes, ...(src ? { src } : {}), n });
  });
  return bytes;
}
