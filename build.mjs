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

import { advanceAccumulator, bestDayByPlayer, buildDayRollup, dayOutcome, DEDUP_FIRST_DAY, FIGHT_DAYS, hasCombatAssist, hasLootAssist, publishCombatAssist, thousands, LOOT_ASSIST_VERSION, LOOT_FIRST_DAY, lootWindows, publishGuildLoot, rollupVersionFor, shardFights, gearFromDay, pidsFromKills, PIECES_VERSION, compactExtras, mergeRollups, P, rivalsByGuild, ROLLUP_VERSION, shardOf, topMembers } from './lib/rollup.mjs';
import { dateList, dayFileBaseBytes, dayFileSize, dayFileSource, fetchDayFile, FIRST_DAY } from './lib/sources.mjs';
import { readJson, readJsonParts, writeJson, writeJsonParts } from './lib/store.mjs';
import { closedLootPeriods, lootOfRollup, mondayOf, monthStartOf } from './lib/rank-loot.mjs';

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
/** Chat 167: tope de tiempo rehaciendo días, por región. El 5-nov, 25 días recientes por región pasaron de 62 min, el
 * trabajo se cortó y no se publicó nada (ni lo de hoy). Lo que no alcance queda para la próxima corrida. */
const DAY_BUILD_BUDGET_MS = 20 * 60_000;
/** Primer día con equipo completo (ítem con tier y encantamiento) en el archivo de equipo. */
const PIECES_FIRST_DAY = '2026-09-29';

const args = process.argv.slice(2);
// Parte 137: `node build.mjs meta` = Meta Armory desde el escáner (lib/meta-run.mjs). Va aparte: no usa la temporada
// ni las carpetas `today`/`index`.
if (args[0] === 'meta') {
  const { runMeta, META_REGIONS } = await import('./lib/meta-run.mjs');
  const only = args.includes('--region') ? [args[args.indexOf('--region') + 1]] : META_REGIONS;
  process.exit(await runMeta({ root: here, regions: only }));
}
// Parte 138: `node build.mjs rankings` = Rankings de kills con el acumulador de las funciones (lib/rankings-run.mjs).
if (args[0] === 'rankings') {
  const { runRankings, RANKINGS_REGIONS } = await import('./lib/rankings-run.mjs');
  const only = args.includes('--region') ? [args[args.indexOf('--region') + 1]] : RANKINGS_REGIONS;
  const at = args.includes('--now') ? new Date(args[args.indexOf('--now') + 1]) : new Date();
  process.exit(await runRankings({ root: here, regions: only, now: at }));
}
// Chat 175: `node build.mjs meta-rescue` = recupera de la API las kills de Meta que se perdieron en la primera carga
// (29-sep, antes de que el escáner guardara el equipo). Despacio y con tope por corrida (lib/meta-rescue.mjs).
if (args[0] === 'meta-rescue') {
  const { runMetaRescue, RESCUE_REGIONS } = await import('./lib/meta-rescue.mjs');
  const only = args.includes('--region') ? [args[args.indexOf('--region') + 1]] : RESCUE_REGIONS;
  process.exit(await runMetaRescue({ root: here, regions: only }));
}
// Chat 175: `node build.mjs loot` = botín y perdido de las filas de Rankings (lib/rank-loot-run.mjs). Al final de la
// corrida: usa lo que dejaron la horaria, Rankings y la diaria.
if (args[0] === 'loot') {
  const { runRankLoot, RANK_LOOT_REGIONS } = await import('./lib/rank-loot-run.mjs');
  const only = args.includes('--region') ? [args[args.indexOf('--region') + 1]] : RANK_LOOT_REGIONS;
  const at = args.includes('--now') ? new Date(args[args.indexOf('--now') + 1]) : new Date();
  process.exit(await runRankLoot({ root: here, regions: only, now: at }));
}
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
 * del escáner agrega kills recuperadas al día de cada una, aunque ese día ya haya cerrado).
 * Auditoría p60: 8 días (lo que cubre el índice por nombre; antes 3 y el relleno puede tardar más), y
 * un día que quedó con 0 bytes de kills (fallo de red al cerrarlo) también se rehace si ahora tiene. */
const GROWTH_CHECK_DAYS = 8;
async function grownDays(region, yesterday, rollupPath) {
  const out = [];
  for (const d of dateList(day(-GROWTH_CHECK_DAYS), yesterday)) {
    const r = readJson(rollupPath(d), null);
    if (!r || typeof r.kb !== 'number') continue;
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
    let text = texts[kind.type] !== undefined ? texts[kind.type] : await fetchDayFile(kind.type, region, date, stats);
    if (text === null) continue; // ese día no tiene archivo: sin índice, la app usa el método de siempre
    // Parte 136: si el día tiene partes `.2`, `.3`..., el índice se arma solo con el archivo de siempre: guarda
    // posiciones dentro de ESE archivo (la app pide esos bytes a esa dirección).
    const baseLen = dayFileBaseBytes(kind.type, region, date);
    if (baseLen !== undefined) text = Buffer.from(text, 'utf8').subarray(0, baseLen).toString('utf8');
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
  // Ventanas con la plata completa: `meta.lootWindows` en el índice; hoy y ayer siempre (salen enteros de los archivos).
  const hasLoot = (key) => !meta.lootWindows || meta.lootWindows.includes(key);
  // Chat 177: ¿la ventana trae la plata y los conteos por asistencia de TODOS sus días? (perfiles con filtros).
  const assistOf = (w) => ({ loot: hasLootAssist(w), combat: hasCombatAssist(w) });
  // Jugadores: agrupados por parte y escritos de a una (parte 90: antes se armaban los registros de
  // TODOS los jugadores juntos y la diaria de Américas pasaba los 4 GB; ahora vive una parte por vez).
  const names = new Set();
  for (const w of Object.values(windows)) for (const n of Object.keys(w.players)) names.add(n);
  const namesByShard = Array.from({ length: PLAYER_SHARDS }, () => []);
  for (const name of names) namesByShard[shardOf(name.toLowerCase(), PLAYER_SHARDS)].push(name);
  const playerRec = (name) => {
    const rec = { n: name };
    let guild = '';
    for (const [key, w] of Object.entries(windows)) {
      const v = w.players[name];
      if (hasActivity(v)) {
        rec[key] = nums(v);
        if (!guild && v[P.GUILD]) guild = v[P.GUILD];
        const x = compactExtras(w.px?.[name], w.gw === true || (w.pv ?? 0) >= PIECES_VERSION, hasLoot(key), assistOf(w));
        if (x) rec["x" + key] = x;
      }
    }
    if (guild) rec.g = guild;
    const bd = rec.w ? bestDay?.[name] : undefined;
    if (bd && (bd[0] || bd[1] || bd[2])) rec.bd = bd;
    return Object.keys(rec).length > 2 || (Object.keys(rec).length === 2 && !rec.g) ? rec : null;
  };
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
      if (w.gx?.[name]) rec["z" + key] = w.gx[name];
      if (hasLoot(key) && w.gl?.[name]) rec["v" + key] = publishGuildLoot(w.gl[name]);
      // Chat 177: plata (`q`, en miles) y kills/muertes/fama (`k`, fama en miles) por asistencia: 1v1, 1-5, 6+, 10+, ZvZ.
      const gla = w.gla?.[name];
      if (hasLoot(key) && hasLootAssist(w) && gla?.some((n) => thousands(n) > 0)) rec["q" + key] = gla.map(thousands);
      const gka = w.gka?.[name];
      if (hasCombatAssist(w) && gka?.some((n, i) => i < 10 && n > 0)) rec["k" + key] = publishCombatAssist(gka);
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
  fs.rmSync(path.join(dir, region, 'players'), { recursive: true, force: true });
  namesByShard.forEach((list, i) => {
    const part = {};
    for (const name of list) {
      const rec = playerRec(name);
      if (rec) part[name.toLowerCase()] = rec;
    }
    bytes += writeJson(path.join(dir, region, 'players', `${i}.json`), { v: 1, region, builtAt, ...meta, players: part });
  });
  write('guilds', spread(gRecs, GUILD_SHARDS), 'guilds', gHead);
  write('ids', spread(ids, ID_SHARDS), 'ids');
  // Formato viejo (256/32 partes con el id dentro): sin testers todavía, ya no se publica (parte 59).
  fs.rmSync(path.join(dir, region, 'p'), { recursive: true, force: true });
  fs.rmSync(path.join(dir, region, 'g'), { recursive: true, force: true });
  return { players: names.size, guilds: gNames.size, ids: Object.keys(ids).length, bytes };
}

/** Publica las peleas con plata de un día (ver `fl` en lib/rollup.mjs) y devuelve las peleas escritas. */
function writeFights(base, date, fl) {
  const dir = path.join(base, 'fights', date);
  fs.rmSync(dir, { recursive: true, force: true });
  const shards = shardFights(fl);
  for (const [n, f] of Object.entries(shards)) writeJson(path.join(dir, `${n}.json`), { v: 1, date, f });
  return Object.keys(fl ?? {}).length;
}

/** Borra los días de peleas que ya no hacen falta. */
function pruneFights(base, keep) {
  const dir = path.join(base, 'fights');
  if (!fs.existsSync(dir)) return;
  for (const date of fs.readdirSync(dir)) if (!keep(date)) fs.rmSync(path.join(dir, date), { recursive: true, force: true });
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
  // Chat 175: botín y perdido de hoy (y de ayer mientras la diaria no lo cierra) para `build.mjs loot`. Interno.
  writeJson(path.join(here, 'today', region, '_loot-today.json'), {
    date: today,
    d: lootOfRollup(r),
    y: ry ? { date: yesterday, ...lootOfRollup(ry) } : null,
  });
  const todayBase = path.join(here, 'today', region);
  pruneFights(todayBase, (date) => date === today || (ry && date === yesterday));
  writeFights(todayBase, today, r.fl);
  if (ry) writeFights(todayBase, yesterday, ry.fl);
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
      return (r?.v ?? 0) < rollupVersionFor(d) || (d >= DEDUP_FIRST_DAY && r?.dd !== 1) || grown.includes(d);
    })
    .reverse();
  // Su índice por nombre también se rehace (paso 3): las líneas nuevas quedaban fuera.
  for (const d of grown) {
    for (const kind of KINDS) fs.rmSync(path.join(here, 'index', region, kind.dir, d), { recursive: true, force: true });
  }
  let built = 0;
  const builtDates = [];
  const empty = [];
  const retry = [];
  const kept = [];
  const buildStart = Date.now();
  let tried = 0;
  for (const d of missing.slice(0, maxDays)) {
    if (Date.now() - buildStart > DAY_BUILD_BUDGET_MS) break;
    tried += 1;
    const failedBefore = stats.failed ?? 0;
    const r = await dayRollup(region, d, stats);
    const outcome = dayOutcome({ failed: (stats.failed ?? 0) > failedBefore, next: r, prev: readJson(rollupPath(d), null) });
    if (outcome !== 'write') {
      (outcome === 'retry' ? retry : outcome === 'keep' ? kept : empty).push(d);
      continue;
    }
    const { badLines, fl, ...data } = r;
    if (d >= day(-FIGHT_DAYS)) writeFights(path.join(here, 'index', region), d, fl);
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
  // Auditoría p86 S1: un `pids` vacío es de una descarga que falló (antes se marcaba `{}` y el día no se
  // completaba nunca); se reintenta como si faltara.
  const lacksPids = (r) => !r.pids || !Object.keys(r.pids).length;
  const patchTodo = dateList(FIRST_DAY, yesterday)
    .concat([...recentDays])
    .filter((d, i, all) => d >= FIRST_DAY && all.indexOf(d) === i)
    .filter((d) => {
      const r = readJson(rollupPath(d), null);
      return r && ((recentDays.has(d) && lacksPids(r)) || (d >= PIECES_FIRST_DAY && (r.pv ?? 0) < PIECES_VERSION) || !hasLootAssist({ ...r, date: d }) || !hasCombatAssist({ ...r, date: d }));
    })
    .sort()
    .reverse();
  let patched = 0;
  for (const d of patchTodo.slice(0, maxDays)) {
    const r = readJson(rollupPath(d), null);
    const killsText = await fetchDayFile('kills', region, d, stats);
    const next = { ...r };
    if (lacksPids(r) && killsText !== null) next.pids = pidsFromKills(killsText);
    if (d >= PIECES_FIRST_DAY && (r.pv ?? 0) < PIECES_VERSION) {
      // Parte 65: el equipo del día con usos y victorias (w, b y p de la MISMA pasada, mismo criterio
      // que un día nuevo). Una sola vez por día: queda marcado `pv: 2`.
      // Si un archivo no llegó (fetchDayFile ya reintentó 4 veces), el día NO se marca: se completa
      // en la próxima corrida en vez de quedar sin victorias para siempre (un 404 es un solo pedido).
      const equipmentText = killsText === null ? null : await fetchDayFile('equipment', region, d, stats);
      if (killsText !== null && equipmentText !== null) {
        const gear = gearFromDay({ killsText, equipmentText });
        next.px = { ...r.px };
        for (const [name, g] of Object.entries(gear)) if (next.px[name]) next.px[name] = { ...next.px[name], ...g };
        next.pv = PIECES_VERSION;
        builtDates.push(d);
      }
    }
    if (!hasLootAssist({ ...r, date: d }) || !hasCombatAssist({ ...r, date: d })) {
      // Chat 176: la plata por asistencia del día, con el MISMO cálculo que un día nuevo (buildDayRollup entero: los
      // cortes de pelea necesitan las kills y el archivo de peleas). Solo se copian `la` y `gla`; lo demás del resumen
      // no se toca. Si un archivo no llegó, el día sigue pendiente (la próxima corrida lo reintenta).
      // Chat 177: los días de antes de la plata (25-jul…28-sep) solo necesitan los conteos (`ka`/`gka`): sin equipo, y un
      // archivo de peleas que no existe (404) no lo frena; solo una descarga que FALLÓ deja el día pendiente.
      const withLoot = d >= LOOT_FIRST_DAY;
      const failedBefore = stats.failed ?? 0;
      const equipmentText = killsText === null || !withLoot ? null : await fetchDayFile('equipment', region, d, stats);
      const battlesText = killsText === null ? null : await fetchDayFile('battles', region, d, stats);
      const complete = killsText !== null && (stats.failed ?? 0) === failedBefore && (withLoot ? equipmentText !== null && battlesText !== null : true);
      if (complete) {
        const full = buildDayRollup({ killsText, battlesText, equipmentText });
        next.px = { ...(next.px ?? r.px) };
        for (const [name, x] of Object.entries(full.px)) {
          const la = withLoot && x.la ? { la: x.la } : {};
          if (!next.px[name] || (!la.la && !x.ka)) continue;
          next.px[name] = { ...next.px[name], ...la, ...(x.ka ? { ka: x.ka } : {}) };
        }
        if (withLoot) {
          next.gla = full.gla;
          next.lav = LOOT_ASSIST_VERSION;
        }
        next.gka = full.gka;
        next.kav = 1;
        if (!builtDates.includes(d)) builtDates.push(d);
      }
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
    // Parte 136: en partes (`readJsonParts`/`writeJsonParts`, ver lib/store.mjs): el de un solo archivo iba a
    // pasar el tope de texto de V8 y los 100 MiB de GitHub. Si todavía no hay partes, se lee el archivo viejo.
    const file = path.join(here, 'index', region, '_acc', `${key}.json.gz`);
    const partsBase = path.join(here, 'index', region, '_acc', key);
    const parts = readJsonParts(partsBase, null, (m) => console.warn(`[${region}] ${m}`));
    const prev = parts === undefined ? readJson(file, null) : parts && { ...parts.head, data: parts.data };
    const { data, acc, rebuilt } = advanceAccumulator(prev, {
      from,
      until: yesterday,
      rollupVersion: ROLLUP_VERSION,
      rebuiltDates: builtDates,
      loadDays,
      loadDay: (d) => readJson(rollupPath(d), null),
      dateList,
    });
    // Auditoría Muse p92 H4: el acumulado crece con los jugadores DISTINTOS vistos (no con los días) y nada lo
    // poda; se registra cuánto pesa y a cuántos cubre para ver venir un OOM con datos (decidir el tope con la serie).
    const { data: accData, ...accHead } = acc;
    const written = writeJsonParts(partsBase, accHead, accData, { legacyFile: file });
    accSize[key] = {
      bytes: written.bytes,
      parts: written.parts,
      maxPartBytes: written.maxPartBytes,
      players: Object.keys(data?.players ?? {}).length,
      guilds: Object.keys(data?.guilds ?? {}).length,
    };
    accRebuilt[key] = rebuilt;
    return data;
  };
  const accRebuilt = {};
  const accSize = {};
  // Chat 175: botín de cada día de la semana y el mes de calendario en curso (para ordenar Rankings por botín). Solo se
  // guarda la plata (chica); los resúmenes siguen el camino de siempre.
  let monthRollups = load(range(29));
  const lootFrom = [mondayOf(yesterday), monthStartOf(yesterday)].sort()[0];
  const dayLoot = {};
  for (const r of monthRollups) if (r.date >= lootFrom) dayLoot[r.date] = lootOfRollup(r);
  for (const d of dateList(lootFrom, yesterday)) {
    if (dayLoot[d]) continue;
    const r = readJson(rollupPath(d), null);
    if (r) dayLoot[d] = lootOfRollup(r);
  }
  const windows = {
    w: mergeRollups(weekRollups), // 6 cerrados + hoy = 7 días
    m: mergeRollups(monthRollups), // 29 cerrados + hoy = 30 días
  };
  // Chat 177 (dueño, 8-nov: «el período de los perfiles igual que Rankings»): Semana desde el lunes y Mes desde el día 1
  // del día de HOY (la app les suma hoy), en ventanas NUEVAS `c` y `o`: la 2.61.0 y la 2.61.1 leen `w`/`m` como 7 y 30
  // días y no cambian. El lunes o el día 1 todavía no hay días cerrados: la ventana no va y la app usa solo hoy.
  const today = day();
  const calendar = { c: mondayOf(today), o: monthStartOf(today) };
  const byDate = new Map(monthRollups.map((r) => [r.date, r]));
  for (const [key, from] of Object.entries(calendar)) {
    if (from > yesterday) continue;
    windows[key] = mergeRollups(dateList(from, yesterday).map((d) => byDate.get(d) ?? readJson(rollupPath(d), null)).filter(Boolean));
  }
  // Los 29 días ya no hacen falta: se sueltan ANTES de los acumulados (la diaria ya usa ~7,4 GB de 12; chat 177).
  byDate.clear();
  monthRollups = null;
  windows.a = accumulated('a', FIRST_DAY);
  if (seasonStart) windows.s = accumulated('s', seasonStart);
  const rivals = { rm: rivalsByGuild(windows.m.rivals, 10, windows.a.ids), ra: rivalsByGuild(windows.a.rivals, 10, windows.a.ids) };
  // Serie diaria de los últimos 29 días cerrados por gremio (la gráfica del perfil del gremio): así
  // el teléfono no baja 30 archivos de peleas de ~6 MB para dibujarla.
  const seriesDays = dateList(day(-29), yesterday);
  const seriesNames = Object.keys(windows.m.guilds);
  const seriesGuilds = {};
  for (const name of seriesNames) seriesGuilds[name] = [];
  for (const d of seriesDays) {
    const guilds = readJson(rollupPath(d), null)?.guilds;
    for (const name of seriesNames) {
      const g = guilds?.[name];
      seriesGuilds[name].push(g ? [g[0], g[1], g[2]] : [0, 0, 0]);
    }
  }
  // Días que todavía no tienen la plata: los que no se alcanzaron y los que fallaron en esta corrida.
  const lootPending = [...missing.slice(tried), ...retry];
  const lootReady = lootWindows({ w: day(-6), m: day(-29), ...calendar, ...(seasonStart ? { s: seasonStart } : {}), a: FIRST_DAY }, lootPending);
  // Chat 175: días cerrados de Semana, Mes, Temporada y Todo, para `build.mjs loot`. Interno. Solo los períodos con la
  // plata completa (`lootReady`): uno con días por rehacer no se publica.
  writeJson(
    path.join(here, 'index', region, '_loot.json.gz'),
    closedLootPeriods({ until: yesterday, dayLoot, windows, seasonStart, firstDay: FIRST_DAY, ready: lootReady }),
  );
  const out = writeShards(path.join(here, 'index'), region, windows, rivals, { from: seriesDays[0], guilds: seriesGuilds }, bestDayByPlayer(weekRollups), {
    until: yesterday,
    // Desde cuándo cuentan "Todo" y "Temporada": la app rotula hasta dónde llega cada total.
    first: FIRST_DAY,
    // Chat 177: primer día de Semana (`c`) y Mes (`o`) de calendario; la app los usa solo si coinciden con los suyos.
    cal: calendar,
    ...(seasonStart ? { seasonStart } : {}),
    lootWindows: lootReady,
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
  pruneFights(base, (date) => date >= day(-FIGHT_DAYS));
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
    daysPending: lootPending.length,
    daysRetry: retry,
    daysKept: kept,
    lootWindows: lootReady,
    grownDays: grown,
    patched,
    pidsPending: Math.max(0, patchTodo.length - maxDays),
    nameIndexBuilt,
    nameIndexPending,
    nameIndexBytes,
    daysWithoutFiles: empty,
    accRebuilt,
    accSize,
    // Pico real de memoria del proceso hasta acá (MB): con 12 GB de tope en la diaria (parte 89).
    maxRssMB: Math.round(process.resourceUsage().maxRSS / 1024),
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
