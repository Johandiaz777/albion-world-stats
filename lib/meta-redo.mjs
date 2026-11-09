// Rehacer los días de Meta Armory con la regla de asistencias y grupo (chat 180; regla del chat 179).
//
// Hasta el 9-nov 00:35 UTC Meta contaba el tamaño de pelea y «en solitario» con `numberOfParticipants`, que la API corta
// en 4: «6 a 10» y «11 o más» quedaban vacíos y «solo» incluía kills con el grupo cerca. Semana y Mes se corrigen solos
// al pasar los días; «Todo» (y los meses compactados) no. Este paso rehace cada día del rango desde los MISMOS archivos
// del escáner (kills + equipo) con el código de hoy (`addEventsToRollup`, generado de `sampleMetaArmory`).
//
// Rango: desde el 5-oct (el escáner guarda `groupSize` desde ese día: antes la regla nueva da lo mismo que la vieja) hasta
// el último día que la regla vieja tocó. El 29-sep (único día con kills rescatadas de la API, que no están en los archivos)
// queda fuera: nada rescatado se pierde.
//
// Defensas («nada se pierde ni se cuenta dos veces»):
//  - Se lee el día D y sus vecinos D-1 y D+1 (una kill de las 23:59 cae en el archivo de D+1; la línea de equipo puede ir
//    en otro archivo) y se quedan solo las kills cuyo `TimeStamp` es D, sin repetir ids.
//  - Si el día guardado tiene ids (días cerrados), TODOS deben estar en lo rehecho; si no tiene (días finales), lo rehecho
//    debe tener al menos las mismas `samples`. Si no, el día NO se escribe y queda anotado (`short`).
//  - Un archivo que no se pudo bajar deja el día para la corrida siguiente.
//  - Los días abiertos (hoy y ayer) esperan a cerrarse: el paso normal de Meta todavía les suma kills.
//  - Al escribir se sube la revisión del día: el mes compactado se rehace solo (su firma cambia).
//  - El avance queda en `metastate/<región>/redo.json.gz`: cada día se rehace UNA vez.
import { addEventsToRollup, emptyMetaRollup } from './meta-core.mjs';
import { addDays, capRollup, CLOSED_CAPS, dateList, decodeIds, encodeIds } from './meta-build.mjs';
import { createMetaStore, diskIo } from './meta-store.mjs';
import { groupByDay, joinKillsAndEquipment, parseNdjson } from './meta.mjs';
import { fetchDayFile } from './sources.mjs';

export const REDO_VERSION = 1;
/** Nombre de la regla con la que se rehace: si cambia, se rehace todo otra vez. */
export const REDO_RULE = 'asistencias-grupo-chat179';
export const REDO_FROM = '2026-10-05';
/** Último día que pudo tener kills sumadas con la regla vieja (la corrida que empezó el 8-nov 23:36 UTC llegó al 9-nov). */
export const REDO_TO = '2026-11-09';
export const REDO_REGIONS = ['americas', 'europe', 'asia'];
/** Tope de bytes bajados por región y corrida (Américas ~100-150 MB por día y tipo). */
export const REDO_MAX_BYTES = 1_200_000_000;

function newRedoState() {
  return { v: REDO_VERSION, rule: REDO_RULE, dates: {} };
}

/** Suma de control de un resumen: kills, kills con arma y «en solitario». */
function summary(rollup) {
  let kills = 0;
  let solo = 0;
  for (const t of Object.values(rollup?.weapons ?? {})) {
    kills += Number(t?.[0]) || 0;
    solo += Number(t?.[2]) || 0;
  }
  return { samples: rollup?.samples ?? 0, kills, solo };
}

/**
 * Rehace los días pendientes de un servidor. `readDay(date)` → { kills, equipment } (texto ndjson) | null si no se pudo
 * bajar | { kills: '', equipment: '' } si no existe. Devuelve el estado nuevo y lo hecho.
 * `write: false` solo mide (no toca el almacén).
 */
export async function redoRegion({ state, store, readDayTexts, from = REDO_FROM, to = REDO_TO, write = true, maxBytes = REDO_MAX_BYTES, log = () => {} }) {
  const st = state && state.v === REDO_VERSION && state.rule === REDO_RULE ? state : newRedoState();
  const done = { redone: [], short: [], waiting: [], missing: [], bytes: 0, capped: false };
  const cache = new Map();
  /** Filas de un día del escáner (con caché: D+1 de un día es D del siguiente). */
  async function rowsOf(date) {
    if (cache.has(date)) return cache.get(date);
    const texts = await readDayTexts(date);
    if (texts) done.bytes += (texts.kills?.length ?? 0) + (texts.equipment?.length ?? 0);
    const rows = texts ? { kills: parseNdjson(texts.kills ?? '').rows, equipment: parseNdjson(texts.equipment ?? '').rows } : null;
    cache.set(date, rows);
    return rows;
  }
  for (const date of dateList(from, to)) {
    if (st.dates[date]?.done) continue;
    if (done.bytes >= maxBytes) {
      done.capped = true;
      break;
    }
    const day = store.readDay(date);
    if (!day) {
      st.dates[date] = { done: true, empty: true };
      continue;
    }
    if (day.status !== 'closed' && day.status !== 'final') {
      done.waiting.push(date);
      continue;
    }
    for (const old of [...cache.keys()]) if (old < addDays(date, -1)) cache.delete(old);
    const near = [];
    let ok = true;
    for (const d of [addDays(date, -1), date, addDays(date, 1)]) {
      const rows = await rowsOf(d);
      if (!rows) {
        ok = false;
        break;
      }
      near.push(rows);
    }
    if (!ok) {
      done.missing.push(date);
      continue;
    }
    const { events } = joinKillsAndEquipment(
      near.flatMap((r) => r.kills),
      near.flatMap((r) => r.equipment),
    );
    const mine = [...new Map((groupByDay(events).get(date) ?? []).map((e) => [e.EventId, e])).values()];
    const oldIds = day.ids ? decodeIds(day.ids) : null;
    const newIds = new Set(mine.map((e) => e.EventId));
    const rollup = emptyMetaRollup(date);
    addEventsToRollup(rollup, mine);
    rollup.seen = [];
    const before = summary(day.rollup);
    const after = summary(rollup);
    const missingIds = oldIds ? [...oldIds].filter((id) => !newIds.has(id)).length : 0;
    if (missingIds > 0 || after.samples < before.samples) {
      // Lo rehecho tiene menos que lo guardado: no se escribe (algo no se pudo leer o el día tenía kills de otra fuente).
      st.dates[date] = { done: false, short: { missingIds, before, after } };
      done.short.push(date);
      log(`${date}: NO se escribe: faltan ${missingIds} ids / samples ${after.samples} < ${before.samples}`);
      continue;
    }
    if (write) {
      const next = { ...day, rev: (day.rev ?? 0) + 1, rollup: capRollup(rollup, CLOSED_CAPS) };
      if (day.status === 'final') store.finalizeDay(next);
      else store.writeDay({ ...next, ids: encodeIds(new Set([...(oldIds ?? []), ...newIds])) });
    }
    st.dates[date] = { done: write, before, after, at: new Date().toISOString() };
    done.redone.push(`${date}:${before.solo}->${after.solo}`);
    log(`${date} (${day.status}): samples ${before.samples}->${after.samples}, solo ${before.solo}->${after.solo}${write ? '' : ' (sin escribir)'}`);
  }
  return { state: st, done };
}

/** `node build.mjs meta-redo [--region r] [--dry]`: una pasada por servidor; lo publica el workflow con metastate y rollups. */
export async function runMetaRedo({ root, regions = REDO_REGIONS, write = true, log = console.log }) {
  const io = diskIo(root);
  let failures = 0;
  for (const region of regions) {
    const path = `metastate/${region}/redo.json.gz`;
    try {
      const store = createMetaStore(io, region);
      const readDayTexts = async (date) => {
        const stats = { bytes: 0, retries: 0 };
        const kills = await fetchDayFile('kills', region, date, stats);
        if (kills === null && stats.failed) return null;
        const equipment = await fetchDayFile('equipment', region, date, stats);
        if (equipment === null && stats.failed) return null;
        return { kills: kills ?? '', equipment: equipment ?? '' };
      };
      const { state, done } = await redoRegion({ state: io.read(path), store, readDayTexts, write, log: (m) => log(`[rehacer ${region}] ${m}`) });
      if (write) io.write(path, state);
      const left = dateList(REDO_FROM, REDO_TO).filter((d) => !state.dates[d]?.done).length;
      log(`[rehacer ${region}] ${JSON.stringify({ ...done, redone: done.redone.length, left })}`);
    } catch (err) {
      failures += 1;
      log(`[rehacer ${region}] FALLÓ: ${err?.stack ?? err}`);
    }
  }
  return failures === regions.length ? 1 : 0;
}
