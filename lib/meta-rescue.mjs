// Rescate de las kills «perdidas» de Meta Armory (chat 175, pedido del dueño: «nuestros datos no se pueden perder»).
//
// Medido el 8-nov: las ~82 mil kills que `state.lost.kills` cuenta (Américas 39.407, Europa 22.822, Asia 20.271) se
// perdieron TODAS en la primera carga (corrida del 30-oct, lote 29-sep..2-oct) y el contador no se movió desde entonces.
// Causa: el escáner empezó a escribir `equipment/` el 29-sep hacia las 14:00 UTC; las kills de antes de esa hora no
// tienen línea de equipo (Asia: 34.056 kills, 19.918 sin equipo, todas antes de las 14 UTC) y Meta las descartó a los
// 2 días sin pareja. El resto de los días tienen el equipo de TODAS sus kills.
//
// La API de Albion sí las devuelve por id (`/events/{id}`, 5 de 5 probadas con 40 días), en la MISMA forma que consume
// Meta (`EventId`, `Killer.Equipment`, `Victim.Equipment`...). Así que el rescate:
//   1. Una vez por servidor y día: compara el archivo de kills con el de equipo y anota los ids sin equipo (`todo`).
//   2. Cada corrida pide a la API unos cientos, despacio (~50 por minuto: el límite medido es ~55-60 por IP y minuto
//      para TODA la API), con tope de tiempo. Un 429 corta el servidor hasta la corrida siguiente.
//   3. Los suma al día FINAL con `addEventsToRollup` (la misma cuenta de siempre) y le sube la revisión: el mes
//      compactado de septiembre se rehace solo (su firma cambia). Nunca cuenta dos veces: esos ids nunca entraron (no
//      tenían pareja) y cada id rescatado queda anotado.
//   4. Descuenta del contador `lost.kills` lo rescatado: el estado dice la verdad.
// Lo que la API no tiene (404) o falla 5 veces se anota y se deja: nunca bloquea al resto.
//
// La plata (`ve`/`vi`) de esas kills NO se rescata: se calcula con los precios del momento de la kill. Meta no la usa.

import { addEventsToRollup } from './meta-core.mjs';
import { capRollup, CLOSED_CAPS } from './meta-build.mjs';
import { createMetaStore, diskIo } from './meta-store.mjs';
import { fetchDayFile } from './sources.mjs';

export const RESCUE_VERSION = 1;
/** Días con kills sin equipo en el escáner (medido: solo el 29-sep, antes de las ~14 UTC). Se revisan 29-sep..2-oct
 * por si acaso: un día sin faltantes queda terminado en la primera pasada. */
export const RESCUE_DATES = ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'];
/** Pausa entre pedidos: ~50 por minuto, por debajo del límite medido de la API (~55-60 por IP y minuto). */
export const RESCUE_GAP_MS = 1200;
/** Tiempo máximo por corrida entre los 3 servidores (la corrida horaria sigue teniendo margen). */
export const RESCUE_BUDGET_MS = 12 * 60_000;
/** Intentos por id antes de dejarlo (errores de red o 5xx). Un 404 se deja a la primera. */
export const RESCUE_MAX_TRIES = 5;

export const API_HOSTS = {
  americas: 'https://gameinfo.albiononline.com',
  europe: 'https://gameinfo-ams.albiononline.com',
  asia: 'https://gameinfo-sgp.albiononline.com',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ids de las kills DEL DÍA `date` sin línea de equipo (el archivo trae también algunas de las 23:5x del día anterior,
 * que no son de este día en Meta). `killsText`/`equipmentText` = archivos NDJSON del escáner. Pura. */
export function missingEquipmentIds(killsText, equipmentText, date) {
  const withEquipment = new Set();
  for (const line of equipmentText.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (typeof e?.e === 'number') withEquipment.add(e.e);
    } catch {
      // línea rota: se ignora (igual que Meta)
    }
  }
  const missing = new Set();
  for (const line of killsText.split('\n')) {
    if (!line.trim()) continue;
    try {
      const k = JSON.parse(line);
      if (typeof k?.eventId !== 'number' || withEquipment.has(k.eventId)) continue;
      if (date && (typeof k.timestamp !== 'string' || k.timestamp.slice(0, 10) !== date)) continue;
      missing.add(k.eventId);
    } catch {
      // línea rota
    }
  }
  return [...missing].sort((a, b) => a - b);
}

/** Estado vacío del rescate de un servidor. */
export function newRescueState() {
  return { v: RESCUE_VERSION, dates: {} };
}

/**
 * Una pasada del rescate para un servidor. Puro salvo por `fetchEvent`, `readDayTexts`, `sleep` y `now`, que las
 * pruebas reemplazan. `store` = el almacén de Meta de ese servidor (lib/meta-store.mjs).
 *
 * `fetchEvent(id)` → { status: 200, event } | { status: 404 } | { status: 429 } | { status: 0, error }.
 * Devuelve el estado nuevo y lo hecho en esta pasada.
 */
export async function rescueRegion({ state, store, readDayTexts, fetchEvent, deadline, now = Date.now, wait = sleep, gapMs = RESCUE_GAP_MS, log = () => {} }) {
  const st = state && state.v === RESCUE_VERSION ? state : newRescueState();
  const done = { listed: [], added: 0, gone: 0, failed: 0, asked: 0, throttled: false };
  for (const date of RESCUE_DATES) {
    let d = st.dates[date];
    if (!d) {
      // 1. La lista de faltantes, una sola vez.
      const texts = await readDayTexts(date);
      if (!texts) continue; // el archivo no se pudo bajar: la próxima corrida
      const todo = missingEquipmentIds(texts.kills, texts.equipment, date);
      d = st.dates[date] = { total: todo.length, todo, added: 0, gone: 0, failed: {}, finished: todo.length === 0 };
      done.listed.push(`${date}:${todo.length}`);
      log(`${date}: ${todo.length} kills sin equipo`);
    }
    const day = store.readDay(date);
    // Tanda anterior sin confirmar: si el día publicado no tiene su revisión (falló la subida de `rollups` y Meta volvió
    // al publicado), sus ids vuelven a la fila y el contador se corrige. Nunca se dan por rescatadas kills que no están.
    if (d.unconfirmed) {
      if (day && (day.rev ?? 0) >= d.unconfirmed.rev) {
        delete d.unconfirmed;
      } else {
        d.todo.unshift(...d.unconfirmed.ids);
        d.added -= d.unconfirmed.added;
        const metaState = store.readState();
        if (metaState?.lost && typeof metaState.lost.kills === 'number') {
          metaState.lost.kills += d.unconfirmed.added;
          metaState.lost.rescued = Math.max(0, (metaState.lost.rescued ?? 0) - d.unconfirmed.added);
          store.writeState(metaState);
        }
        log(`${date}: la tanda de la revisión ${d.unconfirmed.rev} no quedó publicada; ${d.unconfirmed.ids.length} ids vuelven a la fila`);
        delete d.unconfirmed;
        d.finished = false;
      }
    }
    if (d.finished) continue;
    if (!day?.rollup) {
      log(`${date}: el día todavía no está en Meta; se espera`);
      continue;
    }
    // 2. Pedir a la API, despacio y con tope.
    const events = [];
    const rescuedIds = [];
    while (d.todo.length && now() < deadline) {
      const id = d.todo[0];
      done.asked += 1;
      const startedAt = now();
      const res = await fetchEvent(id);
      if (res.status === 429) {
        done.throttled = true;
        log(`429 de la API: este servidor sigue en la próxima corrida`);
        break;
      }
      d.todo.shift();
      if (res.status === 200 && res.event) {
        events.push(res.event);
        rescuedIds.push(id);
      } else if (res.status === 404) {
        d.gone += 1;
        done.gone += 1;
      } else {
        const tries = (d.failed[id] ?? 0) + 1;
        if (tries >= RESCUE_MAX_TRIES) {
          delete d.failed[id];
          d.gone += 1;
          done.gone += 1;
        } else {
          d.failed[id] = tries;
          d.todo.push(id); // al final de la fila: se reintenta después
        }
        done.failed += 1;
      }
      // La pausa cuenta desde el INICIO del pedido (la API tarda ~1 s): ~50 por minuto, no la mitad.
      const rest = gapMs - (now() - startedAt);
      if (d.todo.length && now() < deadline && rest > 0) await wait(rest);
    }
    // 3. Sumar al día final (misma cuenta que Meta) con revisión nueva.
    if (events.length) {
      const rollup = day.rollup;
      rollup.seen = [];
      const added = addEventsToRollup(rollup, events);
      const rev = (day.rev ?? 0) + 1;
      store.finalizeDay({ ...day, rev, rollup: capRollup(rollup, CLOSED_CAPS) });
      d.unconfirmed = { rev, ids: rescuedIds, added };
      d.added += added;
      done.added += added;
      // 4. El contador de perdidas dice la verdad.
      const metaState = store.readState();
      if (metaState?.lost && typeof metaState.lost.kills === 'number') {
        metaState.lost.kills = Math.max(0, metaState.lost.kills - added);
        metaState.lost.rescued = (metaState.lost.rescued ?? 0) + added;
        store.writeState(metaState);
      }
    }
    if (!d.todo.length) d.finished = true;
    if (done.throttled || now() >= deadline) break;
  }
  return { state: st, done };
}

/** Pedido real a la API de Albion (servidor de `region`). Nunca tira. */
export function apiFetcher(region, fetchImpl = fetch) {
  const base = API_HOSTS[region];
  return async (id) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const res = await fetchImpl(`${base}/api/gameinfo/events/${id}`, { signal: controller.signal, headers: { 'User-Agent': 'albion-world-stats' } });
      if (res.status === 404) return { status: 404 };
      if (res.status === 429) return { status: 429 };
      if (!res.ok) return { status: 0, error: `HTTP ${res.status}` };
      const event = await res.json();
      return event && typeof event.EventId === 'number' && event.EventId === id ? { status: 200, event } : { status: 0, error: 'respuesta rara' };
    } catch (err) {
      return { status: 0, error: String(err?.message ?? err) };
    } finally {
      clearTimeout(timer);
    }
  };
}

export const RESCUE_REGIONS = ['americas', 'europe', 'asia'];

/**
 * `node build.mjs meta-rescue`: una pasada por servidor, repartiendo `RESCUE_BUDGET_MS` entre los tres. Escribe en
 * `metastate/<servidor>/rescue.json.gz` (avance), el día final en `rollups/meta/` y el contador en el estado de Meta: lo
 * publican los mismos pasos de siempre del workflow (metastate y rollups).
 */
export async function runMetaRescue({ root, regions = RESCUE_REGIONS, budgetMs = RESCUE_BUDGET_MS, fetchImpl = fetch, log = console.log }) {
  const io = diskIo(root);
  const start = Date.now();
  let failures = 0;
  for (const [i, region] of regions.entries()) {
    const deadline = start + (budgetMs * (i + 1)) / regions.length;
    const path = `metastate/${region}/rescue.json.gz`;
    try {
      const store = createMetaStore(io, region);
      const readDayTexts = async (date) => {
        const stats = { bytes: 0, retries: 0 };
        const kills = await fetchDayFile('kills', region, date, stats);
        const equipment = kills === null ? null : await fetchDayFile('equipment', region, date, stats);
        return kills !== null && equipment !== null ? { kills, equipment } : null;
      };
      const { state, done } = await rescueRegion({
        state: io.read(path),
        store,
        readDayTexts,
        fetchEvent: apiFetcher(region, fetchImpl),
        deadline,
        log: (m) => log(`[rescate ${region}] ${m}`),
      });
      io.write(path, state);
      const left = Object.values(state.dates).reduce((n, d) => n + d.todo.length, 0);
      log(`[rescate ${region}] ${JSON.stringify({ ...done, left })}`);
    } catch (err) {
      failures += 1;
      log(`[rescate ${region}] FALLÓ: ${err?.stack ?? err}`);
    }
  }
  return failures === regions.length ? 1 : 0;
}
