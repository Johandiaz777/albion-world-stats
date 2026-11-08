// Botín y perdido de las filas de Rankings (chat 175, pedido del dueño el 8-nov: ordenar Kills, Fama, Muertes,
// Gremios, Top y Top G por «Botín», «Perdido» y «Profit», mayor o menor).
//
// Reglas que decidió el dueño:
//  - El orden SOLO reordena la lista que ya se ve, como hoy «Mejor/Peor K/D». No cambia cómo se arman los rankings,
//    no recalcula nada en las funciones y no suma lecturas a la app: 0 Firebase para el teléfono.
//  - Botín = lo que llevaba la víctima (`ve` + `vi` del escáner), ENTERO para quien dio el golpe final y su gremio, la
//    misma cuenta de `px.l` y `gl` de los resúmenes y del perfil («Botín estimado»). La API nombra como máximo 4
//    ayudantes por kill, así que un reparto no podría ser exacto.
//  - Perdido = lo que llevaba al morir. Profit = botín − perdido (lo calcula la app).
//
// Por qué los NOMBRES salen de las listas y no de un umbral: medido el 8-nov en Américas, ningún corte por actividad
// cubre las listas (con 34 mil jugadores, 99,8 %): las de 1 vs 1, 6+ o 10+ ayudas y las de fama traen jugadores con
// poca actividad total. Así que cada archivo publica exactamente los jugadores y gremios de las listas del período:
//  - Hoy y Semana: la copia exacta de Rankings que ya arma stats-builder cada hora (`rankingspub/`), 0 Firebase.
//  - Mes, Temporada y Todo: cambian una vez al día (la diaria de las 18:45 UTC). Se leen sus dos docs públicos
//    (`leaderboard_top/{región}_{período}` y `..._score`) una vez al día: 18 lecturas al día entre los 3 servidores.
//
// Las cifras salen de los mismos días de calendario del ranking (Semana = lunes a hoy, Mes = día 1 a hoy, en UTC):
//  - días cerrados: la corrida diaria las deja en `index/<región>/_loot.json.gz` (interno);
//  - ayer, mientras la diaria no lo cierra, y hoy: la horaria las deja en `today/<región>/_loot-today.json` (interno).
// Todo en miles de plata, como `lm` y `fl`. Funciones puras salvo `fetchTopDocNames` (red, con `fetchImpl`).

/** Primer día con plata en el archivo de equipo (= `LOOT_FIRST_DAY` de rollup.mjs). */
export const RANK_LOOT_FIRST_DAY = '2026-09-29';
/** El 29-sep el escáner empezó a guardar el equipo hacia las 14:00 UTC: ese día la plata está a medias. Un período que
 * empieza antes de este día lo dice en el archivo (`partial`) y la app lo avisa. */
export const RANK_LOOT_FULL_DAY = '2026-09-30';
export const RANK_LOOT_VERSION = 1;
export const RANK_LOOT_PERIODS = ['day', 'week', 'month', 'season', 'all'];
/** Hora (UTC) desde la que se vuelven a leer los nombres de Mes, Temporada y Todo: la diaria de las funciones corre a
 * las 18:45 y tarda ~2 min por servidor. */
export const NAMES_REFRESH_UTC = { hour: 18, minute: 55 };

const DAY_MS = 86_400_000;
const k = (silver) => Math.round((Number(silver) || 0) / 1000);
export const dateStr = (d) => d.toISOString().slice(0, 10);
export const addDays = (date, n) => dateStr(new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS));

/** Lunes (UTC) de la semana de `date` (YYYY-MM-DD), igual que `mondayOfWeekUTC` de las funciones. */
export function mondayOf(date) {
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDay();
  return addDays(date, (day === 0 ? -6 : 1) - day);
}
export const monthStartOf = (date) => `${date.slice(0, 7)}-01`;

// ---- Sumas ----

/** Botín y perdido (miles) de un resumen diario o de una ventana sumada: jugadores de `px.l`, gremios de `gl`
 * (botín = solo + grupo + zvz; perdido = lo mismo de lo perdido). Sin plata = no aparece. */
export function lootOfRollup(r) {
  const p = {};
  const g = {};
  for (const [name, x] of Object.entries(r?.px ?? {})) {
    const b = k(x?.l?.[0]);
    const l = k(x?.l?.[1]);
    if (b || l) p[name] = [b, l];
  }
  for (const [name, v] of Object.entries(r?.gl ?? {})) {
    if (!Array.isArray(v)) continue;
    const b = k((v[0] || 0) + (v[1] || 0) + (v[2] || 0));
    const l = k((v[3] || 0) + (v[4] || 0) + (v[5] || 0));
    if (b || l) g[name] = [b, l];
  }
  return { p, g };
}

/** Suma `part` en `into` (muta `into`). */
export function addLoot(into, part) {
  for (const side of ['p', 'g']) {
    const dst = (into[side] ??= {});
    for (const [name, [b, l]] of Object.entries(part?.[side] ?? {})) {
      const o = (dst[name] ??= [0, 0]);
      o[0] += b;
      o[1] += l;
    }
  }
  return into;
}

/**
 * Días cerrados de cada período, para la corrida diaria. `dayLoot` = { fecha: lootOfRollup(resumen) } de al menos la
 * semana y el mes en curso hasta `until` (ayer); `windows` = { s, a } ya sumadas (el acumulado de Temporada y Todo).
 * Cada período dice desde qué día y hasta cuál cuenta (`from`, `until`) para que la horaria sepa si le sirve.
 */
export function closedLootPeriods({ until, dayLoot, windows, seasonStart, firstDay, ready = null }) {
  // `ready` = `lootWindows` de la diaria: ventanas con la plata completa. Semana cabe en los 7 días (`w`) y Mes en los 30
  // (`m`); un período sin su ventana lista no se guarda y la horaria no lo publica (nunca una cifra de menos).
  const isReady = (w) => !ready || ready.includes(w);
  const weekFrom = mondayOf(until);
  const monthFrom = monthStartOf(until);
  const sumDays = (from) => {
    const out = { p: {}, g: {} };
    for (let d = from; d <= until; d = addDays(d, 1)) if (dayLoot[d]) addLoot(out, dayLoot[d]);
    return out;
  };
  const periods = {};
  if (isReady('w')) periods.week = { from: weekFrom, until, ...sumDays(weekFrom) };
  if (isReady('m')) periods.month = { from: monthFrom, until, ...sumDays(monthFrom) };
  if (isReady('a') && windows.a) periods.all = { from: firstDay, until, ...lootOfRollup(windows.a) };
  if (isReady('s') && seasonStart && windows.s) periods.season = { from: seasonStart, until, ...lootOfRollup(windows.s) };
  return { v: RANK_LOOT_VERSION, until, periods };
}

// ---- Nombres de las listas ----

/** Jugadores y gremios de las listas de un período de `rankingspub/<región>.json` (`day` o `week`). Las filas de
 * kills/fama/muertes traen `guild`; las de Top (`top*ScoreLocal`) traen `region`; los gremios no traen ninguno. */
export function namesFromRankingsPeriod(period) {
  const p = new Set();
  const g = new Set();
  for (const [key, rows] of Object.entries(period ?? {})) {
    if (!Array.isArray(rows) || !key.startsWith('top') || key.startsWith('topFameKills') || key.startsWith('topBattles')) continue;
    const guilds = key.startsWith('topGuild');
    for (const row of rows) if (row && typeof row.name === 'string') (guilds ? g : p).add(row.name);
  }
  return { p: [...p].sort(), g: [...g].sort() };
}

const restString = (v) => (v && typeof v.stringValue === 'string' ? v.stringValue : null);
const restArray = (v) => (Array.isArray(v?.arrayValue?.values) ? v.arrayValue.values : []);
const restNames = (v) => restArray(v).map((x) => restString(x?.mapValue?.fields?.name)).filter((n) => n !== null);

/** Nombres de un doc `leaderboard_top/{región}_{período}` (formato REST): `players` y `guilds` ya son las filas de
 * todas sus listas. Y del doc `..._score`: las listas `score*` (jugadores) y `guildScore*` (gremios). */
export function namesFromTopDocs(topDoc, scoreDoc) {
  const p = new Set();
  const g = new Set();
  const top = topDoc?.fields ?? {};
  for (const n of restNames(top.players)) p.add(n);
  for (const n of restNames(top.guilds)) g.add(n);
  for (const [key, v] of Object.entries(scoreDoc?.fields ?? {})) {
    if (key.startsWith('guildScore')) for (const n of restNames(v)) g.add(n);
    else if (key.startsWith('score')) for (const n of restNames(v)) p.add(n);
  }
  return { p: [...p].sort(), g: [...g].sort(), key: restString(top.key), seasonStart: restString(top.seasonStart) };
}

/** ¿Hay que volver a leer los nombres de Mes, Temporada y Todo? Sí si nunca se leyeron o si desde la última lectura
 * pasó la hora de la diaria de las funciones. */
export function namesNeedRefresh(fetchedAt, now) {
  if (!fetchedAt) return true;
  const t = Date.parse(fetchedAt);
  if (!Number.isFinite(t)) return true;
  const today = dateStr(now);
  let boundary = Date.parse(`${today}T${String(NAMES_REFRESH_UTC.hour).padStart(2, '0')}:${String(NAMES_REFRESH_UTC.minute).padStart(2, '0')}:00Z`);
  if (boundary > now.getTime()) boundary -= DAY_MS;
  return t < boundary;
}

const FIRESTORE_DOCS = 'https://firestore.googleapis.com/v1/projects/albion-world/databases/(default)/documents/leaderboard_top';

/** Lee los dos docs públicos de un período (2 lecturas). `null` si el principal no existe o falla. */
export async function fetchTopDocNames(region, period, fetchImpl = fetch) {
  const get = async (id) => {
    const res = await fetchImpl(`${FIRESTORE_DOCS}/${id}`, { headers: { 'User-Agent': 'albion-world-stats' } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${id}: HTTP ${res.status}`);
    return res.json();
  };
  const top = await get(`${region}_${period}`);
  if (!top) return null;
  const score = await get(`${region}_${period}_score`);
  return namesFromTopDocs(top, score);
}

// ---- Archivo publicado ----

/**
 * Suma de un período para la horaria: días cerrados (`closed`, de la diaria) + ayer (`y`, si la diaria todavía no lo
 * cerró) + hoy (`d`). Devuelve `null` si los días no cubren el período sin huecos (diaria atrasada): mejor ningún dato
 * que uno de menos que parezca bueno.
 */
export function periodLoot({ from, today, closed, todayLoot }) {
  const yesterday = addDays(today, -1);
  const out = { p: {}, g: {} };
  if (from > yesterday) return addLoot(out, todayLoot.d);
  let coveredUntil = addDays(from, -1);
  // El cerrado solo sirve si es de ESTE período (mismo primer día) y no pasa de ayer. Si es de otro (el martes antes de
  // que corra la diaria, el cerrado todavía es de la semana pasada), se ignora y cubren ayer y hoy.
  if (closed && closed.from === from && closed.until <= yesterday) {
    addLoot(out, closed);
    coveredUntil = closed.until;
  }
  if (coveredUntil < yesterday && todayLoot.y && todayLoot.y.date === yesterday && addDays(coveredUntil, 1) === yesterday) {
    addLoot(out, todayLoot.y);
    coveredUntil = yesterday;
  }
  if (coveredUntil < yesterday) return null;
  return addLoot(out, todayLoot.d);
}

/** El archivo de un período: solo los nombres de sus listas, `[botín, perdido]` en miles (0 = sin plata). */
export function lootFile({ region, period, key, from, names, loot, builtAt }) {
  const pick = (list, src) => Object.fromEntries(list.map((n) => [n, src?.[n] ?? [0, 0]]));
  const lootFrom = from > RANK_LOOT_FIRST_DAY ? from : RANK_LOOT_FIRST_DAY;
  return {
    v: RANK_LOOT_VERSION,
    region,
    period,
    key,
    builtAt,
    from: lootFrom,
    // El período empieza antes de que hubiera plata completa (Temporada y Todo): la app lo avisa.
    partial: from < RANK_LOOT_FULL_DAY,
    p: pick(names.p, loot.p),
    g: pick(names.g, loot.g),
  };
}
