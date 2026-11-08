// `node build.mjs loot` (chat 175): publica `today/<región>/loot-<período>.json` para ordenar Rankings por botín,
// perdido y profit. Corre al final de cada corrida, después de la horaria, Rankings y (si toca) la diaria. Ver
// lib/rank-loot.mjs para las reglas.
//
// Lee (todo local, ya clonado por el workflow):
//   index/<región>/_loot.json.gz        días cerrados de Semana, Mes, Temporada y Todo (lo escribe la diaria)
//   today/<región>/_loot-today.json     hoy y, si la diaria no lo cerró, ayer (lo escribe la horaria)
//   rankingspub/<región>.json           nombres de Hoy y Semana (la copia exacta de Rankings)
//   today/<región>/_lootnames.json      nombres de Mes, Temporada y Todo (se releen 1 vez al día de Firestore)
// Un período que no se puede armar completo se BORRA en vez de dejar uno viejo: la app dice «sin datos de botín».
import fs from 'node:fs';
import path from 'node:path';

import { dateStr, fetchTopDocNames, lootFile, monthStartOf, mondayOf, namesFromRankingsPeriod, namesNeedRefresh, periodLoot, RANK_LOOT_PERIODS } from './rank-loot.mjs';
import { FIRST_DAY } from './sources.mjs';
import { readJson, writeJson } from './store.mjs';

export const RANK_LOOT_REGIONS = ['americas', 'europe', 'asia'];
const DAILY_NAME_PERIODS = ['month', 'season', 'all'];

/** Nombres de Mes, Temporada y Todo: del caché si sigue vigente; si no, de Firestore (2 lecturas por período). Si la
 * lectura falla se queda lo que había (mejor nombres de ayer que ningún dato). */
async function dailyNames({ root, region, now, fetchImpl, log }) {
  const file = path.join(root, 'today', region, '_lootnames.json');
  const cached = readJson(file, null);
  if (cached && !namesNeedRefresh(cached.fetchedAt, now)) return cached.periods ?? {};
  const periods = { ...(cached?.periods ?? {}) };
  let ok = 0;
  for (const period of DAILY_NAME_PERIODS) {
    try {
      const names = await fetchTopDocNames(region, period, fetchImpl);
      if (names) {
        periods[period] = names;
        ok += 1;
      } else delete periods[period];
    } catch (err) {
      log(`[loot ${region}] nombres de ${period}: ${err?.message ?? err} (se usan los de antes)`);
    }
  }
  if (ok > 0) writeJson(file, { fetchedAt: now.toISOString(), periods });
  return periods;
}

export async function runRankLootRegion({ root, region, now = new Date(), fetchImpl = fetch, log = console.log }) {
  const today = dateStr(now);
  const base = path.join(root, 'today', region);
  const todayLoot = readJson(path.join(base, '_loot-today.json'), null);
  const closed = readJson(path.join(root, 'index', region, '_loot.json.gz'), null);
  const rankings = readJson(path.join(root, 'rankingspub', `${region}.json`), null);
  const daily = await dailyNames({ root, region, now, fetchImpl, log });
  const builtAt = now.toISOString();
  const seasonStart = daily.season?.seasonStart ?? null;

  const plan = {
    day: { from: today, key: today, names: rankings?.dayKey === today ? namesFromRankingsPeriod(rankings.day) : null },
    week: { from: mondayOf(today), key: mondayOf(today), names: rankings?.weekKey === mondayOf(today) ? namesFromRankingsPeriod(rankings.week) : null },
    month: { from: monthStartOf(today), key: today.slice(0, 7), names: daily.month?.key === today.slice(0, 7) ? daily.month : null },
    season: { from: seasonStart, key: daily.season?.key ?? null, names: seasonStart && daily.season?.key ? daily.season : null },
    all: { from: FIRST_DAY, key: 'all', names: daily.all?.key === 'all' ? daily.all : null },
  };

  const result = {};
  for (const period of RANK_LOOT_PERIODS) {
    const out = path.join(base, `loot-${period}.json`);
    const p = plan[period];
    const loot =
      p.names && todayLoot?.date === today && p.from
        ? periodLoot({ from: p.from, today, closed: period === 'day' ? null : closed?.periods?.[period], todayLoot })
        : null;
    if (!loot) {
      if (fs.existsSync(out)) fs.rmSync(out);
      result[period] = p.names ? 'sin-dias' : 'sin-nombres';
      continue;
    }
    const file = lootFile({ region, period, key: p.key, from: p.from, names: p.names, loot, builtAt });
    const bytes = writeJson(out, file);
    result[period] = { players: p.names.p.length, guilds: p.names.g.length, kb: Math.round(bytes / 1024) };
  }
  log(`[loot ${region}] ${JSON.stringify(result)}`);
  return result;
}

export async function runRankLoot({ root, regions = RANK_LOOT_REGIONS, now = new Date(), fetchImpl = fetch, log = console.log }) {
  let failures = 0;
  for (const region of regions) {
    try {
      await runRankLootRegion({ root, region, now, fetchImpl, log });
    } catch (err) {
      failures += 1;
      log(`[loot ${region}] FALLÓ: ${err?.stack ?? err}`);
    }
  }
  return failures === regions.length ? 1 : 0;
}
