// Estadísticas de Albion World a partir del historial del scraper de kills (kills, peleas y equipo).
// Corre en GitHub Actions (gratis): 0 Firebase. La app lee los índices por HTTPS igual que el Radar.
//
//   node build.mjs hourly   # resumen de HOY y sus índices chicos (`today/`)
//   node build.mjs daily    # cierra los días que falten (y completa hacia atrás desde julio),
//                           # arma las ventanas 7 d / 30 d / temporada / todo y publica `index/`
//   Opcional: --region europe  --max-days 5  (pruebas locales)
//
// Carpetas (el workflow las publica en ramas):
//   rollups/<region>/<fecha>.json.gz  resumen de cada día cerrado (rama `rollups`, solo se agregan)
//   index/<region>/players/<n>.json   jugadores por parte (2048 partes por hash del nombre)
//   index/<region>/guilds/<n>.json    gremios por parte (512 partes) con sus rivales
//   index/<region>/ids/<n>.json       directorio nombre → id del juego (1024 partes; todo lo visto)
//   index/<region>/weapons.json       armas: kills y muertes por ventana
//   today/<region>/players|guilds|ids/<n>.json  lo mismo, solo de hoy (se rehace cada hora)
//   index|today/<region>/ki/<fecha>/<n>.json  kills: bytes de cada línea por asesino/víctima (256 partes)
//   index|today/<region>/bi/<fecha>/<n>.json  peleas: bytes de cada línea por gremio (32 partes)
//                                     (la app pide solo esas líneas por Range: lib/name-index.mjs)
//   index/status.json, today/status.json  salud por región para el panel
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BATTLE_INDEX_DAYS,
  BATTLE_INDEX_SHARDS,
  battleGuildNames,
  buildNameIndex,
  KILL_INDEX_DAYS,
  KILL_INDEX_SHARDS,
  killNames,
  NAME_INDEX_VERSION,
  writeNameIndex,
} from './lib/name-index.mjs';

import { advanceAccumulator, bestDayByPlayer, buildDayRollup, DEDUP_FIRST_DAY, pidsFromKills, piecesFromDay, compactExtras, mergeRollups, P, rivalsByGuild, ROLLUP_VERSION, shardOf, topMembers } from './lib/rollup.mjs';
import { dateList, dayFileSize, dayFileSource, fetchDayFile, FIRST_DAY } from './lib/sources.mjs';
import { readJson, writeJson } from './lib/store.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REGIONS = ['europe', 'americas', 'asia'];
/** Parte 59 (medido 03/10): con 256 partes cada una tenía ~700 jugadores de Europa (460 KB, 75 KB
 * comprimida) y abrir un perfil bajaba eso para leer UNO. Con 2048 son ~90 (~57 KB, ~10 KB
 * comprimida). Gremios: 32 partes eran 605 KB (221 KB comprimida) por gremio; con 512, ~38 KB. */
export const PLAYER_SHARDS = 2048;
export const GUILD_SHARDS = 512;
/** Directorio nombre → id: ~150 jugadores por parte (~5 KB, ~3 KB comprimida). La app busca acá el
 * id y abre el perfil por id en Albion (0,3 s) en vez de la búsqueda por nombre (15-40 s). */
export const ID_SHARDS = 1024;
const MAX_BACKFILL_DAYS = 25; // días cerrados nuevos por región y corrida (el resto, la próxima)
/** Primer día con equipo completo (ítem con tier y encantamiento) en el archivo de equipo. */
const PIECES_FIRST_DAY = '2026-09-29';

const args = process.argv.slice(2);
const mode = args[0] === 'daily' ? 'daily' : 'hourly';
const argValue = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const regions = argValue('--region') ? [argValue('--region')] : REGIONS;
const maxDays = Number(argValue('--max-days') ?? MAX_BACKFILL_DAYS);
const fileConfig = readJson(path.join(here, 'config.json'), {});
/** Temporada cargada por el admin en el panel (config/leaderboardSeason, lectura pública); si no hay
 * red o no existe, la de config.json. Así Rankings y los perfiles usan la misma temporada. */
async function panelSeasonStart() {
  try {
    const res = await fetch('https://firestore.googleapis.com/v1/projects/albion-world/databases/(default)/documents/config/leaderboardSeason', { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const start = (await res.json())?.fields?.seasonStart?.stringValue;
    return typeof start === 'string' && /^\d{4}-\d{2}-\d{2}/.test(start) ? start.slice(0, 10) : null;
  } catch {
    return null;
  }
}
const config = { ...fileConfig, seasonStart: (await panelSeasonStart()) ?? fileConfig.seasonStart ?? null };
const day = (offset = 0) => new Date(Date.now() + offset * 86400e3).toISOString().slice(0, 10);

async function dayFiles(region, date, stats) {
  const [killsText, battlesText, equipmentText] = await Promise.all([
    fetchDayFile('kills', region, date, stats),
    fetchDayFile('battles', region, date, stats),
    fetchDayFile('equipment', region, date, stats),
  ]);
  return { killsText, battlesText, equipmentText };
}

async function dayRollup(region, date, stats) {
  const files = await dayFiles(region, date, stats);
  if (files.killsText === null && files.battlesText === null) return null;
  // `kb`: bytes del archivo de kills resumido (para saber si después creció: relleno de huecos).
  return { ...buildDayRollup(files), kb: files.killsText ? Buffer.byteLength(files.killsText) : 0 };
}

/** Días cerrados recientes cuyo archivo de kills creció desde que se resumieron (el relleno de huecos
 * del escáner agrega kills recuperadas al día de cada una, aunque ese día ya haya cerrado). */
const GROWTH_CHECK_DAYS = 3;
async function grownDays(region, yesterday, rollupPath) {
  const out = [];
  for (const d of dateList(day(-GROWTH_CHECK_DAYS), yesterday)) {
    const r = readJson(rollupPath(d), null);
    if (!r || !(r.kb > 0)) continue;
    const size = await dayFileSize('kills', region, d);
    if (size !== null && size > r.kb) out.push(d);
  }
  return out;
}

// ---- Índice por nombre (lib/name-index.mjs) ----
const KINDS = [
  { dir: 'ki', type: 'kills', namesOf: killNames, shards: KILL_INDEX_SHARDS, days: KILL_INDEX_DAYS },
  { dir: 'bi', type: 'battles', namesOf: battleGuildNames, shards: BATTLE_INDEX_SHARDS, days: BATTLE_INDEX_DAYS },
];
/** Un día queda fijo 1 h después de terminar (el scraper commitea cada ~15 min): misma regla que la app. */
const daySettled = (date) => Date.now() - (Date.parse(`${date}T00:00:00Z`) + 86400e3) > 3600e3;
const hasNameIndex = (base, kind, date) => readJson(path.join(base, kind.dir, date, '0.json'), null)?.v === NAME_INDEX_VERSION;

/** Indexa `date` para cada tipo (usa `texts` si ya se bajaron) y devuelve los bytes escritos. */
async function indexDay(base, region, date, stats, texts = {}, only = KINDS) {
  let bytes = 0;
  for (const kind of only) {
    const text = texts[kind.type] !== undefined ? texts[kind.type] : await fetchDayFile(kind.type, region, date, stats);
    if (text === null) continue; // ese día no tiene archivo: sin índice, la app usa el método de siempre
    const index = buildNameIndex(text, kind.namesOf, kind.shards);
    bytes += writeNameIndex(writeJson, path.join(base, kind.dir), region, date, index, dayFileSource(kind.type, region, date));
  }
  return bytes;
}

/** Borra las carpetas de fecha que ya no hacen falta (`keep(kind, fecha)` dice cuáles quedan). */
function pruneNameIndex(base, keep) {
  for (const kind of KINDS) {
    const dir = path.join(base, kind.dir);
    if (!fs.existsSync(dir)) continue;
    for (const date of fs.readdirSync(dir)) if (!keep(kind, date)) fs.rmSync(path.join(dir, date), { recursive: true, force: true });
  }
}

/** Una fila por ventana, sin los ceros de más: [k, m, a, famaK, famaM, daño, cura]. */
const nums = (v) => (v ? v.slice(0, 7) : null);
const hasActivity = (v) => v && (v[0] || v[1] || v[2]);

/** `series`: { desde: fecha, guilds: { gremio: [[kills, muertes, famaKill] por día] } } (opcional).
 * `bestDay`: { jugador: [kills, muertes, daño] } — su mejor día de la ventana `w` (opcional).
 * `meta`: campos de cabecera de cada parte (`until` del índice, `date`/`yDate` de hoy). */
function writeShards(dir, region, windows, rivals, series, bestDay, meta = {}) {
  // Jugadores
  const pRecs = {};
  const names = new Set();
  for (const w of Object.values(windows)) for (const n of Object.keys(w.players)) names.add(n);
  for (const name of names) {
    const rec = { n: name };
    let guild = '';
    for (const [key, w] of Object.entries(windows)) {
      const v = w.players[name];
      if (hasActivity(v)) {
        rec[key] = nums(v);
        if (!guild && v[P.GUILD]) guild = v[P.GUILD];
        const x = compactExtras(w.px?.[name]);
        if (x) rec["x" + key] = x;
      }
    }
    if (guild) rec.g = guild;
    const bd = rec.w ? bestDay?.[name] : undefined;
    if (bd && (bd[0] || bd[1] || bd[2])) rec.bd = bd;
    if (Object.keys(rec).length > 2 || (Object.keys(rec).length === 2 && !rec.g)) pRecs[name.toLowerCase()] = rec;
  }
  // Directorio de ids: UN id por jugador (el de la ventana más reciente), de todos los que se vieron,
  // aunque no tengan actividad en la ventana. Va aparte de las estadísticas: buscar un id baja ~3 KB.
  const ids = {};
  for (const w of Object.values(windows).reverse()) for (const [name, id] of Object.entries(w.pids ?? {})) ids[name.toLowerCase()] = id;
  // Gremios
  const gRecs = {};
  const gNames = new Set();
  for (const w of Object.values(windows)) for (const n of Object.keys(w.guilds)) gNames.add(n);
  for (const name of gNames) {
    const rec = { n: name };
    for (const [key, w] of Object.entries(windows)) {
      if (w.guilds[name]) rec[key] = w.guilds[name];
      const members = topMembers(w.gm?.[name]);
      if (members.length) rec["x" + key] = members;
    }
    for (const [key, map] of Object.entries(rivals ?? {})) if (map[name]) rec[key] = map[name];
    if (series?.guilds[name]) rec.sm = series.guilds[name];
    const id = Object.values(windows).find((w) => w.ids?.[name])?.ids[name];
    if (id) rec.id = id;
    gRecs[name.toLowerCase()] = rec;
  }
  const builtAt = new Date().toISOString();
  const gHead = series ? { smFrom: series.from } : {};
  let bytes = 0;
  const spread = (recs, count) => {
    const shards = Array.from({ length: count }, () => ({}));
    for (const [key, rec] of Object.entries(recs)) shards[shardOf(key, count)][key] = rec;
    return shards;
  };
  const write = (sub, shards, field, head = {}) => {
    // Sin restos de una corrida con otro número de partes.
    fs.rmSync(path.join(dir, region, sub), { recursive: true, force: true });
    shards.forEach((part, i) => (bytes += writeJson(path.join(dir, region, sub, `${i}.json`), { v: 1, region, builtAt, ...meta, ...head, [field]: part })));
  };
  write('players', spread(pRecs, PLAYER_SHARDS), 'players');
  write('guilds', spread(gRecs, GUILD_SHARDS), 'guilds', gHead);
  write('ids', spread(ids, ID_SHARDS), 'ids');
  // Formato viejo (256/32 partes con el id dentro): sin testers todavía, ya no se publica (parte 59).
  fs.rmSync(path.join(dir, region, 'p'), { recursive: true, force: true });
  fs.rmSync(path.join(dir, region, 'g'), { recursive: true, force: true });
  return { players: names.size, guilds: gNames.size, ids: Object.keys(ids).length, bytes };
}

async function hourly(region) {
  const stats = { bytes: 0, retries: 0 };
  const today = day();
  const yesterday = day(-1);
  const files = await dayFiles(region, today, stats);
  if (files.killsText === null && files.battlesText === null) throw new Error(`sin archivos de hoy (${today})`);
  const r = buildDayRollup(files);
  // Ayer, mientras la corrida diaria todavía no lo cerró en el índice (de 00:00 a ~01:30 UTC): sin
  // esto, 7 días / 30 días / temporada / todo perdían un día entero en ese rato (índice hasta
  // anteayer + hoy). Va como ventana `y` con su fecha; la app la suma solo si el índice no la cubre.
  const indexUntil = readJson(path.join(here, 'index', region, 'weapons.json'), null)?.until ?? null;
  let yesterdayFiles = null;
  let ry = null;
  if (typeof indexUntil === 'string' && indexUntil < yesterday) {
    yesterdayFiles = await dayFiles(region, yesterday, stats);
    if (yesterdayFiles.killsText !== null || yesterdayFiles.battlesText !== null) ry = buildDayRollup(yesterdayFiles);
  }
  const out = writeShards(
    path.join(here, 'today'),
    region,
    ry ? { d: r, y: ry } : { d: r },
    { rd: rivalsByGuild(r.rivals, 5, r.ids) },
    undefined,
    undefined,
    ry ? { date: today, yDate: yesterday } : { date: today },
  );
  writeJson(path.join(here, 'today', region, 'weapons.json'), { v: 1, region, date: today, builtAt: new Date().toISOString(), d: r.weapons });
  // Índice por nombre de hoy, y de ayer mientras el scraper todavía le agrega (hasta que cierre y
  // lo indexe la corrida diaria). Con los textos ya bajados para el resumen: no se baja dos veces.
  const base = path.join(here, 'today', region);
  const keepYesterday = !daySettled(yesterday);
  pruneNameIndex(base, (_kind, date) => date === today || (keepYesterday && date === yesterday));
  let nameIndexBytes = await indexDay(base, region, today, stats, { kills: files.killsText, battles: files.battlesText });
  if (keepYesterday)
    nameIndexBytes += await indexDay(base, region, yesterday, stats, yesterdayFiles ? { kills: yesterdayFiles.killsText, battles: yesterdayFiles.battlesText } : {});
  return { date: today, ...(ry ? { yesterdayWindow: yesterday } : {}), ...out, nameIndexBytes, downloadedMB: Math.round(stats.bytes / 1e5) / 10, retries: stats.retries, badLines: r.badLines };
}

async function daily(region) {
  const stats = { bytes: 0, retries: 0 };
  const yesterday = day(-1);
  const rollupPath = (d) => path.join(here, 'rollups', region, `${d}.json.gz`);
  // 1) Días cerrados que falten (primero los más recientes: lo que más se mira).
  // También los días con kills repetidas hechos antes de deduplicar (`dd`): se rehacen enteros.
  const grown = await grownDays(region, yesterday, rollupPath);
  const missing = dateList(FIRST_DAY, yesterday)
    .filter((d) => {
      const r = readJson(rollupPath(d), null);
      return (r?.v ?? 0) < ROLLUP_VERSION || (d >= DEDUP_FIRST_DAY && r?.dd !== 1) || grown.includes(d);
    })
    .reverse();
  // Su índice por nombre también se rehace (paso 3): las líneas nuevas quedaban fuera.
  for (const d of grown) {
    for (const kind of KINDS) fs.rmSync(path.join(here, 'index', region, kind.dir, d), { recursive: true, force: true });
  }
  let built = 0;
  const builtDates = [];
  const empty = [];
  for (const d of missing.slice(0, maxDays)) {
    const r = await dayRollup(region, d, stats);
    if (!r) {
      empty.push(d);
      continue;
    }
    const { badLines, ...data } = r;
    // Resúmenes v1 (sin extras) se rehacen de a poco, los más recientes primero; mientras tanto la
    // ventana usa el v1 que ya había (cuenta igual kills y muertes, solo le faltan los extras).
    writeJson(rollupPath(d), { region, date: d, ...data, v: ROLLUP_VERSION, dd: 1, badLines });
    built += 1;
    builtDates.push(d);
  }
  // 1b) Campos nuevos (parte 58) en resúmenes hechos antes, sin rehacer el día entero:
  //   - pids (ids de jugadores) en los últimos 29 días: solo baja el archivo de kills; las ventanas de
  //     7 y 30 días los traen (Todo/Temporada no hacen falta para abrir un perfil).
  //   - p (piezas) desde que hay equipo completo (29/09): baja kills + equipo y marca `pv`. Esos días
  //     entran en builtDates para que Todo y Temporada se rehagan UNA vez con las piezas.
  const recentDays = new Set(dateList(day(-29), yesterday));
  const patchTodo = dateList(PIECES_FIRST_DAY, yesterday)
    .concat([...recentDays])
    .filter((d, i, all) => d >= FIRST_DAY && all.indexOf(d) === i)
    .filter((d) => {
      const r = readJson(rollupPath(d), null);
      return r && ((recentDays.has(d) && !r.pids) || (d >= PIECES_FIRST_DAY && r.pv !== 1));
    })
    .sort()
    .reverse();
  let patched = 0;
  for (const d of patchTodo.slice(0, maxDays)) {
    const r = readJson(rollupPath(d), null);
    const killsText = await fetchDayFile('kills', region, d, stats);
    const next = { ...r };
    if (!r.pids) next.pids = killsText === null ? {} : pidsFromKills(killsText);
    if (d >= PIECES_FIRST_DAY && r.pv !== 1) {
      const equipmentText = await fetchDayFile('equipment', region, d, stats);
      const pieces = killsText === null || equipmentText === null ? {} : piecesFromDay({ killsText, equipmentText });
      next.px = { ...r.px };
      for (const [name, p] of Object.entries(pieces)) if (next.px[name]) next.px[name] = { ...next.px[name], p };
      next.pv = 1;
      builtDates.push(d);
    }
    writeJson(rollupPath(d), next);
    patched += 1;
  }
  // 2) Ventanas (hasta ayer; la app suma el `today/` para que terminen hoy).
  const load = (days) => dateList(days[0], days[1]).map((d) => readJson(rollupPath(d), null)).filter(Boolean);
  const range = (n) => [day(-n), yesterday];
  const seasonStart = typeof config.seasonStart === 'string' && config.seasonStart >= FIRST_DAY ? config.seasonStart : null;
  const weekRollups = load(range(6));
  // "Todo" y "Temporada" crecen cada día: acumulado incremental en `index/<región>/_acc/` (rama que
  // se reescribe con un solo commit) en vez de cargar todos los días en memoria (ver advanceAccumulator).
  const loadDays = (dates) => dates.map((d) => readJson(rollupPath(d), null)).filter(Boolean);
  const accumulated = (key, from) => {
    const file = path.join(here, 'index', region, '_acc', `${key}.json.gz`);
    const { data, acc, rebuilt } = advanceAccumulator(readJson(file, null), {
      from,
      until: yesterday,
      rollupVersion: ROLLUP_VERSION,
      rebuiltDates: builtDates,
      loadDays,
      dateList,
    });
    writeJson(file, acc);
    accRebuilt[key] = rebuilt;
    return data;
  };
  const accRebuilt = {};
  const windows = {
    w: mergeRollups(weekRollups), // 6 cerrados + hoy = 7 días
    m: mergeRollups(load(range(29))), // 29 cerrados + hoy = 30 días
    a: accumulated('a', FIRST_DAY),
  };
  if (seasonStart) windows.s = accumulated('s', seasonStart);
  const rivals = { rm: rivalsByGuild(windows.m.rivals, 10, windows.a.ids), ra: rivalsByGuild(windows.a.rivals, 10, windows.a.ids) };
  // Serie diaria de los últimos 29 días cerrados por gremio (la gráfica del perfil del gremio): así
  // el teléfono no baja 30 archivos de peleas de ~6 MB para dibujarla.
  const seriesDays = dateList(day(-29), yesterday);
  const dayRollups = seriesDays.map((d) => readJson(rollupPath(d), null));
  const seriesGuilds = {};
  for (const name of Object.keys(windows.m.guilds)) {
    seriesGuilds[name] = dayRollups.map((r) => {
      const g = r?.guilds?.[name];
      return g ? [g[0], g[1], g[2]] : [0, 0, 0];
    });
  }
  const out = writeShards(path.join(here, 'index'), region, windows, rivals, { from: seriesDays[0], guilds: seriesGuilds }, bestDayByPlayer(weekRollups), {
    until: yesterday,
    // Desde cuándo cuentan "Todo" y "Temporada": la app rotula hasta dónde llega cada total.
    first: FIRST_DAY,
    ...(seasonStart ? { seasonStart } : {}),
  });
  writeJson(path.join(here, 'index', region, 'weapons.json'), {
    v: 1,
    region,
    until: yesterday,
    builtAt: new Date().toISOString(),
    w: windows.w.weapons,
    m: windows.m.weapons,
    ...(windows.s ? { s: windows.s.weapons } : {}),
    a: windows.a.weapons,
  });
  // 3) Índice por nombre de los días cerrados que falten (normalmente solo ayer), y poda.
  const base = path.join(here, 'index', region);
  const recent = (kind) => dateList(day(-kind.days), yesterday).filter((d) => d >= FIRST_DAY && daySettled(d));
  pruneNameIndex(base, (kind, date) => recent(kind).includes(date));
  let nameIndexBytes = 0;
  let nameIndexBuilt = 0;
  let nameIndexPending = 0;
  for (const kind of KINDS) {
    const todo = recent(kind).filter((d) => !hasNameIndex(base, kind, d)).reverse();
    for (const d of todo.slice(0, maxDays)) {
      nameIndexBytes += await indexDay(base, region, d, stats, {}, [kind]);
      nameIndexBuilt += 1;
    }
    nameIndexPending += Math.max(0, todo.length - maxDays);
  }
  const have = dateList(FIRST_DAY, yesterday).filter((d) => readJson(rollupPath(d), null) !== null).length;
  return {
    until: yesterday,
    seasonStart,
    daysBuiltNow: built,
    daysWithData: have,
    daysPending: Math.max(0, missing.length - maxDays),
    grownDays: grown,
    patched,
    pidsPending: Math.max(0, patchTodo.length - maxDays),
    nameIndexBuilt,
    nameIndexPending,
    nameIndexBytes,
    daysWithoutFiles: empty,
    accRebuilt,
    ...out,
    downloadedMB: Math.round(stats.bytes / 1e5) / 10,
    retries: stats.retries,
  };
}

const dir = mode === 'daily' ? 'index' : 'today';
const previous = readJson(path.join(here, dir, 'status.json'), { regions: {} });
const statusFile = { mode, generatedAt: new Date().toISOString(), regions: { ...previous.regions } };
let failures = 0;
for (const region of regions) {
  const t0 = Date.now();
  try {
    const result = await (mode === 'daily' ? daily(region) : hourly(region));
    statusFile.regions[region] = { ok: true, at: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), ...result };
    console.log(`[${region}] ${JSON.stringify(statusFile.regions[region])}`);
  } catch (err) {
    failures += 1;
    const last = previous.regions?.[region] ?? {};
    statusFile.regions[region] = { ...last, ok: false, failedAt: new Date().toISOString(), error: String(err?.message ?? err).slice(0, 300) };
    console.error(`[${region}] FALLÓ: ${err?.message ?? err}`);
  }
}
writeJson(path.join(here, dir, 'status.json'), statusFile);
if (failures === regions.length) process.exit(1);
