// Meta Armory desde el escáner (parte 136, fase 2). Funciones puras, sin red ni disco.
//
// Hasta ahora Meta Armory salía de `sampleMetaArmory` (Firebase): cada 2 h pedía 16 páginas de eventos a la API de
// Albion, que solo deja ir 1.000 eventos hacia atrás, así que era una MUESTRA (~7.500 kills al día por servidor,
// medido el 30/10: 9 % de Europa y Américas, 20 % de Asia). El escáner de kills ya guarda TODAS las kills con el equipo
// de asesino y víctima (`kills/<día>.ndjson` + `equipment/<día>.ndjson`). Acá se rearma, para cada kill, el mismo
// evento de la API que lee `addEventsToRollup` (lib/meta-core.mjs, generado del código de Firebase), así los
// resúmenes salen con el mismo código y los mismos campos, pero con el 100 % de las kills.
//
// Lo que el escáner NO guarda igual que la API (medido contra la API real, ver docs del informe p136-fase2):
//  - La montura va sin tier ni encantamiento (`MOUNT_HORSE`, no `T3_MOUNT_HORSE`). Las familias de `items` salen
//    iguales (también van sin tier), pero el top de «Montura» y la montura de los ganadores no se pueden dibujar sin
//    tier: al publicar se quitan las monturas sin tier (`dropTierlessMounts`). Nada se borra de los resúmenes.
//  - El poder de objeto va redondeado. `items` ya lo redondeaba; el «duelo parejo» de Versus (diferencia <= 100) y
//    los IP de «últimos usos» pueden diferir en el borde.

import { META_SLOTS } from './meta-core.mjs';

/** Ítem con tier (`T5_MOUNT_ARMORED_HORSE`, `T8_2H_CLAYMORE@3`). */
const TIERED = /^T\d_/;

function equipmentObject(list) {
  const out = {};
  META_SLOTS.forEach((slot, i) => {
    const type = Array.isArray(list) ? list[i] : undefined;
    out[slot] = typeof type === 'string' && type ? { Type: type } : null;
  });
  return out;
}

const ipOf = (n) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined);

/** Evento con la forma de `/api/gameinfo/events` a partir de una línea de `kills` y su línea de `equipment` (mismo
 * `eventId`). Solo los campos que lee Meta Armory. */
export function eventFromLines(kill, equipment) {
  const participants = Array.isArray(kill.participants)
    ? kill.participants.filter((p) => p && typeof p === 'object').map((p) => ({ Name: p.name, DamageDone: p.damageDone }))
    : [];
  const event = {
    EventId: kill.eventId,
    TimeStamp: kill.timestamp,
    numberOfParticipants: kill.participantsCount,
    TotalVictimKillFame: kill.totalFame,
    Killer: { Name: kill.killerName, GuildName: kill.killerGuild, Equipment: equipmentObject(equipment.k) },
    Victim: { Name: kill.victimName, GuildName: kill.victimGuild, Equipment: equipmentObject(equipment.v) },
    Participants: participants,
  };
  const kp = ipOf(equipment.kp);
  const vp = ipOf(equipment.vp);
  if (kp !== undefined) event.Killer.AverageItemPower = kp;
  if (vp !== undefined) event.Victim.AverageItemPower = vp;
  return event;
}

/** Líneas completas de un trozo de NDJSON. Devuelve los objetos y cuántas líneas no se pudieron leer. */
export function parseNdjson(text) {
  const rows = [];
  let bad = 0;
  if (!text) return { rows, bad };
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      bad += 1;
    }
  }
  return { rows, bad };
}

/**
 * Junta kills con su equipo por `eventId`. Las que todavía no tienen pareja (el escáner sube los dos archivos juntos,
 * pero la copia en caché de GitHub de uno puede ir unos minutos detrás del otro) vuelven en `pendingKills` /
 * `pendingEquipment` para la próxima corrida. Nada se descarta acá.
 */
export function joinKillsAndEquipment(kills, equipment, pending = { kills: [], equipment: [] }) {
  const equipById = new Map();
  for (const e of [...(pending.equipment ?? []), ...equipment]) if (e && typeof e.e === 'number') equipById.set(e.e, e);
  const events = [];
  const pendingKills = [];
  const used = new Set();
  for (const k of [...(pending.kills ?? []), ...kills]) {
    if (!k || typeof k.eventId !== 'number' || typeof k.timestamp !== 'string') continue;
    if (used.has(k.eventId)) continue;
    const eq = equipById.get(k.eventId);
    if (!eq) {
      pendingKills.push(k);
      continue;
    }
    used.add(k.eventId);
    events.push(eventFromLines(k, eq));
  }
  const pendingEquipment = [...equipById.values()].filter((e) => !used.has(e.e));
  return { events, pending: { kills: pendingKills, equipment: pendingEquipment } };
}

/** Agrupa eventos por el día UTC de su `TimeStamp` (igual que `sampleMetaArmory`): una kill de las 23:59 que el
 * escáner guardó en el archivo del día siguiente cuenta en SU día. */
export function groupByDay(events) {
  const byDate = new Map();
  for (const e of events) {
    const date = typeof e?.TimeStamp === 'string' ? e.TimeStamp.slice(0, 10) : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const list = byDate.get(date) ?? [];
    list.push(e);
    byDate.set(date, list);
  }
  return byDate;
}

/** Ventana publicable: sin monturas sin tier (la app no puede dibujarlas). Devuelve una copia. */
export function dropTierlessMounts(window) {
  if (!window || typeof window !== 'object') return window;
  const out = { ...window };
  if (out.slots?.Mount) out.slots = { ...out.slots, Mount: out.slots.Mount.filter((m) => TIERED.test(m.id ?? '')) };
  if (Array.isArray(out.killers)) {
    out.killers = out.killers.map((k) => {
      const mount = k.slots?.Mount;
      if (typeof mount !== 'string' || TIERED.test(mount)) return k;
      const { Mount: _drop, ...rest } = k.slots;
      return { ...k, slots: rest };
    });
  }
  return out;
}

/** Lo mismo para un anillo de «últimos usos»: el rival con montura no importa (solo se guarda su arma). */
export function isTiered(type) {
  return typeof type === 'string' && TIERED.test(type);
}
