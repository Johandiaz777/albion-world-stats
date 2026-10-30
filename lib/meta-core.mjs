// GENERADO por scripts/generar-meta-core.mjs: NO editar a mano.
// Fuente: functions/src/meta-armory.ts (repo Albion World), parte pura, sha256 68e76f00a0eda404.
// Es el mismo código que usa `sampleMetaArmory`, sin los tipos.
export const META_SLOTS = ['MainHand', 'OffHand', 'Head', 'Armor', 'Shoes', 'Cape', 'Mount'];
/** Igual que `BUILD_SLOTS` de `src/utils/meta-armory.ts`: la montura no define la build. */
const BUILD_SLOTS = ['MainHand', 'OffHand', 'Head', 'Armor', 'Shoes', 'Cape'];
const PAGE_SIZE = 51; // máximo real que acepta /api/gameinfo/events
/** Parte 115 (pedido del dueño: el meta era el 42 % del costo de Functions): una corrida por hora en vez de
 * cada 30 min, con el doble de páginas: la misma muestra por hora (~400 kills por servidor) con la mitad de
 * arranques, lecturas de resúmenes y escrituras (y de disparos de `validateUploadedImage` por los anillos).
 * Parte 136 (costos v3 §3, decisión del dueño): una corrida cada 2 h con 16 páginas. Las páginas del DÍA no cambian
 * (8 × 24 = 16 × 12 = 192 por servidor): la muestra diaria queda del mismo tamaño y solo se mira 12 veces al día en vez
 * de 24. Baja a la mitad los arranques, las lecturas y escrituras de los resúmenes, los anillos de `meta-recent` y los
 * disparos de `validateUploadedImage`. La última página pide `offset` 765, por debajo del tope de 1.000 de la API. */
export const PAGES_PER_RUN = 16;
const REQUEST_TIMEOUT_MS = 12_000;
/** Topes al guardar un día: acota el archivo (y la memoria al sumar meses) sin afectar el top 25.
 * El tope de builds se queda en 800 (no sube a 1200): en el peor caso con todo lleno
 * (slots 7x400x~60 B≈168 KB + builds 800x~300 B≈240 KB + killers 300x~120 B≈36 KB +
 * matchups 3000x~60 B≈180 KB + weapons 300x~60 B≈18 KB + seen 25000x~9 B≈225 KB +
 * items 1500x~75 B≈112 KB) el día queda en ~979 KB < 1 MB; con 1200 builds sumaría
 * ~120 KB más y pasaría 1 MB, así que no se sube. */
const ROLLUP_SLOT_CAP = 400;
const ROLLUP_BUILD_CAP = 800;
/** Top de familias de piezas en `items` por uso total (suma de índices 0..7). 1500x~75 B≈112 KB. */
const ROLLUP_ITEM_CAP = 1500;
const ROLLUP_KILLER_CAP = 300;
/** Tope de pares arma-contra-arma por día (por kills) y por ventana publicada en Firestore.
 * Parte 90: el día subió de 3.000 a 6.000. El resumen del día se relee y se recorta en CADA corrida
 * (cada 30 min), así que con más pares que el tope los raros se borraban y volvían a empezar de 1
 * todo el día (contaban de menos). Cada par extra pesa ~45 B en el archivo del día (6.000 = ~270 KB
 * en el peor caso). El doc de Firestore sigue con 1.500 (las versiones viejas de la app lo leen); la
 * tabla COMPLETA va al archivo `meta-detail/{region}/versus-{ventana}.json`. */
const ROLLUP_MATCHUP_CAP = 6000;
const MATCHUP_WINDOW_TOP = 1500;
/** Tope de armas distintas con métricas por día (por uso = kills+muertes) y armas publicadas por
 * ventana. 100 entradas de ~70 B ≈ 7 KB por ventana: el doc `meta_armory/{region}` (day+week en
 * cada corrida, month/all en la pesada) crece ~15-30 KB y sigue lejos del límite de 1 MiB. */
const ROLLUP_WEAPON_CAP = 300;
const WINDOW_WEAPONS_N = 100;
/** Topes del archivo de detalle `meta-detail/{region}/{window}.json`: 900 familias por uso,
 * 150 armas por uso en items, hasta 6 configuraciones por arma con al menos 2 usos. */
const DETAIL_ITEMS_TOP = 900;
const DETAIL_WEAPONS_TOP = 150;
const DETAIL_BUILDS_PER_WEAPON = 6;
const DETAIL_BUILD_MIN_USE = 2;
/** cacheControl del detalle (igual que `meta-recent`): la app lo lee por URL. Parte 136 (costos v3 §5): 30 min (antes
 * 5). Los archivos se rehacen cada 2 h (`META_SCHEDULE`), así que un teléfono que ya lo bajó lo reutiliza en vez de
 * pedirlo de nuevo; lo peor que pasa es ver la versión anterior hasta 30 min más. Nada se pierde: la próxima lectura
 * pasada la media hora trae la nueva. Exportado para las pruebas. */
export const DETAIL_CACHE_CONTROL = 'public, max-age=1800';
/** Anillo de últimos usos por arma en `meta-recent/{region}/{arma}.json`: 50 usos de ~180 B ≈
 * 9-10 KB por archivo, siempre por debajo de 15 KB. cacheControl de 30 min para la app (parte 136; antes 5 min):
 * el anillo cambia como mucho cada 2 h. */
const RECENT_USES_CAP = 50;
export const RECENT_CACHE_CONTROL = 'public, max-age=1800';
/** Clave de arma válida para el nombre del archivo (`weaponBase`: letras, dígitos y `_`). */
const RECENT_KEY_RE = /^[A-Za-z0-9_]{1,64}$/;
const WINDOW_KILLERS_N = 10;
const ROLLUP_SEEN_CAP = 25_000;
const WINDOW_TOP_N = 25;
const READ_CONCURRENCY = 8;
/** Parte 115: lecturas/escrituras de los anillos `meta-recent` en vuelo a la vez. Antes iban de a una
 * (3 idas y vueltas a Storage por arma, ~50 armas por servidor): ~20 s de cada corrida de ~2 min. */
const RECENT_CONCURRENCY = 8;
/** Storage respondió "no existe" (404): no es un error pasajero. */
export function isNotFound(err) {
    return err?.code === 404;
}
/** Corre `fn` sobre cada elemento con a lo sumo `limit` en vuelo; los errores quedan dentro de `fn`. */
async function forEachWithConcurrency(items, limit, fn) {
    const queue = [...items];
    await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
        for (let item = queue.shift(); item !== undefined; item = queue.shift())
            await fn(item);
    }));
}
const HOSTS = {
    // Europa es el servidor de Ámsterdam (`-ams`); hasta 2026-09-29 estaban cruzados.
    europe: 'https://gameinfo-ams.albiononline.com',
    americas: 'https://gameinfo.albiononline.com',
    asia: 'https://gameinfo-sgp.albiononline.com',
};
const REGIONS = Object.keys(HOSTS);
/** Días que representa un resumen: 1 el diario, `days` el mes compactado. */
function rollupDays(rollup) {
    return typeof rollup.days === 'number' && rollup.days > 0 ? rollup.days : 1;
}
/** Días distintos de una lista (varios servidores pueden traer el mismo día o el mismo mes: cuenta
 * una vez, con la mayor cantidad de días de ese mes). */
function distinctDays(rollups) {
    const byKey = new Map();
    for (const r of rollups) {
        if (typeof r.date !== 'string')
            continue;
        const key = r.days ? `m:${r.date.slice(0, 7)}` : r.date;
        byKey.set(key, Math.max(byKey.get(key) ?? 0, rollupDays(r)));
    }
    let n = 0;
    for (const v of byKey.values())
        n += v;
    return n;
}
function emptySlots(make) {
    return Object.fromEntries(META_SLOTS.map((s) => [s, make()]));
}
export function emptyMetaRollup(date) {
    return { version: 1, date, samples: 0, seen: [], slots: emptySlots(() => ({})), builds: {}, killers: {}, weapons: {} };
}
/** Id base sin encantamiento (`T6_2H_CLAYMORE@2` → `T6_2H_CLAYMORE`), igual que el cliente. */
function baseOf(type) {
    return type.split('@')[0];
}
/** Arma base para los cruces (`T8_2H_CROSSBOWLARGE@3` → '2H_CROSSBOWLARGE'). Sin arma → null. */
export function weaponBase(type) {
    if (typeof type !== 'string' || type.length === 0)
        return null;
    const noEnchant = type.split('@')[0];
    if (!noEnchant)
        return null;
    const base = noEnchant.replace(/^T\d_/, '');
    return base || null;
}
/** Familia de cualquier pieza (`T6_2H_CLAYMORE@2` → '2H_CLAYMORE';
 * `T5_HEAD_PLATE_SET1` → 'HEAD_PLATE_SET1'). Misma regla que `weaponBase`. */
export function familyOf(type) {
    return weaponBase(type);
}
/** Bucket de tamaño de pelea según `numberOfParticipants`: 1 → 0, 2-5 → 1, 6-10 → 2,
 * 11 o más → 3. Cualquier otro valor (ausente, no entero o < 1) → null: quien llama
 * decide si lo rescata (un solo `Participant`) o si el evento no suma en `items`. */
export function fightSizeBucket(n) {
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1)
        return null;
    if (n === 1)
        return 0;
    if (n <= 5)
        return 1;
    if (n <= 10)
        return 2;
    return 3;
}
/** Nivel de encantamiento del id (`T6_2H_CLAYMORE@2` → '2'; sin `@` → '0'). */
export function enchantOf(type) {
    const m = /@(\d)$/.exec(type);
    return m ? m[1] : '0';
}
function addEnchant(target, enchant, count) {
    const e = (target.e ??= {});
    e[enchant] = (e[enchant] ?? 0) + count;
}
/** Daño del asesino en Participants (por nombre; si hay un solo participante, es él). null si
 * la API no lo trae: el promedio entonces queda null, nunca 0 inventado. */
function killerDamageDone(event) {
    const parts = event.Participants;
    if (!Array.isArray(parts) || parts.length === 0)
        return null;
    const name = event.Killer?.Name;
    const mine = (typeof name === 'string' && name.length > 0 ? parts.find((p) => p?.Name === name) : undefined) ??
        (parts.length === 1 ? parts[0] : undefined);
    const dmg = mine?.DamageDone;
    return typeof dmg === 'number' && Number.isFinite(dmg) && dmg >= 0 ? dmg : null;
}
function weaponBucket(rollup, weapon) {
    const bucket = (rollup.weapons ??= {});
    return (bucket[weapon] ??= [0, 0, 0, 0, 0, 0, 0]);
}
/** Suma una kill con el arma: en solitario (`numberOfParticipants === 1`) o en grupo, más el
 * daño del asesino y la fama cuando la API los trae. */
function addWeaponKill(rollup, killerWeapon, event) {
    const cur = weaponBucket(rollup, killerWeapon);
    cur[0] += 1;
    if (event.numberOfParticipants === 1)
        cur[2] += 1;
    else
        cur[3] += 1;
    const dmg = killerDamageDone(event);
    if (dmg !== null) {
        cur[4] += dmg;
        cur[5] += 1;
    }
    const fame = event.TotalVictimKillFame;
    if (typeof fame === 'number' && Number.isFinite(fame))
        cur[6] += fame;
}
/** Suma una muerte con el arma (la víctima la llevaba). null = sin arma, no cuenta. */
function addWeaponDeath(rollup, victimWeapon) {
    if (!victimWeapon)
        return;
    weaponBucket(rollup, victimWeapon)[1] += 1;
}
function itemBucket(rollup, family) {
    const map = (rollup.items ??= {});
    return (map[family] ??= [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
}
/** Bucket con rescate: si `numberOfParticipants` falta o no es entero ≥ 1, vale como 1
 * cuando hay un solo `Participant`; si no, null y el evento no suma en `items`. */
function resolveFightBucket(event) {
    const direct = fightSizeBucket(event.numberOfParticipants);
    if (direct !== null)
        return direct;
    if (Array.isArray(event.Participants) && event.Participants.length === 1)
        return 0;
    return null;
}
/** Uso total de una familia (victorias + derrotas, índices 0..7). */
function itemUseTotal(tuple) {
    let total = 0;
    for (let i = 0; i < 8; i++)
        total += tupleNum(tuple, i);
    return total;
}
/** Uso total de una build (kills + muertes; los resúmenes viejos traen `d` ausente = 0). */
function buildUseTotal(entry) {
    return entry.c + (entry.d ?? 0);
}
/** Suma al rollup del día los eventos nuevos (los ya vistos se ignoran). Muta y devuelve cuántos
 * sumó. Solo cuenta el equipo del GANADOR, mismo criterio que la pantalla. Además suma el cruce
 * de armas MainHand asesino→víctima en `matchups` (sin arma en algún lado no cuenta) y las
 * métricas por arma en `weapons` (kills de quien la llevaba, muertes de quien murió con ella,
 * en solitario o en grupo según `numberOfParticipants`, daño del asesino y fama). Las muertes
 * cuentan aunque el evento no traiga equipo del asesino: basta el arma de la víctima. */
export function addEventsToRollup(rollup, events) {
    const seen = new Set(rollup.seen);
    let added = 0;
    for (const event of events) {
        if (!event || typeof event.EventId !== 'number' || seen.has(event.EventId))
            continue;
        if (typeof event.TimeStamp !== 'string' || event.TimeStamp.slice(0, 10) !== rollup.date)
            continue;
        const equipment = event.Killer?.Equipment;
        const victimEquipment = event.Victim?.Equipment;
        if (!equipment && !victimEquipment)
            continue;
        seen.add(event.EventId);
        // Métricas por pieza: si no se sabe el tamaño de pelea, el evento no suma en `items`.
        const fightBucket = resolveFightBucket(event);
        let hasNewDetail = false;
        if (fightBucket !== null) {
            if (equipment) {
                const fame = event.TotalVictimKillFame;
                const fameVal = typeof fame === 'number' && Number.isFinite(fame) ? fame : null;
                const killerIp = event.Killer?.AverageItemPower;
                const ipRounded = typeof killerIp === 'number' && Number.isFinite(killerIp) && killerIp > 0 ? Math.round(killerIp) : null;
                for (const slot of META_SLOTS) {
                    const type = equipment[slot]?.Type;
                    if (!type)
                        continue;
                    const family = familyOf(type);
                    if (!family)
                        continue;
                    const tuple = itemBucket(rollup, family);
                    tuple[fightBucket] += 1;
                    if (fameVal !== null)
                        tuple[8] += fameVal;
                    if (ipRounded !== null) {
                        tuple[9] += ipRounded;
                        tuple[10] += 1;
                    }
                    hasNewDetail = true;
                }
            }
            if (victimEquipment) {
                for (const slot of META_SLOTS) {
                    const type = victimEquipment[slot]?.Type;
                    if (!type)
                        continue;
                    const family = familyOf(type);
                    if (!family)
                        continue;
                    itemBucket(rollup, family)[4 + fightBucket] += 1;
                    hasNewDetail = true;
                }
            }
        }
        // Muertes por build de la víctima, con la misma clave que la del asesino.
        if (victimEquipment) {
            const victimParts = [];
            const victimSlots = {};
            let victimHasSlot = false;
            for (const slot of BUILD_SLOTS) {
                const type = victimEquipment[slot]?.Type;
                if (!type) {
                    victimParts.push('empty');
                    continue;
                }
                victimHasSlot = true;
                victimParts.push(baseOf(type));
                victimSlots[slot] = type;
            }
            if (victimHasSlot) {
                const victimKey = victimParts.join('::');
                const existing = rollup.builds[victimKey];
                if (existing)
                    existing.d = (existing.d ?? 0) + 1;
                else
                    rollup.builds[victimKey] = { c: 0, d: 1, slots: victimSlots };
                hasNewDetail = true;
            }
        }
        let anySlot = false;
        if (equipment) {
            for (const slot of META_SLOTS) {
                const type = equipment[slot]?.Type;
                if (!type)
                    continue;
                anySlot = true;
                const base = baseOf(type);
                const bucket = rollup.slots[slot];
                if (bucket[base])
                    bucket[base].c += 1;
                else
                    bucket[base] = { s: type, c: 1 };
                addEnchant(bucket[base], enchantOf(type), 1);
            }
        }
        const killerWeapon = weaponBase(equipment?.MainHand?.Type);
        const victimWeapon = weaponBase(victimEquipment?.MainHand?.Type);
        if (!anySlot && !killerWeapon && !victimWeapon) {
            if (hasNewDetail)
                added += 1;
            continue;
        }
        // `anySlot` solo es true dentro de `if (equipment)`: acá el equipo existe y TS lo sabe.
        const killerEq = equipment;
        if (!anySlot || !killerEq) {
            // Sin equipo útil del asesino: solo deja métricas de muerte del arma de la víctima.
            addWeaponDeath(rollup, victimWeapon);
            if (victimWeapon)
                added += 1;
            else if (hasNewDetail)
                added += 1;
            continue;
        }
        const parts = [];
        const buildSlots = {};
        let buildHasSlot = false;
        for (const slot of BUILD_SLOTS) {
            const type = killerEq[slot]?.Type;
            if (!type) {
                parts.push('empty');
                continue;
            }
            buildHasSlot = true;
            parts.push(baseOf(type));
            buildSlots[slot] = type;
        }
        const killerName = event.Killer?.Name;
        if (killerName) {
            const killers = (rollup.killers ??= {});
            const loadout = {};
            for (const slot of META_SLOTS) {
                const type = killerEq[slot]?.Type;
                if (type)
                    loadout[slot] = type;
            }
            const cur = killers[killerName];
            if (cur) {
                cur.c += 1;
                if (event.TimeStamp >= cur.t) {
                    cur.t = event.TimeStamp;
                    cur.slots = loadout;
                }
            }
            else {
                killers[killerName] = { c: 1, g: event.Killer?.GuildName ?? '', t: event.TimeStamp, slots: loadout };
            }
        }
        if (buildHasSlot) {
            const key = parts.join('::');
            const solo = event.numberOfParticipants === 1;
            const existingBuild = rollup.builds[key];
            if (existingBuild) {
                existingBuild.c += 1;
                if (solo)
                    existingBuild.s = (existingBuild.s ?? 0) + 1;
            }
            else {
                rollup.builds[key] = { c: 1, ...(solo ? { s: 1 } : {}), slots: buildSlots };
            }
        }
        if (killerWeapon && victimWeapon) {
            const pairKey = `${killerWeapon}|${victimWeapon}`;
            const bucket = (rollup.matchups ??= {});
            const cur = (bucket[pairKey] ??= [0, 0, 0]);
            cur[0] += 1;
            if (event.numberOfParticipants === 1) {
                cur[1] += 1;
                const killerIp = event.Killer?.AverageItemPower;
                const victimIp = event.Victim?.AverageItemPower;
                if (typeof killerIp === 'number' && typeof victimIp === 'number' && Math.abs(killerIp - victimIp) <= 100) {
                    cur[2] += 1;
                }
            }
        }
        if (killerWeapon)
            addWeaponKill(rollup, killerWeapon, event);
        addWeaponDeath(rollup, victimWeapon);
        rollup.samples += 1;
        added += 1;
    }
    rollup.seen = [...seen].slice(-ROLLUP_SEEN_CAP);
    return added;
}
function topEntries(record, cap) {
    const entries = Object.entries(record);
    if (entries.length <= cap)
        return record;
    return Object.fromEntries(entries.sort((a, b) => b[1].c - a[1].c).slice(0, cap));
}
/** Deja las `cap` builds con más uso (kills + muertes, para no perder las que solo
 * murieron; los resúmenes viejos traen `d` ausente = 0). */
function topBuildEntries(record, cap) {
    const entries = Object.entries(record);
    if (entries.length <= cap)
        return record;
    entries.sort((a, b) => buildUseTotal(b[1]) - buildUseTotal(a[1]));
    return Object.fromEntries(entries.slice(0, cap));
}
/** Deja las `cap` familias con más uso total (victorias + derrotas). */
function topItemTuples(record, cap) {
    const entries = Object.entries(record);
    if (entries.length <= cap)
        return record;
    entries.sort((a, b) => itemUseTotal(b[1]) - itemUseTotal(a[1]));
    return Object.fromEntries(entries.slice(0, cap));
}
/** Topes de un MES compactado (parte 90): ~4 veces los del día. Las ventanas publican top 25 (y el
 * detalle top 900 familias), así que lo que queda afuera es la cola que nunca se muestra; los cruces
 * van sin tope práctico (son por familia de arma: no crecen sin límite). */
export const META_MONTH_VERSION = 1;
const MONTH_SLOT_CAP = 1600;
const MONTH_BUILD_CAP = 3200;
const MONTH_KILLER_CAP = 1000;
const MONTH_MATCHUP_CAP = 30_000;
const MONTH_WEAPON_CAP = 600;
const MONTH_ITEM_CAP = 6000;
/** Suma `rollup` dentro de `acc` (mutándolo), sin topes: se recorta una sola vez al final. */
export function addRollupInto(acc, rollup) {
    acc.samples += rollup.samples ?? 0;
    if (typeof rollup.date === 'string' && (!acc.date || rollup.date < acc.date))
        acc.date = rollup.date;
    const last = rollup.until ?? rollup.date;
    if (typeof last === 'string' && (!acc.until || last > acc.until))
        acc.until = last;
    acc.days = (acc.days ?? 0) + rollupDays(rollup);
    for (const slot of META_SLOTS) {
        const target = (acc.slots[slot] ??= {});
        for (const [base, entry] of Object.entries(rollup.slots?.[slot] ?? {})) {
            const cur = (target[base] ??= { s: entry.s, c: 0 });
            cur.c += entry.c ?? 0;
            for (const [en, n] of Object.entries(entry.e ?? {}))
                addEnchant(cur, en, n);
        }
    }
    for (const [key, entry] of Object.entries(rollup.builds ?? {})) {
        const cur = acc.builds[key];
        if (!cur) {
            acc.builds[key] = { c: entry.c ?? 0, ...(entry.s ? { s: entry.s } : {}), ...(entry.d ? { d: entry.d } : {}), slots: entry.slots };
            continue;
        }
        cur.c += entry.c ?? 0;
        if (entry.s)
            cur.s = (cur.s ?? 0) + entry.s;
        if (entry.d)
            cur.d = (cur.d ?? 0) + entry.d;
    }
    const killers = (acc.killers ??= {});
    for (const [name, entry] of Object.entries(rollup.killers ?? {})) {
        const cur = killers[name];
        if (!cur) {
            killers[name] = { ...entry };
            continue;
        }
        cur.c += entry.c;
        if (entry.t >= cur.t) {
            cur.t = entry.t;
            cur.slots = entry.slots;
            cur.g = entry.g || cur.g;
        }
    }
    if (rollup.matchups) {
        const target = (acc.matchups ??= {});
        for (const [key, tuple] of Object.entries(rollup.matchups)) {
            const cur = (target[key] ??= [0, 0, 0]);
            for (let i = 0; i < 3; i++)
                cur[i] += tupleNum(tuple, i);
        }
    }
    if (rollup.weapons) {
        const target = (acc.weapons ??= {});
        for (const [key, tuple] of Object.entries(rollup.weapons)) {
            const cur = (target[key] ??= [0, 0, 0, 0, 0, 0, 0]);
            for (let i = 0; i < 7; i++)
                cur[i] += tupleNum(tuple, i);
        }
    }
    if (rollup.items) {
        const target = (acc.items ??= {});
        for (const [key, tuple] of Object.entries(rollup.items)) {
            const cur = (target[key] ??= [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
            for (let i = 0; i < 11; i++)
                cur[i] += tupleNum(tuple, i);
        }
    }
}
/** Mes compactado vacío (se llena con `addRollupInto` y se cierra con `capMonthRollup`). */
export function emptyMonthRollup() {
    return { version: 1, date: '', samples: 0, seen: [], slots: emptySlots(() => ({})), builds: {}, days: 0, mv: META_MONTH_VERSION };
}
/** Recorta un mes compactado a sus topes (más amplios que los del día). */
export function capMonthRollup(rollup) {
    return {
        ...rollup,
        seen: [],
        slots: Object.fromEntries(META_SLOTS.map((s) => [s, topEntries(rollup.slots[s] ?? {}, MONTH_SLOT_CAP)])),
        builds: topBuildEntries(rollup.builds, MONTH_BUILD_CAP),
        killers: topEntries(rollup.killers ?? {}, MONTH_KILLER_CAP),
        ...(rollup.matchups ? { matchups: topMatchupPairs(rollup.matchups, MONTH_MATCHUP_CAP) } : {}),
        ...(rollup.weapons ? { weapons: topWeaponTuples(rollup.weapons, MONTH_WEAPON_CAP) } : {}),
        ...(rollup.items ? { items: topItemTuples(rollup.items, MONTH_ITEM_CAP) } : {}),
    };
}
/** Recorta un rollup a sus topes antes de guardarlo (matchups: 3000 pares por kills,
 * weapons: 300 armas por uso, items: 1500 familias por uso, builds: 800 por kills+muertes). */
export function capMetaRollup(rollup) {
    return {
        ...rollup,
        slots: Object.fromEntries(META_SLOTS.map((s) => [s, topEntries(rollup.slots[s] ?? {}, ROLLUP_SLOT_CAP)])),
        builds: topBuildEntries(rollup.builds, ROLLUP_BUILD_CAP),
        killers: topEntries(rollup.killers ?? {}, ROLLUP_KILLER_CAP),
        ...(rollup.matchups ? { matchups: topMatchupPairs(rollup.matchups, ROLLUP_MATCHUP_CAP) } : {}),
        ...(rollup.weapons ? { weapons: topWeaponTuples(rollup.weapons, ROLLUP_WEAPON_CAP) } : {}),
        ...(rollup.items ? { items: topItemTuples(rollup.items, ROLLUP_ITEM_CAP) } : {}),
    };
}
/** Deja las `cap` armas con más uso (kills+muertes). Los resúmenes viejos sin el campo no llegan acá. */
function topWeaponTuples(record, cap) {
    const entries = Object.entries(record);
    if (entries.length <= cap)
        return record;
    entries.sort((a, b) => b[1][0] + b[1][1] - (a[1][0] + a[1][1]));
    return Object.fromEntries(entries.slice(0, cap));
}
function round4(n) {
    return Math.round(n * 10000) / 10000;
}
function round1(n) {
    return Math.round(n * 10) / 10;
}
/** Deja los `cap` pares con más kills (los resúmenes viejos sin el campo no llegan acá). */
function topMatchupPairs(record, cap) {
    const entries = Object.entries(record);
    if (entries.length <= cap)
        return record;
    entries.sort((a, b) => b[1][0] - a[1][0]);
    return Object.fromEntries(entries.slice(0, cap));
}
/** Lee un elemento de la tupla como número finito (los resúmenes viejos o corruptos no
 * suman basura). */
function tupleNum(tuple, index) {
    const v = Array.isArray(tuple) ? tuple[index] : undefined;
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
/** Suma varios días en una ventana y la ordena al top N — la forma que lee la app. Además publica
 * el top `weaponsTopN` armas por uso con winRate/soloPct/avgDamage/avgFame (null sin medición). */
export function buildMetaWindow(rollups, topN = WINDOW_TOP_N, weaponsTopN = WINDOW_WEAPONS_N) {
    const slots = emptySlots(() => new Map());
    const builds = new Map();
    const killers = new Map();
    const weapons = new Map();
    let samples = 0;
    for (const rollup of rollups) {
        samples += rollup.samples ?? 0;
        for (const [key, tuple] of Object.entries(rollup.weapons ?? {})) {
            const next = [0, 1, 2, 3, 4, 5, 6].map((i) => tupleNum(tuple, i));
            const cur = weapons.get(key);
            if (cur) {
                for (let i = 0; i < 7; i++)
                    cur[i] += next[i];
            }
            else {
                weapons.set(key, next);
            }
        }
        for (const slot of META_SLOTS) {
            for (const [base, entry] of Object.entries(rollup.slots?.[slot] ?? {})) {
                const cur = slots[slot].get(base);
                const target = cur ?? { s: entry.s, c: 0 };
                target.c += entry.c;
                for (const [en, n] of Object.entries(entry.e ?? {}))
                    addEnchant(target, en, n);
                if (!cur)
                    slots[slot].set(base, target);
            }
        }
        for (const [key, entry] of Object.entries(rollup.builds ?? {})) {
            const cur = builds.get(key);
            if (cur)
                cur.c += entry.c;
            else
                builds.set(key, { c: entry.c, slots: entry.slots });
        }
        for (const [name, entry] of Object.entries(rollup.killers ?? {})) {
            const cur = killers.get(name);
            if (!cur)
                killers.set(name, { ...entry });
            else {
                cur.c += entry.c;
                if (entry.t >= cur.t) {
                    cur.t = entry.t;
                    cur.slots = entry.slots;
                    cur.g = entry.g || cur.g;
                }
            }
        }
    }
    return {
        samples,
        days: rollups.reduce((n, r) => n + rollupDays(r), 0),
        slots: Object.fromEntries(META_SLOTS.map((slot) => [
            slot,
            [...slots[slot].entries()]
                .sort((a, b) => b[1].c - a[1].c)
                .slice(0, topN)
                .map(([base, { s, c, e }]) => ({ id: s, base, c, ...(e ? { e } : {}) })),
        ])),
        builds: [...builds.entries()]
            .sort((a, b) => b[1].c - a[1].c)
            .slice(0, topN)
            .map(([k, { c, slots: bs }]) => ({ k, c, slots: bs })),
        killers: [...killers.entries()]
            .sort((a, b) => b[1].c - a[1].c)
            .slice(0, WINDOW_KILLERS_N)
            .map(([name, { c, g, slots: ks }]) => ({ name, guild: g, c, slots: ks })),
        weapons: [...weapons.entries()]
            .map(([w, t]) => {
            const k = t[0];
            const d = t[1];
            const total = k + d;
            return {
                w,
                k,
                d,
                wr: total > 0 ? round4(k / total) : null,
                solo: k > 0 ? round4(t[2] / k) : null,
                dmg: t[5] > 0 ? round1(t[4] / t[5]) : null,
                fame: k > 0 ? round1(t[6] / k) : null,
            };
        })
            .filter((e) => e.k + e.d > 0)
            .sort((a, b) => b.k + b.d - (a.k + a.d))
            .slice(0, Number.isFinite(weaponsTopN) ? Math.max(0, Math.floor(weaponsTopN)) : WINDOW_WEAPONS_N),
    };
}
/** Separador interno servidor/nombre de los ganadores al combinar servidores (no aparece en
 * nombres de Albion ni llega a Firestore: se deshace en `buildCombinedMetaWindow`). */
const REGION_KEY_SEP = '\u0001';
/** Resumen reducido para combinar servidores: solo lo que usan `buildMetaWindow` y
 * `buildMetaDetail` (sin `seen` ni `matchups`, lo más pesado; conserva `items` y los `s`/`d`
 * de las builds para la ventana "Todos" y el detalle) y con los ganadores marcados con su
 * servidor, para que dos jugadores homónimos de servidores distintos no se sumen como uno. */
export function slimRollupForCombined(rollup, region) {
    const killers = {};
    for (const [name, entry] of Object.entries(rollup.killers ?? {}))
        killers[`${region}${REGION_KEY_SEP}${name}`] = entry;
    return {
        version: 1,
        date: rollup.date,
        samples: rollup.samples,
        seen: [],
        slots: rollup.slots,
        builds: rollup.builds,
        killers,
        weapons: rollup.weapons,
        ...(rollup.items ? { items: rollup.items } : {}),
        // Un mes compactado sigue contando sus días (parte 90).
        ...(rollup.days ? { days: rollup.days, until: rollup.until } : {}),
    };
}
/**
 * "Todos" de Meta Armory (BH.8.3): la ventana de los 3 servidores juntos, EXACTA porque suma los
 * resúmenes diarios completos (no los top ya recortados de cada servidor, que perderían un ítem
 * que es #26 en cada uno y #1 sumando). Recibe resúmenes de `slimRollupForCombined`: `days`
 * cuenta fechas distintas (no una por servidor) y cada ganador sale con su `region`.
 */
export function buildCombinedMetaWindow(rollups) {
    const window = buildMetaWindow(rollups);
    window.days = distinctDays(rollups);
    window.killers = window.killers.map((k) => {
        const at = k.name.indexOf(REGION_KEY_SEP);
        return at < 0 ? k : { ...k, region: k.name.slice(0, at), name: k.name.slice(at + REGION_KEY_SEP.length) };
    });
    return window;
}
/** Suma los cruces de varios días y deja los `topN` pares con más kills. `from`/`to` salen de
 * los resúmenes sumados ('' si no hay ninguno); `sampleKills` son las muertes muestreadas de la
 * ventana, no solo las que tenían arma en ambos lados. Los resúmenes viejos sin `matchups`
 * suman sus muestras igual y aportan cero pares. */
export function buildMatchupWindow(rollups, topN = MATCHUP_WINDOW_TOP) {
    return matchupWindowFromSums(sumMatchups(rollups), topN);
}
export function sumMatchups(rollups) {
    const sums = new Map();
    let sampleKills = 0;
    let from = '';
    let to = '';
    for (const rollup of rollups) {
        sampleKills += rollup.samples ?? 0;
        if (typeof rollup.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rollup.date)) {
            const last = rollup.until ?? rollup.date;
            if (!from || rollup.date < from)
                from = rollup.date;
            if (!to || last > to)
                to = last;
        }
        for (const [key, tuple] of Object.entries(rollup.matchups ?? {})) {
            const kills = tuple?.[0] ?? 0;
            const duels = tuple?.[1] ?? 0;
            const fair = tuple?.[2] ?? 0;
            const cur = sums.get(key);
            if (cur) {
                cur[0] += kills;
                cur[1] += duels;
                cur[2] += fair;
            }
            else {
                sums.set(key, [kills, duels, fair]);
            }
        }
    }
    const sorted = [...sums.entries()].sort((a, b) => b[1][0] - a[1][0] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return { from, to, sampleKills, sorted };
}
/** Los `topN` pares con más kills, para el doc de Firestore (versiones viejas de la app). */
export function matchupWindowFromSums(sums, topN = MATCHUP_WINDOW_TOP) {
    const pairs = {};
    for (const [key, tuple] of sums.sorted.slice(0, topN))
        pairs[key] = tuple;
    return { from: sums.from, to: sums.to, sampleKills: sums.sampleKills, pairs };
}
/** Archivo con TODOS los pares (sin tope). Pura: el handler solo lo guarda. Claves sin `|` o con
 * un lado vacío se descartan (no se pueden mostrar). */
export function matchupFileFromSums(sums, region, window, updatedAt) {
    const bases = [];
    const index = new Map();
    const at = (base) => {
        let i = index.get(base);
        if (i === undefined) {
            i = bases.length;
            bases.push(base);
            index.set(base, i);
        }
        return i;
    };
    const pairs = [];
    for (const [key, [kills, duels, fair]] of sums.sorted) {
        const sep = key.indexOf('|');
        if (sep <= 0 || sep === key.length - 1 || kills <= 0)
            continue;
        pairs.push(at(key.slice(0, sep)), at(key.slice(sep + 1)), kills, duels, fair);
    }
    return { v: 1, region, window, from: sums.from, to: sums.to, sampleKills: sums.sampleKills, updatedAt, bases, pairs };
}
/** Archivo de detalle por ventana: suma los mismos resúmenes ya leídos que las ventanas
 * (cero lecturas extra), agrupa las builds por familias (sin tier ni encantamiento) y deja el
 * top 900 de familias por uso y, por arma, hasta 6 configuraciones con al menos 2 usos.
 * Pura: el handler solo escribe el archivo. Los resúmenes viejos sin `items`/`s`/`d` valen 0. */
export function buildMetaDetail(rollups, region, window, nowIso) {
    let samples = 0;
    let from = '';
    let to = '';
    const itemSums = new Map();
    const grouped = new Map();
    for (const rollup of rollups) {
        samples += rollup.samples ?? 0;
        if (typeof rollup.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rollup.date)) {
            const last = rollup.until ?? rollup.date;
            if (!from || rollup.date < from)
                from = rollup.date;
            if (!to || last > to)
                to = last;
        }
        for (const [family, tuple] of Object.entries(rollup.items ?? {})) {
            const next = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => tupleNum(tuple, i));
            const cur = itemSums.get(family);
            if (cur) {
                for (let i = 0; i < 11; i++)
                    cur[i] += next[i];
            }
            else {
                itemSums.set(family, next);
            }
        }
        for (const [tierKey, entry] of Object.entries(rollup.builds ?? {})) {
            if (!entry || typeof tierKey !== 'string')
                continue;
            const tierParts = tierKey.split('::');
            const familyParts = tierParts.map((p) => (p === 'empty' ? 'empty' : (familyOf(p) ?? p)));
            const familyKey = familyParts.join('::');
            const c = typeof entry.c === 'number' && Number.isFinite(entry.c) ? entry.c : 0;
            const s = typeof entry.s === 'number' && Number.isFinite(entry.s) ? entry.s : 0;
            const d = typeof entry.d === 'number' && Number.isFinite(entry.d) ? entry.d : 0;
            const use = c + d;
            const cur = grouped.get(familyKey);
            if (cur) {
                cur.c += c;
                cur.s += s;
                cur.d += d;
                if (use > cur.best) {
                    cur.best = use;
                    cur.slots = entry.slots ?? {};
                }
            }
            else {
                grouped.set(familyKey, { c, s, d, slots: entry.slots ?? {}, best: use });
            }
        }
    }
    const items = {};
    for (const [family, tuple] of [...itemSums.entries()]
        .sort((a, b) => itemUseTotal(b[1]) - itemUseTotal(a[1]))
        .slice(0, DETAIL_ITEMS_TOP)) {
        tuple[8] = Math.round(tuple[8]);
        tuple[9] = Math.round(tuple[9]);
        items[family] = tuple;
    }
    const itemUseByFamily = new Map();
    for (const [family, tuple] of itemSums)
        itemUseByFamily.set(family, itemUseTotal(tuple));
    const byWeapon = new Map();
    for (const [familyKey, g] of grouped) {
        const weapon = familyKey.split('::')[0] ?? 'empty';
        if (!weapon || weapon === 'empty')
            continue;
        const list = byWeapon.get(weapon) ?? [];
        list.push({ k: familyKey, slots: g.slots, c: g.c, s: g.s, d: g.d });
        byWeapon.set(weapon, list);
    }
    const weaponBuilds = {};
    for (const [weapon] of [...byWeapon.entries()]
        .sort((a, b) => (itemUseByFamily.get(b[0]) ?? 0) - (itemUseByFamily.get(a[0]) ?? 0))
        .slice(0, DETAIL_WEAPONS_TOP)) {
        const builds = (byWeapon.get(weapon) ?? [])
            .filter((b) => b.c + b.d >= DETAIL_BUILD_MIN_USE)
            .sort((a, b) => b.c + b.d - (a.c + a.d))
            .slice(0, DETAIL_BUILDS_PER_WEAPON);
        if (builds.length > 0)
            weaponBuilds[weapon] = builds;
    }
    return {
        v: 1,
        region,
        window,
        from,
        to,
        days: distinctDays(rollups),
        samples,
        updatedAt: nowIso,
        items,
        weaponBuilds,
    };
}
/** Anillo de últimos usos por arma (pedido 204): junta los usos previos del archivo con los
 * nuevos de la corrida, deduplica por evento+rol (el mismo evento aporta un 'kill' y un 'death'
 * cuando espejo con la misma arma, y ambos se conservan), ordena por fecha descendente y recorta
 * a `cap`. Puro: el handler solo lee/escribe el archivo. */
export function mergeRecentUses(prev, incoming, cap = RECENT_USES_CAP) {
    const limit = Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : RECENT_USES_CAP;
    const seen = new Set();
    const merged = [];
    for (const u of [...(Array.isArray(incoming) ? incoming : []), ...(Array.isArray(prev) ? prev : [])]) {
        if (!u || typeof u.eventId !== 'number' || typeof u.timeStamp !== 'string')
            continue;
        if (u.role !== 'kill' && u.role !== 'death')
            continue;
        const key = `${u.eventId}:${u.role}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        merged.push(u);
    }
    merged.sort((a, b) => a.timeStamp < b.timeStamp ? 1 : a.timeStamp > b.timeStamp ? -1 : b.eventId - a.eventId);
    return merged.slice(0, limit);
}
/** Usos por arma de los eventos de una corrida (pedido 204): cada evento aporta un uso 'kill'
 * bajo el arma del asesino y uno 'death' bajo la de la víctima (con el UniqueName completo del
 * rival en `opponentWeapon`), deduplicados dentro de la corrida por evento+rol. Puro: el handler
 * escribe solo los archivos de las armas con usos nuevos. */
export function collectRecentUses(events) {
    const out = new Map();
    const seenInRun = new Set();
    const push = (weapon, use) => {
        if (!weapon || !RECENT_KEY_RE.test(weapon))
            return;
        const key = `${weapon}:${use.eventId}:${use.role}`;
        if (seenInRun.has(key))
            return;
        seenInRun.add(key);
        const list = out.get(weapon) ?? [];
        list.push(use);
        out.set(weapon, list);
    };
    for (const event of events) {
        if (!event || typeof event.EventId !== 'number' || typeof event.TimeStamp !== 'string')
            continue;
        const killerWeapon = weaponBase(event.Killer?.Equipment?.MainHand?.Type);
        const victimWeapon = weaponBase(event.Victim?.Equipment?.MainHand?.Type);
        if (!killerWeapon && !victimWeapon)
            continue;
        const killerName = typeof event.Killer?.Name === 'string' ? event.Killer.Name : '';
        const victimName = typeof event.Victim?.Name === 'string' ? event.Victim.Name : '';
        if (!killerName && !victimName)
            continue;
        const killerGuild = event.Killer?.GuildName;
        const victimGuild = event.Victim?.GuildName;
        const killerType = event.Killer?.Equipment?.MainHand?.Type;
        const victimType = event.Victim?.Equipment?.MainHand?.Type;
        const base = {
            eventId: event.EventId,
            timeStamp: event.TimeStamp,
            killerName,
            victimName,
            ...(typeof killerGuild === 'string' && killerGuild ? { killerGuild } : {}),
            ...(typeof victimGuild === 'string' && victimGuild ? { victimGuild } : {}),
            ...(typeof event.TotalVictimKillFame === 'number' && Number.isFinite(event.TotalVictimKillFame)
                ? { fame: event.TotalVictimKillFame }
                : {}),
            ...(typeof event.numberOfParticipants === 'number' && Number.isFinite(event.numberOfParticipants)
                ? { participants: event.numberOfParticipants }
                : {}),
            ...(typeof event.Killer?.AverageItemPower === 'number' && Number.isFinite(event.Killer.AverageItemPower)
                ? { killerIp: event.Killer.AverageItemPower }
                : {}),
            ...(typeof event.Victim?.AverageItemPower === 'number' && Number.isFinite(event.Victim.AverageItemPower)
                ? { victimIp: event.Victim.AverageItemPower }
                : {}),
        };
        if (killerWeapon) {
            push(killerWeapon, {
                ...base,
                role: 'kill',
                ...(typeof victimType === 'string' ? { opponentWeapon: victimType } : {}),
            });
        }
        if (victimWeapon) {
            push(victimWeapon, {
                ...base,
                role: 'death',
                ...(typeof killerType === 'string' ? { opponentWeapon: killerType } : {}),
            });
        }
    }
    return out;
}
function dateStr(d) {
    return d.toISOString().slice(0, 10);
}
function mondayOf(d) {
    const day = d.getUTCDay();
    const diff = (day === 0 ? -6 : 1) - day;
    return dateStr(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diff)));
}

export { dateStr, mondayOf };
export const META_CORE_SOURCE_SHA = '68e76f00a0eda404';
