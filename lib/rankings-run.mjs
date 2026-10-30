// `node build.mjs rankings`: Rankings de kills (Kills, Fama, Muertes, Gremios, Hoy, Semana, Puntaje global, Batallas
// con más fama) desde el escáner, con el MISMO acumulador que `refreshCraftingLeaderboards` (lib/ranking-core.mjs,
// generado desde las funciones) y en el MISMO orden. Parte 137/138, fase 2 de costos.
//
// Por qué así (informe p136-fase2 §8.2): sumar estados por día NO da lo mismo (una pelea que aparece después cambia
// kills ya sumadas, los empates dependen del orden...). Por eso se guarda la copia cruda de los últimos 8 días
// (`rawcache/`, caché de Actions entre corridas; solo se baja lo nuevo con `Range`, lib/raw-cache.mjs) y cada corrida
// recorre los 7 días enteros como la función:
//
//   fechas  = los 7 días UTC del más nuevo al más viejo (`lastNDatesUTC(7)`);
//   peleas  = un Map por battleId recorriendo esas fechas (gana la ÚLTIMA vista, o sea la del archivo más viejo; el
//             orden del Map es el de la primera vez vista), como `fetchBattlesForRegion`;
//   kills   = en ese orden, la PRIMERA vez que se ve cada eventId, con `kill.region = región`, como
//             `streamKillsForRegion`;
//   Hoy     = solo kills y peleas del día UTC de `now`; Semana = lunes a hoy (`datesForPeriod`).
//
// Publica (carpeta local `rankingspub/`, rama `rankings`):
//   <región>.json  { v, region, builtAt, dayKey, weekKey, dates, killsSeen, sources, all, day, week }
//                  all/day/week = `acc.finish()` tal cual (lo que la función calcula hoy con los mismos archivos)
//   status.json    salud por región
// La función, en `appConfig/rankingsSource = {mode:'repos'}`, copia `all`, `day` y `week` en lugar de calcularlos
// (functions/src/rankings-source.ts) y sigue haciendo crafteo, reclamos, insignias y el global.
import fs from 'node:fs';
import path from 'node:path';

import { createCombatRankingsAccumulator, forEachNdjsonRow, RANKING_CORE_SOURCE_SHA } from './ranking-core.mjs';
import { pruneRawCache, syncDayText } from './raw-cache.mjs';
import { readJson, writeJson } from './store.mjs';

/** Mismo orden que `LEADERBOARD_REGIONS` de las funciones. */
export const RANKINGS_REGIONS = ['americas', 'europe', 'asia'];
export const RANKINGS_PUBLISH_DIR = 'rankingspub';
export const RAW_CACHE_DIR = 'rawcache';
export const RANKINGS_FILE_VERSION = 1;
/** `LEADERBOARD_DAYS` de las funciones. */
export const RANKINGS_DAYS = 7;
/** Días que se guardan en la copia local: los 7 y uno más, para no volver a bajar entero el día que sale. */
const CACHE_DAYS = RANKINGS_DAYS + 1;
/** Archivos bajando a la vez (como `SCRAPER_DAY_CONCURRENCY` de la función). */
const SYNC_CONCURRENCY = 4;

const DAY_MS = 24 * 60 * 60 * 1000;
const dateStr = (d) => d.toISOString().slice(0, 10);

/** `lastNDatesUTC(n)` de las funciones, con `now` explícito. Del más nuevo al más viejo. */
export function lastNDatesUTC(n, now) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(dateStr(new Date(now.getTime() - i * DAY_MS)));
  return out;
}

/** `mondayOfWeekUTC` de las funciones. */
function mondayOfWeekUTC(d) {
  const day = d.getUTCDay();
  const diff = (day === 0 ? -6 : 1) - day;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diff));
}

/** `datesForPeriod('day'|'week', now)` de las funciones. */
export function datesForPeriod(period, now) {
  if (period === 'day') return [dateStr(now)];
  const out = [];
  const cur = mondayOfWeekUTC(now);
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  while (cur.getTime() <= last.getTime()) {
    out.push(dateStr(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

/** `periodKey('day'|'week', now)` de las funciones. */
export function periodKey(period, now) {
  return period === 'day' ? dateStr(now) : dateStr(mondayOfWeekUTC(now));
}

/**
 * Rankings de una región con el acumulador de la función. `readDay(type, date)` = texto del archivo del día o null
 * (404). Pura salvo por `readDay`: las pruebas le pasan textos en memoria.
 */
export async function buildRegionRankings({ region, now, readDay }) {
  const dates = lastNDatesUTC(RANKINGS_DAYS, now);
  const byBattleId = new Map();
  for (const date of dates) {
    const text = await readDay('battles', date);
    if (text === null) continue;
    forEachNdjsonRow(text, (battle) => {
      byBattleId.set(battle.battleId, battle);
    });
  }
  const battles = [...byBattleId.values()];
  const dayDates = new Set(datesForPeriod('day', now));
  const weekDates = new Set(datesForPeriod('week', now));
  const battlesIn = (set) => battles.filter((b) => set.has(b.startTime.slice(0, 10)));
  const allAcc = createCombatRankingsAccumulator(battles, region);
  const dayAcc = createCombatRankingsAccumulator(battlesIn(dayDates), region);
  const weekAcc = createCombatRankingsAccumulator(battlesIn(weekDates), region);
  const seen = new Set();
  for (const date of dates) {
    const text = await readDay('kills', date);
    if (text === null) continue;
    forEachNdjsonRow(text, (kill) => {
      if (seen.has(kill.eventId)) return;
      seen.add(kill.eventId);
      kill.region = region;
      allAcc.addKill(kill);
      const d = kill.timestamp.slice(0, 10);
      if (dayDates.has(d)) dayAcc.addKill(kill);
      if (weekDates.has(d)) weekAcc.addKill(kill);
    });
  }
  return {
    dates,
    dayKey: periodKey('day', now),
    weekKey: periodKey('week', now),
    killsSeen: seen.size,
    battles: battles.length,
    all: allAcc.finish(),
    day: dayAcc.finish(),
    week: weekAcc.finish(),
  };
}

async function inBatches(items, size, fn) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

/** Pone al día la copia local de una región (los 7 días, peleas y kills) y devuelve un `readDay` que lee de ella. */
export async function syncRegion({ dir, region, now, fetchImpl = fetch }) {
  const stats = { bytes: 0, mismatches: 0, fullDownloads: 0, files: {} };
  const texts = new Map();
  const jobs = [];
  for (const type of ['battles', 'kills']) for (const date of lastNDatesUTC(RANKINGS_DAYS, now)) jobs.push({ type, date });
  await inBatches(jobs, SYNC_CONCURRENCY, async ({ type, date }) => {
    const text = await syncDayText({ dir, region, type, date, fetchImpl, stats, withParts: false });
    // Solo si existe: el texto se vuelve a leer del disco al recorrerlo (no se guardan los 14 a la vez).
    texts.set(`${type}/${date}`, text !== null);
  });
  const readDay = async (type, date) => {
    if (!texts.get(`${type}/${date}`)) return null;
    return fs.readFileSync(path.join(dir, region, type, `${date}.ndjson`), 'utf8');
  };
  return { readDay, stats };
}

export async function runRankings({ root, regions = RANKINGS_REGIONS, now = new Date(), fetchImpl = fetch, log = console.log }) {
  const pub = path.join(root, RANKINGS_PUBLISH_DIR);
  const cache = path.join(root, RAW_CACHE_DIR);
  const builtAt = now.toISOString();
  const previous = readJson(path.join(pub, 'status.json'), { regions: {} });
  const status = { v: RANKINGS_FILE_VERSION, builtAt, dayKey: periodKey('day', now), core: RANKING_CORE_SOURCE_SHA, regions: { ...(previous.regions ?? {}) } };
  let failures = 0;
  for (const region of regions) {
    const t0 = Date.now();
    try {
      const { readDay, stats } = await syncRegion({ dir: cache, region, now, fetchImpl });
      const tSync = Date.now();
      const r = await buildRegionRankings({ region, now, readDay });
      const bytes = writeJson(path.join(pub, `${region}.json`), {
        v: RANKINGS_FILE_VERSION,
        region,
        builtAt,
        dayKey: r.dayKey,
        weekKey: r.weekKey,
        dates: r.dates,
        core: RANKING_CORE_SOURCE_SHA,
        killsSeen: r.killsSeen,
        battles: r.battles,
        sources: stats.files,
        all: r.all,
        day: r.day,
        week: r.week,
      });
      status.regions[region] = {
        ok: true,
        at: new Date().toISOString(),
        syncSeconds: Math.round((tSync - t0) / 1000),
        buildSeconds: Math.round((Date.now() - tSync) / 1000),
        downloadedMB: Math.round(stats.bytes / 1e5) / 10,
        fullDownloads: stats.fullDownloads,
        mismatches: stats.mismatches,
        killsSeen: r.killsSeen,
        battles: r.battles,
        fileKB: Math.round(bytes / 1024),
        maxRssMB: Math.round(process.resourceUsage().maxRSS / 1024),
      };
      log(`[rankings ${region}] ${JSON.stringify(status.regions[region])}`);
    } catch (err) {
      failures += 1;
      status.regions[region] = { ...(previous.regions?.[region] ?? {}), ok: false, failedAt: new Date().toISOString(), error: String(err?.message ?? err).slice(0, 300) };
      log(`[rankings ${region}] FALLÓ: ${err?.stack ?? err}`);
    }
  }
  writeJson(path.join(pub, 'status.json'), status);
  const removed = pruneRawCache(cache, lastNDatesUTC(CACHE_DAYS, now));
  if (removed) log(`[rankings] copia local: ${removed} archivos viejos borrados`);
  return failures === regions.length ? 1 : 0;
}
