// Pruebas del botín de las filas de Rankings (chat 175, lib/rank-loot.mjs y lib/rank-loot-run.mjs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  addDays,
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
  assert.deepEqual(lootOfRollup(r), { p: { Ana: [1235, 400], Beto: [0, 2] }, g: { G1: [6, 1] } });
  assert.deepEqual(lootOfRollup(null), { p: {}, g: {} });
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
  assert.deepEqual(c.periods.week, { from: '2026-11-02', until: '2026-11-03', p: { Ana: [1, 3], Beto: [8, 1] }, g: { G: [1, 0] } });
  assert.deepEqual(c.periods.month, { from: '2026-11-01', until: '2026-11-03', p: { Ana: [11, 5], Beto: [8, 1] }, g: { G: [6, 5] } });
  assert.deepEqual(c.periods.season, { from: '2026-09-12', until: '2026-11-03', p: { Ana: [9, 1] }, g: {} });
  assert.deepEqual(c.periods.all, { from: '2026-07-25', until: '2026-11-03', p: { Ana: [20, 0] }, g: { G: [1, 0] } });
  // Sin la plata completa de la ventana, el período no se guarda (nunca una cifra de menos).
  const partial = closedLootPeriods({ until: '2026-11-03', dayLoot, windows, seasonStart: '2026-09-12', firstDay: '2026-07-25', ready: ['w', 'm'] });
  assert.deepEqual(Object.keys(partial.periods).sort(), ['month', 'week']);
});

const todayLoot = (today, y = null) => ({ date: today, d: { p: { Ana: [1, 0] }, g: {} }, y });

test('periodLoot: Hoy es solo hoy', () => {
  assert.deepEqual(periodLoot({ from: '2026-11-08', today: '2026-11-08', closed: null, todayLoot: todayLoot('2026-11-08') }), { p: { Ana: [1, 0] }, g: {} });
});

test('periodLoot: con los días cerrados de este período, suma cerrados + hoy', () => {
  const closed = { from: '2026-11-02', until: '2026-11-07', p: { Ana: [10, 5] }, g: {} };
  assert.deepEqual(periodLoot({ from: '2026-11-02', today: '2026-11-08', closed, todayLoot: todayLoot('2026-11-08') }), { p: { Ana: [11, 5] }, g: {} });
});

test('periodLoot: antes de la diaria (cerrado hasta anteayer) suma el ayer de la horaria', () => {
  const closed = { from: '2026-11-02', until: '2026-11-06', p: { Ana: [10, 5] }, g: {} };
  const y = { date: '2026-11-07', p: { Ana: [100, 0] }, g: {} };
  assert.deepEqual(periodLoot({ from: '2026-11-02', today: '2026-11-08', closed, todayLoot: todayLoot('2026-11-08', y) }), { p: { Ana: [111, 5] }, g: {} });
});

test('periodLoot: el martes antes de la diaria el cerrado es de la semana pasada: se ignora y cuentan ayer + hoy', () => {
  const closed = { from: '2026-11-02', until: '2026-11-08', p: { Ana: [999, 999] }, g: {} };
  const y = { date: '2026-11-09', p: { Ana: [3, 0] }, g: {} };
  assert.deepEqual(periodLoot({ from: '2026-11-09', today: '2026-11-10', closed, todayLoot: todayLoot('2026-11-10', y) }), { p: { Ana: [4, 0] }, g: {} });
});

test('periodLoot: el lunes la semana es solo hoy', () => {
  const closed = { from: '2026-11-02', until: '2026-11-08', p: { Ana: [999, 999] }, g: {} };
  assert.deepEqual(periodLoot({ from: '2026-11-09', today: '2026-11-09', closed, todayLoot: todayLoot('2026-11-09') }), { p: { Ana: [1, 0] }, g: {} });
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
