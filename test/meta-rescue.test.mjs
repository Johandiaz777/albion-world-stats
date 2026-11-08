// Rescate de las kills «perdidas» de Meta (chat 175, lib/meta-rescue.mjs).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addEventsToRollup, buildMetaWindow, emptyMetaRollup } from '../lib/meta-core.mjs';
import { createMetaStore, memoryIo } from '../lib/meta-store.mjs';
import { joinKillsAndEquipment } from '../lib/meta.mjs';
import { missingEquipmentIds, rescueRegion } from '../lib/meta-rescue.mjs';

const DATE = '2026-09-29';
const W = ['T6_2H_CLAYMORE@1', 'T5_MAIN_SWORD', 'T7_2H_BOW@2', 'T4_MAIN_FIRESTAFF'];
const A = ['T6_ARMOR_PLATE_SET1@1', 'T5_ARMOR_LEATHER_SET2', 'T8_ARMOR_CLOTH_SET3'];

/** Un día con `n` kills; las que cumplen `lost` no tienen línea de equipo (como antes de las 14 UTC del 29-sep). */
function day(n, lost) {
  const kills = [];
  const equipment = [];
  for (let i = 0; i < n; i++) {
    const id = 515_000_000 + i * 7;
    const hh = String(Math.floor((i / n) * 24)).padStart(2, '0');
    kills.push({ eventId: id, timestamp: `${DATE}T${hh}:10:00.000000000Z`, participantsCount: 1 + (i % 5), totalFame: 1000 + i * 37, killerName: `k${i % 9}`, killerGuild: 'G', victimName: `v${i}`, victimGuild: 'H', participants: [{ name: `k${i % 9}`, damageDone: 100 }] });
    equipment.push({ e: id, k: [W[i % 4], null, 'T5_HEAD_PLATE_SET1', A[i % 3], 'T5_SHOES_LEATHER_SET2', 'T4_CAPE', null], v: [W[(i + 1) % 4], null, null, A[(i + 2) % 3], null, null, null], kp: 1100, vp: 1000 });
  }
  // Una kill del día anterior en el archivo (23:59) y sin equipo: no es de este día.
  kills.push({ eventId: 514_999_999, timestamp: '2026-09-28T23:59:30.000000000Z', participantsCount: 1, totalFame: 5, killerName: 'x', killerGuild: '', victimName: 'y', victimGuild: '', participants: [] });
  const nd = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const kept = equipment.filter((_e, i) => !lost(i));
  return { kills, equipment, killsText: nd(kills), equipmentText: nd(kept) };
}

function setup(n, lost) {
  const d = day(n, lost);
  // Meta «completa» (como si el equipo hubiera estado siempre) y Meta como quedó (sin las perdidas).
  const allEvents = joinKillsAndEquipment(d.kills, d.equipment).events;
  const complete = emptyMetaRollup(DATE);
  addEventsToRollup(complete, allEvents);
  const keptIds = new Set(JSON.parse(`[${d.equipmentText.trim().split('\n').join(',')}]`).map((e) => e.e));
  const partial = emptyMetaRollup(DATE);
  addEventsToRollup(partial, allEvents.filter((e) => keptIds.has(e.EventId)));
  const io = memoryIo();
  const store = createMetaStore(io, 'asia');
  store.finalizeDay({ v: 2, date: DATE, rev: 3, status: 'final', rollup: partial });
  store.writeState({ v: 2, region: 'asia', files: {}, pending: { kills: [], equipment: [] }, lost: { kills: 99, equipment: 0 } });
  // La API devuelve el evento en la forma de siempre.
  const byId = new Map(allEvents.map((e) => [e.EventId, e]));
  return { d, complete, store, byId };
}

/** Misma ventana sin depender del orden de los empates (lo rescatado entra después y desempata distinto). */
const canon = (v) => (Array.isArray(v) ? v.map(canon).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort().map(([k, x]) => [k, canon(x)])) : v);
const same = (a, b) => assert.deepEqual(canon(buildMetaWindow([a])), canon(buildMetaWindow([b])));

const at = () => {
  let t = 0;
  return { now: () => t, wait: async (ms) => void (t += ms), deadline: (ms) => ms };
};

test('missingEquipmentIds: solo las kills del día sin línea de equipo', () => {
  const d = day(10, (i) => i < 4);
  const ids = missingEquipmentIds(d.killsText, d.equipmentText, DATE);
  assert.deepEqual(ids, d.kills.slice(0, 4).map((k) => k.eventId));
  // Sin fecha también entra la del día anterior.
  assert.equal(missingEquipmentIds(d.killsText, d.equipmentText).length, 5);
});

test('después del rescate el día es IGUAL al que hubiera sido con todo el equipo, y el contador baja', async () => {
  const { d, complete, store, byId } = setup(40, (i) => i % 3 === 0);
  const clock = at();
  const fetchEvent = async (id) => ({ status: 200, event: structuredClone(byId.get(id)) });
  const { state, done } = await rescueRegion({ state: null, store, readDayTexts: async () => ({ kills: d.killsText, equipment: d.equipmentText }), fetchEvent, deadline: 1e9, now: clock.now, wait: clock.wait });
  assert.equal(done.added, 14);
  assert.equal(state.dates[DATE].finished, true);
  const after = store.readDay(DATE);
  assert.equal(after.rev, 4);
  same(after.rollup, complete);
  assert.equal(store.readState().lost.kills, 99 - 14);
  assert.equal(store.readState().lost.rescued, 14);
  // Otra pasada no suma nada (nunca dos veces).
  const again = await rescueRegion({ state, store, readDayTexts: async () => assert.fail('no vuelve a bajar'), fetchEvent: async () => assert.fail('no vuelve a pedir'), deadline: 1e9, now: clock.now, wait: clock.wait });
  assert.equal(again.done.added, 0);
  same(store.readDay(DATE).rollup, complete);
});

test('despacio y con tope: sigue donde quedó en la corrida siguiente', async () => {
  const { d, complete, store, byId } = setup(30, (i) => i < 10);
  const clock = at();
  const fetchEvent = async (id) => ({ status: 200, event: structuredClone(byId.get(id)) });
  const texts = async () => ({ kills: d.killsText, equipment: d.equipmentText });
  // 1.200 ms entre pedidos: con 4.000 ms de tope entran 4.
  const first = await rescueRegion({ state: null, store, readDayTexts: texts, fetchEvent, deadline: 4000, now: clock.now, wait: clock.wait });
  assert.equal(first.done.asked, 4);
  assert.equal(first.state.dates[DATE].todo.length, 6);
  const second = await rescueRegion({ state: first.state, store, readDayTexts: texts, fetchEvent, deadline: 1e9, now: clock.now, wait: clock.wait });
  assert.equal(second.done.added, 6);
  same(store.readDay(DATE).rollup, complete);
});

test('429 corta hasta la próxima corrida; 404 y 5 fallos se dejan sin frenar al resto', async () => {
  const { d, store, byId } = setup(12, (i) => i < 6);
  const ids = d.kills.slice(0, 6).map((k) => k.eventId);
  const clock = at();
  const texts = async () => ({ kills: d.killsText, equipment: d.equipmentText });
  let calls = 0;
  const throttled = async () => (++calls === 3 ? { status: 429 } : { status: 200, event: structuredClone(byId.get(ids[calls - 1])) });
  const r1 = await rescueRegion({ state: null, store, readDayTexts: texts, fetchEvent: throttled, deadline: 1e9, now: clock.now, wait: clock.wait });
  assert.equal(r1.done.throttled, true);
  assert.equal(r1.done.added, 2);
  assert.equal(r1.state.dates[DATE].todo[0], ids[2]); // el del 429 no se pierde
  const failing = async (id) => (id === ids[2] ? { status: 404 } : id === ids[3] ? { status: 0, error: 'red' } : { status: 200, event: structuredClone(byId.get(id)) });
  const r2 = await rescueRegion({ state: r1.state, store, readDayTexts: texts, fetchEvent: failing, deadline: 1e9, now: clock.now, wait: clock.wait });
  assert.equal(r2.state.dates[DATE].gone, 2); // el 404 y el que falló 5 veces
  assert.equal(r2.state.dates[DATE].finished, true);
  assert.equal(r1.done.added + r2.done.added, 4);
});

test('un día sin faltantes queda terminado sin pedir nada', async () => {
  const { d, store } = setup(8, () => false);
  const r = await rescueRegion({ state: null, store, readDayTexts: async () => ({ kills: d.killsText, equipment: d.equipmentText }), fetchEvent: async () => assert.fail('nada que pedir'), deadline: 1e9 });
  assert.equal(r.state.dates[DATE].finished, true);
  assert.equal(r.state.dates[DATE].total, 0);
});

test('si la subida del día rescatado falla, sus ids vuelven a la fila y el contador se corrige', async () => {
  const { d, complete, store, byId } = setup(20, (i) => i < 5);
  const clock = at();
  const texts = async () => ({ kills: d.killsText, equipment: d.equipmentText });
  const fetchEvent = async (id) => ({ status: 200, event: structuredClone(byId.get(id)) });
  const snapshot = structuredClone(store.readDay(DATE));
  const r1 = await rescueRegion({ state: null, store, readDayTexts: texts, fetchEvent, deadline: 1e9, now: clock.now, wait: clock.wait });
  assert.equal(r1.done.added, 5);
  assert.equal(store.readState().lost.kills, 94);
  // Simula que la rama `rollups` no se subió: el día vuelve a la revisión publicada (sin lo rescatado).
  store.finalizeDay(snapshot);
  const r2 = await rescueRegion({ state: r1.state, store, readDayTexts: texts, fetchEvent, deadline: 1e9, now: clock.now, wait: clock.wait });
  assert.equal(r2.done.added, 5);
  assert.equal(store.readState().lost.kills, 94);
  assert.equal(r2.state.dates[DATE].added, 5);
  same(store.readDay(DATE).rollup, complete);
  // La siguiente confirma y no hace nada más.
  const r3 = await rescueRegion({ state: r2.state, store, readDayTexts: texts, fetchEvent: async () => assert.fail('nada que pedir'), deadline: 1e9, now: clock.now, wait: clock.wait });
  assert.equal(r3.state.dates[DATE].unconfirmed, undefined);
  assert.equal(r3.done.added, 0);
});

test('por pelea: 51 por pedido, solo las perdidas; la que la pelea no trae va por id; el día queda igual', async () => {
  // 120 kills: las 90 primeras en la pelea 7 (2 páginas de lo perdido), 4 en la pelea 8, el resto sueltas.
  const base = day(120, (i) => i < 100);
  base.kills.forEach((k, i) => {
    if (i < 90) k.battleId = 7;
    else if (i < 94) k.battleId = 8;
  });
  const nd = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const d = { ...base, killsText: nd(base.kills) };
  const allEvents = joinKillsAndEquipment(d.kills, d.equipment).events;
  const complete = emptyMetaRollup(DATE);
  addEventsToRollup(complete, allEvents);
  const kept = new Set(allEvents.slice(100).map((e) => e.EventId));
  const partial = emptyMetaRollup(DATE);
  addEventsToRollup(partial, allEvents.filter((e) => kept.has(e.EventId)));
  const store = createMetaStore(memoryIo(), 'asia');
  store.finalizeDay({ v: 2, date: DATE, rev: 1, status: 'final', rollup: partial });
  const byId = new Map(allEvents.map((e) => [e.EventId, e]));
  // La API: la pelea 7 trae sus 90 kills MENOS una (la 5), de a 51.
  const battle7 = allEvents.slice(0, 90).filter((_e, i) => i !== 5);
  const calls = { battle: 0, event: 0 };
  const fetchBattle = async (id, offset) => {
    calls.battle += 1;
    const list = id === 7 ? battle7 : allEvents.slice(90, 94);
    return { status: 200, events: structuredClone(list.slice(offset, offset + 51)) };
  };
  const fetchEvent = async (id) => {
    calls.event += 1;
    return { status: 200, event: structuredClone(byId.get(id)) };
  };
  const clock = at();
  const r = await rescueRegion({ state: null, store, readDayTexts: async () => ({ kills: d.killsText, equipment: d.equipmentText }), fetchEvent, fetchBattle, deadline: 1e9, now: clock.now, wait: clock.wait });
  assert.equal(r.done.added, 100);
  assert.equal(calls.battle, 3); // pelea 7: 2 páginas; pelea 8: 1
  assert.equal(calls.event, 7); // la 5 de la pelea 7 + las 6 sueltas (94..99)
  same(store.readDay(DATE).rollup, complete);
  assert.equal(r.state.dates[DATE].finished, true);
});
