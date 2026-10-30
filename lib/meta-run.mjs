// `node build.mjs meta`: Meta Armory desde el escáner (parte 136/137, fase 2). Corre cada hora en el workflow,
// después de `hourly`. Lee lo nuevo del escáner (lib/meta-build.mjs), arma las ventanas con el código de
// `sampleMetaArmory` y escribe lo que publica la rama `meta` (carpeta local `metapub/`):
//
//   armory/<región>.json   la forma del doc `meta_armory/{región}` (sin el reto del día) + builtAt
//   armory/all.json        «Todos» (solo si las 3 regiones salieron bien en esta corrida)
//   versus/<región>.json   la forma de `versus_matchups/{región}` (windows week/month/all, top 1.500)
//   meta-detail/<región>/<ventana>.json y versus-<ventana>.json   los mismos archivos que hoy van a Storage
//   meta-recent/<región>/<arma>.json                             los mismos anillos de últimos usos
//   status.json            salud por región (lo lee la función `sampleMetaArmory` antes de copiar)
//
// Las rutas de `meta-detail/` y `meta-recent/` son las mismas que en Storage: la app solo cambia la base.
import fs from 'node:fs';
import path from 'node:path';

import { advanceRegion, buildCombinedOutputs, buildRegionOutputs, mergeRecentRings } from './meta-build.mjs';
import { createMetaStore, diskIo } from './meta-store.mjs';
import { candidateUrls } from './sources.mjs';
import { readJson, writeJson } from './store.mjs';

export const META_REGIONS = ['europe', 'americas', 'asia'];
export const META_PUBLISH_DIR = 'metapub';
export const META_STATUS_VERSION = 1;

/** Estado sin las listas largas (solo cuántas). */
function summary(status) {
  const out = {};
  for (const [k, v] of Object.entries(status)) out[k] = Array.isArray(v) ? (v.length <= 12 ? v : v.length) : v;
  return out;
}

export async function runMeta({ root, regions = META_REGIONS, now = new Date(), fetchImpl = fetch, log = console.log }) {
  const io = diskIo(root);
  const pub = path.join(root, META_PUBLISH_DIR);
  const today = now.toISOString().slice(0, 10);
  const builtAt = now.toISOString();
  const previous = readJson(path.join(pub, 'status.json'), { regions: {} });
  const status = { v: META_STATUS_VERSION, builtAt, today, regions: { ...(previous.regions ?? {}) } };
  const combined = [];
  let failures = 0;
  const write = (rel, value) => writeJson(path.join(pub, rel), value);

  for (const region of regions) {
    const t0 = Date.now();
    try {
      const store = createMetaStore(io, region);
      const adv = await advanceRegion({ region, today, store, urlsFor: (type, date) => candidateUrls(type, region, date), fetchImpl, log: (m) => log(`[meta ${region}] ${m}`) });
      const outs = buildRegionOutputs({ region, today, store, builtAt });
      write(`armory/${region}.json`, { v: 1, region, builtAt, source: 'scanner', ...outs.doc });
      write(`versus/${region}.json`, { v: 1, region, builtAt, windows: outs.versus });
      for (const [rel, value] of Object.entries(outs.files)) write(rel, value);
      const ringPath = (weapon) => path.join(pub, 'meta-recent', region, `${weapon}.json`);
      const rings = mergeRecentRings(adv.recentIncoming, (weapon) => readJson(ringPath(weapon), null), builtAt);
      for (const [weapon, ring] of Object.entries(rings)) writeJson(ringPath(weapon), ring);
      combined.push({ region, ...outs.combined });
      status.regions[region] = {
        ok: true,
        at: new Date().toISOString(),
        seconds: Math.round((Date.now() - t0) / 1000),
        days: outs.days,
        months: outs.months,
        samples: { day: outs.doc.day.samples, week: outs.doc.week.samples, month: outs.doc.month.samples, all: outs.doc.all.samples },
        ringsWritten: Object.keys(rings).length,
        maxRssMB: Math.round(process.resourceUsage().maxRSS / 1024),
        ...summary(adv.status),
      };
      log(`[meta ${region}] ${JSON.stringify(status.regions[region])}`);
    } catch (err) {
      failures += 1;
      const last = previous.regions?.[region] ?? {};
      status.regions[region] = { ...last, ok: false, failedAt: new Date().toISOString(), error: String(err?.message ?? err).slice(0, 300) };
      log(`[meta ${region}] FALLÓ: ${err?.stack ?? err}`);
    }
  }

  // «Todos»: solo con los 3 servidores de esta corrida (como `sampleMetaArmory`: nunca una suma a la que le falta uno).
  if (combined.length === META_REGIONS.length) {
    const all = buildCombinedOutputs({ today, combined, builtAt });
    write('armory/all.json', { v: 1, region: 'all', builtAt, source: 'scanner', ...all.doc });
    for (const [rel, value] of Object.entries(all.files)) write(rel, value);
    status.all = { ok: true, at: builtAt };
  } else {
    status.all = { ...(previous.all ?? {}), ok: false, skippedAt: builtAt };
  }
  write('status.json', status);
  fs.mkdirSync(pub, { recursive: true });
  return failures === regions.length ? 1 : 0;
}
