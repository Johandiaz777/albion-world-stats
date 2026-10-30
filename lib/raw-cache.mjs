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
    let r = await readWithRetry(url, size, tail, fetchImpl);
    if (r.status === 'mismatch') {
      stats.mismatches += 1;
      r = { status: 'restart' };
    } else if (r.status === 'error') {
      throw new Error(`escáner: ${url} no respondió`);
    } else {
      if (r.status === 'new') {
        fs.appendFileSync(file, r.data);
        stats.bytes += r.data.length;
      }
      return 'ok';
    }
  }
  // Primera vez (o el archivo cambió por dentro): entero.
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
 * Texto del archivo del día (con sus partes) o `null` si no existe en ninguna dirección (404, como
 * `fetchScraperDayText`). Lanza si la red falla tras los reintentos: esa región no se publica en esta corrida.
 * Solo guarda líneas completas: una línea a medio subir entra en la corrida siguiente.
 */
export async function syncDayText({ dir, region, type, date, fetchImpl = fetch, stats }) {
  const st = stats ?? { bytes: 0, mismatches: 0, fullDownloads: 0 };
  const base = localPath(dir, region, type, date, 1);
  let url = fs.existsSync(`${base}.url`) ? fs.readFileSync(`${base}.url`, 'utf8') : null;
  if (url) {
    if ((await syncPart(base, url, fetchImpl, st)) === 'missing') url = null;
  }
  if (!url) {
    for (const candidate of candidateUrls(type, region, date)) {
      if ((await syncPart(base, candidate, fetchImpl, st)) === 'ok') {
        url = candidate;
        break;
      }
    }
  }
  if (!url) return null;
  const texts = [fs.readFileSync(base, 'utf8')];
  if (url.includes('/albion-data-') && fs.statSync(base).size >= PART_PROBE_BYTES) {
    for (let n = 2; n <= MAX_PARTS; n++) {
      const file = localPath(dir, region, type, date, n);
      if ((await syncPart(file, partUrl(url, n), fetchImpl, st)) === 'missing') break;
      texts.push(fs.readFileSync(file, 'utf8'));
      if (fs.statSync(file).size < PART_PROBE_BYTES) break;
    }
  }
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
