// Mide con un día REAL del escáner lo que agrega el botín por gremio y por pelea (no es parte de `npm test`).
//   node scripts/medir-botin.mjs <fecha> [gremio ...]
import zlib from 'node:zlib';

import { buildDayRollup, shardFights, thousands } from '../lib/rollup.mjs';
import { fetchDayFile } from '../lib/sources.mjs';

const [date, ...names] = process.argv.slice(2);
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const gz = (s) => zlib.gzipSync(s, { level: 9 }).length;
const silver = (n) => `${(n / 1e6).toFixed(1)}M`;

for (const region of ['americas', 'europe', 'asia']) {
  const stats = { bytes: 0, retries: 0 };
  const [killsText, battlesText, equipmentText] = await Promise.all(['kills', 'battles', 'equipment'].map((t) => fetchDayFile(t, region, date, stats)));
  if (killsText === null) {
    console.log(`\n== ${region}: sin archivo`);
    continue;
  }
  const r = buildDayRollup({ killsText, battlesText: battlesText ?? '', equipmentText: equipmentText ?? '' });
  const guilds = Object.entries(r.gl);
  const looted = guilds.reduce((a, [, v]) => a + v[0] + v[1] + v[2], 0);
  const lost = guilds.reduce((a, [, v]) => a + v[3] + v[4] + v[5], 0);
  const glPublished = JSON.stringify(Object.fromEntries(guilds.map(([g, v]) => [g, v.map(thousands)])));
  const flText = JSON.stringify(r.fl);
  const shards = Object.values(shardFights(r.fl)).map((f) => JSON.stringify({ v: 1, date, f }));
  const biggest = Math.max(...shards.map((s) => s.length));
  const pairs = Object.values(r.fl).reduce((a, f) => a + Object.keys(f).length, 0);
  console.log(`\n== ${region} ${date}`);
  console.log(`gremios con plata ${guilds.length} · botín ${silver(looted)} · perdido ${silver(lost)} · entre gremios no cuadra por las kills sin gremio`);
  console.log(`gl publicado por día: ${kb(glPublished.length)} (${kb(gz(glPublished))} comprimido), ${(glPublished.length / Math.max(1, guilds.length)).toFixed(0)} B por gremio`);
  console.log(`fights: ${Object.keys(r.fl).length} peleas, ${pairs} pares · ${kb(flText.length)} (${kb(gz(flText))} comprimido) · parte más grande ${kb(biggest)} (${kb(gz(shards[0] ?? ''))} comprimido la primera)`);
  const top = Object.entries(r.fl)
    .map(([id, f]) => [id, Object.values(f).reduce((a, v) => a + v[0], 0), Object.keys(f).length])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  console.log('peleas con más plata:', top.map(([id, k, n]) => `${id}: ${(k / 1000).toFixed(1)}M, ${n} gremios`).join(' · '));
  const wanted = names.length ? names : guilds.sort((a, b) => b[1][2] - a[1][2]).slice(0, 4).map(([g]) => g);
  for (const name of wanted) {
    const v = r.gl[name];
    if (!v) continue;
    const x = r.gx?.[name] ?? [];
    console.log(`  ${name}: botín solo ${silver(v[0])} grupo ${silver(v[1])} ZvZ ${silver(v[2])} | perdido solo ${silver(v[3])} grupo ${silver(v[4])} ZvZ ${silver(v[5])} | muertes ${x[3] ?? 0}/${x[4] ?? 0}/${x[5] ?? 0}`);
  }
}
