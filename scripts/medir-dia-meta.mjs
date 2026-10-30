import fs from 'node:fs';
import zlib from 'node:zlib';
const SB = 'C:/Users/angel/Desktop/Albion/orchestration/p136-github/stats-builder/lib';
const core = await import('file:///' + SB + '/meta-core.mjs');
const meta = await import('file:///' + SB + '/meta.mjs');
const [dir, date] = process.argv.slice(2);
for (const region of ['asia', 'europe', 'americas']) {
  const t0 = Date.now();
  const kills = meta.parseNdjson(fs.readFileSync(`${dir}/${region}-kills-${date}.ndjson`, 'utf8')).rows;
  const equip = meta.parseNdjson(fs.readFileSync(`${dir}/${region}-equipment-${date}.ndjson`, 'utf8')).rows;
  const { events, pending } = meta.joinKillsAndEquipment(kills, equip);
  const byDay = meta.groupByDay(events);
  const t1 = Date.now();
  const r = core.emptyMetaRollup(date);
  const added = core.addEventsToRollup(r, byDay.get(date) ?? []);
  const t2 = Date.now();
  const n = (o) => Object.keys(o ?? {}).length;
  const raw = JSON.stringify(r);
  const capped = JSON.stringify(core.capMetaRollup(r));
  const gz = (s) => zlib.gzipSync(s).length;
  const days = [...byDay.keys()].map((d) => `${d}:${byDay.get(d).length}`).join(' ');
  console.log(`${region} ${date}: kills ${kills.length}, equipo ${equip.length}, eventos ${events.length} (${days}), pendientes ${pending.kills.length}/${pending.equipment.length}, sumados ${added}, samples ${r.samples}`);
  console.log(`  distintos: slots ${core.META_SLOTS.map((s) => n(r.slots[s])).join('/')} builds ${n(r.builds)} killers ${n(r.killers)} matchups ${n(r.matchups)} weapons ${n(r.weapons)} items ${n(r.items)}`);
  console.log(`  sin tope ${(raw.length / 1e6).toFixed(2)} MB (gz ${(gz(raw) / 1e6).toFixed(2)}), con topes de Meta ${(capped.length / 1e6).toFixed(2)} MB (gz ${(gz(capped) / 1e6).toFixed(2)}); leer+juntar ${t1 - t0} ms, sumar ${t2 - t1} ms`);
  // Cuánto deja afuera cada tope (en kills/usos)
  const cut = (obj, cap, val) => { const v = Object.values(obj ?? {}).map(val).sort((a, b) => b - a); const tot = v.reduce((a, b) => a + b, 0); const kept = v.slice(0, cap).reduce((a, b) => a + b, 0); return tot ? (100 * (1 - kept / tot)).toFixed(1) + '%' : '0%'; };
  console.log(`  fuera por los topes: builds(800) ${cut(r.builds, 800, (b) => b.c + (b.d ?? 0))}, killers(300) ${cut(r.killers, 300, (k) => k.c)}, matchups(6000) ${cut(r.matchups, 6000, (m) => m[0])}, items(1500) ${cut(r.items, 1500, (t) => t.slice(0, 8).reduce((a, b) => a + b, 0))}, weapons(300) ${cut(r.weapons, 300, (t) => t[0] + t[1])}`);
}
