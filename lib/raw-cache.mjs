// Copia local de los archivos del escáner que se baja SOLO por lo nuevo (parte 137, Rankings desde stats-builder).
//
// `rawcache/<región>/<tipo>/<día>.ndjson` (+ `.url`, la dirección de donde salió). Cada corrida pide a raw solo los bytes
// que faltan (pedido `Range` desde el tamaño local, comprobando que el final ya guardado no cambió: lib/meta-build.mjs
// `readNewBytes`). La carpeta se guarda entre corridas con la caché de Actions (stats.yml). Si no está (primera vez,
// caché vencida), se baja entera: el resultado es el mismo, solo cuesta más bajarlo.
//
// Mismas direcciones y mismo orden que las funciones (`scraperDataUrl`, `candidateUrls`): repo mensual y detrás el
// histórico. Las partes `.2`, `.3`... de un día que pasó el tope del escáner se guardan aparte y se juntan al leer,
// igual que `fetchDayFile` de lib/sources.mjs.
import fs from 'node:fs';
import path from 'node:path';

import { readNewBytes, partUrl } from './meta-build.mjs';
import { candidateUrls } from './sources.mjs';

const TAIL_BYTES = 256;
const PART_PROBE_BYTES = 85_000_000;
const MAX_PARTS = 50;
const ATTEMPTS = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function localPath(dir, region, type, date, part) {
  return path.join(dir, region, type, part <= 1 ? `${date}.ndjson` : `${date}.${part}.ndjson`);
}

function readTail(file) {
  const size = fs.statSync(file).size;
  const len = Math.min(TAIL_BYTES, size);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return { size, tail: buf };
  } finally {
    fs.closeSync(fd);
  }
}

async function readWithRetry(url, cursor, tail, fetchImpl) {
  let r;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    r = await readNewBytes(url, cursor, tail, fetchImpl);
    if (r.status !== 'error') return r;
    if (attempt < ATTEMPTS) await sleep(1000 * attempt);
  }
  return r;
}

/** Pone al día una parte (1 = el archivo de siempre) desde `url`. Devuelve 'ok', 'missing' o lanza si la red falla. */
async function syncPart(file, url, fetchImpl, stats) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const urlFile = `${file}.url`;
  const sameUrl = fs.existsSync(file) && fs.existsSync(urlFile) && fs.readFileSync(urlFile, 'utf8') === url;
  if (sameUrl) {
    const { size, tail } = readTail(file);
    const r = await readWithRetry(url, size, tail, fetchImpl);
    if (r.status === 'error') throw new Error(`escáner: ${url} no respondió`);
    if (r.status === 'missing') return 'missing'; // copia local vacía y el archivo ya no está: como un 404
    if (r.status !== 'mismatch') {
      if (r.status === 'new') {
        fs.appendFileSync(file, r.data);
        stats.bytes += r.data.length;
      }
      return 'ok';
    }
    stats.mismatches += 1; // cambió por dentro: se baja entero
  }
  // Primera vez (o el archivo cambió por dentro, o salió de otra dirección): entero.
  const r = await readWithRetry(url, 0, null, fetchImpl);
  if (r.status === 'missing') return 'missing';
  if (r.status === 'error' || r.status === 'mismatch') throw new Error(`escáner: ${url} no respondió`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, r.status === 'new' ? r.data : Buffer.alloc(0));
  fs.renameSync(tmp, file);
  fs.writeFileSync(urlFile, url);
  stats.bytes += r.status === 'new' ? r.data.length : 0;
  stats.fullDownloads += 1;
  return 'ok';
}

/**
 * Texto del archivo del día o `null` si no existe en ninguna dirección (404, como `fetchScraperDayText` de las
 * funciones). Lanza si la red falla tras los reintentos: esa región no se publica en esta corrida.
 *
 * Mismo orden que las funciones: se prueban las direcciones EN ORDEN (repo mensual y detrás el histórico) en cada
 * corrida, así que si el mensual aparece después de haber leído el histórico, se pasa al mensual como haría la
 * función. Solo guarda líneas completas: una línea a medio subir entra en la corrida siguiente (la función la
 * descarta igual, porque `JSON.parse` falla).
 *
 * `withParts`: suma las partes `.2`, `.3`... de un día que pasó el tope del escáner (como `fetchDayFile` de
 * lib/sources.mjs). Rankings lo pasa en `false` porque `refreshCraftingLeaderboards` no las lee (mismo resultado).
 */
export async function syncDayText({ dir, region, type, date, fetchImpl = fetch, stats, withParts = true, urls = candidateUrls(type, region, date) }) {
  const st = stats ?? { bytes: 0, mismatches: 0, fullDownloads: 0 };
  const base = localPath(dir, region, type, date, 1);
  let url = null;
  for (const candidate of urls) {
    if ((await syncPart(base, candidate, fetchImpl, st)) === 'ok') {
      url = candidate;
      break;
    }
  }
  if (!url) return null;
  const texts = [fs.readFileSync(base, 'utf8')];
  if (withParts && url.includes('/albion-data-') && fs.statSync(base).size >= PART_PROBE_BYTES) {
    for (let n = 2; n <= MAX_PARTS; n++) {
      const file = localPath(dir, region, type, date, n);
      if ((await syncPart(file, partUrl(url, n), fetchImpl, st)) === 'missing') break;
      texts.push(fs.readFileSync(file, 'utf8'));
      if (fs.statSync(file).size < PART_PROBE_BYTES) break;
    }
  }
  if (st.files) st.files[`${type}/${date}`] = { url, bytes: Buffer.byteLength(texts[0]) };
  return texts.length === 1 ? texts[0] : texts.map((t) => (t.endsWith('\n') || t === '' ? t : `${t}\n`)).join('');
}

/** Borra de la copia local los días que ya no se usan. */
export function pruneRawCache(dir, keepDates) {
  const keep = new Set(keepDates);
  let removed = 0;
  if (!fs.existsSync(dir)) return removed;
  for (const region of fs.readdirSync(dir)) {
    for (const type of fs.existsSync(path.join(dir, region)) ? fs.readdirSync(path.join(dir, region)) : []) {
      const typeDir = path.join(dir, region, type);
      if (!fs.statSync(typeDir).isDirectory()) continue;
      for (const name of fs.readdirSync(typeDir)) {
        const date = name.slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(date) && !keep.has(date)) {
          fs.rmSync(path.join(typeDir, name), { force: true });
          removed += 1;
        }
      }
    }
  }
  return removed;
}
