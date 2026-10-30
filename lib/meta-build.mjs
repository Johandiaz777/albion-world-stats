// Meta Armory incremental desde el escáner (parte 136, fase 2).
//
// Cada corrida lee SOLO los bytes nuevos de los archivos del escáner (`kills` y `equipment` de cada día), con un
// cursor por archivo y pedidos `Range`, y los suma a un resumen por día (`addEventsToRollup`, el mismo código de
// `sampleMetaArmory`). Nunca vuelve a leer lo ya sumado: los archivos del escáner solo crecen por el final.
//
// Defensas («nada se puede perder ni contar dos veces»):
//  - Cada día guarda los ids de TODAS sus kills ya sumadas. Una kill repetida (en dos archivos, o releída tras un
//    corte) no se suma dos veces. Por eso el cursor es solo un ahorro: si un archivo no coincide con lo que se leyó
//    (alguien lo reescribió), se vuelve a leer desde el principio sin riesgo.
//  - Antes de usar los bytes nuevos se comprueba que el final de lo ya leído siga igual (`tail`).
//  - Solo se suman líneas completas (hasta el último salto de línea); el resto se lee la próxima vez.
//  - Una kill sin su línea de equipo (o al revés) espera a la próxima corrida (`pending`).
//  - Un archivo que no se pudo bajar deja todo como estaba para ese archivo; se reintenta la próxima corrida.
//
// Dónde vive cada cosa (las carpetas las publica el workflow en ramas):
//  - estado y días abiertos: `metastate/<región>/state.json.gz` y `metastate/<región>/open/<día>.json.gz`
//    (rama `metastate`, un solo commit que se reescribe);
//  - días cerrados y meses compactados: `rollups/meta/<región>/<día>.json.gz` y `rollups/meta/<región>/months/`
//    (rama `rollups`, la de siempre);
//  - lo que lee la app: `meta/...` (rama `meta`, un solo commit que se reescribe; ver `publishRegion`).

import {
  addEventsToRollup,
  addRollupInto,
  buildCombinedMetaWindow,
  buildMetaDetail,
  buildMetaWindow,
  capMonthRollup,
  collectRecentUses,
  emptyMetaRollup,
  emptyMonthRollup,
  matchupFileFromSums,
  matchupWindowFromSums,
  mergeRecentUses,
  META_MONTH_VERSION,
  META_SLOTS,
  mondayOf,
  slimRollupForCombined,
  sumMatchups,
} from './meta-core.mjs';
import { dropTierlessMounts, groupByDay, joinKillsAndEquipment, parseNdjson } from './meta.mjs';

/** Primer día con el equipo COMPLETO (tier y encantamiento) en el archivo de equipo: antes solo se guardaba la base
 * y no se pueden armar las mismas claves que la API. Igual que `PIECES_FIRST_DAY` de build.mjs. */
export const META_FIRST_DAY = '2026-09-29';
/** Días hacia atrás en los que se sigue mirando si el archivo creció (el relleno de huecos del escáner agrega kills
 * a días ya pasados). Igual que `GROWTH_CHECK_DAYS` de build.mjs. */
export const META_GROWTH_DAYS = 8;
/** Días viejos (fuera de esos 8) que se completan por corrida y región al empezar de cero. */
export const META_BACKFILL_DATES = 4;
/** Parte siguiente (`<día>.2.ndjson`) solo se busca si la actual ya pasó esto: el escáner abre la parte 2 a los 90 MB. */
const PART_PROBE_BYTES = 85_000_000;
const MAX_PARTS = 50;
/** Bytes que se guardan del final de lo leído para comprobar, la vez siguiente, que el archivo no cambió. */
const TAIL_BYTES = 256;
/** Una kill o un equipo sin pareja se espera hasta 2 días; después se cuenta como perdido en el estado (nunca pasó:
 * medido el 29/10, mismas líneas en los dos archivos de las 3 regiones). */
const PENDING_MAX_DAYS = 2;
export const META_STATE_VERSION = 1;
export const META_DAY_VERSION = 1;

/** Topes de un día ABIERTO (se recorta en cada corrida). Medido el 29/10 con el día completo de Europa: 63.496 builds
 * y 16.811 ganadores distintos; lo que queda afuera de estos topes son builds y jugadores con 1 o 2 kills en el día. */
export const OPEN_CAPS = { builds: 20_000, killers: 10_000 };
/** Topes de un día CERRADO (como `capMetaRollup`, pero más amplios: aquí no hay costo por byte). Los cruces y las
 * piezas van sin tope: con todas las kills son ~11.000 pares y ~350 familias por día. */
export const CLOSED_CAPS = { builds: 5_000, killers: 3_000 };

// ---- Ids por día (texto compacto: diferencias en base 36) ----

export function encodeIds(ids) {
  const sorted = [...ids].sort((a, b) => a - b);
  let prev = 0;
  const out = [];
  for (const id of sorted) {
    out.push((id - prev).toString(36));
    prev = id;
  }
  return out.join(',');
}

export function decodeIds(text) {
  const out = new Set();
  if (typeof text !== 'string' || !text) return out;
  let prev = 0;
  for (const part of text.split(',')) {
    const n = parseInt(part, 36);
    if (!Number.isFinite(n)) continue;
    prev += n;
    out.add(prev);
  }
  return out;
}

// ---- Topes ----

function topBy(record, cap, value) {
  const entries = Object.entries(record ?? {});
  if (!Number.isFinite(cap) || entries.length <= cap) return record ?? {};
  entries.sort((a, b) => value(b[1]) - value(a[1]));
  return Object.fromEntries(entries.slice(0, cap));
}

/** Recorta builds (por kills + muertes, como `capMetaRollup`) y ganadores (por kills). Lo demás va entero. */
export function capRollup(rollup, caps) {
  return {
    ...rollup,
    seen: [],
    builds: topBy(rollup.builds, caps.builds, (b) => (b.c ?? 0) + (b.d ?? 0)),
    killers: topBy(rollup.killers, caps.killers, (k) => k.c ?? 0),
  };
}

// ---- Lectura incremental de un archivo ----

const fileKey = (type, date, part) => `${type}|${date}|${part}`;

export function partUrl(url, n) {
  return n <= 1 ? url : url.replace(/\.ndjson$/, `.${n}.ndjson`);
}

/**
 * Bytes nuevos de `url` desde `cursor`. `tail` = los últimos bytes ya leídos (Buffer). `fetchImpl` = fetch.
 * Devuelve { status, data?, cursor?, tail?, total? }:
 *  'new'      bytes nuevos con líneas completas (`data`), y el cursor y el final nuevos;
 *  'none'     nada nuevo (o solo media línea);
 *  'missing'  el archivo no existe (404);
 *  'mismatch' lo ya leído no coincide: hay que volver a leer desde 0;
 *  'error'    la red falló o la respuesta no tiene sentido: se reintenta la próxima corrida.
 */
export async function readNewBytes(url, cursor, tail, fetchImpl = fetch) {
  const tailBuf = tail && cursor > 0 ? tail : Buffer.alloc(0);
  const start = cursor - tailBuf.length;
  let res;
  try {
    res = await fetchImpl(url, {
      headers: { 'User-Agent': 'AlbionWorld-stats/1.0', 'Accept-Encoding': 'identity', ...(start > 0 ? { Range: `bytes=${start}-` } : {}) },
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    return { status: 'error' };
  }
  if (res.status === 404) {
    await res.arrayBuffer().catch(() => null);
    return { status: cursor > 0 ? 'error' : 'missing' };
  }
  if (res.status === 416) {
    await res.arrayBuffer().catch(() => null);
    return { status: 'none' };
  }
  if (res.status !== 200 && res.status !== 206) {
    await res.arrayBuffer().catch(() => null);
    return { status: 'error' };
  }
  let body;
  try {
    body = Buffer.from(await res.arrayBuffer());
  } catch {
    return { status: 'error' };
  }
  let fresh;
  if (res.status === 206) {
    const m = /^bytes (\d+)-\d+\/(\d+|\*)$/.exec(res.headers.get('content-range') ?? '');
    if (!m || Number(m[1]) !== start) return { status: 'error' };
    if (!body.subarray(0, tailBuf.length).equals(tailBuf)) return { status: 'mismatch' };
    fresh = body.subarray(tailBuf.length);
  } else {
    // El servidor ignoró el Range: vino el archivo entero.
    if (body.length < cursor) return { status: 'mismatch' };
    if (!body.subarray(start, cursor).equals(tailBuf)) return { status: 'mismatch' };
    fresh = body.subarray(cursor);
  }
  const lastNl = fresh.lastIndexOf(0x0a);
  if (lastNl < 0) return { status: 'none' };
  const data = fresh.subarray(0, lastNl + 1);
  const nextCursor = cursor + data.length;
  const joined = Buffer.concat([tailBuf, data]);
  return { status: 'new', data, cursor: nextCursor, tail: joined.subarray(Math.max(0, joined.length - TAIL_BYTES)) };
}

// ---- Fechas ----

export function dateList(from, to) {
  const out = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86400e3) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);

// ---- Una región ----

/**
 * Avanza el Meta de una región con lo nuevo del escáner. `store` lee y escribe el estado y los días (ver build.mjs;
 * en las pruebas, en memoria). `urlsFor(type, date)` = direcciones a probar en orden (`candidateUrls`).
 * Devuelve { events, recentIncoming, touchedDates, status }.
 */
export async function advanceRegion({ region, today, store, urlsFor, fetchImpl = fetch, backfillDates = META_BACKFILL_DATES, log = () => {} }) {
  const state = store.readState() ?? { v: META_STATE_VERSION, region, files: {}, pending: { kills: [], equipment: [] }, lost: { kills: 0, equipment: 0 } };
  if (state.v !== META_STATE_VERSION) throw new Error(`estado de Meta con otra versión (${state.v})`);
  const status = { bytes: 0, requests: 0, filesRead: 0, errors: 0, mismatches: 0, badLines: 0, events: 0, added: 0, duplicates: 0, backfilled: [] };
  const recentFrom = addDays(today, -META_GROWTH_DAYS);
  const newKills = [];
  const newEquipment = [];
  let oldUsed = 0;

  // 1) Bytes nuevos de cada archivo que todavía puede crecer (o que falta completar).
  for (const date of dateList(META_FIRST_DAY, today)) {
    const recent = date >= recentFrom;
    if (!recent) {
      const allDone = ['kills', 'equipment'].every((t) => state.files[fileKey(t, date, 1)]?.done);
      if (allDone) continue;
      if (oldUsed >= backfillDates) continue;
      oldUsed += 1;
      status.backfilled.push(date);
    }
    for (const type of ['kills', 'equipment']) {
      for (let part = 1; part <= MAX_PARTS; part++) {
        const key = fileKey(type, date, part);
        const prev = state.files[key];
        if (prev?.done) {
          if (prev.cursor >= PART_PROBE_BYTES) continue;
          break;
        }
        let entry = prev ?? null;
        let result = null;
        const urls = entry ? [entry.url] : part === 1 ? urlsFor(type, date) : [partUrl(state.files[fileKey(type, date, 1)]?.url ?? '', part)];
        for (const url of urls) {
          if (!url) continue;
          const cursor = entry?.url === url ? entry.cursor : 0;
          const tail = entry?.url === url && entry.tail ? Buffer.from(entry.tail, 'base64') : null;
          status.requests += 1;
          let r = await readNewBytes(url, cursor, tail, fetchImpl);
          if (r.status === 'mismatch') {
            // El archivo cambió por dentro: se relee entero (los ids por día evitan contar dos veces).
            status.mismatches += 1;
            log(`${key}: el archivo no coincide con lo leído; se relee desde el principio`);
            status.requests += 1;
            r = await readNewBytes(url, 0, null, fetchImpl);
          }
          if (r.status === 'missing') continue;
          result = { url, ...r };
          break;
        }
        if (!result) break; // no existe (todavía): ni esta parte ni las siguientes
        if (result.status === 'error') {
          status.errors += 1;
          break;
        }
        entry = { url: result.url, cursor: entry?.url === result.url ? entry.cursor : 0, tail: entry?.url === result.url ? entry.tail : null };
        if (result.status === 'new') {
          status.bytes += result.data.length;
          status.filesRead += 1;
          const { rows, bad } = parseNdjson(result.data.toString('utf8'));
          status.badLines += bad;
          (type === 'kills' ? newKills : newEquipment).push(...rows);
          entry.cursor = result.cursor;
          entry.tail = result.tail.toString('base64');
        }
        // Un archivo de más de 8 días ya no crece: leído hasta el final, no se vuelve a mirar.
        if (!recent) entry.done = true;
        state.files[key] = entry;
        if (entry.cursor < PART_PROBE_BYTES) break;
      }
    }
  }

  // 2) Kills con su equipo, en eventos como los de la API.
  const pendingIn = state.pending ?? { kills: [], equipment: [] };
  const { events, pending } = joinKillsAndEquipment(newKills, newEquipment, pendingIn);
  const oldest = addDays(today, -PENDING_MAX_DAYS);
  const keepKills = pending.kills.filter((k) => (k.timestamp ?? '').slice(0, 10) >= oldest);
  const equipFirstSeen = new Map((pendingIn.equipmentSeen ?? []).map(([id, d]) => [id, d]));
  const keepEquipment = [];
  const equipmentSeen = [];
  for (const e of pending.equipment) {
    const seen = equipFirstSeen.get(e.e) ?? today;
    if (seen >= oldest) {
      keepEquipment.push(e);
      equipmentSeen.push([e.e, seen]);
    }
  }
  state.lost = state.lost ?? { kills: 0, equipment: 0 };
  state.lost.kills += pending.kills.length - keepKills.length;
  state.lost.equipment += pending.equipment.length - keepEquipment.length;
  state.pending = { kills: keepKills, equipment: keepEquipment, equipmentSeen };
  status.events = events.length;

  // 3) Sumar a cada día (el de la hora de la kill), sin repetir ids.
  const touchedDates = [];
  const accepted = [];
  for (const [date, list] of groupByDay(events)) {
    if (date < META_FIRST_DAY || date > today) continue;
    const day = store.readDay(date) ?? { v: META_DAY_VERSION, date, rev: 0, closed: false, ids: '', rollup: emptyMetaRollup(date) };
    const ids = decodeIds(day.ids);
    const fresh = [];
    for (const e of list) {
      if (ids.has(e.EventId)) {
        status.duplicates += 1;
        continue;
      }
      ids.add(e.EventId);
      fresh.push(e);
    }
    if (fresh.length === 0) continue;
    day.rollup.seen = [];
    status.added += addEventsToRollup(day.rollup, fresh);
    day.rollup.seen = [];
    day.ids = encodeIds(ids);
    day.rev = (day.rev ?? 0) + 1;
    day.rollup = capRollup(day.rollup, day.closed ? CLOSED_CAPS : OPEN_CAPS);
    store.writeDay(day);
    touchedDates.push(date);
    accepted.push(...fresh);
  }

  // 4) Cerrar los días que ya no reciben kills por el camino normal (día D: cuando ya se leyó el archivo de D+1,
  // donde caen las de las 23:59, y D quedó 2 días atrás). Si después llega una tarde (relleno de huecos), se suma al
  // día cerrado igual.
  for (const date of store.listOpenDays()) {
    const next = addDays(date, 1);
    const nextRead = ['kills', 'equipment'].every((t) => state.files[fileKey(t, next, 1)]);
    if (date <= addDays(today, -2) && nextRead) {
      const day = store.readDay(date);
      if (!day) continue;
      store.closeDay({ ...day, closed: true, rev: (day.rev ?? 0) + 1, rollup: capRollup(day.rollup, CLOSED_CAPS) });
    }
  }

  store.writeState(state);
  return { events: accepted, recentIncoming: collectRecentUses(accepted), touchedDates, status: { ...status, pendingKills: keepKills.length, pendingEquipment: keepEquipment.length, lost: state.lost } };
}

// ---- Ventanas (lo mismo que arma `sampleMetaArmory` en cada corrida pesada) ----

/** Mes compactado: se rehace solo si cambió algún día (firma = fecha:rev de cada día). */
function monthOf(store, month, dates) {
  const days = dates.map((d) => store.readDay(d)).filter(Boolean);
  const sig = days.map((d) => `${d.date}:${d.rev ?? 0}`).join(',');
  const saved = store.readMonth(month);
  if (saved?.mv === META_MONTH_VERSION && saved.sig === sig && saved.slots && saved.builds) return saved;
  const acc = emptyMonthRollup();
  for (const d of days) addRollupInto(acc, d.rollup);
  if (!acc.days) return null;
  const compact = { ...capMonthRollup({ ...acc, srcDays: days.length }), sig };
  store.writeMonth(month, compact);
  return compact;
}

/**
 * Ventanas y archivos de una región, con la misma forma que publica `sampleMetaArmory`:
 *  doc     = `meta_armory/{región}` (day, week, month, all, dayKey, weekKey, monthKey, allSince)
 *  versus  = `versus_matchups/{región}.windows` (week, month, all; top 1.500)
 *  files   = { 'meta-detail/<región>/<ventana>.json', 'meta-detail/<región>/versus-<ventana>.json' }
 *  combined = resúmenes reducidos para «Todos».
 */
export function buildRegionOutputs({ region, today, store, builtAt }) {
  const dates = store.listDays().filter((d) => d >= META_FIRST_DAY && d <= today).sort();
  const monday = mondayOf(new Date(`${today}T12:00:00Z`));
  const monthStart = `${today.slice(0, 8)}01`;
  const compactBelow = addDays(today, -2).slice(0, 7);
  const closedMonths = [...new Set(dates.map((d) => d.slice(0, 7)))].filter((m) => m < compactBelow).sort();
  const closedSet = new Set(closedMonths);
  const needed = dates.filter((d) => !closedSet.has(d.slice(0, 7)) || d >= monday);
  const loaded = new Map();
  for (const d of needed) {
    const day = store.readDay(d);
    if (day?.rollup) loaded.set(d, day.rollup);
  }
  const pick = (from) => [...loaded.entries()].filter(([d]) => d >= from && d <= today).map(([, r]) => r);
  const months = new Map();
  for (const m of closedMonths) {
    const merged = monthOf(store, m, dates.filter((d) => d.slice(0, 7) === m));
    if (merged) months.set(m, merged);
  }
  const allEntries = [...months.entries(), ...[...loaded.entries()].filter(([d]) => !closedSet.has(d.slice(0, 7)))];
  const allRollups = allEntries.map(([, r]) => r);
  const clean = (w) => dropTierlessMounts(w);
  const doc = {
    day: clean(buildMetaWindow(pick(today))),
    week: clean(buildMetaWindow(pick(monday))),
    month: clean(buildMetaWindow(pick(monthStart))),
    all: clean(buildMetaWindow(allRollups)),
    dayKey: today,
    weekKey: monday,
    monthKey: today.slice(0, 7),
    allSince: dates[0] ?? today,
  };
  const sums = { week: sumMatchups(pick(monday)), month: sumMatchups(pick(monthStart)), all: sumMatchups(allRollups) };
  const versus = {};
  const files = {};
  for (const [name, s] of Object.entries(sums)) {
    versus[name] = matchupWindowFromSums(s);
    files[`meta-detail/${region}/versus-${name}.json`] = matchupFileFromSums(s, region, name, builtAt);
  }
  const detailWindows = { day: pick(today), week: pick(monday), month: pick(monthStart), all: allRollups };
  for (const [name, rollups] of Object.entries(detailWindows)) files[`meta-detail/${region}/${name}.json`] = buildMetaDetail(rollups, region, name, builtAt);
  const slim = (r) => slimRollupForCombined(r, region);
  const combined = { rollups: [...loaded.entries()].map(([d, r]) => [d, slim(r)]), all: allRollups.map(slim) };
  return { doc, versus, files, combined };
}

/** «Todos» (los 3 servidores sumados), igual que el paso 4 de `sampleMetaArmory`. */
export function buildCombinedOutputs({ today, combined, builtAt }) {
  const monday = mondayOf(new Date(`${today}T12:00:00Z`));
  const monthStart = `${today.slice(0, 8)}01`;
  const pickAll = (from) => combined.flatMap((c) => c.rollups.filter(([d]) => d >= from && d <= today).map(([, r]) => r));
  const every = combined.flatMap((c) => c.all);
  const doc = {
    day: dropTierlessMounts(buildCombinedMetaWindow(pickAll(today))),
    week: dropTierlessMounts(buildCombinedMetaWindow(pickAll(monday))),
    month: dropTierlessMounts(buildCombinedMetaWindow(pickAll(monthStart))),
    all: dropTierlessMounts(buildCombinedMetaWindow(every)),
    dayKey: today,
    weekKey: monday,
    monthKey: today.slice(0, 7),
    allSince: every.map((r) => r.date).filter(Boolean).sort()[0] ?? today,
  };
  const files = {};
  const windows = { day: pickAll(today), week: pickAll(monday), month: pickAll(monthStart), all: every };
  for (const [name, rollups] of Object.entries(windows)) files[`meta-detail/all/${name}.json`] = buildMetaDetail(rollups, 'all', name, builtAt);
  return { doc, files };
}

/** Junta los usos nuevos con el anillo de cada arma. `readRing(arma)` devuelve el archivo publicado o null.
 * Devuelve solo los anillos que cambiaron: { arma: archivo }. */
export function mergeRecentRings(incoming, readRing, builtAt) {
  const out = {};
  for (const [weapon, uses] of incoming) {
    const prev = readRing(weapon);
    const prevUses = Array.isArray(prev?.uses) ? prev.uses : [];
    const merged = mergeRecentUses(prevUses, uses);
    const changed = merged.length !== prevUses.length || merged.some((u, i) => u.eventId !== prevUses[i]?.eventId || u.role !== prevUses[i]?.role);
    if (changed) out[weapon] = { weapon, updatedAt: builtAt, uses: merged };
  }
  return out;
}

export { META_SLOTS };
