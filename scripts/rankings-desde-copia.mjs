// Rankings de stats-builder sobre una copia FIJA de los archivos del escáner (sin bajar nada), para la prueba de
// igualdad con la función (parte 138). La copia tiene la forma de `rawcache/` (<región>/<tipo>/<día>.ndjson).
//
//   node scripts/rankings-desde-copia.mjs --dir <copia> --now 2026-10-31T00:40:00Z --out <carpeta> [--region asia]
//
// Escribe <out>/<región>.json con la misma forma que `node build.mjs rankings` (sin `sources`). Un día que no está en
// la copia cuenta como 404, igual que en la función.
import fs from 'node:fs';
import path from 'node:path';

import { buildRegionRankings, RANKINGS_REGIONS } from '../lib/rankings-run.mjs';
import { RANKING_CORE_SOURCE_SHA } from '../lib/ranking-core.mjs';
import { writeJson } from '../lib/store.mjs';

const args = process.argv.slice(2);
const arg = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const dir = arg('--dir');
const out = arg('--out');
const now = new Date(arg('--now') ?? NaN);
if (!dir || !out || Number.isNaN(now.getTime())) {
  console.error('uso: node scripts/rankings-desde-copia.mjs --dir <copia> --now <ISO> --out <carpeta> [--region r]');
  process.exit(2);
}
const regions = arg('--region') ? [arg('--region')] : RANKINGS_REGIONS;
for (const region of regions) {
  const t0 = Date.now();
  const readDay = async (type, date) => {
    const file = path.join(dir, region, type, `${date}.ndjson`);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  };
  const r = await buildRegionRankings({ region, now, readDay });
  writeJson(path.join(out, `${region}.json`), {
    v: 1,
    region,
    builtAt: now.toISOString(),
    dayKey: r.dayKey,
    weekKey: r.weekKey,
    dates: r.dates,
    core: RANKING_CORE_SOURCE_SHA,
    killsSeen: r.killsSeen,
    battles: r.battles,
    all: r.all,
    day: r.day,
    week: r.week,
  });
  console.log(`${region}: ${r.killsSeen} kills, ${r.battles} peleas, día ${r.dayKey} (${r.day.sampleSize}), semana ${r.weekKey} (${r.week.sampleSize}), ${Date.now() - t0} ms`);
}
