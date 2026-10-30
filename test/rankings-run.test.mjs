// Pruebas de Rankings desde stats-builder (lib/rankings-run.mjs): el mismo orden que `refreshCraftingLeaderboards`
// (peleas: gana el archivo más viejo; kills: gana la primera vista, del archivo más nuevo), fechas de Hoy/Semana y la
// corrida completa con un `fetch` falso. La igualdad con la función compilada de verdad se prueba en el repo de
// Albion World (functions/src/__tests__/rankings-equality.real.test.ts) con días reales.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { aggregateCombatRankings } from '../lib/ranking-core.mjs';
import { buildRegionRankings, datesForPeriod, lastNDatesUTC, periodKey, runRankings } from '../lib/rankings-run.mjs';
import { candidateUrls } from '../lib/sources.mjs';

const nd = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const kill = (eventId, ts, over = {}) => ({
  eventId,
  battleId: null,
  timestamp: ts,
  killerName: `k${eventId % 7}`,
  killerGuild: `G${eventId % 3}`,
  victimName: `v${eventId % 5}`,
  victimGuild: `H${eventId % 2}`,
  totalFame: 1000 * (eventId % 4),
  participantsCount: 1 + (eventId % 4),
  participants: [{ id: `id${eventId % 7}`, name: `k${eventId % 7}`, guildId: '', guildName: '', damageDone: 1, healingDone: 0 }],
  ...over,
});
const battle = (battleId, startTime, size, guilds) => ({ battleId, startTime, totalKills: 3, totalFame: 9000, guilds, players: Array.from({ length: size }, (_, i) => ({ name: `p${i}` })) });

test('fechas: 7 días del más nuevo al más viejo; Hoy y Semana como datesForPeriod; vuelta de medianoche', () => {
  const now = new Date('2026-11-02T00:25:00Z'); // lunes
  assert.deepEqual(lastNDatesUTC(7, now), ['2026-11-02', '2026-11-01', '2026-10-31', '2026-10-30', '2026-10-29', '2026-10-28', '2026-10-27']);
  assert.deepEqual(datesForPeriod('day', now), ['2026-11-02']);
  assert.deepEqual(datesForPeriod('week', now), ['2026-11-02']);
  assert.equal(periodKey('day', now), '2026-11-02');
  assert.equal(periodKey('week', now), '2026-11-02');
  const sunday = new Date('2026-11-01T23:59:00Z');
  assert.deepEqual(datesForPeriod('week', sunday), ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
  assert.equal(periodKey('week', sunday), '2026-10-26');
});

test('orden de la función: pelea repetida = la del archivo más viejo; kill repetida = la primera (archivo más nuevo)', async () => {
  const now = new Date('2026-10-30T12:00:00Z');
  // La pelea 1 está en el archivo del 30 (con 25 jugadores: ZvZ) y en el del 29 (con 5: chica). Gana la del 29.
  const files = {
    'battles/2026-10-30': nd([battle(1, '2026-10-29T23:58:00Z', 25, [{ name: 'G0', kills: 3, deaths: 1 }]), battle(2, '2026-10-30T10:00:00Z', 30, [{ name: 'G1', kills: 1, deaths: 2 }])]),
    'battles/2026-10-29': nd([battle(1, '2026-10-29T23:58:00Z', 5, [{ name: 'G0', kills: 3, deaths: 1 }])]),
    // La kill 10 está en los dos archivos (medianoche) con fama distinta: cuenta la del 30 (la primera vista).
    'kills/2026-10-30': nd([kill(10, '2026-10-29T23:59:00Z', { totalFame: 777, battleId: 1 }), kill(11, '2026-10-30T10:00:00Z', { battleId: 2, totalFame: 100 }), kill(12, '2026-10-30T11:00:00Z', { totalFame: 100 })]),
    'kills/2026-10-29': nd([kill(10, '2026-10-29T23:59:00Z', { totalFame: 5, battleId: 1 }), kill(9, '2026-10-29T08:00:00Z', { totalFame: 100 })]),
  };
  const readDay = async (type, date) => files[`${type}/${date}`] ?? null;
  const r = await buildRegionRankings({ region: 'asia', now, readDay });
  assert.equal(r.killsSeen, 4);
  assert.equal(r.battles, 2);
  assert.equal(r.dayKey, '2026-10-30');
  assert.equal(r.weekKey, '2026-10-26');
  // Referencia: la misma lista que arman fetchBattlesForRegion/streamKillsForRegion, a mano.
  const battles = [battle(1, '2026-10-29T23:58:00Z', 5, [{ name: 'G0', kills: 3, deaths: 1 }]), battle(2, '2026-10-30T10:00:00Z', 30, [{ name: 'G1', kills: 1, deaths: 2 }])];
  const kills = [kill(10, '2026-10-29T23:59:00Z', { totalFame: 777, battleId: 1 }), kill(11, '2026-10-30T10:00:00Z', { battleId: 2, totalFame: 100 }), kill(12, '2026-10-30T11:00:00Z', { totalFame: 100 }), kill(9, '2026-10-29T08:00:00Z', { totalFame: 100 })].map((k) => ({ ...k, region: 'asia' }));
  assert.equal(JSON.stringify(r.all), JSON.stringify(aggregateCombatRankings(kills, battles, 'asia')));
  const today = kills.filter((k) => k.timestamp.startsWith('2026-10-30'));
  assert.equal(JSON.stringify(r.day), JSON.stringify(aggregateCombatRankings(today, battles.filter((b) => b.startTime.startsWith('2026-10-30')), 'asia')));
  assert.equal(JSON.stringify(r.week), JSON.stringify(aggregateCombatRankings(kills, battles, 'asia')));
  // La kill 10 entró con la fama del archivo del 30 y la pelea 1 cuenta como chica (la versión del 29).
  assert.equal(r.all.biggestKill.eventId, 10);
  assert.equal(r.all.biggestKill.totalFame, 777);
  assert.equal(r.all.topGuildsZvz.find((g) => g.name === 'G0'), undefined);
});

function fakeServer() {
  const files = new Map();
  const fail = new Set();
  const fetchImpl = async (url, init = {}) => {
    if (fail.has(url)) throw new Error('red');
    const body = files.get(url);
    const resp = (status, buf, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) });
    if (!body) return resp(404, Buffer.from('404'));
    const range = init.headers?.Range;
    if (!range) return resp(200, body);
    const start = Number(/bytes=(\d+)-/.exec(range)[1]);
    if (start >= body.length) return resp(416, Buffer.alloc(0));
    return resp(206, body.subarray(start), { 'content-range': `bytes ${start}-${body.length - 1}/${body.length}` });
  };
  return { files, fail, fetchImpl };
}

test('runRankings: publica <región>.json y status.json, se pone al día solo con lo nuevo, y una región caída no frena a las otras', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rankings-'));
  const srv = fakeServer();
  const now = new Date('2026-10-30T12:20:00Z');
  for (const region of ['asia', 'europe']) {
    srv.files.set(candidateUrls('kills', region, '2026-10-30')[0], Buffer.from(nd([kill(1, '2026-10-30T01:00:00Z'), kill(2, '2026-10-30T02:00:00Z')])));
    srv.files.set(candidateUrls('kills', region, '2026-10-28')[1], Buffer.from(nd([kill(3, '2026-10-28T01:00:00Z')])));
    srv.files.set(candidateUrls('battles', region, '2026-10-30')[0], Buffer.from(nd([battle(5, '2026-10-30T00:30:00Z', 22, [{ name: 'G1', kills: 2, deaths: 0 }])])));
  }
  srv.fail.add(candidateUrls('kills', 'americas', '2026-10-29')[0]);
  const logs = [];
  const code = await runRankings({ root, now, fetchImpl: srv.fetchImpl, log: (m) => logs.push(m) });
  assert.equal(code, 0);
  const asia = JSON.parse(fs.readFileSync(path.join(root, 'rankingspub', 'asia.json'), 'utf8'));
  assert.equal(asia.v, 1);
  assert.equal(asia.region, 'asia');
  assert.equal(asia.dayKey, '2026-10-30');
  assert.equal(asia.killsSeen, 3);
  assert.equal(asia.day.sampleSize, 2);
  assert.equal(asia.week.sampleSize, 3);
  assert.equal(asia.sources['kills/2026-10-28'].url, candidateUrls('kills', 'asia', '2026-10-28')[1]);
  assert.ok(!fs.existsSync(path.join(root, 'rankingspub', 'americas.json')));
  const status = JSON.parse(fs.readFileSync(path.join(root, 'rankingspub', 'status.json'), 'utf8'));
  assert.equal(status.regions.asia.ok, true);
  assert.equal(status.regions.americas.ok, false);
  // Segunda corrida: llega una kill nueva; solo se bajan sus bytes.
  const url = candidateUrls('kills', 'asia', '2026-10-30')[0];
  const grown = Buffer.concat([srv.files.get(url), Buffer.from(nd([kill(4, '2026-10-30T12:10:00Z')]))]);
  srv.files.set(url, grown);
  srv.fail.clear();
  await runRankings({ root, now: new Date('2026-10-30T13:20:00Z'), regions: ['asia'], fetchImpl: srv.fetchImpl, log: (m) => logs.push(m) });
  const status2 = JSON.parse(fs.readFileSync(path.join(root, 'rankingspub', 'status.json'), 'utf8'));
  assert.equal(status2.regions.asia.fullDownloads, 0);
  assert.equal(status2.regions.asia.killsSeen, 4);
  // Cambio de día: el 23 sale de la copia (se guardan 8 días).
  fs.mkdirSync(path.join(root, 'rawcache', 'asia', 'kills'), { recursive: true });
  fs.writeFileSync(path.join(root, 'rawcache', 'asia', 'kills', '2026-10-22.ndjson'), 'x');
  await runRankings({ root, now: new Date('2026-10-31T00:20:00Z'), regions: ['asia'], fetchImpl: srv.fetchImpl, log: (m) => logs.push(m) });
  assert.ok(!fs.existsSync(path.join(root, 'rawcache', 'asia', 'kills', '2026-10-22.ndjson')));
  const asia3 = JSON.parse(fs.readFileSync(path.join(root, 'rankingspub', 'asia.json'), 'utf8'));
  // Medianoche: «Hoy» ya es el 31 (vacío), nunca el 30 con la fecha nueva.
  assert.equal(asia3.dayKey, '2026-10-31');
  assert.equal(asia3.day.sampleSize, 0);
});
