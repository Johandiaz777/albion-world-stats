import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildDayRollup, G, mergeRollups, P, rivalsByGuild, shardOf } from '../lib/rollup.mjs';

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
