// Lectura/escritura tolerante (misma lección del scraper de kills: un archivo roto no puede tumbar
// ni envenenar las corridas siguientes). Leer un archivo faltante, vacío, truncado o con marcadores
// de conflicto devuelve el valor por defecto; escribir es atómico (archivo temporal + rename).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export function hasConflictMarkers(text) {
  return /^(<<<<<<< |>>>>>>> |=======$)/m.test(text);
}

export function readJson(file, fallback, log = () => {}) {
  try {
    if (!fs.existsSync(file)) return fallback;
    let buf = fs.readFileSync(file);
    if (file.endsWith('.gz')) buf = zlib.gunzipSync(buf);
    const text = buf.toString('utf8');
    if (!text.trim() || hasConflictMarkers(text)) {
      log(`${path.basename(file)} vacío o dañado: se ignora`);
      return fallback;
    }
    return JSON.parse(text);
  } catch (err) {
    log(`${path.basename(file)} ilegible (${err.message}): se ignora`);
    return fallback;
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let buf = Buffer.from(JSON.stringify(value));
  if (file.endsWith('.gz')) buf = zlib.gzipSync(buf, { level: 9 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
  return buf.length;
}

// ---- Acumulado en partes (parte 136) ----
// El acumulado de "Todo" (`index/<región>/_acc/a.json.gz`) medía el 30/10/2026 72 MB comprimido y 432 MB
// de JSON en Américas, y crecía ~1,6 MB comprimidos por día. Dos topes lo iban a romper sin aviso:
//  - V8 no arma textos de más de 536.870.888 caracteres: `JSON.stringify` y `toString` tiran
//    «Invalid string length» (a este ritmo, hacia mediados de noviembre);
//  - GitHub rechaza archivos de más de 100 MiB: el push de la rama `index` entera fallaría.
// Por eso se guarda en partes: `<base>.meta.json` (versión y cuántas partes) y `<base>.p<i>.json.gz`, cada una
// con un trozo de las claves de primer nivel (`{"k": clave, "o": {...}}`, o `{"k": clave, "v": valor}` si no es un
// objeto). Ninguna parte pasa de `maxChars` caracteres, así que ningún texto se acerca al tope de V8 y cada archivo
// queda muy por debajo de los 50 MiB. Los datos chicos de cabecera (versión, desde, hasta) van en el índice.
// Leer y volver a escribir da el mismo objeto con el mismo orden de claves.

export const PARTS_VERSION = 1;
export const PARTS_MAX_CHARS = 48_000_000;

function partFile(base, i) {
  return `${base}.p${i}.json.gz`;
}

function writeAtomic(file, buf) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
}

/** Escribe `data` (un objeto) en partes y `head` (datos chicos) en el índice. Devuelve { bytes, parts, maxPartBytes }.
 * Borra las partes de una escritura anterior que ya no hacen falta y, si se pasa `legacyFile`, el archivo de un
 * solo trozo de antes. */
export function writeJsonParts(base, head, value, { maxChars = PARTS_MAX_CHARS, legacyFile = null } = {}) {
  fs.mkdirSync(path.dirname(base), { recursive: true });
  const parts = [];
  let current = null;
  let currentChars = 0;
  const flush = () => {
    if (current) parts.push(current);
    current = null;
    currentChars = 0;
  };
  for (const [k, v] of Object.entries(value)) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      flush();
      parts.push({ k, v });
      continue;
    }
    flush();
    current = { k, o: {} };
    for (const [ek, ev] of Object.entries(v)) {
      // Lo que ocupa esta entrada dentro del JSON de la parte: "clave":valor, (sin espacios, como JSON.stringify).
      const chars = JSON.stringify(ek).length + JSON.stringify(ev).length + 2;
      if (currentChars > 0 && currentChars + chars > maxChars) {
        flush();
        current = { k, o: {} };
      }
      current.o[ek] = ev;
      currentChars += chars;
    }
    flush();
  }
  let bytes = 0;
  let maxPartBytes = 0;
  parts.forEach((part, i) => {
    const buf = zlib.gzipSync(Buffer.from(JSON.stringify(part)), { level: 9 });
    writeAtomic(partFile(base, i), buf);
    bytes += buf.length;
    maxPartBytes = Math.max(maxPartBytes, buf.length);
  });
  // El índice va al final: una escritura cortada a la mitad deja el índice anterior, que no coincide con
  // las partes nuevas, y la lectura lo detecta (cuenta y suma de control) y vuelve a armar desde los días.
  const sums = parts.map((_, i) => fs.statSync(partFile(base, i)).size);
  writeAtomic(`${base}.meta.json`, Buffer.from(JSON.stringify({ v: PARTS_VERSION, n: parts.length, sizes: sums, head })));
  for (let i = parts.length; fs.existsSync(partFile(base, i)); i++) fs.rmSync(partFile(base, i));
  if (legacyFile && fs.existsSync(legacyFile)) fs.rmSync(legacyFile);
  return { bytes, parts: parts.length, maxPartBytes };
}

/** Lee lo que escribió `writeJsonParts`: `{ head, data }`. Si falta el índice devuelve `undefined` (no hay partes:
 * quien llama prueba el formato viejo); si algo no cuadra (una parte que falta, otro tamaño, JSON roto) devuelve
 * `fallback`, igual que `readJson`. */
export function readJsonParts(base, fallback, log = () => {}) {
  const metaFile = `${base}.meta.json`;
  if (!fs.existsSync(metaFile)) return undefined;
  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    if (meta?.v !== PARTS_VERSION || !Number.isInteger(meta.n) || meta.n < 0 || !Array.isArray(meta.sizes) || meta.sizes.length !== meta.n) {
      log(`${path.basename(metaFile)} con otra forma: se ignora`);
      return fallback;
    }
    const out = {};
    for (let i = 0; i < meta.n; i++) {
      const file = partFile(base, i);
      if (!fs.existsSync(file) || fs.statSync(file).size !== meta.sizes[i]) {
        log(`${path.basename(file)} falta o no coincide con el índice: se ignora el acumulado`);
        return fallback;
      }
      const text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
      if (hasConflictMarkers(text)) {
        log(`${path.basename(file)} dañado: se ignora el acumulado`);
        return fallback;
      }
      const part = JSON.parse(text);
      if (!part || typeof part.k !== 'string') return fallback;
      if ('o' in part) out[part.k] = Object.assign(out[part.k] ?? {}, part.o);
      else out[part.k] = part.v;
    }
    return { head: meta.head ?? null, data: out };
  } catch (err) {
    log(`${path.basename(base)} en partes ilegible (${err.message}): se ignora`);
    return fallback;
  }
}
