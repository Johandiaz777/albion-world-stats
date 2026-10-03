import assert from 'node:assert/strict';
import { test } from 'node:test';

import { battleGuildNames, buildNameIndex, killNames } from '../lib/name-index.mjs';
import { shardOf } from '../lib/rollup.mjs';

const line = (o) => JSON.stringify(o);

test('índice por nombre: posiciones en BYTES (acentos, CJK) que apuntan a la línea exacta', () => {
  const lines = [
    line({ eventId: 1, killerName: 'Ñandú', victimName: 'Beto', participants: [{ name: 'Caro' }] }),
    '<<<<<<< HEAD',
    line({ eventId: 2, killerName: 'Beto', victimName: '龍王' }),
    '',
    line({ eventId: 3, killerName: 'beto', victimName: 'Ñandú' }),
  ];
  const text = lines.join('\n');
  const buf = Buffer.from(text, 'utf8');
  const { bytes, shards } = buildNameIndex(text, killNames, 16);
  assert.equal(bytes, buf.length);

  const refs = (name) => shards[shardOf(name, 16)][name.toLowerCase()] ?? [];
  const read = (r) => {
    const out = [];
    for (let i = 0; i < r.length; i += 2) out.push(JSON.parse(buf.toString('utf8', r[i], r[i] + r[i + 1])).eventId);
    return out;
  };
  assert.deepEqual(read(refs('Ñandú')), [1, 3]);
  assert.deepEqual(read(refs('龍王')), [2]);
  // Sin distinguir mayúsculas: "Beto" y "beto" son la misma clave (la app filtra el exacto).
  assert.deepEqual(read(refs('BETO')), [1, 2, 3]);
  // Solo asesino y víctima: un participante no se indexa (la búsqueda no lo mostraría).
  assert.deepEqual(refs('Caro'), []);
});

test('peleas: se indexan por gremio', () => {
  const text = [line({ battleId: 9, guilds: [{ name: 'Lobos' }, { name: 'Osos' }] }), line({ battleId: 10, guilds: [{ name: 'Osos' }] })].join('\n');
  const { shards } = buildNameIndex(text, battleGuildNames, 4);
  assert.equal(shards[shardOf('Osos', 4)].osos.length, 4);
  assert.equal(shards[shardOf('Lobos', 4)].lobos.length, 2);
});

test('archivo vacío o nulo: índice vacío, sin errores', () => {
  const { bytes, shards } = buildNameIndex(null, killNames, 4);
  assert.equal(bytes, 0);
  assert.equal(shards.length, 4);
});

test('parte 59: una línea repetida (mismo eventId) se indexa una sola vez, la primera', () => {
  const line = JSON.stringify({ eventId: 5, killerName: 'Ana', victimName: 'Beto' });
  const other = JSON.stringify({ eventId: 6, killerName: 'Ana', victimName: 'Caro' });
  const text = [line, line, other].join('\n') + '\n';
  const { shards } = buildNameIndex(text, killNames, 256);
  const refs = shards[shardOf('Ana', 256)].ana;
  assert.deepEqual(refs, [0, Buffer.byteLength(line), 2 * (Buffer.byteLength(line) + 1), Buffer.byteLength(other)]);
});
