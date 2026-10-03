import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildDayRollup, compactExtras, G, mergeRollups, P, pidsFromKills, piecesFromDay, rivalsByGuild, shardOf } from '../lib/rollup.mjs';

const kill = (killer, kg, victim, vg, fame, parts = []) =>
  JSON.stringify({ killerName: killer, killerGuild: kg, victimName: victim, victimGuild: vg, totalFame: fame, participants: parts });

test('kills: asesino suma kill y fama, víctima muerte, participantes asistencia, daño y cura', () => {
  const killsText = [
    kill('Ana', 'Lobos', 'Beto', 'Osos', 1000, [
      { name: 'Ana', guildName: 'Lobos', damageDone: 500, healingDone: 0 },
      { name: 'Caro', guildName: 'Lobos', damageDone: 100, healingDone: 300 },
    ]),
    '{roto',
  ].join('\n');
  const r = buildDayRollup({ killsText, battlesText: '', equipmentText: '' });
  assert.equal(r.players.Ana[P.KILLS], 1);
  assert.equal(r.players.Ana[P.ASSISTS], 0);
  assert.equal(r.players.Beto[P.DEATHS], 1);
  assert.equal(r.players.Caro[P.ASSISTS], 1);
  assert.equal(r.players.Caro[P.HEAL], 300);
  assert.equal(r.guilds.Lobos[G.KFAME], 1000);
  assert.equal(r.badLines, 1);
});

test('peleas: victoria/derrota por kills contra muertes y rivales por par', () => {
  const battlesText = JSON.stringify({
    guilds: [
      { name: 'Lobos', kills: 5, deaths: 1 },
      { name: 'Osos', kills: 1, deaths: 5 },
    ],
  });
  const r = buildDayRollup({ killsText: '', battlesText, equipmentText: '' });
  assert.equal(r.guilds.Lobos[G.WINS], 1);
  assert.equal(r.guilds.Osos[G.LOSSES], 1);
  const rivals = rivalsByGuild(r.rivals);
  assert.deepEqual(rivals.Lobos[0], ['Osos', 1, 1, 0, '']);
  assert.deepEqual(rivals.Osos[0], ['Lobos', 1, 0, 1, '']);
});

test('equipo: arma del asesino suma kill, arma de la víctima suma muerte', () => {
  const equipmentText = JSON.stringify({ e: 1, k: ['2H_CLAYMORE'], v: ['MAIN_AXE'] });
  const r = buildDayRollup({ killsText: '', battlesText: '', equipmentText });
  assert.deepEqual(r.weapons['2H_CLAYMORE'], [1, 0]);
  assert.deepEqual(r.weapons.MAIN_AXE, [0, 1]);
});

test('ventanas: se suman los días y el gremio queda el más reciente', () => {
  const d1 = buildDayRollup({ killsText: kill('Ana', 'Lobos', 'Beto', '', 10), battlesText: '', equipmentText: '' });
  const d2 = buildDayRollup({ killsText: kill('Ana', 'Zorros', 'Beto', '', 20), battlesText: '', equipmentText: '' });
  const m = mergeRollups([d1, d2]);
  assert.equal(m.players.Ana[P.KILLS], 2);
  assert.equal(m.players.Ana[P.KFAME], 30);
  assert.equal(m.players.Ana[P.GUILD], 'Zorros');
});

test('parte (shard) estable, sin distinguir mayúsculas', () => {
  assert.equal(shardOf('Ana', 256), shardOf('ANA', 256));
  assert.ok(shardOf('YakiShiba', 256) < 256);
  // Valor fijo: la app usa la misma función y debe coincidir.
  assert.equal(shardOf('yakishiba', 256), shardOf('YakiShiba', 256));
});

test('sources: antes del 01/10 Europa y América se leen de la carpeta cruzada', async () => {
  const { candidateUrls, legacyFolder } = await import('../lib/sources.mjs');
  assert.equal(legacyFolder('europe', '2026-09-29'), 'americas');
  assert.equal(legacyFolder('americas', '2026-09-30'), 'europe');
  assert.equal(legacyFolder('asia', '2026-09-29'), 'asia');
  assert.equal(legacyFolder('europe', '2026-10-01'), 'europe');
  assert.match(candidateUrls('kills', 'europe', '2026-09-01')[0], /data\/kills\/americas\/2026-09-01/);
  const oct = candidateUrls('kills', 'europe', '2026-10-02');
  assert.match(oct[0], /albion-data-europe-2026-10\/main\/kills\/2026-10-02/);
  assert.match(oct[1], /data\/kills\/europe\/2026-10-02/);
});

test('v2: solo / grupo / ZvZ, healer, arma y build completas, botín y miembros del gremio', async () => {
  const { buildDayRollup, compactExtras, topMembers } = await import('../lib/rollup.mjs');
  const line = (o) => JSON.stringify(o);
  const zvzParts = Array.from({ length: 22 }, (_, i) => ({ name: `z${i}`, guildName: 'Lobos', damageDone: 10, healingDone: 0 }));
  const killsText = [
    line({ eventId: 1, battleId: 1, killerName: 'Ana', killerGuild: 'Lobos', victimName: 'Beto', victimGuild: 'Osos', totalFame: 100, participantsCount: 1, participants: [{ name: 'Ana', guildName: 'Lobos', damageDone: 900, healingDone: 0 }] }),
    line({ eventId: 2, battleId: 2, killerName: 'Ana', killerGuild: 'Lobos', victimName: 'Caro', victimGuild: 'Osos', totalFame: 50, participantsCount: 2, participants: [{ name: 'Ana', guildName: 'Lobos', damageDone: 500 }, { name: 'Dani', guildName: 'Lobos', damageDone: 0, healingDone: 800 }] }),
    line({ eventId: 3, battleId: 3, killerName: 'Ana', killerGuild: 'Lobos', victimName: 'Eva', victimGuild: 'Osos', totalFame: 10, participantsCount: 22, participants: zvzParts }),
  ].join('\n');
  const equipmentText = [
    line({ e: 1, k: ['T8_2H_CLAYMORE@3', '', 'T8_HEAD_PLATE_SET1@2', 'T8_ARMOR_PLATE_SET1', 'T8_SHOES_PLATE_SET1', 'CAPE', 'HORSE'], v: ['2H_BOW'], ve: 1000, vi: 500 }),
    line({ e: 2, k: ['T8_2H_CLAYMORE@3', '', 'T8_HEAD_PLATE_SET1@2', 'T8_ARMOR_PLATE_SET1', 'T8_SHOES_PLATE_SET1', 'CAPE', 'HORSE'], v: [''] }),
  ].join('\n');
  const r = buildDayRollup({ killsText, battlesText: '', equipmentText });
  assert.equal(r.v, 2);
  assert.deepEqual(r.px.Ana.m, [1, 1, 1, 0, 0, 0]);
  assert.deepEqual(r.px.Beto.m, [0, 0, 0, 1, 0, 0]);
  assert.deepEqual(r.px.Dani.h, [1, 1]);
  assert.deepEqual(r.px.Ana.l, [1500, 0]);
  assert.deepEqual(r.px.Beto.l, [0, 1500]);
  assert.equal(r.px.Ana.w['T8_2H_CLAYMORE@3'], 2);
  assert.equal(r.px.Beto.w['2H_BOW'], undefined); // línea vieja (solo base): no cuenta
  assert.equal(r.weapons['2H_CLAYMORE'][0], 2); // armas por base, como siempre
  const x = compactExtras(r.px.Ana);
  assert.deepEqual(x.w, [['T8_2H_CLAYMORE@3', 2]]);
  assert.equal(x.b[0][0], 'T8_2H_CLAYMORE@3||T8_HEAD_PLATE_SET1@2|T8_ARMOR_PLATE_SET1|T8_SHOES_PLATE_SET1');
  assert.deepEqual(topMembers(r.gm.Lobos, 2)[0], ['Ana', 3, 0, 0, 160]);
  assert.equal(r.gm.Lobos.Dani[2], 1);
});

test('mejor día: máximo por jugador de kills, muertes y daño entre varios días', async () => {
  const { bestDayByPlayer } = await import('../lib/rollup.mjs');
  const d1 = { players: { Ana: [3, 1, 0, 0, 0, 1200.4, 0, 'Lobos'], Beto: [0, 2, 0, 0, 0, 0, 0, ''] } };
  const d2 = { players: { Ana: [1, 4, 0, 0, 0, 5000, 0, 'Lobos'] } };
  const out = bestDayByPlayer([d1, d2, { players: undefined }]);
  assert.deepEqual(out.Ana, [3, 4, 5000]);
  assert.deepEqual(out.Beto, [0, 2, 0]);
});

test('acumulado incremental: suma solo los días nuevos y se rehace si se rehízo un día viejo', async () => {
  const { advanceAccumulator } = await import('../lib/rollup.mjs');
  const { dateList } = await import('../lib/sources.mjs');
  const dayR = (k) => ({ players: { Ana: [k, 0, 0, 0, 0, 0, 0, 'Lobos'] }, guilds: {}, rivals: {}, weapons: {}, ids: {}, px: {}, gm: {} });
  const files = { '2026-07-25': dayR(1), '2026-07-26': dayR(2), '2026-07-27': dayR(4) };
  const loads = [];
  const loadDays = (dates) => {
    loads.push(dates);
    return dates.map((d) => files[d]).filter(Boolean);
  };
  const base = { from: '2026-07-25', rollupVersion: 2, loadDays, dateList };
  const first = advanceAccumulator(null, { ...base, until: '2026-07-26', rebuiltDates: [] });
  assert.equal(first.data.players.Ana[P.KILLS], 3);
  assert.equal(first.rebuilt, true);
  loads.length = 0;
  const second = advanceAccumulator(first.acc, { ...base, until: '2026-07-27', rebuiltDates: [] });
  assert.equal(second.data.players.Ana[P.KILLS], 7);
  assert.deepEqual(loads, [['2026-07-27']]);
  assert.equal(second.rebuilt, false);
  // El mismo día otra vez: no carga nada.
  loads.length = 0;
  assert.equal(advanceAccumulator(second.acc, { ...base, until: '2026-07-27', rebuiltDates: [] }).data.players.Ana[P.KILLS], 7);
  assert.deepEqual(loads, []);
  // Se rehízo un día ya sumado: recalcula todo.
  files['2026-07-26'] = dayR(10);
  const redo = advanceAccumulator(second.acc, { ...base, until: '2026-07-27', rebuiltDates: ['2026-07-26'] });
  assert.equal(redo.data.players.Ana[P.KILLS], 15);
  assert.equal(redo.rebuilt, true);
  // Otra versión de resumen u otro inicio: recalcula.
  assert.equal(advanceAccumulator(second.acc, { ...base, rollupVersion: 3, until: '2026-07-27', rebuiltDates: [] }).rebuilt, true);
  assert.equal(advanceAccumulator(second.acc, { ...base, from: '2026-07-26', until: '2026-07-27', rebuiltDates: [] }).rebuilt, true);
});

test('pids: id de cada jugador desde los participantes; al sumar días queda el más reciente', () => {
  const line = (id) => JSON.stringify({ eventId: 1, battleId: null, killerName: 'Ana', killerGuild: 'Lobos', victimName: 'Beto', victimGuild: '', totalFame: 10, participantsCount: 1, participants: [{ id, name: 'Ana', guildName: 'Lobos', damageDone: 5, healingDone: 0 }] });
  const viejo = buildDayRollup({ killsText: line('id-viejo'), battlesText: '', equipmentText: '' });
  const nuevo = buildDayRollup({ killsText: line('id-nuevo'), battlesText: '', equipmentText: '' });
  assert.equal(viejo.pids.Ana, 'id-viejo');
  assert.equal(viejo.pids.Beto, undefined); // la víctima no trae id en las kills del scraper
  assert.equal(mergeRollups([viejo, nuevo]).pids.Ana, 'id-nuevo');
  assert.deepEqual(mergeRollups([{ players: {} }]).pids, {}); // resúmenes viejos sin pids
});

test('pidsFromKills: solo los ids de los participantes, el último gana, tolera líneas rotas', () => {
  const text = [
    JSON.stringify({ killerName: 'A', victimName: 'B', participants: [{ name: 'A', id: 'id-a-1' }, { name: 'C' }] }),
    '{roto',
    JSON.stringify({ killerName: 'A', victimName: 'C', participants: [{ name: 'A', id: 'id-a-2' }, { name: 'D', id: '' }] }),
  ].join(String.fromCharCode(10));
  assert.deepEqual(pidsFromKills(text), { A: 'id-a-2' });
  const conVictima = JSON.stringify({ killerName: 'A', victimName: 'V', victimId: 'id-v', participants: [{ name: 'A', id: 'id-a' }] });
  assert.deepEqual(pidsFromKills(conVictima), { A: 'id-a', V: 'id-v' });
  assert.equal(buildDayRollup({ killsText: conVictima, battlesText: null, equipmentText: null }).pids.V, 'id-v');
});

test('piezas: casco, pecho, botas y capa por separado; la más usada de cada espacio con sus usos', () => {
  const killsText = [
    JSON.stringify({ eventId: 1, killerName: 'A', victimName: 'B', participants: [] }),
    JSON.stringify({ eventId: 2, killerName: 'A', victimName: 'C', participants: [] }),
    JSON.stringify({ eventId: 3, killerName: 'A', victimName: 'D', participants: [] }),
  ].join(String.fromCharCode(10));
  const eq = (head, cape) => ['T8_2H_CLAYMORE@3', '', head, 'T8_ARMOR_PLATE_SET1@1', 'T8_SHOES_CLOTH_SET1', cape, ''];
  const equipmentText = [
    JSON.stringify({ e: 1, k: eq('T8_HEAD_CLOTH_SET1', 'T6_CAPEITEM_FW_MARTLOCK@1'), v: ['T4_MAIN_SWORD', '', '', '', '', '', ''] }),
    JSON.stringify({ e: 2, k: eq('T8_HEAD_CLOTH_SET1', 'T6_CAPEITEM_FW_MARTLOCK@1'), v: [] }),
    JSON.stringify({ e: 3, k: eq('T7_HEAD_LEATHER_SET2', ''), v: [] }),
  ].join(String.fromCharCode(10));
  const r = buildDayRollup({ killsText, battlesText: null, equipmentText });
  assert.equal(r.pv, 1);
  assert.deepEqual(r.px.A.p, piecesFromDay({ killsText, equipmentText }).A);
  assert.deepEqual(compactExtras(r.px.A).p, [['T8_HEAD_CLOTH_SET1', 2], ['T8_ARMOR_PLATE_SET1@1', 3], ['T8_SHOES_CLOTH_SET1', 3], ['T6_CAPEITEM_FW_MARTLOCK@1', 2]]);
  assert.equal(compactExtras(r.px.B)?.p, undefined); // arma sin tier completo: no cuenta
  const sum = mergeRollups([r, { px: { A: { m: [0, 0, 0, 0, 0, 0], h: [0, 0], w: {}, b: {}, l: [0, 0] } } }, r]); // día viejo sin p
  assert.equal(sum.px.A.p['5|T6_CAPEITEM_FW_MARTLOCK@1'], 4);
});

test('parte 59: una kill repetida en el archivo (mismo eventId) se cuenta UNA vez, también su equipo', () => {
  const k1 = JSON.stringify({ eventId: 7, battleId: 7, killerName: 'Ana', killerGuild: 'Lobos', victimName: 'Beto', victimGuild: 'Osos', totalFame: 500, participants: [{ name: 'Ana', guildName: 'Lobos', damageDone: 10, healingDone: 0 }] });
  const k2 = JSON.stringify({ eventId: 8, battleId: 8, killerName: 'Ana', killerGuild: 'Lobos', victimName: 'Caro', victimGuild: 'Osos', totalFame: 300, participants: [] });
  const eq = JSON.stringify({ e: 7, k: ['T8_2H_CLAYMORE@3', '', 'T8_HEAD_PLATE_SET1', 'T8_ARMOR_PLATE_SET1', 'T8_SHOES_PLATE_SET1', 'T6_CAPE', ''], v: ['T4_MAIN_SWORD', '', '', '', '', '', ''] });
  const r = buildDayRollup({ killsText: [k1, k1, k2, k1].join('\n'), battlesText: '', equipmentText: [eq, eq].join('\n') });
  assert.equal(r.players.Ana[P.KILLS], 2);
  assert.equal(r.players.Ana[P.KFAME], 800);
  assert.equal(r.players.Beto[P.DEATHS], 1);
  assert.equal(r.players.Ana[P.DAMAGE], 10);
  assert.equal(r.guilds.Lobos[G.KILLS], 2);
  const pieces = piecesFromDay({ killsText: [k1, k1].join('\n'), equipmentText: [eq, eq].join('\n') });
  assert.equal(Object.values(pieces.Ana).reduce((a, b) => a + b, 0), 4); // casco, pecho, botas, capa: una vez cada uno
});
