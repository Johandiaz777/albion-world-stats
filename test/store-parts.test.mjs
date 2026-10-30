import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import zlib from 'node:zlib';

import { readJsonParts, writeJsonParts } from '../lib/store.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'acc-parts-'));

function sample(n) {
  const players = {};
  const px = {};
  for (let i = 0; i < n; i++) {
    players[`jugador ${i} ñ 名前`] = [i, i * 2, i % 7];
    px[`jugador ${i} ñ 名前`] = { w: { T4_MAIN_SWORD: [i, 1] }, s: `x${i}` };
  }
  return { players, guilds: { g: [1, 2, 3] }, px, weapons: {}, gw: true, list: [1, 2, 3] };
}

test('partes: leer lo escrito da el mismo objeto, con el mismo orden de claves', () => {
  const dir = tmp();
  const base = path.join(dir, 'a');
  const head = { v: 1, rv: 2, from: '2026-07-25', through: '2026-10-29' };
  const data = sample(500);
  const w = writeJsonParts(base, head, data, { maxChars: 4000 });
  assert.ok(w.parts > 5, `se esperaban varias partes, salieron ${w.parts}`);
  const r = readJsonParts(base, null);
  assert.equal(JSON.stringify(r.data), JSON.stringify(data));
  assert.deepEqual(r.head, head);
});

test('partes: ninguna parte pasa del tope de caracteres (salvo una sola entrada más grande que el tope)', () => {
  const dir = tmp();
  const base = path.join(dir, 'a');
  const maxChars = 3000;
  const w = writeJsonParts(base, {}, sample(400), { maxChars });
  for (let i = 0; i < w.parts; i++) {
    const text = zlib.gunzipSync(fs.readFileSync(`${base}.p${i}.json.gz`)).toString('utf8');
    const part = JSON.parse(text);
    const entries = part.o ? Object.keys(part.o).length : 1;
    if (entries > 1) assert.ok(text.length <= maxChars + 200, `parte ${i}: ${text.length} caracteres`);
  }
});

test('partes: se borran las partes sobrantes y el archivo viejo de un solo trozo', () => {
  const dir = tmp();
  const base = path.join(dir, 'a');
  const legacy = path.join(dir, 'a.json.gz');
  fs.writeFileSync(legacy, zlib.gzipSync('{"v":1}'));
  const w1 = writeJsonParts(base, {}, sample(300), { maxChars: 2000, legacyFile: legacy });
  assert.equal(fs.existsSync(legacy), false);
  const w2 = writeJsonParts(base, {}, sample(10), { maxChars: 2000 });
  assert.ok(w2.parts < w1.parts);
  assert.equal(fs.existsSync(`${base}.p${w2.parts}.json.gz`), false);
  assert.equal(JSON.stringify(readJsonParts(base, null).data), JSON.stringify(sample(10)));
});

test('partes: sin índice da undefined (se usa el formato viejo); una parte que falta o cambió da el valor por defecto', () => {
  const dir = tmp();
  const base = path.join(dir, 'a');
  assert.equal(readJsonParts(base, null), undefined);
  const w = writeJsonParts(base, {}, sample(300), { maxChars: 2000 });
  fs.appendFileSync(`${base}.p1.json.gz`, 'x');
  assert.equal(readJsonParts(base, 'defecto'), 'defecto');
  fs.rmSync(`${base}.p${w.parts - 1}.json.gz`);
  assert.equal(readJsonParts(base, 'defecto'), 'defecto');
});
