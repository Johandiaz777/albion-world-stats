// De dónde leer los archivos diarios del scraper de kills. Misma regla que la app
// (`src/utils/scraper-data-url.ts`) y las Functions (`scraperDataUrl`): hasta el 30/09/2026 todo vive
// en el repo histórico; desde el 01/10/2026 cada región tiene su repo mensual. Si el mensual no tiene
// el archivo (por ejemplo, porque el scraper todavía escribe en el histórico), se prueba el histórico.

const OWNER = 'Angelsistemas7';
const LEGACY = 'angel-prueba0-xdxdxd';
const FIRST_MONTHLY_DAY = '2026-10-01';
/** Primer día con kills guardadas en el repo histórico. */
export const FIRST_DAY = '2026-07-25';

/** Hasta el 30/09/2026 el scraper guardaba Europa y América CRUZADOS (usaba el host de América para
 * "europe" y el de Europa para "americas"; confirmado por IDs de evento y horas pico). Desde el
 * 01/10 escribe cada región donde corresponde. Por eso, para los días anteriores, cada región se lee
 * de la carpeta de la otra. Misma regla en la app y en las Functions. */
export const FIRST_CORRECT_REGION_DAY = '2026-10-01';
export function legacyFolder(region, date) {
  if (date >= FIRST_CORRECT_REGION_DAY) return region;
  return region === 'europe' ? 'americas' : region === 'americas' ? 'europe' : region;
}

export function candidateUrls(type, region, date) {
  const legacy = `https://raw.githubusercontent.com/${OWNER}/${LEGACY}/main/data/${type}/${legacyFolder(region, date)}/${date}.ndjson`;
  if (date < FIRST_MONTHLY_DAY) return [legacy];
  return [`https://raw.githubusercontent.com/${OWNER}/albion-data-${region}-${date.slice(0, 7)}/main/${type}/${date}.ndjson`, legacy];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** De qué URL salió cada archivo bajado (`tipo|región|fecha`): el índice por nombre lo guarda para
 * que la app pida los bytes al MISMO archivo (repo mensual o histórico). */
const sources = new Map();
export function dayFileSource(type, region, date) {
  return sources.get(`${type}|${region}|${date}`) ?? null;
}

/** Parte 136: cuando el archivo de un día llega a 90 MB (GitHub rechaza más de 100 MiB), el escáner sigue en
 * `<día>.2.ndjson`, `.3`... en el MISMO repo mensual. Dirección de la parte `n` (1 = el archivo de siempre). */
export function partUrl(url, n) {
  return n <= 1 ? url : url.replace(/\.ndjson$/, `.${n}.ndjson`);
}
const MAX_PARTS = 50;

/** Bytes del archivo de siempre (sin las partes) cuando el día tiene partes: el índice por nombre guarda
 * posiciones dentro de ESE archivo, así que tiene que armarse solo con él. */
const baseBytes = new Map();
export function dayFileBaseBytes(type, region, date) {
  return baseBytes.get(`${type}|${region}|${date}`);
}

/** Un pedido con reintentos: texto, `null` si es 404, o `undefined` si la red no respondió en 4 intentos. */
async function fetchText(url, stats) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      // Con tope (auditoría p60): un pedido colgado se comía la corrida entera (límite de 60 min).
      const res = await fetch(url, { headers: { 'User-Agent': 'AlbionWorld-stats/1.0' }, signal: AbortSignal.timeout(120_000) });
      if (res.status === 404) return null;
      if (res.ok) {
        const text = await res.text();
        if (stats) stats.bytes += text.length;
        return text;
      }
    } catch {
      /* red: se reintenta */
    }
    if (stats) stats.retries += 1;
    await sleep(2000 * attempt);
  }
  return undefined;
}

/** Texto del archivo o `null` si no existe en ningún lado (404 es normal). Reintenta fallos de red.
 * Parte 136: en los repos mensuales suma las partes `.2`, `.3`... del día, si las hay (un 404 más por archivo
 * cuando no hay). Si una parte no se pudo bajar, devuelve `null` como cuando falla el archivo entero: el día
 * queda pendiente y se completa en la próxima corrida, en vez de resumirse incompleto. */
export async function fetchDayFile(type, region, date, stats) {
  const key = `${type}|${region}|${date}`;
  for (const url of candidateUrls(type, region, date)) {
    const text = await fetchText(url, stats);
    if (text === null || text === undefined) continue;
    sources.set(key, url);
    baseBytes.delete(key);
    if (!url.includes('/albion-data-')) return text;
    const parts = [text];
    for (let n = 2; n <= MAX_PARTS; n++) {
      const more = await fetchText(partUrl(url, n), stats);
      if (more === null) break;
      if (more === undefined) return null;
      parts.push(more);
    }
    if (parts.length === 1) return text;
    baseBytes.set(key, Buffer.byteLength(text));
    return parts.map((p) => (p.endsWith('\n') ? p : `${p}\n`)).join('');
  }
  return null;
}

/** Tamaño en bytes del archivo del día (sin bajarlo: pide 1 byte y lee el total de `Content-Range`),
 * o `null` si no se pudo saber. Parte 59: el relleno de huecos del escáner puede agregar kills a un
 * día ya cerrado; si el archivo creció desde que se resumió, ese día se rehace. */
async function rangeSize(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'AlbionWorld-stats/1.0', Range: 'bytes=0-0', 'Accept-Encoding': 'identity' }, signal: AbortSignal.timeout(20_000) });
  if (res.status === 404) return 0;
  const total = Number(/\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1]);
  await res.arrayBuffer().catch(() => null);
  return Number.isFinite(total) && total > 0 ? total : null;
}

/** Parte 136: suma las partes `.2`, `.3`... del día (si crece la parte 2, el archivo de siempre no cambia). */
export async function dayFileSize(type, region, date) {
  for (const url of candidateUrls(type, region, date)) {
    try {
      const first = await rangeSize(url);
      if (first === 0) continue;
      if (first === null) return null;
      if (!url.includes('/albion-data-')) return first;
      let total = first;
      for (let n = 2; n <= MAX_PARTS; n++) {
        const more = await rangeSize(partUrl(url, n));
        if (more === 0) break;
        if (more === null) return null;
        total += more;
      }
      return total;
    } catch {
      continue; // fallo de red en esta dirección: se prueba la otra (auditoría p60)
    }
  }
  return null;
}

export function dateList(from, to) {
  const out = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86400e3) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}
