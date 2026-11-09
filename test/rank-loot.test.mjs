// Pruebas del botín de las filas de Rankings (chat 175, lib/rank-loot.mjs y lib/rank-loot-run.mjs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  addDays,
  addLoot,
  closedLootPeriods,
  lootFile,
  lootOfRollup,
  mondayOf,
  monthStartOf,
  namesFromRankingsPeriod,
  namesFromTopDocs,
  namesNeedRefresh,
  periodLoot,
} from '../lib/rank-loot.mjs';
import { runRankLootRegion } from '../lib/rank-loot-run.mjs';
import { writeJson } from '../lib/store.mjs';

// Resumen mínimo con la forma de rollup.mjs: px.l = [botín, perdido] en plata; gl = [botín solo, grupo, zvz, perdido
// solo, grupo, zvz, muertes...].
const rollup = (date, px, gl = {}) => ({ date, px: Object.fromEntries(Object.entries(px).map(([n, l]) => [n, { l }])), gl });

/** Lo de siempre (`p`, `g`, `from`, `until`) sin lo nuevo del chat 176 (`pa`, `ga`, `assist`). */
const pg = (x) => {
  if (!x) return x;
  const { pa, ga, assist, ...rest } = x;
  return rest;
};

test('lunes y primer día del mes en UTC, como las funciones', () => {
  assert.equal(mondayOf('2026-11-08'), '2026-11-02'); // domingo
  assert.equal(mondayOf('2026-11-09'), '2026-11-09'); // lunes
  assert.equal(mondayOf('2026-11-04'), '2026-11-02');
  assert.equal(mondayOf('2026-10-01'), '2026-09-28'); // la semana cruza el mes
  assert.equal(monthStartOf('2026-11-08'), '2026-11-01');
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
});

test('lootOfRollup: miles, jugadores de px.l, gremios de gl (botín y perdido de los 3 tamaños)', () => {
  const r = rollup('2026-11-05', { Ana: [1_234_567, 400_499], Cero: [0, 0], Beto: [0, 2_000] }, { G1: [1000, 2000, 3000, 500, 0, 499, 9, 9, 9] });
  assert.deepEqual(pg(lootOfRollup(r)), { p: { Ana: [1235, 400], Beto: [0, 2] }, g: { G1: [6, 1] } });
  assert.deepEqual(pg(lootOfRollup(null)), { p: {}, g: {} });
});

test('closedLootPeriods: Semana y Mes suman sus días de calendario; Temporada y Todo salen del acumulado', () => {
  const dayLoot = {
    '2026-10-31': { p: { Ana: [100, 1] }, g: {} },
    '2026-11-01': { p: { Ana: [10, 2] }, g: { G: [5, 5] } },
    '2026-11-02': { p: { Ana: [1, 3], Beto: [7, 0] }, g: {} },
    '2026-11-03': { p: { Beto: [1, 1] }, g: { G: [1, 0] } },
  };
  const windows = { s: { px: { Ana: { l: [9_000, 1_000] } } }, a: { px: { Ana: { l: [20_000, 0] } }, gl: { G: [1000, 0, 0, 0, 0, 0] } } };
  const c = closedLootPeriods({ until: '2026-11-03', dayLoot, windows, seasonStart: '2026-09-12', firstDay: '2026-07-25' });
  assert.deepEqual(pg(c.periods.week), { from: '2026-11-02', until: '2026-11-03', p: { Ana: [1, 3], Beto: [8, 1] }, g: { G: [1, 0] } });
  assert.deepEqual(pg(c.periods.month), { from: '2026-11-01', until: '2026-11-03', p: { Ana: [11, 5], Beto: [8, 1] }, g: { G: [6, 5] } });
  assert.deepEqual(pg(c.periods.season), { from: '2026-09-12', until: '2026-11-03', p: { Ana: [9, 1] }, g: {} });
  assert.deepEqual(pg(c.periods.all), { from: '2026-07-25', until: '2026-11-03', p: { Ana: [20, 0] }, g: { G: [1, 0] } });
  // Sin la plata completa de la ventana, el período no se guarda (nunca una cifra de menos).
  const partial = closedLootPeriods({ until: '2026-11-03', dayLoot, windows, seasonStart: '2026-09-12', firstDay: '2026-07-25', ready: ['w', 'm'] });
  assert.deepEqual(Object.keys(partial.periods).sort(), ['month', 'week']);
});

const todayLoot = (today, y = null) => ({ date: today, d: { p: { Ana: [1, 0] }, g: {} }, y });

test('periodLoot: Hoy es solo hoy', () => {
  assert.deepEqual(pg(periodLoot({ from: '2026-11-08', today: '2026-11-08', closed: null, todayLoot: todayLoot('2026-11-08') })), { p: { Ana: [1, 0] }, g: {} });
});

test('periodLoot: con los días cerrados de este período, suma cerrados + hoy', () => {
  const closed = { from: '2026-11-02', until: '2026-11-07', p: { Ana: [10, 5] }, g: {} };
  assert.deepEqual(pg(periodLoot({ from: '2026-11-02', today: '2026-11-08', closed, todayLoot: todayLoot('2026-11-08') })), { p: { Ana: [11, 5] }, g: {} });
});

test('periodLoot: antes de la diaria (cerrado hasta anteayer) suma el ayer de la horaria', () => {
  const closed = { from: '2026-11-02', until: '2026-11-06', p: { Ana: [10, 5] }, g: {} };
  const y = { date: '2026-11-07', p: { Ana: [100, 0] }, g: {} };
  assert.deepEqual(pg(periodLoot({ from: '2026-11-02', today: '2026-11-08', closed, todayLoot: todayLoot('2026-11-08', y) })), { p: { Ana: [111, 5] }, g: {} });
});

test('periodLoot: el martes antes de la diaria el cerrado es de la semana pasada: se ignora y cuentan ayer + hoy', () => {
  const closed = { from: '2026-11-02', until: '2026-11-08', p: { Ana: [999, 999] }, g: {} };
  const y = { date: '2026-11-09', p: { Ana: [3, 0] }, g: {} };
  assert.deepEqual(pg(periodLoot({ from: '2026-11-09', today: '2026-11-10', closed, todayLoot: todayLoot('2026-11-10', y) })), { p: { Ana: [4, 0] }, g: {} });
});

test('periodLoot: el lunes la semana es solo hoy', () => {
  const closed = { from: '2026-11-02', until: '2026-11-08', p: { Ana: [999, 999] }, g: {} };
  assert.deepEqual(pg(periodLoot({ from: '2026-11-09', today: '2026-11-09', closed, todayLoot: todayLoot('2026-11-09') })), { p: { Ana: [1, 0] }, g: {} });
});

test('periodLoot: con un hueco (diaria atrasada y sin ayer) no hay dato', () => {
  const closed = { from: '2026-11-02', until: '2026-11-05', p: { Ana: [10, 5] }, g: {} };
  assert.equal(periodLoot({ from: '2026-11-02', today: '2026-11-08', closed, todayLoot: todayLoot('2026-11-08') }), null);
  // Sin cerrado de un período que empezó hace días: tampoco.
  assert.equal(periodLoot({ from: '2026-11-01', today: '2026-11-08', closed: null, todayLoot: todayLoot('2026-11-08') }), null);
});

test('namesFromRankingsPeriod: jugadores de kills/fama/muertes y Top; gremios de Gremios y Top G; sin kills ni batallas', () => {
  const period = {
    topKillers: [{ name: 'Ana', guild: 'G' }],
    topDeathsZvz: [{ name: 'Beto', guild: '' }],
    topScoreLocal: [{ name: 'Ceci', region: 'asia' }],
    topGuilds: [{ name: 'G' }],
    topGuildScoreZvzLocal: [{ name: 'H', region: 'asia' }],
    topFameKills: [{ killerName: 'X', name: 'no' }],
    topBattlesLocal: [{ battleId: 1 }],
    biggestKill: { name: 'no' },
    sampleSize: 3,
  };
  assert.deepEqual(namesFromRankingsPeriod(period), { p: ['Ana', 'Beto', 'Ceci'], g: ['G', 'H'] });
});

test('namesFromTopDocs: formato REST de Firestore', () => {
  const rest = (names) => ({ arrayValue: { values: names.map((n) => ({ mapValue: { fields: { name: { stringValue: n }, kills: { integerValue: '3' } } } })) } });
  const top = { fields: { key: { stringValue: '2026-11' }, seasonStart: { stringValue: '2026-09-12' }, players: rest(['Ana', 'Beto']), guilds: rest(['G']) } };
  const score = { fields: { score: rest(['Ceci']), scoreZvz: rest(['Ana']), guildScoreLow: rest(['H']), battles: rest(['no']), n: { integerValue: '100' } } };
  assert.deepEqual(namesFromTopDocs(top, score), { p: ['Ana', 'Beto', 'Ceci'], g: ['G', 'H'], key: '2026-11', seasonStart: '2026-09-12' });
  // Sin doc de Top (antes de la primera diaria): solo los del principal.
  assert.deepEqual(namesFromTopDocs(top, null).p, ['Ana', 'Beto']);
});

test('namesNeedRefresh: una vez al día, después de la diaria de las funciones', () => {
  const now = new Date('2026-11-08T20:00:00Z');
  assert.equal(namesNeedRefresh(null, now), true);
  assert.equal(namesNeedRefresh('2026-11-08T19:00:00Z', now), false);
  assert.equal(namesNeedRefresh('2026-11-08T18:00:00Z', now), true);
  // Antes de las 18:55 vale la lectura de ayer después de la diaria.
  assert.equal(namesNeedRefresh('2026-11-07T19:30:00Z', new Date('2026-11-08T10:00:00Z')), false);
  assert.equal(namesNeedRefresh('2026-11-07T18:30:00Z', new Date('2026-11-08T10:00:00Z')), true);
});

test('lootFile: solo los nombres de las listas, 0 sin plata, y avisa si el período empieza antes de la plata completa', () => {
  const f = lootFile({ region: 'asia', period: 'all', key: 'all', from: '2026-07-25', names: { p: ['Ana', 'Zed'], g: ['G'] }, loot: { p: { Ana: [5, 1], Otro: [9, 9] }, g: {} }, builtAt: 'x' });
  assert.deepEqual(f.p, { Ana: [5, 1], Zed: [0, 0] });
  assert.deepEqual(f.g, { G: [0, 0] });
  assert.equal(f.from, '2026-09-29');
  assert.equal(f.partial, true);
  const w = lootFile({ region: 'asia', period: 'week', key: '2026-11-02', from: '2026-11-02', names: { p: [], g: [] }, loot: { p: {}, g: {} }, builtAt: 'x' });
  assert.equal(w.from, '2026-11-02');
  assert.equal(w.partial, false);
});

test('runRankLootRegion: publica los períodos completos, lee Firestore una vez y borra el que ya no se puede armar', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rank-loot-'));
  const now = new Date('2026-11-08T20:10:00Z');
  writeJson(path.join(root, 'today', 'asia', '_loot-today.json'), { date: '2026-11-08', d: { p: { Ana: [1, 1] }, g: { G: [2, 0] } }, y: null });
  writeJson(path.join(root, 'index', 'asia', '_loot.json.gz'), {
    v: 1,
    until: '2026-11-07',
    periods: {
      week: { from: '2026-11-02', until: '2026-11-07', p: { Ana: [10, 0] }, g: { G: [20, 0] } },
      month: { from: '2026-11-01', until: '2026-11-07', p: { Ana: [11, 0] }, g: {} },
      season: { from: '2026-09-12', until: '2026-11-07', p: { Ana: [50, 5] }, g: {} },
      // Sin «all»: la plata de Todo no estaba completa.
    },
  });
  writeJson(path.join(root, 'rankingspub', 'asia.json'), {
    dayKey: '2026-11-08',
    weekKey: '2026-11-02',
    day: { topKillers: [{ name: 'Ana', guild: 'G' }], topGuilds: [{ name: 'G' }] },
    week: { topKillers: [{ name: 'Ana', guild: 'G' }, { name: 'Beto', guild: '' }], topGuilds: [{ name: 'G' }] },
  });
  // Un archivo viejo de Todo que ya no se puede armar: se borra.
  writeJson(path.join(root, 'today', 'asia', 'loot-all.json'), { stale: true });
  const rest = (names) => ({ arrayValue: { values: names.map((n) => ({ mapValue: { fields: { name: { stringValue: n } } } })) } });
  const docs = {
    asia_month: { fields: { key: { stringValue: '2026-11' }, players: rest(['Ana']), guilds: rest([]) } },
    asia_season: { fields: { key: { stringValue: 's34' }, seasonStart: { stringValue: '2026-09-12' }, players: rest(['Ana']), guilds: rest([]) } },
    asia_all: { fields: { key: { stringValue: 'all' }, players: rest(['Ana']), guilds: rest([]) } },
  };
  const calls = [];
  const fetchImpl = async (url) => {
    const id = url.split('/').pop();
    calls.push(id);
    return docs[id] ? { ok: true, status: 200, json: async () => docs[id] } : { ok: false, status: 404, json: async () => ({}) };
  };
  const res = await runRankLootRegion({ root, region: 'asia', now, fetchImpl, log: () => {} });
  const read = (p) => JSON.parse(fs.readFileSync(path.join(root, 'today', 'asia', `loot-${p}.json`), 'utf8'));
  assert.deepEqual(read('day').p, { Ana: [1, 1] });
  assert.deepEqual(read('day').g, { G: [2, 0] });
  assert.deepEqual(read('week').p, { Ana: [11, 1], Beto: [0, 0] });
  assert.equal(read('week').key, '2026-11-02');
  assert.deepEqual(read('month').p, { Ana: [12, 1] });
  assert.equal(read('season').key, 's34');
  assert.deepEqual(read('season').p, { Ana: [51, 6] });
  assert.equal(read('season').partial, true);
  assert.equal(fs.existsSync(path.join(root, 'today', 'asia', 'loot-all.json')), false);
  assert.equal(res.all, 'sin-dias');
  assert.equal(calls.length, 6); // 3 períodos × (doc + _score)
  // Una hora después no vuelve a leer Firestore.
  calls.length = 0;
  await runRankLootRegion({ root, region: 'asia', now: new Date('2026-11-08T21:10:00Z'), fetchImpl, log: () => {} });
  assert.equal(calls.length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('chat 176: plata por asistencia, de un día a la ventana y al archivo (solo si TODOS los días la tienen)', async () => {
  const { buildDayRollup, mergeRollups } = await import('../lib/rollup.mjs');
  const line = (o) => JSON.stringify(o);
  const parts = (n, g) => Array.from({ length: n }, (_, i) => ({ name: `${g}${i}`, guildName: g }));
  const killsText = [
    // 1 vs 1
    line({ eventId: 1, battleId: 1, killerName: 'Ana', killerGuild: 'Lobos', victimName: 'Beto', victimGuild: 'Osos', totalFame: 1, participantsCount: 1, participants: [{ name: 'Ana', guildName: 'Lobos' }] }),
    // 1-5 ayudas: 4 personas
    line({ eventId: 2, battleId: 2, killerName: 'Ana', killerGuild: 'Lobos', victimName: 'Caro', victimGuild: 'Osos', totalFame: 1, participantsCount: 4, participants: parts(4, 'Lobos') }),
    // 6+ y 10+: la API corta en 4, pero el grupo era de 12
    line({ eventId: 3, battleId: 3, killerName: 'Ana', killerGuild: 'Lobos', victimName: 'Dani', victimGuild: 'Osos', totalFame: 1, participantsCount: 4, groupSize: 12, participants: parts(4, 'Lobos') }),
    // ZvZ: pelea de 25 (1-5 ayudas en la kill)
    line({ eventId: 4, battleId: 4, killerName: 'Eva', killerGuild: 'Zorros', victimName: 'Ana', victimGuild: 'Lobos', totalFame: 1, participantsCount: 3, participants: parts(3, 'Zorros') }),
  ].join('\n');
  const battlesText = line({ battleId: 4, players: Array.from({ length: 25 }, (_, i) => ({ name: `p${i}` })), guilds: [] });
  const equipmentText = [
    line({ e: 1, ve: 1000, vi: 0 }),
    line({ e: 2, ve: 2000, vi: 0 }),
    line({ e: 3, ve: 3000, vi: 0 }),
    line({ e: 4, ve: 4000, vi: 500 }),
  ].join('\n');
  const r = buildDayRollup({ killsText, battlesText, equipmentText });
  assert.equal(r.lav, 3); // chat 179: versión 3 (cortes con la lista de participantes)
  // v2: kills, muertes y fama por corte (kills 1v1, 1-5, 6+, 10+, ZvZ, muertes …, fama de kill …, fama de muerte …).
  assert.deepEqual(r.px.Ana.ka, [1, 1, 1, 1, 0, 0, 1, 0, 0, 1, 1, 1, 1, 1, 0, 0, 1, 0, 0, 1]);
  assert.deepEqual(r.gka.Zorros, [0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0]);
  // Ana: botín 1v1 1000, 1-5 2000, 6+ 3000 (también 10+); perdió 4500 en ZvZ (kill de 1-5 ayudas en pelea de 25).
  assert.deepEqual(r.px.Ana.la, [1000, 2000, 3000, 3000, 0, 0, 4500, 0, 0, 4500]);
  // Los tres cortes base (1v1, 1-5, 6+) suman el total; 10+ y ZvZ son recortes aparte.
  assert.equal(r.px.Ana.la[0] + r.px.Ana.la[1] + r.px.Ana.la[2], r.px.Ana.l[0]);
  assert.equal(r.px.Ana.la[5] + r.px.Ana.la[6] + r.px.Ana.la[7], r.px.Ana.l[1]);
  assert.deepEqual(r.gla.Lobos, [1000, 2000, 3000, 3000, 0, 0, 4500, 0, 0, 4500]);
  assert.deepEqual(r.gla.Zorros, [0, 4500, 0, 0, 4500, 0, 0, 0, 0, 0]);

  // Un día: miles, por asistencia.
  const day = lootOfRollup({ ...r, date: '2026-11-07' });
  assert.equal(day.assist, true);
  assert.deepEqual(day.pa.Ana, [1, 2, 3, 3, 0, 0, 5, 0, 0, 5]);
  assert.deepEqual(day.ga.Zorros, [0, 5, 0, 0, 5, 0, 0, 0, 0, 0]);

  // Una ventana con un día viejo (con plata, sin `lav`) NO tiene la plata por asistencia; con días de antes de la plata, sí.
  const viejo = { date: '2026-10-01', px: { Ana: { m: [0, 0, 0, 0, 0, 0], h: [0, 0], w: {}, b: {}, l: [9000, 0], p: {} } } };
  const antes = { date: '2026-09-01', px: {} };
  assert.equal(lootOfRollup(mergeRollups([{ ...r, date: '2026-11-07' }, viejo])).assist, false);
  const w = mergeRollups([{ ...r, date: '2026-11-07' }, antes, { ...r, date: '2026-11-06' }]);
  assert.equal(lootOfRollup(w).assist, true);
  assert.deepEqual(lootOfRollup(w).pa.Ana, [2, 4, 6, 6, 0, 0, 9, 0, 0, 9]);

  // Sumas: con una parte sin plata por asistencia (archivo viejo), la suma tampoco la tiene.
  const sum = addLoot({ p: {}, g: {} }, day);
  addLoot(sum, day);
  assert.equal(sum.assist, true);
  assert.deepEqual(sum.pa.Ana, [2, 4, 6, 6, 0, 0, 10, 0, 0, 10]);
  assert.equal(addLoot(addLoot({ p: {}, g: {} }, day), { p: {}, g: {} }).assist, false);

  // Archivo: `pa`/`ga` solo de los nombres de las listas con algo; sin `assist`, no van.
  const f = lootFile({ region: 'asia', period: 'day', key: '2026-11-07', from: '2026-11-07', names: { p: ['Ana', 'Zed'], g: ['Lobos'] }, loot: sum, builtAt: 'x' });
  assert.equal(f.assist, true);
  assert.deepEqual(f.pa, { Ana: [2, 4, 6, 6, 0, 0, 10, 0, 0, 10] });
  assert.deepEqual(Object.keys(f.ga), ['Lobos']);
  const sinAsistencia = lootFile({ region: 'asia', period: 'day', key: 'k', from: '2026-11-07', names: { p: ['Ana'], g: [] }, loot: { p: { Ana: [1, 0] }, g: {} }, builtAt: 'x' });
  assert.equal(sinAsistencia.assist, undefined);
  assert.equal(sinAsistencia.pa, undefined);
});
