// Pruebas del motor incremental de Meta Armory (lib/meta-build.mjs + lib/meta-store.mjs), con datos sintéticos con
// la forma de los archivos del escáner y un `fetch` falso que entiende `Range`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addDays, advanceRegion, buildRegionOutputs, CLOSED_CAPS, capRollup, decodeIds, encodeIds, readNewBytes } from '../lib/meta-build.mjs';
import { addEventsToRollup, buildMetaWindow, emptyMetaRollup } from '../lib/meta-core.mjs';
import { createMetaStore, memoryIo } from '../lib/meta-store.mjs';
import { dropTierlessMounts, groupByDay, joinKillsAndEquipment, parseNdjson } from '../lib/meta.mjs';

// ---- Generador determinista ----

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const WEAPONS = ['2H_CLAYMORE', 'MAIN_SWORD', '2H_DUALSWORD', 'MAIN_SPEAR', '2H_BOW', 'MAIN_FIRESTAFF', '2H_HOLYSTAFF', 'MAIN_DAGGER'];
const ARMORS = ['ARMOR_PLATE_SET1', 'ARMOR_LEATHER_SET2', 'ARMOR_CLOTH_SET3', 'ARMOR_PLATE_KEEPER'];
const HEADS = ['HEAD_PLATE_SET1', 'HEAD_LEATHER_SET2', 'HEAD_CLOTH_SET3'];
const SHOES = ['SHOES_PLATE_SET1', 'SHOES_LEATHER_SET2', 'SHOES_CLOTH_SET3'];
const CAPES = ['CAPE', 'CAPEITEM_FW_MARTLOCK'];
const OFF = ['OFF_SHIELD', 'OFF_TORCH', null];

function gear(r) {
  const t = () => `T${4 + Math.floor(r() * 5)}_`;
  const ench = () => (r() < 0.4 ? `@${1 + Math.floor(r() * 3)}` : '');
  const pick = (list) => list[Math.floor(r() * list.length)];
  const off = pick(OFF);
  return [
    `${t()}${pick(WEAPONS)}${ench()}`,
    off ? `${t()}${off}` : null,
    `${t()}${pick(HEADS)}${ench()}`,
    `${t()}${pick(ARMORS)}${ench()}`,
    `${t()}${pick(SHOES)}`,
    `${t()}${pick(CAPES)}`,
    r() < 0.5 ? 'MOUNT_HORSE' : null,
  ];
}

/** Kills y equipo de un día con la forma de los archivos del escáner. Las últimas `spill` kills del día anterior
 * (23:59) van al principio, como pasa en el archivo real. */
function makeDay(date, n, seed, { spillFrom = null, spill = 0, firstId = 1_000_000 } = {}) {
  const r = rng(seed);
  const kills = [];
  const equipment = [];
  let id = firstId;
  const add = (ts) => {
    id += 1 + Math.floor(r() * 5);
    const parts = 1 + Math.floor(r() * 12);
    const killer = `jug${Math.floor(r() * 60)}`;
    kills.push({
      eventId: id,
      timestamp: ts,
      participantsCount: parts,
      totalFame: Math.floor(r() * 100000),
      killerName: killer,
      killerGuild: `g${Math.floor(r() * 9)}`,
      victimName: `vic${Math.floor(r() * 200)}`,
      victimGuild: `g${Math.floor(r() * 9)}`,
      participants: [{ name: killer, damageDone: Math.floor(r() * 3000) }],
    });
    equipment.push({ e: id, k: gear(r), v: gear(r), kp: 900 + Math.round(r() * 600), vp: 900 + Math.round(r() * 600) });
  };
  for (let i = 0; i < spill; i++) add(`${spillFrom}T23:59:${String(10 + i).padStart(2, '0')}.000000000Z`);
  for (let i = 0; i < n; i++) {
    const secs = Math.floor((i / n) * 86000);
    const hh = String(Math.floor(secs / 3600)).padStart(2, '0');
    const mm = String(Math.floor((secs % 3600) / 60)).padStart(2, '0');
    const ss = String(secs % 60).padStart(2, '0');
    add(`${date}T${hh}:${mm}:${ss}.000000000Z`);
  }
  const text = (rows) => Buffer.from(rows.map((x) => JSON.stringify(x)).join('\n') + '\n');
  return { kills: text(kills), equipment: text(equipment), killRows: kills, equipRows: equipment };
}

// ---- fetch falso ----

function fakeServer() {
  const files = new Map();
  const calls = [];
  const opts = { ignoreRange: false, fail: new Set() };
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, range: init.headers?.Range ?? null });
    if (opts.fail.has(url)) throw new Error('red');
    const body = files.get(url);
    const resp = (status, buf, headers = {}) => ({
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (k) => headers[k.toLowerCase()] ?? null },
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length),
    });
    if (!body) return resp(404, Buffer.from('404'));
    const range = init.headers?.Range;
    if (!range || opts.ignoreRange) return resp(200, body);
    const start = Number(/bytes=(\d+)-/.exec(range)[1]);
    if (start >= body.length) return resp(416, Buffer.alloc(0));
    return resp(206, body.subarray(start), { 'content-range': `bytes ${start}-${body.length - 1}/${body.length}` });
  };
  return { files, calls, opts, fetchImpl };
}

const URL = (type, date) => `https://raw.test/${type}/${date}.ndjson`;
const urlsFor = (type, date) => [URL(type, date)];

/** Reparte un archivo en `k` cortes al azar (por bytes: también a mitad de línea). */
function cuts(buf, k, r) {
  const points = new Set([buf.length]);
  while (points.size < k) points.add(1 + Math.floor(r() * (buf.length - 1)));
  return [...points].sort((a, b) => a - b);
}

/** Referencia: todo de una vez, con el código de `sampleMetaArmory`. */
function oneShot(dayFiles, date) {
  const kills = [];
  const equipment = [];
  for (const f of dayFiles) {
    kills.push(...parseNdjson(f.kills.toString('utf8')).rows);
    equipment.push(...parseNdjson(f.equipment.toString('utf8')).rows);
  }
  const { events } = joinKillsAndEquipment(kills, equipment);
  const r = emptyMetaRollup(date);
  addEventsToRollup(r, groupByDay(events).get(date) ?? []);
  return { ...r, seen: [] };
}

const strip = (rollup) => JSON.stringify({ ...rollup, seen: [] });

// ---- Pruebas ----

test('ids por día: ida y vuelta', () => {
  const ids = new Set([5, 1_234_567_890, 1_234_567_891, 42, 7_000_000_000]);
  assert.deepEqual([...decodeIds(encodeIds(ids))].sort((a, b) => a - b), [...ids].sort((a, b) => a - b));
  assert.equal(decodeIds('').size, 0);
});

test('readNewBytes: 206, media línea, nada nuevo (416), archivo entero sin Range, cambio por dentro y caché vieja', async () => {
  const srv = fakeServer();
  const url = 'https://raw.test/x.ndjson';
  srv.files.set(url, Buffer.from('{"a":1}\n{"a":2}\n{"a":'));
  let r = await readNewBytes(url, 0, null, srv.fetchImpl);
  assert.equal(r.status, 'new');
  assert.equal(r.data.toString(), '{"a":1}\n{"a":2}\n');
  assert.equal(r.cursor, 16);
  // Media línea: no avanza.
  r = await readNewBytes(url, 16, Buffer.from('{"a":2}\n'), srv.fetchImpl);
  assert.equal(r.status, 'none');
  // Termina la línea y llega otra.
  srv.files.set(url, Buffer.from('{"a":1}\n{"a":2}\n{"a":3}\n{"a":4}\n'));
  r = await readNewBytes(url, 16, Buffer.from('{"a":2}\n'), srv.fetchImpl);
  assert.equal(r.status, 'new');
  assert.equal(r.data.toString(), '{"a":3}\n{"a":4}\n');
  assert.equal(r.cursor, 32);
  assert.equal(srv.calls.at(-1).range, 'bytes=8-');
  // Nada nuevo: 206 vacío después del final.
  r = await readNewBytes(url, 32, Buffer.from('{"a":4}\n'), srv.fetchImpl);
  assert.equal(r.status, 'none');
  // 416: la copia servida es más corta que lo ya leído (caché vieja de raw).
  r = await readNewBytes(url, 64, Buffer.alloc(8, 120), srv.fetchImpl);
  assert.equal(r.status, 'none');
  assert.equal(r.stale, true);
  // Servidor que ignora Range: viene el archivo entero y se usa solo lo nuevo.
  srv.opts.ignoreRange = true;
  srv.files.set(url, Buffer.from('{"a":1}\n{"a":2}\n{"a":3}\n{"a":4}\n{"a":5}\n'));
  r = await readNewBytes(url, 32, Buffer.from('{"a":4}\n'), srv.fetchImpl);
  assert.equal(r.status, 'new');
  assert.equal(r.data.toString(), '{"a":5}\n');
  srv.opts.ignoreRange = false;
  // Reescrito por dentro: no coincide el final leído.
  srv.files.set(url, Buffer.from('{"b":1}\n{"b":2}\n{"b":3}\n{"b":4}\n{"b":5}\n'));
  r = await readNewBytes(url, 32, Buffer.from('{"a":4}\n'), srv.fetchImpl);
  assert.equal(r.status, 'mismatch');
  // 404 sin haber leído nada = no existe; con cursor = error (se reintenta).
  assert.equal((await readNewBytes('https://raw.test/nada', 0, null, srv.fetchImpl)).status, 'missing');
  assert.equal((await readNewBytes('https://raw.test/nada', 10, Buffer.from('x'), srv.fetchImpl)).status, 'error');
  // Red caída.
  srv.opts.fail.add(url);
  assert.equal((await readNewBytes(url, 0, null, srv.fetchImpl)).status, 'error');
});

/** Hace crecer los archivos de D y D+1 en trozos (D entero antes de que empiece D+1, como el escáner) y corre el
 * motor después de cada trozo. Devuelve el almacén y lo necesario para comparar. */
async function runChunked({ seed, n = 600, k = 9 }) {
  const D = '2026-10-20';
  const D1 = addDays(D, 1);
  const fD = makeDay(D, n, seed);
  const fD1 = makeDay(D1, Math.floor(n / 2), seed + 1, { spillFrom: D, spill: 7, firstId: 9_000_000 });
  const srv = fakeServer();
  const io = memoryIo();
  const r = rng(seed + 99);
  const steps = [];
  for (const [date, f] of [
    [D, fD],
    [D1, fD1],
  ]) {
    const ck = cuts(f.kills, k, r);
    const ce = cuts(f.equipment, k, r);
    // El equipo a veces va detrás de las kills (copias de raw desfasadas): se prueban los dos órdenes.
    for (let i = 0; i < k; i++) steps.push({ date, kills: f.kills.subarray(0, ck[i]), equipment: f.equipment.subarray(0, ce[Math.max(0, i - (i % 2))]) });
    steps.push({ date, kills: f.kills, equipment: f.equipment });
  }
  const runs = [];
  for (const s of steps) {
    srv.files.set(URL('kills', s.date), s.kills);
    srv.files.set(URL('equipment', s.date), s.equipment);
    const store = createMetaStore(io, 'europe');
    runs.push(await advanceRegion({ region: 'europe', today: D1, store, urlsFor, fetchImpl: srv.fetchImpl }));
  }
  return { D, D1, fD, fD1, srv, io, runs };
}

test('por trozos = de una vez: mismo resumen que addEventsToRollup con todas las kills (D y la kill de las 23:59 en D+1)', async () => {
  for (const seed of [1, 7, 2026]) {
    const { D, D1, fD, fD1, io, runs } = await runChunked({ seed });
    const store = createMetaStore(io, 'europe');
    const day = store.readDay(D);
    const ref = oneShot([fD, fD1], D);
    assert.ok(ref.samples > 500, `muestra chica (${ref.samples})`);
    assert.equal(strip(day.rollup), strip(ref), `semilla ${seed}: el resumen por trozos no es igual al de una vez`);
    assert.equal(decodeIds(day.ids).size, fD.killRows.length + 7);
    const day1 = store.readDay(D1);
    assert.equal(strip(day1.rollup), strip(oneShot([fD1], D1)));
    const last = runs.at(-1).status;
    assert.equal(last.pendingKills, 0);
    assert.equal(last.pendingEquipment, 0);
    assert.equal(last.duplicates, 0);
    assert.equal(last.errors, 0);
  }
});

test('volver a leer no cuenta dos veces (cursor perdido y archivo reescrito igual)', async () => {
  const { D, io, srv, D1 } = await runChunked({ seed: 3, k: 4 });
  const before = strip(createMetaStore(io, 'europe').readDay(D).rollup);
  // Cursor perdido: se relee todo desde 0.
  const state = io.read('metastate/europe/state.json.gz');
  for (const f of Object.values(state.files)) {
    f.cursor = 0;
    f.tail = null;
  }
  io.write('metastate/europe/state.json.gz', state);
  let out = await advanceRegion({ region: 'europe', today: D1, store: createMetaStore(io, 'europe'), urlsFor, fetchImpl: srv.fetchImpl });
  assert.ok(out.status.duplicates > 500);
  assert.equal(out.status.added, 0);
  assert.equal(strip(createMetaStore(io, 'europe').readDay(D).rollup), before);
  // Archivo cambiado por dentro (mismo contenido, otro orden de bytes al principio): mismatch y relectura sin sumar.
  const k = srv.files.get(URL('kills', D));
  srv.files.set(URL('kills', D), Buffer.concat([Buffer.from('{"basura":1}\n'), k]));
  out = await advanceRegion({ region: 'europe', today: D1, store: createMetaStore(io, 'europe'), urlsFor, fetchImpl: srv.fetchImpl });
  assert.equal(out.status.mismatches, 1);
  assert.equal(out.status.added, 0);
  assert.equal(strip(createMetaStore(io, 'europe').readDay(D).rollup), before);
});

test('un archivo que no se pudo bajar no avanza su cursor y se completa la corrida siguiente', async () => {
  const D = '2026-10-20';
  const f = makeDay(D, 200, 11);
  const srv = fakeServer();
  const io = memoryIo();
  srv.files.set(URL('kills', D), f.kills);
  srv.files.set(URL('equipment', D), f.equipment);
  srv.opts.fail.add(URL('equipment', D));
  let out = await advanceRegion({ region: 'asia', today: D, store: createMetaStore(io, 'asia'), urlsFor, fetchImpl: srv.fetchImpl });
  assert.equal(out.status.errors, 1);
  assert.equal(out.status.pendingKills, 200);
  srv.opts.fail.clear();
  out = await advanceRegion({ region: 'asia', today: D, store: createMetaStore(io, 'asia'), urlsFor, fetchImpl: srv.fetchImpl });
  assert.equal(out.status.pendingKills, 0);
  assert.equal(strip(createMetaStore(io, 'asia').readDay(D).rollup), strip(oneShot([f], D)));
});

test('cierre con topes, kill tardía en un día cerrado, día final en rollups y limpieza cuando ya está publicado', async () => {
  const { D, D1, fD, fD1, srv, io } = await runChunked({ seed: 5, k: 3 });
  const ref = oneShot([fD, fD1], D);
  // D+3: D se cierra (ya se leyó D+1).
  let out = await advanceRegion({ region: 'europe', today: addDays(D, 3), store: createMetaStore(io, 'europe'), urlsFor, fetchImpl: srv.fetchImpl });
  assert.deepEqual(out.status.closed, [D]);
  let day = createMetaStore(io, 'europe').readDay(D);
  assert.equal(day.status, 'closed');
  assert.equal(strip(day.rollup), strip(capRollup(ref, CLOSED_CAPS)));
  // Kill tardía del relleno de huecos: llega al día cerrado y se suma una sola vez.
  const late = makeDay(D, 1, 77, { firstId: 50_000_000 });
  srv.files.set(URL('kills', D), Buffer.concat([fD.kills, late.kills]));
  srv.files.set(URL('equipment', D), Buffer.concat([fD.equipment, late.equipment]));
  out = await advanceRegion({ region: 'europe', today: addDays(D, 3), store: createMetaStore(io, 'europe'), urlsFor, fetchImpl: srv.fetchImpl });
  assert.equal(out.status.added, 1);
  day = createMetaStore(io, 'europe').readDay(D);
  assert.equal(day.rollup.samples, ref.samples + 1);
  // D+10: D+1 ya no está en los 8 días; se lee hasta el final (los días viejos, de a 4 por corrida) y D pasa a final
  // (rollups, sin ids).
  const finalized = [];
  for (let i = 0; i < 4; i++) {
    out = await advanceRegion({ region: 'europe', today: addDays(D, 10), store: createMetaStore(io, 'europe'), urlsFor, fetchImpl: srv.fetchImpl });
    finalized.push(...out.status.finalized);
    if (finalized.length) break;
  }
  assert.ok(finalized.includes(D), JSON.stringify(out.status));
  const final = io.read(`rollups/meta/europe/${D}.json.gz`);
  assert.equal(final.status, 'final');
  assert.equal(final.ids, undefined);
  assert.equal(io.read(`metastate/europe/days/${D}.json.gz`).status, 'final');
  // Si el push de `rollups` falló, el clon siguiente no lo trae: se vuelve a escribir desde metastate.
  io.remove(`rollups/meta/europe/${D}.json.gz`);
  out = await advanceRegion({ region: 'europe', today: addDays(D, 10), store: createMetaStore(io, 'europe'), urlsFor, fetchImpl: srv.fetchImpl });
  assert.ok(io.exists(`rollups/meta/europe/${D}.json.gz`));
  assert.ok(io.exists(`metastate/europe/days/${D}.json.gz`));
  // Corrida siguiente con el día ya publicado en rollups: se borra de metastate.
  out = await advanceRegion({ region: 'europe', today: addDays(D, 10), store: createMetaStore(io, 'europe'), urlsFor, fetchImpl: srv.fetchImpl });
  assert.ok(out.status.pruned.includes(D));
  assert.equal(io.exists(`metastate/europe/days/${D}.json.gz`), false);
  assert.equal(createMetaStore(io, 'europe').readDay(D).rollup.samples, ref.samples + 1);
});

test('ventanas publicadas: Día y Semana iguales a buildMetaWindow sobre el resumen de una vez', async () => {
  const { D1, fD, fD1, io } = await runChunked({ seed: 9, k: 3 });
  const D = '2026-10-20';
  const store = createMetaStore(io, 'europe');
  const out = buildRegionOutputs({ region: 'europe', today: D1, store, builtAt: '2026-10-21T10:00:00.000Z' });
  const refD = oneShot([fD, fD1], D);
  const refD1 = oneShot([fD1], D1);
  assert.deepEqual(out.doc.day, dropTierlessMounts(buildMetaWindow([refD1])));
  // 20/10 es martes: la semana (desde el lunes 19) tiene D y D+1.
  assert.deepEqual(out.doc.week, dropTierlessMounts(buildMetaWindow([refD, refD1])));
  assert.equal(out.doc.weekKey, '2026-10-19');
  assert.ok(out.files['meta-detail/europe/week.json'].samples > 0);
  assert.ok(out.files['meta-detail/europe/versus-all.json'].pairs.length > 0);
  // La montura sin tier (`MOUNT_HORSE`, como la guarda hoy el escáner) no se publica.
  assert.equal(out.doc.week.slots.Mount.length, 0);
});

test('primera corrida: tope de bytes; lo que falta se lee en la siguiente sin perder nada', async () => {
  const D = '2026-10-20';
  const f = makeDay(D, 400, 21);
  const srv = fakeServer();
  srv.files.set(URL('kills', D), f.kills);
  srv.files.set(URL('equipment', D), f.equipment);
  const D1 = addDays(D, 1);
  const f1 = makeDay(D1, 400, 22, { firstId: 9_000_000 });
  srv.files.set(URL('kills', D1), f1.kills);
  srv.files.set(URL('equipment', D1), f1.equipment);
  const io = memoryIo();
  let out = await advanceRegion({ region: 'asia', today: D1, store: createMetaStore(io, 'asia'), urlsFor, fetchImpl: srv.fetchImpl, maxBytes: 10 });
  assert.equal(out.status.capped, true);
  out = await advanceRegion({ region: 'asia', today: D1, store: createMetaStore(io, 'asia'), urlsFor, fetchImpl: srv.fetchImpl, maxBytes: 10 });
  out = await advanceRegion({ region: 'asia', today: D1, store: createMetaStore(io, 'asia'), urlsFor, fetchImpl: srv.fetchImpl });
  const store = createMetaStore(io, 'asia');
  assert.equal(strip(store.readDay(D).rollup), strip(oneShot([f, f1], D)));
  assert.equal(strip(store.readDay(D1).rollup), strip(oneShot([f1], D1)));
});
