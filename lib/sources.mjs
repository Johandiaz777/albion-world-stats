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

/** Texto del archivo o `null` si no existe en ningún lado (404 es normal). Reintenta fallos de red. */
export async function fetchDayFile(type, region, date, stats) {
  for (const url of candidateUrls(type, region, date)) {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': 'AlbionWorld-stats/1.0' } });
        if (res.status === 404) break;
        if (res.ok) {
          const text = await res.text();
          if (stats) stats.bytes += text.length;
          sources.set(`${type}|${region}|${date}`, url);
          return text;
        }
      } catch {
        /* red: se reintenta */
      }
      if (stats) stats.retries += 1;
      await sleep(2000 * attempt);
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
