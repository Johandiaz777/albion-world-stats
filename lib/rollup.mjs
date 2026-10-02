// Resumen de UN día de una región, a partir de los archivos que ya guarda el scraper de kills:
// `kills/<fecha>.ndjson`, `battles/<fecha>.ndjson` y `equipment/<fecha>.ndjson`. Funciones puras (sin
// red ni disco) para poder probarlas.
//
// Forma del resumen (compacta a propósito: se guarda uno por día y región):
//   players: { nombre: [kills, muertes, asistencias, famaKill, famaMuerte, daño, curación, gremio] }
//   guilds:  { nombre: [kills, muertes, famaKill, famaMuerte, peleas, ganadas, perdidas] }
//   rivals:  { "A\u0001B": [peleas, ganó A, ganó B] }   (A < B alfabéticamente)
//   weapons: { base: [kills con esa arma, muertes con esa arma] }
//   ids:     { gremio: id }  (para abrir su perfil desde la lista de rivales)
//   px:      { nombre: { m: [solo, grupo, zvz (kills), solo, grupo, zvz (muertes)],
//                        h: [participaciones curando más que dañando, participaciones],
//                        w: { arma completa (T8_…@3): usos }, b: { build: usos },
//                        l: [botín estimado de sus kills, lo que perdió al morir] } }   (v2)
//   gm:      { gremio: { jugador: [kills, muertes, asistencias, famaKill] } }        (v2)
//
// Solo / grupo / ZvZ: solo = la kill tuvo un único participante; ZvZ = la pelea tuvo 20+ jugadores
// (mismo corte que el ranking ZvZ); el resto, grupo. Arma y build salen del archivo de equipo y solo
// cuentan líneas con el ítem completo (desde el 29/09/2026; antes se guardaba solo la base).
export const ROLLUP_VERSION = 2;
export const ZVZ_MIN_PLAYERS = 20;

export const P = { KILLS: 0, DEATHS: 1, ASSISTS: 2, KFAME: 3, DFAME: 4, DAMAGE: 5, HEAL: 6, GUILD: 7 };
export const G = { KILLS: 0, DEATHS: 1, KFAME: 2, DFAME: 3, BATTLES: 4, WINS: 5, LOSSES: 6 };
const RIVAL_SEP = '\u0001';
/** Gremios por pelea que cuentan como rivales entre sí (los de más participación): evita que una
 * pelea de 60 gremios genere 1.770 pares, casi todos de un solo muerto. */
const RIVALS_PER_BATTLE = 6;

function parseLines(text, onError) {
  const out = [];
  if (!text) return out;
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      onError?.();
    }
  }
  return out;
}

const player = (map, name, guild) => {
  let p = map[name];
  if (!p) map[name] = p = [0, 0, 0, 0, 0, 0, 0, guild || ''];
  if (guild) p[P.GUILD] = guild;
  return p;
};
const guild = (map, name) => (map[name] ??= [0, 0, 0, 0, 0, 0, 0]);

/** Ítem completo con tier (y encantamiento opcional): `T8_2H_CLAYMORE@3`. */
const FULL_ITEM = /^T\d_[A-Z0-9_]+(@\d)?$/;
/** Base del ítem (`T8_2H_CLAYMORE@3` → `2H_CLAYMORE`); las líneas viejas ya vienen en base. */
export const baseOf = (type) => (typeof type === 'string' ? type.replace(/^T\d_/, '').replace(/@\d$/, '') : '');
/** Build = arma, mano izquierda, casco, pecho y botas completos (sin capa ni montura, que cambian
 * mucho y partirían la misma build en variantes), separados por `|`. */
export function buildSignature(eq) {
  const parts = [0, 1, 2, 3, 4].map((i) => (typeof eq[i] === 'string' ? eq[i] : ''));
  return parts[0] ? parts.join('|') : '';
}

export function buildDayRollup({ killsText, battlesText, equipmentText }) {
  let badLines = 0;
  const bad = () => (badLines += 1);
  const players = {};
  const guilds = {};
  const rivals = {};
  const weapons = {};
  const ids = {};
  const px = {};
  const gm = {};
  const extra = (name) => (px[name] ??= { m: [0, 0, 0, 0, 0, 0], h: [0, 0], w: {}, b: {}, l: [0, 0] });
  const member = (g, name) => ((gm[g] ??= {})[name] ??= [0, 0, 0, 0]);

  const kills = parseLines(killsText, bad).filter((k) => k?.killerName && k?.victimName);
  // Tamaño de cada pelea: jugadores distintos que aparecen en sus kills del día.
  const battlePlayers = new Map();
  for (const k of kills) {
    if (!k.battleId) continue;
    let set = battlePlayers.get(k.battleId);
    if (!set) battlePlayers.set(k.battleId, (set = new Set()));
    set.add(k.killerName);
    set.add(k.victimName);
    for (const part of Array.isArray(k.participants) ? k.participants : []) if (part?.name) set.add(part.name);
  }
  const modeOf = (k) => {
    const size = battlePlayers.get(k.battleId)?.size ?? 0;
    if (size >= ZVZ_MIN_PLAYERS) return 2;
    return (Number(k.participantsCount) || (k.participants?.length ?? 0)) <= 1 ? 0 : 1;
  };
  const killById = new Map();

  for (const k of kills) {
    killById.set(k.eventId, k);
    const mode = modeOf(k);
    extra(k.killerName).m[mode] += 1;
    extra(k.victimName).m[3 + mode] += 1;
    if (k.killerGuild) {
      const m = member(k.killerGuild, k.killerName);
      m[0] += 1;
      m[3] += Number(k.totalFame) || 0;
    }
    if (k.victimGuild) member(k.victimGuild, k.victimName)[1] += 1;
    for (const part of Array.isArray(k.participants) ? k.participants : []) {
      if (!part?.name) continue;
      const h = extra(part.name).h;
      h[1] += 1;
      if ((Number(part.healingDone) || 0) > (Number(part.damageDone) || 0)) h[0] += 1;
      if (part.name !== k.killerName && part.guildName) member(part.guildName, part.name)[2] += 1;
    }
  }

  for (const k of kills) {
    if (!k?.killerName || !k?.victimName) continue;
    const fame = Number(k.totalFame) || 0;
    const killer = player(players, k.killerName, k.killerGuild);
    killer[P.KILLS] += 1;
    killer[P.KFAME] += fame;
    const victim = player(players, k.victimName, k.victimGuild);
    victim[P.DEATHS] += 1;
    victim[P.DFAME] += fame;
    if (k.killerGuild) {
      const g = guild(guilds, k.killerGuild);
      g[G.KILLS] += 1;
      g[G.KFAME] += fame;
    }
    if (k.victimGuild) {
      const g = guild(guilds, k.victimGuild);
      g[G.DEATHS] += 1;
      g[G.DFAME] += fame;
    }
    for (const part of Array.isArray(k.participants) ? k.participants : []) {
      if (!part?.name) continue;
      const p = player(players, part.name, part.guildName);
      if (part.name !== k.killerName) p[P.ASSISTS] += 1;
      p[P.DAMAGE] += Math.round(Number(part.damageDone) || 0);
      p[P.HEAL] += Math.round(Number(part.healingDone) || 0);
    }
  }

  for (const b of parseLines(battlesText, bad)) {
    const list = (Array.isArray(b?.guilds) ? b.guilds : []).filter((g) => g?.name);
    for (const g of list) {
      if (typeof g.id === 'string' && g.id) ids[g.name] = g.id;
      const entry = guild(guilds, g.name);
      entry[G.BATTLES] += 1;
      // "Ganó" = más kills que muertes en ESA pelea (mismo criterio observado que ya usaba el scraper).
      if ((g.kills ?? 0) > (g.deaths ?? 0)) entry[G.WINS] += 1;
      else if ((g.kills ?? 0) < (g.deaths ?? 0)) entry[G.LOSSES] += 1;
    }
    const top = [...list].sort((a, c) => (c.kills ?? 0) + (c.deaths ?? 0) - ((a.kills ?? 0) + (a.deaths ?? 0))).slice(0, RIVALS_PER_BATTLE);
    for (let i = 0; i < top.length; i++) {
      for (let j = i + 1; j < top.length; j++) {
        const [a, c] = top[i].name < top[j].name ? [top[i], top[j]] : [top[j], top[i]];
        const key = `${a.name}${RIVAL_SEP}${c.name}`;
        const r = (rivals[key] ??= [0, 0, 0]);
        r[0] += 1;
        const na = (a.kills ?? 0) - (a.deaths ?? 0);
        const nc = (c.kills ?? 0) - (c.deaths ?? 0);
        if (na > nc) r[1] += 1;
        else if (nc > na) r[2] += 1;
      }
    }
  }

  for (const e of parseLines(equipmentText, bad)) {
    const kw = Array.isArray(e?.k) ? baseOf(e.k[0]) : '';
    const vw = Array.isArray(e?.v) ? baseOf(e.v[0]) : '';
    if (kw) (weapons[kw] ??= [0, 0])[0] += 1;
    if (vw) (weapons[vw] ??= [0, 0])[1] += 1;
    const k = killById.get(e?.e);
    if (!k) continue;
    const loot = (Number(e.ve) || 0) + (Number(e.vi) || 0);
    if (loot > 0) {
      extra(k.killerName).l[0] += loot;
      extra(k.victimName).l[1] += loot;
    }
    for (const [name, eq] of [
      [k.killerName, e.k],
      [k.victimName, e.v],
    ]) {
      if (!Array.isArray(eq) || !FULL_ITEM.test(eq[0] ?? '')) continue;
      const x = extra(name);
      x.w[eq[0]] = (x.w[eq[0]] ?? 0) + 1;
      const sig = buildSignature(eq);
      if (sig) x.b[sig] = (x.b[sig] ?? 0) + 1;
    }
  }

  return { v: ROLLUP_VERSION, players, guilds, rivals, weapons, ids, px, gm, badLines };
}

/** Suma varios resúmenes diarios (ventanas de 7 días, mes, temporada, todo). */
export function mergeRollups(rollups) {
  const out = { players: {}, guilds: {}, rivals: {}, weapons: {}, ids: {}, px: {}, gm: {} };
  const addMap = (to, from) => {
    for (const [k, n] of Object.entries(from ?? {})) to[k] = (to[k] ?? 0) + (n || 0);
  };
  for (const r of rollups) {
    for (const [name, x] of Object.entries(r.px ?? {})) {
      const o = (out.px[name] ??= { m: [0, 0, 0, 0, 0, 0], h: [0, 0], w: {}, b: {}, l: [0, 0] });
      for (let i = 0; i < 6; i++) o.m[i] += x.m?.[i] || 0;
      for (let i = 0; i < 2; i++) o.h[i] += x.h?.[i] || 0;
      for (let i = 0; i < 2; i++) o.l[i] += x.l?.[i] || 0;
      addMap(o.w, x.w);
      addMap(o.b, x.b);
    }
    for (const [g, members] of Object.entries(r.gm ?? {})) {
      const o = (out.gm[g] ??= {});
      for (const [name, v] of Object.entries(members)) {
        const m = (o[name] ??= [0, 0, 0, 0]);
        for (let i = 0; i < 4; i++) m[i] += v[i] || 0;
      }
    }
    for (const [name, v] of Object.entries(r.players ?? {})) {
      const p = (out.players[name] ??= [0, 0, 0, 0, 0, 0, 0, '']);
      for (let i = 0; i < 7; i++) p[i] += v[i] || 0;
      if (v[P.GUILD]) p[P.GUILD] = v[P.GUILD]; // el gremio del día más reciente (se suman en orden)
    }
    for (const [name, v] of Object.entries(r.guilds ?? {})) {
      const g = (out.guilds[name] ??= [0, 0, 0, 0, 0, 0, 0]);
      for (let i = 0; i < 7; i++) g[i] += v[i] || 0;
    }
    for (const [key, v] of Object.entries(r.rivals ?? {})) {
      const x = (out.rivals[key] ??= [0, 0, 0]);
      for (let i = 0; i < 3; i++) x[i] += v[i] || 0;
    }
    Object.assign(out.ids, r.ids ?? {});
    for (const [key, v] of Object.entries(r.weapons ?? {})) {
      const x = (out.weapons[key] ??= [0, 0]);
      x[0] += v[0] || 0;
      x[1] += v[1] || 0;
    }
  }
  return out;
}

/** Mejor día de cada jugador en varios resúmenes diarios: [kills, muertes, daño] (cada uno el
 * máximo de un día, no necesariamente del mismo día). Las insignias de "mejor día" del perfil lo
 * leen del índice en vez de bajar al teléfono los archivos de kills (~45 MB por día). */
export function bestDayByPlayer(rollups) {
  const out = {};
  for (const r of rollups) {
    for (const [name, v] of Object.entries(r.players ?? {})) {
      const b = (out[name] ??= [0, 0, 0]);
      b[0] = Math.max(b[0], v[P.KILLS] || 0);
      b[1] = Math.max(b[1], v[P.DEATHS] || 0);
      b[2] = Math.max(b[2], Math.round(v[P.DAMAGE] || 0));
    }
  }
  return out;
}

/** Los N rivales de cada gremio (por peleas juntos) con su balance: [rival, peleas, ganadas, perdidas, id]. */
export function rivalsByGuild(rivals, top = 10, ids = {}) {
  const map = {};
  for (const [key, [n, wa, wb]] of Object.entries(rivals)) {
    const [a, b] = key.split(RIVAL_SEP);
    (map[a] ??= []).push([b, n, wa, wb, ids[b] ?? '']);
    (map[b] ??= []).push([a, n, wb, wa, ids[a] ?? '']);
  }
  for (const k of Object.keys(map)) map[k] = map[k].sort((x, y) => y[1] - x[1]).slice(0, top);
  return map;
}

/** Hash FNV-1a del nombre en minúsculas → shard. La app usa EXACTAMENTE esta función. */
export function shardOf(name, shards) {
  let h = 0x811c9dc5;
  const s = String(name).toLowerCase();
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % shards;
}

const topEntries = (map, n) =>
  Object.entries(map ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);

/** Extras de un jugador para el índice (compactos): armas top 3 y builds top 2. `null` si no hay nada. */
export function compactExtras(x) {
  if (!x) return null;
  const any = x.m.some(Boolean) || x.h[1] || x.l[0] || x.l[1] || Object.keys(x.w).length;
  if (!any) return null;
  const out = { m: x.m, h: x.h };
  const w = topEntries(x.w, 3);
  const b = topEntries(x.b, 2);
  if (w.length) out.w = w;
  if (b.length) out.b = b;
  if (x.l[0] || x.l[1]) out.l = x.l.map(Math.round);
  return out;
}

/** Los N miembros más activos de un gremio: [nombre, kills, muertes, asistencias, famaKill]. */
export function topMembers(members, n = 20) {
  return Object.entries(members ?? {})
    .map(([name, v]) => [name, v[0], v[1], v[2], v[3]])
    .sort((a, b) => b[1] + b[3] - (a[1] + a[3]) || b[4] - a[4])
    .slice(0, n);
}

/** Versión del formato de los acumulados (`index/<región>/_acc/*.json.gz`). */
export const ACC_VERSION = 1;

/**
 * Acumulado incremental de una ventana que crece todos los días ("Todo" desde FIRST_DAY, "Temporada"
 * desde su inicio). Antes la corrida diaria cargaba en memoria TODOS los resúmenes diarios para
 * sumarlos de nuevo (≈1,2 MB comprimidos por día y región, sin tope): con un año de datos el job se
 * quedaba sin memoria. Ahora se guarda el total hasta `through` y cada día solo se le suman los días
 * nuevos. Se rehace entero (como antes) si cambia el inicio, la versión del resumen, o si esta
 * corrida rehízo algún día ya incluido (backfill tardío o resúmenes v1 → v2).
 *
 * `loadDays(dates)` devuelve los resúmenes existentes de esas fechas (saltea los que falten).
 * Devuelve `{ data, acc }`: la ventana sumada y el acumulado a guardar.
 */
export function advanceAccumulator(prev, { from, until, rollupVersion, rebuiltDates, loadDays, dateList }) {
  const usable =
    prev &&
    prev.v === ACC_VERSION &&
    prev.rv === rollupVersion &&
    prev.from === from &&
    typeof prev.through === 'string' &&
    prev.through <= until &&
    prev.data &&
    !rebuiltDates.some((d) => d >= from && d <= prev.through);
  let data;
  if (usable) {
    const next = new Date(Date.parse(`${prev.through}T00:00:00Z`) + 86400e3).toISOString().slice(0, 10);
    const fresh = next <= until ? loadDays(dateList(next, until)) : [];
    data = fresh.length > 0 ? mergeRollups([prev.data, ...fresh]) : prev.data;
  } else {
    data = mergeRollups(loadDays(dateList(from, until)));
  }
  return { data, acc: { v: ACC_VERSION, rv: rollupVersion, from, through: until, data }, rebuilt: !usable };
}
