// Compara dos resultados de Rankings y dice si son IGUALES y, si no, dónde difieren (parte 138).
//
//   node scripts/comparar-rankings.mjs <firebase.json> <stats-builder.json> [--max 30]
//
// Cada archivo puede ser:
//  - `rankingspub/<región>.json` de `node build.mjs rankings` (o bajado de la rama `rankings`), o
//  - lo que escribe la prueba de igualdad de las funciones (`RANKINGS_FN_OUT`, functions/src/__tests__/
//    rankings-equality.real.test.ts): `{ region, dayKey, weekKey, all, day, week }` calculado con el código compilado
//    de `refreshCraftingLeaderboards` (`computeCombatWindows`).
// Se comparan `all`, `day` y `week` (lo que la función copia) y `dayKey`/`weekKey`. Igual = mismo JSON byte a byte
// (mismo orden de claves y de filas: los empates también). Sale con 0 si son iguales y 1 si no.
import fs from 'node:fs';
import zlib from 'node:zlib';

const args = process.argv.slice(2);
const files = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1] === '--max'));
const max = args.includes('--max') ? Number(args[args.indexOf('--max') + 1]) : 30;
if (files.length !== 2) {
  console.error('uso: node scripts/comparar-rankings.mjs <firebase.json> <stats-builder.json> [--max 30]');
  process.exit(2);
}
const load = (f) => {
  let buf = fs.readFileSync(f);
  if (f.endsWith('.gz')) buf = zlib.gunzipSync(buf);
  return JSON.parse(buf.toString('utf8'));
};
const [a, b] = files.map(load);

/** Diferencias entre dos valores JSON: [ruta, a, b]. Los arreglos se comparan por posición (el orden importa). */
function diffJson(x, y, at = '', out = [], limit = Infinity) {
  if (out.length >= limit) return out;
  if (Object.is(x, y)) return out;
  const tx = Array.isArray(x) ? 'array' : x === null ? 'null' : typeof x;
  const ty = Array.isArray(y) ? 'array' : y === null ? 'null' : typeof y;
  if (tx !== ty || (tx !== 'object' && tx !== 'array')) {
    out.push([at || '(raíz)', x, y]);
    return out;
  }
  if (tx === 'array') {
    if (x.length !== y.length) out.push([`${at}.length`, x.length, y.length]);
    for (let i = 0; i < Math.min(x.length, y.length); i++) diffJson(x[i], y[i], `${at}[${i}]`, out, limit);
    return out;
  }
  const kx = Object.keys(x);
  const ky = Object.keys(y);
  for (const k of kx) if (!(k in y)) out.push([`${at}.${k}`, x[k], '(no está)']);
  for (const k of ky) if (!(k in x)) out.push([`${at}.${k}`, '(no está)', y[k]]);
  for (const k of kx) if (k in y) diffJson(x[k], y[k], `${at}.${k}`, out, limit);
  if (!out.length && kx.join('|') !== ky.join('|')) out.push([`${at} (orden de claves)`, kx.join(','), ky.join(',')]);
  return out;
}

const short = (v) => {
  const s = JSON.stringify(v);
  return s === undefined ? String(v) : s.length > 120 ? `${s.slice(0, 117)}...` : s;
};

let equal = true;
for (const key of ['dayKey', 'weekKey']) {
  if (a[key] !== b[key]) {
    equal = false;
    console.log(`${key}: ${a[key]} ≠ ${b[key]}`);
  }
}
for (const w of ['all', 'day', 'week']) {
  if (!a[w] || !b[w]) {
    equal = false;
    console.log(`${w}: falta en ${!a[w] ? files[0] : files[1]}`);
    continue;
  }
  const same = JSON.stringify(a[w]) === JSON.stringify(b[w]);
  const lists = Object.keys(a[w]).filter((k) => Array.isArray(a[w][k]));
  console.log(`${w}: ${same ? 'IGUAL' : 'DISTINTO'} (sampleSize ${a[w].sampleSize} / ${b[w].sampleSize}; ${lists.length} listas; ${JSON.stringify(a[w]).length} caracteres)`);
  if (same) continue;
  equal = false;
  const diffs = diffJson(a[w], b[w], w, [], max);
  for (const [at, x, y] of diffs) console.log(`  ${at}: ${short(x)}  ≠  ${short(y)}`);
  if (diffs.length >= max) console.log(`  … (se muestran las primeras ${max})`);
}
console.log(equal ? 'RESULTADO: IGUALES' : 'RESULTADO: DISTINTOS');
process.exit(equal ? 0 : 1);
