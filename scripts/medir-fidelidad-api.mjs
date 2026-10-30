// Compara Meta armado con eventos de la API real contra Meta armado con las líneas del escáner, para las MISMAS kills.
import fs from 'node:fs';
import path from 'node:path';
const SB = 'C:/Users/angel/Desktop/Albion/orchestration/p136-github/stats-builder/lib';
const core = await import('file:///' + SB + '/meta-core.mjs');
const meta = await import('file:///' + SB + '/meta.mjs');
const [region, apiDir, killsFile, equipFile] = process.argv.slice(2);
const api = [];
for (const f of fs.readdirSync(apiDir).filter((f) => f.startsWith(region + '-'))) api.push(...JSON.parse(fs.readFileSync(path.join(apiDir, f), 'utf8')));
const kills = meta.parseNdjson(fs.readFileSync(killsFile, 'utf8')).rows;
const equip = meta.parseNdjson(fs.readFileSync(equipFile, 'utf8')).rows;
const { events: rebuilt } = meta.joinKillsAndEquipment(kills, equip);
const rebuiltById = new Map(rebuilt.map((e) => [e.EventId, e]));
const apiById = new Map(api.map((e) => [e.EventId, e]));
const common = [...apiById.keys()].filter((id) => rebuiltById.has(id));
console.log(`${region}: API ${apiById.size} eventos, escáner ${rebuiltById.size}, en común ${common.length}`);
const run = (events) => {
  const byDay = meta.groupByDay(events);
  const out = {};
  for (const [d, list] of byDay) {
    const r = core.emptyMetaRollup(d);
    core.addEventsToRollup(r, list);
    out[d] = r;
  }
  return out;
};
const A = run(common.map((id) => apiById.get(id)));
const B = run(common.map((id) => rebuiltById.get(id)));
const diffs = {};
const note = (k) => (diffs[k] = (diffs[k] ?? 0) + 1);
for (const d of Object.keys(A)) {
  const a = A[d], b = B[d];
  if (a.samples !== b.samples) note('samples');
  for (const s of core.META_SLOTS) {
    const ka = Object.keys(a.slots[s]).sort().join(), kb = Object.keys(b.slots[s]).sort().join();
    if (ka !== kb) note('slots.' + s + '(claves)');
    else for (const k of Object.keys(a.slots[s])) if (JSON.stringify(a.slots[s][k]) !== JSON.stringify(b.slots[s][k])) note('slots.' + s);
  }
  for (const f of ['builds', 'matchups', 'weapons', 'items']) {
    const all = new Set([...Object.keys(a[f] ?? {}), ...Object.keys(b[f] ?? {})]);
    for (const k of all) if (JSON.stringify(a[f]?.[k]) !== JSON.stringify(b[f]?.[k])) note(f);
    diffs[f + '(total)'] = all.size;
  }
  for (const k of new Set([...Object.keys(a.killers), ...Object.keys(b.killers)])) {
    const x = a.killers[k], y = b.killers[k];
    if (!x || !y || x.c !== y.c || x.g !== y.g || x.t !== y.t) note('killers(c,g,t)');
    else {
      const { Mount: m1, ...r1 } = x.slots; const { Mount: m2, ...r2 } = y.slots;
      if (JSON.stringify(r1) !== JSON.stringify(r2)) note('killers.slots(sin montura)');
      if (m1 !== m2) note('killers.slots.Mount');
    }
  }
}
// Últimos usos
const ra = core.collectRecentUses(common.map((id) => apiById.get(id)));
const rb = core.collectRecentUses(common.map((id) => rebuiltById.get(id)));
let recentSame = 0, recentDiff = 0, ipOnly = 0;
for (const [w, list] of ra) {
  const other = rb.get(w) ?? [];
  list.forEach((u, i) => {
    const v = other[i];
    if (JSON.stringify(u) === JSON.stringify(v)) recentSame++;
    else {
      const strip = (x) => JSON.stringify({ ...x, killerIp: undefined, victimIp: undefined });
      if (v && strip(u) === strip(v)) ipOnly++;
      else recentDiff++;
    }
  });
}
console.log('diferencias:', JSON.stringify(diffs));
console.log(`últimos usos: iguales ${recentSame}, solo IP redondeado ${ipOnly}, otras ${recentDiff}`);
// matchups: dónde difiere
for (const d of Object.keys(A)) for (const k of Object.keys(A[d].matchups ?? {})) if (JSON.stringify(A[d].matchups[k]) !== JSON.stringify(B[d].matchups?.[k])) console.log('  versus', d, k, JSON.stringify(A[d].matchups[k]), JSON.stringify(B[d].matchups?.[k]));
