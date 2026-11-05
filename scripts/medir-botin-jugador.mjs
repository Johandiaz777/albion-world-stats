// Mide con días REALES del escáner cuánto agrega el botín del jugador por tipo de pelea (no es parte de `npm test`).
//   node scripts/medir-botin-jugador.mjs <región> <fecha> [fecha ...]
import zlib from 'node:zlib';

import { buildDayRollup, compactExtras, mergeRollups } from '../lib/rollup.mjs';
import { fetchDayFile } from '../lib/sources.mjs';

const [region, ...dates] = process.argv.slice(2);
const gz = (s) => zlib.gzipSync(s, { level: 9 }).length;
const days = [];
for (const date of dates) {
  const stats = { bytes: 0, retries: 0 };
  const [killsText, battlesText, equipmentText] = await Promise.all(['kills', 'battles', 'equipment'].map((t) => fetchDayFile(t, region, date, stats)));
  const r = buildDayRollup({ killsText, battlesText: battlesText ?? '', equipmentText: equipmentText ?? '' });
  const { fl, badLines, ...data } = r;
  const without = { ...data, px: Object.fromEntries(Object.entries(data.px).map(([n, x]) => { const { lm, ...rest } = x; return [n, rest]; })) };
  const a = gz(JSON.stringify(without));
  const b = gz(JSON.stringify(data));
  console.log(`${date}: resumen ${(a / 1048576).toFixed(2)} MB -> ${(b / 1048576).toFixed(2)} MB (+${(((b - a) / a) * 100).toFixed(1)} %)`);
  days.push(data);
}
const w = mergeRollups(days);
let before = 0;
let after = 0;
let withLm = 0;
let total = 0;
for (const x of Object.values(w.px)) {
  const a = compactExtras(x, true, false);
  const b = compactExtras(x, true, true);
  if (!b) continue;
  total += 1;
  if (b.lm) withLm += 1;
  before += JSON.stringify(a).length;
  after += JSON.stringify(b).length;
}
console.log(`ventana de ${dates.length} días: ${total} jugadores, ${withLm} con lm (${((withLm / total) * 100).toFixed(0)} %)`);
console.log(`extras ${(before / 1e6).toFixed(2)} MB -> ${(after / 1e6).toFixed(2)} MB (+${(((after - before) / before) * 100).toFixed(1)} %), ${((after - before) / Math.max(1, withLm)).toFixed(0)} B por jugador con lm`);
