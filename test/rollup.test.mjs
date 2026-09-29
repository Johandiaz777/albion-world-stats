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
  assert.deepEqual(rivals.Lobos[0], ['Osos', 1, 1, 0]);
  assert.deepEqual(rivals.Osos[0], ['Lobos', 1, 0, 1]);
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
