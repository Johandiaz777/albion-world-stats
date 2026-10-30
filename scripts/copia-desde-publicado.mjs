// Arma una copia FIJA de los archivos del escáner con los MISMOS bytes que usó una corrida publicada de Rankings
// (campo `sources` de <región>.json: de qué dirección salió cada día y cuántos bytes leyó). Con esa copia, la prueba
// de igualdad de las funciones calcula sobre exactamente los mismos datos que stats-builder en Actions (parte 138).
//
//   node scripts/copia-desde-publicado.mjs --rama rankings --out <carpeta> [--region asia]
//
// Deja <out>/copia/<región>/<tipo>/<día>.ndjson (+ .url) y <out>/sb/<región>.json, y escribe el instante (`builtAt`)
// para RANKINGS_NOW. Los archivos del escáner solo crecen: pedir los primeros N bytes da lo que leyó la corrida.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const branch = arg('--rama') ?? 'rankings';
const out = arg('--out');
if (!out || !/^[a-z0-9-]+$/.test(branch)) {
  console.error('uso: node scripts/copia-desde-publicado.mjs --rama rankings --out <carpeta> [--region r]');
  process.exit(2);
}
const base = `https://raw.githubusercontent.com/Johandiaz777/albion-world-stats/${branch}`;
const regions = arg('--region') ? [arg('--region')] : ['americas', 'europe', 'asia'];
const RAW = /^https:\/\/raw\.githubusercontent\.com\/Angelsistemas7\/[A-Za-z0-9._-]+\/main\/[A-Za-z0-9/._-]+\.ndjson$/;
let builtAt = null;
for (const region of regions) {
  const res = await fetch(`${base}/${region}.json`);
  if (!res.ok) throw new Error(`${region}.json: HTTP ${res.status}`);
  const text = await res.text();
  const pub = JSON.parse(text);
  fs.mkdirSync(path.join(out, 'sb'), { recursive: true });
  fs.writeFileSync(path.join(out, 'sb', `${region}.json`), text);
  if (builtAt && builtAt !== pub.builtAt) console.warn(`ojo: ${region} es de otra corrida (${pub.builtAt})`);
  builtAt ??= pub.builtAt;
  let bytes = 0;
  for (const [key, src] of Object.entries(pub.sources ?? {})) {
    const [type, date] = key.split('/');
    if (!['kills', 'battles'].includes(type) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !RAW.test(src.url) || !Number.isInteger(src.bytes)) throw new Error(`fuente rara: ${key}`);
    const file = path.join(out, 'copia', region, type, `${date}.ndjson`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let body = Buffer.alloc(0);
    if (src.bytes > 0) {
      const r = await fetch(src.url, { headers: { Range: `bytes=0-${src.bytes - 1}`, 'Accept-Encoding': 'identity' } });
      if (r.status !== 206 && r.status !== 200) throw new Error(`${src.url}: HTTP ${r.status}`);
      body = Buffer.from(await r.arrayBuffer()).subarray(0, src.bytes);
      if (body.length !== src.bytes) throw new Error(`${src.url}: ${body.length} de ${src.bytes} bytes`);
    }
    fs.writeFileSync(file, body);
    fs.writeFileSync(`${file}.url`, src.url);
    bytes += body.length;
  }
  console.log(`${region}: ${Object.keys(pub.sources ?? {}).length} archivos, ${(bytes / 1e6).toFixed(1)} MB, builtAt ${pub.builtAt}`);
}
console.log(`RANKINGS_NOW=${builtAt}`);
