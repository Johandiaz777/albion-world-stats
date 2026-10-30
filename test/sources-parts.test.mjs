import assert from 'node:assert/strict';
import { test } from 'node:test';

import { candidateUrls, dayFileBaseBytes, dayFileSize, fetchDayFile, partUrl } from '../lib/sources.mjs';

// Parte 136: el escáner sigue en `<día>.2.ndjson`, `.3`... cuando el archivo del día llega a 90 MB.
function fakeFetch(files, failing = new Set()) {
  return async (url, opts = {}) => {
    if (failing.has(url)) throw new Error('red');
    if (!(url in files)) return new Response('no', { status: 404 });
    const body = files[url];
    if (opts.headers?.Range) return new Response(body.slice(0, 1), { status: 206, headers: { 'content-range': `bytes 0-0/${Buffer.byteLength(body)}` } });
    return new Response(body, { status: 200 });
  };
}

test('partes: el día se arma con el archivo de siempre y sus partes, en orden; el índice usa solo el primero', async (t) => {
  const [mensual] = candidateUrls('kills', 'americas', '2026-11-03');
  const files = { [mensual]: '{"eventId":1}\n{"eventId":2}\n', [partUrl(mensual, 2)]: '{"eventId":3}\n', [partUrl(mensual, 3)]: '{"eventId":4}' };
  t.mock.method(globalThis, 'fetch', fakeFetch(files));
  const text = await fetchDayFile('kills', 'americas', '2026-11-03', null);
  assert.equal(text, '{"eventId":1}\n{"eventId":2}\n{"eventId":3}\n{"eventId":4}\n');
  assert.equal(dayFileBaseBytes('kills', 'americas', '2026-11-03'), Buffer.byteLength(files[mensual]));
  assert.equal(await dayFileSize('kills', 'americas', '2026-11-03'), Object.values(files).reduce((s, f) => s + Buffer.byteLength(f), 0));
});

test('partes: sin partes todo queda como antes (mismo texto, sin marca de bytes)', async (t) => {
  const [mensual] = candidateUrls('kills', 'europe', '2026-11-04');
  const files = { [mensual]: '{"eventId":1}\n' };
  t.mock.method(globalThis, 'fetch', fakeFetch(files));
  assert.equal(await fetchDayFile('kills', 'europe', '2026-11-04', null), files[mensual]);
  assert.equal(dayFileBaseBytes('kills', 'europe', '2026-11-04'), undefined);
  assert.equal(await dayFileSize('kills', 'europe', '2026-11-04'), Buffer.byteLength(files[mensual]));
});

test('partes: si una parte no se pudo bajar, el día no se da por completo (null)', async (t) => {
  const [mensual] = candidateUrls('kills', 'asia', '2026-11-05');
  const files = { [mensual]: '{"eventId":1}\n', [partUrl(mensual, 2)]: '{"eventId":2}\n' };
  t.mock.method(globalThis, 'fetch', fakeFetch(files, new Set([partUrl(mensual, 2)])));
  t.mock.method(globalThis, 'setTimeout', (fn) => { fn(); return 0; });
  assert.equal(await fetchDayFile('kills', 'asia', '2026-11-05', null), null);
});

test('partes: el repo histórico (antes del 01/10) no busca partes', async (t) => {
  const [legado] = candidateUrls('kills', 'asia', '2026-09-10');
  const pedidos = [];
  const base = fakeFetch({ [legado]: '{"eventId":1}\n' });
  t.mock.method(globalThis, 'fetch', (url, o) => { pedidos.push(url); return base(url, o); });
  assert.equal(await fetchDayFile('kills', 'asia', '2026-09-10', null), '{"eventId":1}\n');
  assert.deepEqual(pedidos, [legado]);
});
