// Meta Armory incremental desde el escáner (parte 136/137, fase 2).
//
// Cada corrida lee SOLO los bytes nuevos de los archivos del escáner (`kills` y `equipment` de cada día), con un
// cursor por archivo y pedidos `Range`, y los suma al resumen de su día (`addEventsToRollup`, el mismo código de
// `sampleMetaArmory`, generado en lib/meta-core.mjs). Los archivos del escáner solo crecen por el final.
//
// Defensas («nada se puede perder ni contar dos veces»):
//  - Cada día que todavía puede cambiar guarda los ids de TODAS sus kills ya sumadas. Una kill repetida (en dos
//    archivos, o releída tras un corte) no se suma dos veces. Por eso el cursor es solo un ahorro: si un archivo no
//    coincide con lo ya leído (alguien lo reescribió), se vuelve a leer desde el principio sin riesgo.
//  - Antes de usar los bytes nuevos se comprueba que el final de lo ya leído siga igual (`tail`).
//  - Solo se suman líneas completas (hasta el último salto de línea); el resto se lee la próxima vez.
//  - Una kill sin su línea de equipo (o al revés) espera a la próxima corrida (`pending`), hasta 2 días.
//  - Un archivo que no se pudo bajar deja todo como estaba para ese archivo; se reintenta la próxima corrida.
//
// Vida de un día (ver lib/meta-store.mjs):
//  abierto  (hoy, ayer): resumen SIN topes, así sumar por trozos da exactamente lo mismo que sumar de una vez;
//  cerrado  (cuando ya se leyó el archivo de D+1, donde caen las kills de las 23:59, y D <= hoy-2): con los topes de
//           `CLOSED_CAPS`; todavía acepta kills tardías del relleno de huecos (8 días);
//  final    (cuando D+1 sale de los 8 días): va a la rama `rollups` y no cambia más.

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
/** Tope de bytes bajados por región y corrida (la primera vez hay ~13 días enteros por leer; Américas ~100 MB por
 * día). Lo que no entra se lee en la corrida siguiente: los cursores lo hacen reanudable. */
export const META_MAX_BYTES = 500_000_000;
/** Parte siguiente (`<día>.2.ndjson`) solo se busca si la actual ya pasó esto: el escáner abre la parte 2 a los 90 MB. */
const PART_PROBE_BYTES = 85_000_000;
const MAX_PARTS = 50;
/** Bytes que se guardan del final de lo leído para comprobar, la vez siguiente, que el archivo no cambió. */
const TAIL_BYTES = 256;
/** Una kill o un equipo sin pareja se espera hasta 2 días; después se cuenta como perdido en el estado (medido el
 * 29/10: mismas líneas en los dos archivos de las 3 regiones). */
const PENDING_MAX_DAYS = 2;
export const META_STATE_VERSION = 2;
export const META_DAY_VERSION = 2;

/** Topes de un día ABIERTO: de seguridad, nunca alcanzados en lo medido (el día más grande, Américas 29/10, tuvo
 * 66.683 builds y 18.117 ganadores distintos). Si se alcanzan, el estado lo dice (`openCapHit`): desde ahí sumar por
 * trozos ya no da exactamente lo mismo que de una vez (solo en la cola de builds de 1-2 kills). */
export const OPEN_CAPS = { builds: 200_000, killers: 100_000 };
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
  // Desempate por clave: el resultado no depende del orden en que llegaron las kills.
  entries.sort((a, b) => value(b[1]) - value(a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return Object.fromEntries(entries.slice(0, cap));
}

const capHit = (rollup, caps) => Object.keys(rollup.builds ?? {}).length > caps.builds || Object.keys(rollup.killers ?? {}).length > caps.killers;

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
 * Devuelve { status, data?, cursor?, tail? }:
 *  'new'      bytes nuevos con líneas completas (`data`), y el cursor y el final nuevos;
 *  'none'     nada nuevo (o solo media línea, o una copia en caché más vieja que lo ya leído);
 *  'missing'  el archivo no existe (404) y no se había leído nada;
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
  const drain = () => res.arrayBuffer().catch(() => null);
  if (res.status === 404) {
    await drain();
    return { status: cursor > 0 ? 'error' : 'missing' };
  }
  if (res.status === 416) {
    // Pedimos desde antes del cursor: 416 = la copia servida es más corta que eso (caché de raw más vieja).
    await drain();
    return { status: 'none', stale: true };
  }
  if (res.status !== 200 && res.status !== 206) {
    await drain();
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
    if (body.length < tailBuf.length) {
      // Copia más corta que lo ya leído: si es un principio de lo leído, es una caché vieja; si no, cambió.
      return body.equals(tailBuf.subarray(0, body.length)) ? { status: 'none', stale: true } : { status: 'mismatch' };
    }
    if (!body.subarray(0, tailBuf.length).equals(tailBuf)) return { status: 'mismatch' };
    fresh = body.subarray(tailBuf.length);
  } else {
    // El servidor ignoró el Range: vino el archivo entero.
    if (body.length < cursor) {
      return body.subarray(start).equals(tailBuf.subarray(0, Math.max(0, body.length - start))) ? { status: 'none', stale: true } : { status: 'mismatch' };
    }
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
export const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);

function newState(region) {
  return { v: META_STATE_VERSION, region, files: {}, pending: { kills: [], equipment: [], equipmentSeen: [] }, lost: { kills: 0, equipment: 0 } };
}

// ---- Una región ----

/**
 * Avanza el Meta de una región con lo nuevo del escáner. `store` = lib/meta-store.mjs. `urlsFor(type, date)` =
 * direcciones a probar en orden (`candidateUrls`). Devuelve { recentIncoming, touchedDates, status }.
 */
export async function advanceRegion({
  region,
  today,
  store,
  urlsFor,
  fetchImpl = fetch,
  backfillDates = META_BACKFILL_DATES,
  maxBytes = META_MAX_BYTES,
  log = () => {},
}) {
  const state = store.readState() ?? newState(region);
  if (state.v !== META_STATE_VERSION) throw new Error(`estado de Meta con otra versión (${state.v})`);
  const status = {
    bytes: 0,
    requests: 0,
    filesRead: 0,
    errors: 0,
    mismatches: 0,
    staleCopies: 0,
    badLines: 0,
    events: 0,
    added: 0,
    duplicates: 0,
    lateForFinal: 0,
    outOfRange: 0,
    backfilled: [],
    closed: [],
    finalized: [],
    pruned: [],
    capped: false,
    openCapHit: false,
    lastEventAt: state.lastEventAt ?? null,
  };
  const recentFrom = addDays(today, -META_GROWTH_DAYS);
  const fileDone = (type, date) => state.files[fileKey(type, date, 1)]?.done === true;
  const dateDone = (date) => fileDone('kills', date) && fileDone('equipment', date);
  const allDates = dateList(META_FIRST_DAY, today);
  const recentDates = allDates.filter((d) => d >= recentFrom);
  const oldDates = allDates.filter((d) => d < recentFrom && !dateDone(d)).slice(0, backfillDates);
  const recentIncoming = new Map();
  const touched = new Set();
  const pendingIn = state.pending ?? { kills: [], equipment: [], equipmentSeen: [] };
  let pending = { kills: pendingIn.kills ?? [], equipment: pendingIn.equipment ?? [] };
  const equipFirstSeen = new Map((pendingIn.equipmentSeen ?? []).map(([id, d]) => [id, d]));

  /** Bytes nuevos de un tipo de archivo de un día (todas sus partes), ya convertidos en filas. */
  async function readType(type, date, recent) {
    const rows = [];
    for (let part = 1; part <= MAX_PARTS; part++) {
      const key = fileKey(type, date, part);
      const prev = state.files[key];
      if (prev?.done) {
        if (prev.cursor >= PART_PROBE_BYTES) continue;
        break;
      }
      const base = state.files[fileKey(type, date, 1)]?.url;
      const urls = prev?.url ? [prev.url] : part === 1 ? urlsFor(type, date) : base ? [partUrl(base, part)] : [];
      let result = null;
      for (const url of urls) {
        const same = prev?.url === url;
        const cursor = same ? prev.cursor : 0;
        const tail = same && prev.tail ? Buffer.from(prev.tail, 'base64') : null;
        status.requests += 1;
        let r = await readNewBytes(url, cursor, tail, fetchImpl);
        let fromZero = !same;
        if (r.status === 'mismatch') {
          // El archivo cambió por dentro: se relee entero (los ids por día evitan contar dos veces).
          status.mismatches += 1;
          log(`${key}: el archivo no coincide con lo leído; se relee desde el principio`);
          status.requests += 1;
          r = await readNewBytes(url, 0, null, fetchImpl);
          fromZero = true;
        }
        if (r.status === 'missing') continue;
        result = { url, fromZero, ...r };
        break;
      }
      if (!result) {
        // No existe (todavía). Un día viejo sin archivo no va a tenerlo: queda hecho para no volver a probarlo.
        if (part === 1 && !recent) state.files[key] = { url: null, cursor: 0, tail: null, done: true, missing: true };
        break;
      }
      if (result.status === 'error') {
        status.errors += 1;
        break;
      }
      if (result.stale) status.staleCopies += 1;
      const entry = result.fromZero ? { url: result.url, cursor: 0, tail: null } : { url: result.url, cursor: prev.cursor, tail: prev.tail };
      if (result.status === 'new') {
        status.bytes += result.data.length;
        status.filesRead += 1;
        const { rows: parsed, bad } = parseNdjson(result.data.toString('utf8'));
        status.badLines += bad;
        for (const row of parsed) rows.push(row);
        entry.cursor = result.cursor;
        entry.tail = result.tail.toString('base64');
      }
      // Un archivo de más de 8 días ya no crece: leído hasta el final, no se vuelve a mirar.
      if (!recent) entry.done = true;
      state.files[key] = entry;
      if (entry.cursor < PART_PROBE_BYTES) break;
    }
    return rows;
  }

  /** Suma eventos a su día (el de la hora de la kill), sin repetir ids. */
  function addEvents(events) {
    for (const [date, list] of groupByDay(events)) {
      if (date < META_FIRST_DAY || date > today) {
        status.outOfRange += list.length;
        continue;
      }
      const day = store.readDay(date) ?? { v: META_DAY_VERSION, date, rev: 0, status: 'open', ids: '', rollup: emptyMetaRollup(date) };
      if (day.status === 'final') {
        // Solo pasa si un archivo viejo se reescribió y se releyó entero: esas kills ya están en el día final.
        status.lateForFinal += list.length;
        continue;
      }
      const ids = decodeIds(day.ids);
      const fresh = [];
      for (const e of list) {
        if (ids.has(e.EventId)) {
          status.duplicates += 1;
          continue;
        }
        ids.add(e.EventId);
        fresh.push(e);
        if (!status.lastEventAt || e.TimeStamp > status.lastEventAt) status.lastEventAt = e.TimeStamp;
      }
      if (fresh.length === 0) continue;
      day.rollup.seen = [];
      status.added += addEventsToRollup(day.rollup, fresh);
      day.ids = encodeIds(ids);
      day.rev = (day.rev ?? 0) + 1;
      const caps = day.status === 'closed' ? CLOSED_CAPS : OPEN_CAPS;
      if (day.status !== 'closed' && capHit(day.rollup, caps)) status.openCapHit = true;
      day.rollup = capRollup(day.rollup, caps);
      store.writeDay(day);
      touched.add(date);
      for (const [weapon, uses] of collectRecentUses(fresh)) recentIncoming.set(weapon, mergeRecentUses(recentIncoming.get(weapon) ?? [], uses));
    }
  }

  // 1) Día por día (primero los 8 recientes, después los viejos que faltan): bytes nuevos, kills con su equipo y suma.
  // Un día a la vez para no tener en memoria varios días enteros la primera vez.
  for (const date of [...recentDates, ...oldDates]) {
    if (status.bytes >= maxBytes) {
      status.capped = true;
      break;
    }
    const recent = date >= recentFrom;
    if (!recent) status.backfilled.push(date);
    const kills = await readType('kills', date, recent);
    const equipment = await readType('equipment', date, recent);
    if (kills.length === 0 && equipment.length === 0) continue;
    const joined = joinKillsAndEquipment(kills, equipment, pending);
    pending = joined.pending;
    status.events += joined.events.length;
    addEvents(joined.events);
  }

  // 2) Lo que quedó sin pareja espera hasta 2 días; después se cuenta como perdido.
  const oldest = addDays(today, -PENDING_MAX_DAYS);
  const keepKills = pending.kills.filter((k) => (k.timestamp ?? '').slice(0, 10) >= oldest);
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

  // 3) Cerrar: D <= hoy-2 y ya se leyó el archivo de D+1 (donde caen las kills de las 23:59). Si el escáner no tuvo
  // archivo de D+1 (caído un día entero), un día reciente se cierra igual a los 3 días. Los viejos esperan a D+1.
  const nextRead = (date) => ['kills', 'equipment'].every((t) => state.files[fileKey(t, addDays(date, 1), 1)]);
  for (const date of store.listMutable('open')) {
    const ready = date <= addDays(today, -2) && (date < recentFrom ? dateDone(addDays(date, 1)) : nextRead(date) || date <= addDays(today, -3));
    if (!ready) continue;
    const day = store.readDay(date);
    if (!day) continue;
    store.writeDay({ ...day, status: 'closed', rev: (day.rev ?? 0) + 1, rollup: capRollup(day.rollup, CLOSED_CAPS) });
    status.closed.push(date);
  }

  // 4) Final: cuando D+1 ya salió de los 8 días y está leído entero, D no puede recibir más kills.
  for (const date of store.listMutable('closed')) {
    const next = addDays(date, 1);
    if (!(next < recentFrom && dateDone(next) && dateDone(date))) continue;
    const day = store.readDay(date);
    if (!day) continue;
    store.finalizeDay({ ...day, rev: (day.rev ?? 0) + 1 });
    status.finalized.push(date);
  }
  // Los finales que el clon de `rollups` ya traía publicados se borran de `metastate`; los que se escribieron ahora
  // quedan hasta la corrida siguiente (si el push de `rollups` falla, se vuelven a escribir desde acá).
  const finalsOnDisk = new Set(store.listFinalDays());
  for (const date of store.listMutable('final')) if (!finalsOnDisk.has(date)) store.finalizeDay(store.readDay(date));
  status.pruned = store.pruneFinal();

  state.lastEventAt = status.lastEventAt;
  store.writeState(state);
  const missingOld = allDates.filter((d) => d < recentFrom && !dateDone(d)).length;
  return {
    recentIncoming,
    touchedDates: [...touched].sort(),
    status: { ...status, pendingKills: keepKills.length, pendingEquipment: keepEquipment.length, lost: state.lost, backfillLeft: missingOld },
  };
}

// ---- Ventanas (lo mismo que arma `sampleMetaArmory` en su corrida pesada) ----

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
 *  doc      = `meta_armory/{región}` (day, week, month, all, dayKey, weekKey, monthKey, allSince), sin el reto
 *  versus   = `versus_matchups/{región}.windows` (week, month, all; top 1.500)
 *  files    = { 'meta-detail/<región>/<ventana>.json', 'meta-detail/<región>/versus-<ventana>.json' }
 *  combined = resúmenes reducidos para «Todos».
 * Un mes se usa compactado solo si todos sus días son finales (ya no cambian).
 */
export function buildRegionOutputs({ region, today, store, builtAt }) {
  const dates = store.listDays().filter((d) => d >= META_FIRST_DAY && d <= today).sort();
  const finals = new Set(store.listFinalDays());
  const monday = mondayOf(new Date(`${today}T12:00:00Z`));
  const monthStart = `${today.slice(0, 8)}01`;
  const thisMonth = today.slice(0, 7);
  const byMonth = new Map();
  for (const d of dates) byMonth.set(d.slice(0, 7), [...(byMonth.get(d.slice(0, 7)) ?? []), d]);
  const closedMonths = [...byMonth.keys()].filter((m) => m < thisMonth && byMonth.get(m).every((d) => finals.has(d))).sort();
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
    const merged = monthOf(store, m, byMonth.get(m));
    if (merged) months.set(m, merged);
  }
  const allEntries = [...months.entries(), ...[...loaded.entries()].filter(([d]) => !closedSet.has(d.slice(0, 7)))];
  const allRollups = allEntries.map(([, r]) => r);
  const doc = {
    day: dropTierlessMounts(buildMetaWindow(pick(today))),
    week: dropTierlessMounts(buildMetaWindow(pick(monday))),
    month: dropTierlessMounts(buildMetaWindow(pick(monthStart))),
    all: dropTierlessMounts(buildMetaWindow(allRollups)),
    dayKey: today,
    weekKey: monday,
    monthKey: thisMonth,
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
  return { doc, versus, files, combined, days: dates.length, months: closedMonths.length };
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
