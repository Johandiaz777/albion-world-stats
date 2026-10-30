// Pruebas de la copia local de los archivos del escáner (lib/raw-cache.mjs), con un `fetch` falso que entiende
// `Range` (el mismo de test/meta-build.test.mjs). Parte 138: Rankings desde stats-builder.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { pruneRawCache, syncDayText } from '../lib/raw-cache.mjs';

function fakeServer() {
  const files = new Map();
  const calls = [];
  const opts = { ignoreRange: false, fail: new Set() };
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, range: init.headers?.Range ?? null });
    if (opts.fail.has(url)) throw new Error('red');
    const body = files.get(url);
    const resp = (status, buf, headers = {}) => ({
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (k) => headers[k.toLowerCase()] ?? null },
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length),
    });
    if (!body) return resp(404, Buffer.from('404'));
    const range = init.headers?.Range;
    if (!range || opts.ignoreRange) return resp(200, body);
    const start = Number(/bytes=(\d+)-/.exec(range)[1]);
    if (start >= body.length) return resp(416, Buffer.alloc(0));
    return resp(206, body.subarray(start), { 'content-range': `bytes ${start}-${body.length - 1}/${body.length}` });
  };
  return { files, calls, opts, fetchImpl };
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rawcache-'));
const MONTHLY = 'https://raw.test/mensual/kills/2026-10-30.ndjson';
const LEGACY = 'https://raw.test/historico/kills/2026-10-30.ndjson';
const urls = [MONTHLY, LEGACY];
const lines = (from, to) => Buffer.from(Array.from({ length: to - from }, (_, i) => JSON.stringify({ eventId: from + i, x: 'é'.repeat(i % 5) })).join('\n') + '\n');
const sync = (dir, srv, extra = {}) => syncDayText({ dir, region: 'asia', type: 'kills', date: '2026-10-30', fetchImpl: srv.fetchImpl, urls, ...extra });

test('un archivo que crece por trozos (cortes a mitad de línea) queda igual al archivo entero', async () => {
  const dir = tmpDir();
  const srv = fakeServer();
  const full = lines(0, 400);
  const st = { bytes: 0, mismatches: 0, fullDownloads: 0, files: {} };
  let text;
  for (const cut of [37, 1000, 1001, 5000, 9000, full.length]) {
    srv.files.set(MONTHLY, full.subarray(0, cut));
    text = await sync(dir, srv, { stats: st });
    // Solo líneas completas: nunca media línea.
    assert.ok(text === '' || text.endsWith('\n'));
    assert.ok(full.toString('utf8').startsWith(text));
  }
  assert.equal(text, full.toString('utf8'));
  // Se bajó una sola vez cada byte (más los 256 de comprobación del final en cada relectura, que no se cuentan).
  assert.equal(st.bytes, full.length);
  assert.equal(st.fullDownloads, 1);
  assert.equal(st.files['kills/2026-10-30'].url, MONTHLY);
  assert.equal(st.files['kills/2026-10-30'].bytes, full.length);
  // Siempre el mensual; en cuanto hay algo guardado, con Range (el primer corte, 37 bytes, no traía ninguna línea entera).
  assert.ok(srv.calls.every((c) => c.url === MONTHLY));
  assert.ok(srv.calls.slice(2).every((c) => /^bytes=\d+-$/.test(c.range)));
  // Sin nada nuevo: un pedido y el mismo texto.
  const before = srv.calls.length;
  assert.equal(await sync(dir, srv, { stats: st }), full.toString('utf8'));
  assert.equal(srv.calls.length, before + 1);
});

test('404 en el mensual: lee el histórico; si el mensual aparece después, pasa al mensual (como la función)', async () => {
  const dir = tmpDir();
  const srv = fakeServer();
  srv.files.set(LEGACY, lines(0, 50));
  assert.equal(await sync(dir, srv), lines(0, 50).toString('utf8'));
  // Crece el histórico: incremental sobre el histórico (el mensual sigue en 404).
  srv.files.set(LEGACY, lines(0, 80));
  const st = { bytes: 0, mismatches: 0, fullDownloads: 0 };
  assert.equal(await sync(dir, srv, { stats: st }), lines(0, 80).toString('utf8'));
  assert.equal(st.fullDownloads, 0);
  // Aparece el mensual: la función lo leería primero; la copia también.
  srv.files.set(MONTHLY, lines(1000, 1010));
  assert.equal(await sync(dir, srv), lines(1000, 1010).toString('utf8'));
  // Ninguno: null (día sin datos todavía).
  const empty = fakeServer();
  assert.equal(await syncDayText({ dir: tmpDir(), region: 'asia', type: 'kills', date: '2026-10-30', fetchImpl: empty.fetchImpl, urls }), null);
});

test('cambio por dentro de lo ya leído: se baja entero', async () => {
  const dir = tmpDir();
  const srv = fakeServer();
  srv.files.set(MONTHLY, lines(0, 100));
  await sync(dir, srv);
  srv.files.set(MONTHLY, lines(500, 700));
  const st = { bytes: 0, mismatches: 0, fullDownloads: 0 };
  assert.equal(await sync(dir, srv, { stats: st }), lines(500, 700).toString('utf8'));
  assert.equal(st.mismatches, 1);
  assert.equal(st.fullDownloads, 1);
});

test('servidor que ignora Range: sigue saliendo igual', async () => {
  const dir = tmpDir();
  const srv = fakeServer();
  srv.opts.ignoreRange = true;
  srv.files.set(MONTHLY, lines(0, 30));
  await sync(dir, srv);
  srv.files.set(MONTHLY, lines(0, 90));
  assert.equal(await sync(dir, srv), lines(0, 90).toString('utf8'));
});

test('red caída: lanza (la región no se publica) y la copia local no se toca', async () => {
  const dir = tmpDir();
  const srv = fakeServer();
  srv.files.set(MONTHLY, lines(0, 20));
  await sync(dir, srv);
  srv.opts.fail.add(MONTHLY);
  await assert.rejects(() => sync(dir, srv), /no respondió/);
  srv.opts.fail.clear();
  assert.equal(await sync(dir, srv), lines(0, 20).toString('utf8'));
  // También en la primera bajada.
  const srv2 = fakeServer();
  srv2.opts.fail.add(MONTHLY);
  await assert.rejects(() => syncDayText({ dir: tmpDir(), region: 'asia', type: 'kills', date: '2026-10-30', fetchImpl: srv2.fetchImpl, urls }), /no respondió/);
});

test('sin withParts (Rankings, como la función) no pide ni suma la parte .2', async () => {
  const dir = tmpDir();
  const srv = fakeServer();
  const big = 'https://raw.test/albion-data-asia-2026-10/main/kills/2026-10-30.ndjson';
  srv.files.set(big, lines(0, 10));
  srv.files.set(big.replace('.ndjson', '.2.ndjson'), lines(10, 20));
  // Con un archivo chico no se buscan partes (como sources.mjs): solo con el tope.
  const a = await syncDayText({ dir, region: 'asia', type: 'kills', date: '2026-10-30', fetchImpl: srv.fetchImpl, urls: [big], withParts: false });
  assert.equal(a, lines(0, 10).toString('utf8'));
  assert.ok(srv.calls.every((c) => !c.url.includes('.2.ndjson')));
});

test('pruneRawCache borra solo los días que ya no se usan', async () => {
  const dir = tmpDir();
  for (const d of ['2026-10-20', '2026-10-29', '2026-10-30']) {
    fs.mkdirSync(path.join(dir, 'asia', 'kills'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'asia', 'kills', `${d}.ndjson`), 'x');
    fs.writeFileSync(path.join(dir, 'asia', 'kills', `${d}.ndjson.url`), 'u');
  }
  assert.equal(pruneRawCache(dir, ['2026-10-29', '2026-10-30']), 2);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'asia', 'kills')).sort(), ['2026-10-29.ndjson', '2026-10-29.ndjson.url', '2026-10-30.ndjson', '2026-10-30.ndjson.url']);
});
