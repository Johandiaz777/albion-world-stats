// Prueba del motor con un día REAL del escáner (no es parte de `npm test`: necesita los archivos bajados).
//
//   node scripts/probar-motor-real.mjs <carpeta> <región> <día> [cortes]
//
// <carpeta> tiene `<región>-kills-<día>.ndjson`, `<región>-equipment-<día>.ndjson` y los mismos del día siguiente
// (bajados de raw de los repos mensuales). Simula que el escáner los va escribiendo: el archivo de D crece en
// `cortes` trozos (cortados en bytes al azar, también a mitad de línea, con el equipo a veces detrás de las kills) y
// después el de D+1; el motor corre después de cada trozo, como el workflow cada hora. Al final compara el resumen
// de D con UNA sola tanda de `addEventsToRollup` (el código de `sampleMetaArmory`) sobre todas las kills, y mide
// tiempos, memoria y lo que pesa cada cosa.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { addDays, advanceRegion, buildRegionOutputs, CLOSED_CAPS, capRollup } from '../lib/meta-build.mjs';
import { addEventsToRollup, emptyMetaRollup } from '../lib/meta-core.mjs';
import { createMetaStore, diskIo } from '../lib/meta-store.mjs';
import { groupByDay, joinKillsAndEquipment, parseNdjson } from '../lib/meta.mjs';

const [dir, region, D, cutsArg] = process.argv.slice(2);
const K = Number(cutsArg ?? 24);
const D1 = addDays(D, 1);
const read = (type, date) => fs.readFileSync(path.join(dir, `${region}-${type}-${date}.ndjson`));
const full = { [D]: { kills: read('kills', D), equipment: read('equipment', D) }, [D1]: { kills: read('kills', D1), equipment: read('equipment', D1) } };

let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const cuts = (len) => {
  const s = new Set([len]);
  while (s.size < K) s.add(1 + Math.floor(rnd() * (len - 1)));
  return [...s].sort((a, b) => a - b);
};

const served = new Map();
const URL = (type, date) => `https://raw.test/${type}/${date}.ndjson`;
let bytesServed = 0;
const fetchImpl = async (url, init = {}) => {
  const body = served.get(url);
  const resp = (status, buf, headers = {}) => ({
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length),
  });
  if (!body) return resp(404, Buffer.alloc(0));
  const range = init.headers?.Range;
  if (!range) {
    bytesServed += body.length;
    return resp(200, body);
  }
  const start = Number(/bytes=(\d+)-/.exec(range)[1]);
  if (start >= body.length) return resp(416, Buffer.alloc(0));
  bytesServed += body.length - start;
  return resp(206, body.subarray(start), { 'content-range': `bytes ${start}-${body.length - 1}/${body.length}` });
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-real-'));
const io = diskIo(root);
let runs = 0;
let maxRunMs = 0;
let maxHeapMB = 0;
const t0 = Date.now();
for (const date of [D, D1]) {
  const ck = cuts(full[date].kills.length);
  const ce = cuts(full[date].equipment.length);
  for (let i = 0; i < K; i++) {
    served.set(URL('kills', date), full[date].kills.subarray(0, ck[i]));
    served.set(URL('equipment', date), full[date].equipment.subarray(0, ce[Math.max(0, i - (i % 3 === 1 ? 1 : 0))]));
    const t = Date.now();
    const out = await advanceRegion({ region, today: D1, store: createMetaStore(io, region), urlsFor: (type, d) => [URL(type, d)], fetchImpl });
    maxRunMs = Math.max(maxRunMs, Date.now() - t);
    maxHeapMB = Math.max(maxHeapMB, Math.round(process.memoryUsage().heapUsed / 1e6));
    runs += 1;
    if (out.status.errors || out.status.mismatches) console.log('aviso', JSON.stringify(out.status));
  }
}
const totalMs = Date.now() - t0;

// Referencia: todo de una vez.
const kills = [...parseNdjson(full[D].kills.toString('utf8')).rows, ...parseNdjson(full[D1].kills.toString('utf8')).rows];
const equipment = [...parseNdjson(full[D].equipment.toString('utf8')).rows, ...parseNdjson(full[D1].equipment.toString('utf8')).rows];
const { events } = joinKillsAndEquipment(kills, equipment);
const t1 = Date.now();
const ref = emptyMetaRollup(D);
addEventsToRollup(ref, groupByDay(events).get(D) ?? []);
const oneShotMs = Date.now() - t1;
ref.seen = [];

const store = createMetaStore(io, region);
const day = store.readDay(D);
const strip = (r) => JSON.stringify({ ...r, seen: [] });
const same = strip(day.rollup) === strip(ref);
console.log(`${region} ${D}: ${runs} corridas (${K} trozos por día), ${Math.round(bytesServed / 1e6)} MB servidos (los archivos: ${Math.round((full[D].kills.length + full[D].equipment.length + full[D1].kills.length + full[D1].equipment.length) / 1e6)} MB)`);
console.log(`  muestras: motor ${day.rollup.samples}, una tanda ${ref.samples}; IGUAL: ${same ? 'SÍ' : 'NO'}`);
if (!same) {
  for (const k of Object.keys(ref)) if (JSON.stringify(ref[k]) !== JSON.stringify(day.rollup[k])) console.log(`  difiere: ${k}`);
}
const capped = capRollup(ref, CLOSED_CAPS);
console.log(`  tiempo: ${totalMs} ms en total, la corrida más lenta ${maxRunMs} ms, una tanda ${oneShotMs} ms; heap máx ${maxHeapMB} MB`);
const size = (rel) => (fs.existsSync(path.join(root, rel)) ? fs.statSync(path.join(root, rel)).size : 0);
const gz = (v) => zlib.gzipSync(JSON.stringify(v), { level: 9 }).length;
console.log(`  pesos (gz): día abierto ${(size(`metastate/${region}/days/${D}.json.gz`) / 1e6).toFixed(2)} MB (ids ${(gz(day.ids) / 1e6).toFixed(2)} MB), cerrado sin ids ${(gz({ ...day, ids: '', rollup: capped }) / 1e6).toFixed(2)} MB, estado ${(size(`metastate/${region}/state.json.gz`) / 1e3).toFixed(0)} KB`);

// Salidas publicadas con lo que hay (D y D+1).
const builtAt = new Date().toISOString();
const t2 = Date.now();
const outs = buildRegionOutputs({ region, today: D1, store, builtAt });
const outMs = Date.now() - t2;
const sizes = Object.entries(outs.files).map(([k, v]) => [k, JSON.stringify(v).length, gz(v)]);
const docBytes = JSON.stringify(outs.doc).length;
const versusBytes = JSON.stringify(outs.versus).length;
console.log(`  salidas: ${outMs} ms; doc ${(docBytes / 1e3).toFixed(0)} KB (Firestore: tope 1 MiB), versus ${(versusBytes / 1e3).toFixed(0)} KB`);
for (const [k, raw, z] of sizes) console.log(`    ${k}: ${(raw / 1e3).toFixed(0)} KB (gz ${(z / 1e3).toFixed(0)} KB)`);
fs.rmSync(root, { recursive: true, force: true });
process.exit(same ? 0 : 1);
