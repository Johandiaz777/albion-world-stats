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
//   index/<region>/p/<n>.json         jugadores por parte (256 partes por hash del nombre)
//   index/<region>/g/<n>.json         gremios por parte (32 partes) con sus rivales
//   index/<region>/weapons.json       armas: kills y muertes por ventana
//   today/<region>/p|g/<n>.json       lo mismo, solo de hoy (se rehace cada hora)
//   index/status.json, today/status.json  salud por región para el panel
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildDayRollup, compactExtras, mergeRollups, P, rivalsByGuild, ROLLUP_VERSION, shardOf, topMembers } from './lib/rollup.mjs';
import { dateList, fetchDayFile, FIRST_DAY } from './lib/sources.mjs';
import { readJson, writeJson } from './lib/store.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REGIONS = ['europe', 'americas', 'asia'];
export const PLAYER_SHARDS = 256;
export const GUILD_SHARDS = 32;
const MAX_BACKFILL_DAYS = 25; // días cerrados nuevos por región y corrida (el resto, la próxima)

const args = process.argv.slice(2);
const mode = args[0] === 'daily' ? 'daily' : 'hourly';
const argValue = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const regions = argValue('--region') ? [argValue('--region')] : REGIONS;
const maxDays = Number(argValue('--max-days') ?? MAX_BACKFILL_DAYS);
const config = readJson(path.join(here, 'config.json'), {});
const day = (offset = 0) => new Date(Date.now() + offset * 86400e3).toISOString().slice(0, 10);

async function dayRollup(region, date, stats) {
  const [killsText, battlesText, equipmentText] = await Promise.all([
    fetchDayFile('kills', region, date, stats),
    fetchDayFile('battles', region, date, stats),
    fetchDayFile('equipment', region, date, stats),
  ]);
  if (killsText === null && battlesText === null) return null;
  return buildDayRollup({ killsText, battlesText, equipmentText });
}

/** Una fila por ventana, sin los ceros de más: [k, m, a, famaK, famaM, daño, cura]. */
const nums = (v) => (v ? v.slice(0, 7) : null);
const hasActivity = (v) => v && (v[0] || v[1] || v[2]);

function writeShards(dir, region, windows, rivals) {
  // Jugadores
  const pShards = Array.from({ length: PLAYER_SHARDS }, () => ({}));
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
    if (Object.keys(rec).length > 2 || (Object.keys(rec).length === 2 && !rec.g)) pShards[shardOf(name, PLAYER_SHARDS)][name.toLowerCase()] = rec;
  }
  // Gremios
  const gShards = Array.from({ length: GUILD_SHARDS }, () => ({}));
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
    const id = Object.values(windows).find((w) => w.ids?.[name])?.ids[name];
    if (id) rec.id = id;
    gShards[shardOf(name, GUILD_SHARDS)][name.toLowerCase()] = rec;
  }
  const builtAt = new Date().toISOString();
  let bytes = 0;
  pShards.forEach((players, i) => (bytes += writeJson(path.join(dir, region, 'p', `${i}.json`), { v: 1, region, builtAt, players })));
  gShards.forEach((guilds, i) => (bytes += writeJson(path.join(dir, region, 'g', `${i}.json`), { v: 1, region, builtAt, guilds })));
  return { players: names.size, guilds: gNames.size, bytes };
}

async function hourly(region) {
  const stats = { bytes: 0, retries: 0 };
  const today = day();
  const r = await dayRollup(region, today, stats);
  if (!r) throw new Error(`sin archivos de hoy (${today})`);
  const out = writeShards(path.join(here, 'today'), region, { d: r }, { rd: rivalsByGuild(r.rivals, 5, r.ids) });
  writeJson(path.join(here, 'today', region, 'weapons.json'), { v: 1, region, date: today, builtAt: new Date().toISOString(), d: r.weapons });
  return { date: today, ...out, downloadedMB: Math.round(stats.bytes / 1e5) / 10, retries: stats.retries, badLines: r.badLines };
}

async function daily(region) {
  const stats = { bytes: 0, retries: 0 };
  const yesterday = day(-1);
  const rollupPath = (d) => path.join(here, 'rollups', region, `${d}.json.gz`);
  // 1) Días cerrados que falten (primero los más recientes: lo que más se mira).
  const missing = dateList(FIRST_DAY, yesterday).filter((d) => (readJson(rollupPath(d), null)?.v ?? 0) < ROLLUP_VERSION).reverse();
  let built = 0;
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
    writeJson(rollupPath(d), { region, date: d, ...data, v: ROLLUP_VERSION, badLines });
    built += 1;
  }
  // 2) Ventanas (hasta ayer; la app suma el `today/` para que terminen hoy).
  const load = (days) => dateList(days[0], days[1]).map((d) => readJson(rollupPath(d), null)).filter(Boolean);
  const range = (n) => [day(-n), yesterday];
  const seasonStart = typeof config.seasonStart === 'string' && config.seasonStart >= FIRST_DAY ? config.seasonStart : null;
  const windows = {
    w: mergeRollups(load(range(6))), // 6 cerrados + hoy = 7 días
    m: mergeRollups(load(range(29))), // 29 cerrados + hoy = 30 días
    a: mergeRollups(load([FIRST_DAY, yesterday])),
  };
  if (seasonStart) windows.s = mergeRollups(load([seasonStart, yesterday]));
  const rivals = { rm: rivalsByGuild(windows.m.rivals, 10, windows.a.ids), ra: rivalsByGuild(windows.a.rivals, 10, windows.a.ids) };
  const out = writeShards(path.join(here, 'index'), region, windows, rivals);
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
  const have = dateList(FIRST_DAY, yesterday).filter((d) => readJson(rollupPath(d), null) !== null).length;
  return {
    until: yesterday,
    seasonStart,
    daysBuiltNow: built,
    daysWithData: have,
    daysPending: Math.max(0, missing.length - maxDays),
    daysWithoutFiles: empty,
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
