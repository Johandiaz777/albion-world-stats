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

export function buildDayRollup({ killsText, battlesText, equipmentText }) {
  let badLines = 0;
  const bad = () => (badLines += 1);
  const players = {};
  const guilds = {};
  const rivals = {};
  const weapons = {};
  const ids = {};

  for (const k of parseLines(killsText, bad)) {
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
    const kw = Array.isArray(e?.k) ? e.k[0] : '';
    const vw = Array.isArray(e?.v) ? e.v[0] : '';
    if (kw) (weapons[kw] ??= [0, 0])[0] += 1;
    if (vw) (weapons[vw] ??= [0, 0])[1] += 1;
  }

  return { players, guilds, rivals, weapons, ids, badLines };
}

/** Suma varios resúmenes diarios (ventanas de 7 días, mes, temporada, todo). */
export function mergeRollups(rollups) {
  const out = { players: {}, guilds: {}, rivals: {}, weapons: {}, ids: {} };
  for (const r of rollups) {
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
