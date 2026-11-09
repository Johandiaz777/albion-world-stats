// Rehacer los días de Meta con la regla de asistencias y grupo (chat 180, lib/meta-redo.mjs).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addEventsToRollup, emptyMetaRollup } from '../lib/meta-core.mjs';
import { capRollup, CLOSED_CAPS, decodeIds, encodeIds } from '../lib/meta-build.mjs';
import { createMetaStore, memoryIo } from '../lib/meta-store.mjs';
import { joinKillsAndEquipment } from '../lib/meta.mjs';
import { redoRegion } from '../lib/meta-redo.mjs';

const W = ['T6_2H_CLAYMORE@1', 'T5_MAIN_SWORD', 'T7_2H_BOW@2', 'T4_MAIN_FIRESTAFF'];

/** Kills de un día: la mitad con 1 participante y grupo de 6 (antes «solo», ahora no). La última, a las 23:59:50, va en
 * el archivo del día siguiente (como hace el escáner). */
function dayLines(date, n, base) {
  const kills = [];
  const equipment = [];
  for (let i = 0; i < n; i++) {
    const id = base + i;
    const late = i === n - 1;
    const hh = late ? '23:59:50' : `${String(i % 23).padStart(2, '0')}:10:00`;
    kills.push({ eventId: id, timestamp: `${date}T${hh}.000000000Z`, participantsCount: 1, groupSize: i % 2 ? 6 : 1, totalFame: 1000 + i, killerName: `k${i % 5}`, killerGuild: 'G', victimName: `v${i}`, victimGuild: 'H', participants: [{ name: `k${i % 5}`, damageDone: 100 }] });
    equipment.push({ e: id, k: [W[i % 4], null, null, null, null, null, null], v: [W[(i + 1) % 4], null, null, null, null, null, null], kp: 1100, vp: 1000 });
  }
  return { kills, equipment };
}
const nd = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');

function setup() {
  const io = memoryIo();
  const store = createMetaStore(io, 'asia');
  const days = { '2026-10-05': dayLines('2026-10-05', 40, 1000), '2026-10-06': dayLines('2026-10-06', 30, 2000), '2026-10-07': dayLines('2026-10-07', 20, 3000) };
  // Archivos del escáner: la kill de las 23:59 de cada día está en el archivo del día siguiente.
  const files = { '2026-10-04': { kills: [], equipment: [] }, '2026-10-08': { kills: [], equipment: [] } };
  for (const d of Object.keys(days)) files[d] = { kills: [], equipment: [] };
  const next = { '2026-10-05': '2026-10-06', '2026-10-06': '2026-10-07', '2026-10-07': '2026-10-08' };
  for (const [d, { kills, equipment }] of Object.entries(days)) {
    files[d].kills.push(...kills.slice(0, -1));
    files[d].equipment.push(...equipment.slice(0, -1));
    files[next[d]].kills.push(kills.at(-1));
    files[next[d]].equipment.push(equipment.at(-1));
  }
  // Lo guardado con la regla vieja: «solo» = 1 participante (sin mirar el grupo). Se simula quitando el grupo.
  const oldRollup = (d) => {
    const { events } = joinKillsAndEquipment(days[d].kills.map((k) => ({ ...k, groupSize: undefined })), days[d].equipment);
    const r = emptyMetaRollup(d);
    addEventsToRollup(r, events);
    r.seen = [];
    return capRollup(r, CLOSED_CAPS);
  };
  store.finalizeDay({ v: 2, date: '2026-10-05', rev: 4, ids: '', rollup: oldRollup('2026-10-05') });
  const ids6 = new Set(days['2026-10-06'].kills.map((k) => k.eventId));
  store.writeDay({ v: 2, date: '2026-10-06', rev: 7, status: 'closed', ids: encodeIds(ids6), rollup: oldRollup('2026-10-06') });
  store.writeDay({ v: 2, date: '2026-10-07', rev: 2, status: 'open', ids: '', rollup: oldRollup('2026-10-07') });
  const readDayTexts = async (d) => (files[d] ? { kills: nd(files[d].kills), equipment: nd(files[d].equipment) } : { kills: '', equipment: '' });
  return { io, store, days, files, readDayTexts };
}

const soloOf = (rollup) => Object.values(rollup.weapons).reduce((n, t) => n + (t[2] ?? 0), 0);

test('rehace días final y cerrado con el grupo, sin perder kills; el abierto espera', async () => {
  const { store, readDayTexts } = setup();
  const before5 = store.readDay('2026-10-05');
  assert.equal(soloOf(before5.rollup), 40);
  const { state, done } = await redoRegion({ state: null, store, readDayTexts, from: '2026-10-05', to: '2026-10-07' });
  assert.deepEqual(done.waiting, ['2026-10-07']);
  assert.equal(done.short.length, 0);
  const d5 = store.readDay('2026-10-05');
  assert.equal(d5.status, 'final');
  assert.equal(d5.rev, 5);
  assert.equal(d5.rollup.samples, 40);
  assert.equal(soloOf(d5.rollup), 20); // los de grupo de 6 ya no son «solo»
  const d6 = store.readDay('2026-10-06');
  assert.equal(d6.status, 'closed');
  assert.equal(d6.rev, 8);
  assert.equal(d6.rollup.samples, 30);
  assert.equal(decodeIds(d6.ids).size, 30);
  assert.equal(state.dates['2026-10-05'].done, true);
  assert.equal(state.dates['2026-10-07'], undefined);
  // Segunda pasada: no rehace lo hecho.
  const again = await redoRegion({ state, store, readDayTexts, from: '2026-10-05', to: '2026-10-07' });
  assert.equal(again.done.redone.length, 0);
  assert.equal(store.readDay('2026-10-05').rev, 5);
});

test('si el archivo no trae todas las kills guardadas, el día NO se escribe', async () => {
  const { store, files, readDayTexts } = setup();
  files['2026-10-06'].kills.splice(3, 1);
  const { state, done } = await redoRegion({ state: null, store, readDayTexts, from: '2026-10-06', to: '2026-10-06' });
  assert.deepEqual(done.short, ['2026-10-06']);
  assert.equal(store.readDay('2026-10-06').rev, 7);
  assert.equal(state.dates['2026-10-06'].done, false);
});

test('un archivo que no se pudo bajar deja el día para la próxima', async () => {
  const { store, readDayTexts } = setup();
  const failing = async (d) => (d === '2026-10-06' ? null : readDayTexts(d));
  const { state, done } = await redoRegion({ state: null, store, readDayTexts: failing, from: '2026-10-05', to: '2026-10-05' });
  assert.deepEqual(done.missing, ['2026-10-05']);
  assert.equal(state.dates['2026-10-05'], undefined);
  assert.equal(store.readDay('2026-10-05').rev, 4);
});

test('sin escribir (medir) no toca el almacén', async () => {
  const { store, readDayTexts } = setup();
  const { done } = await redoRegion({ state: null, store, readDayTexts, from: '2026-10-05', to: '2026-10-06', write: false });
  assert.equal(done.redone.length, 2);
  assert.equal(store.readDay('2026-10-05').rev, 4);
  assert.equal(store.readDay('2026-10-06').rev, 7);
});
