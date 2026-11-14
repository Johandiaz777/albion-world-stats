import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fightBackfillDays, FIGHT_BACKFILL_PER_RUN, LOOT_FIRST_DAY } from '../lib/rollup.mjs';

// Hallazgo 102 (chat 205): al rehacer la rama index, los días cerrados quedaron sin `fights/` y la app no mostraba plata.
const days = ['2026-10-14', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08'];
const conPeleas = new Set(['2026-11-07', '2026-11-08']);
const base = { days, hasFights: (d) => conPeleas.has(d), hasRollup: () => true };

test('elige los días sin peleas, del más nuevo al más viejo, con tope por corrida', () => {
  assert.equal(FIGHT_BACKFILL_PER_RUN, 2);
  assert.deepEqual(fightBackfillDays(base), ['2026-11-06', '2026-11-05']);
  assert.deepEqual(fightBackfillDays({ ...base, max: 10 }), ['2026-11-06', '2026-11-05', '2026-11-04', '2026-10-14']);
});

test('no repite lo que la corrida acaba de rehacer ni días sin resumen', () => {
  assert.deepEqual(fightBackfillDays({ ...base, built: ['2026-11-06'], hasRollup: (d) => d !== '2026-11-05' }), ['2026-11-04', '2026-10-14']);
});

test('nada antes de que hubiera plata ni nada si ya están todos', () => {
  assert.deepEqual(fightBackfillDays({ ...base, days: ['2026-09-20', LOOT_FIRST_DAY], max: 5 }), [LOOT_FIRST_DAY]);
  assert.deepEqual(fightBackfillDays({ ...base, hasFights: () => true }), []);
});
