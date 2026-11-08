// GENERADO por scripts/generar-ranking-core.mjs: NO editar a mano.
// Fuente: functions/src/index.ts + leaderboard-season.ts + battle-tally.ts (repo Albion World), sha256 a29c37fbbfca2356.
// Es el mismo acumulador que usa `refreshCraftingLeaderboards`, sin los tipos.
const LEADERBOARD_TOP_N = 50;
const GLOBAL_SCORE_TOP_N = 100;
export const MIN_BATTLE_KILLS = 3;
/** Participantes guardados por kill: la API no da más (ver `killPeople`). */
const SLOT_SHIFT = 2 ** 24;
export function createBattleTally(battlesFromFile) {
    const fileSize = new Map();
    for (const b of battlesFromFile)
        if (b.players)
            fileSize.set(b.battleId, b.players.length);
    const textIds = new Map();
    const texts = [];
    const textId = (text) => {
        let id = textIds.get(text);
        if (id === undefined) {
            id = texts.length;
            texts.push(text);
            textIds.set(text, id);
        }
        return id;
    };
    // Por pelea.
    const slotByBattle = new Map();
    const battleIds = [];
    const battleKills = [];
    const battleFame = [];
    const battleStartMs = [];
    const battleStart = [];
    const battleGroup = [];
    const battleUnseen = [];
    // Por kill.
    const killSlot = [];
    const killKiller = [];
    const killKillerGuild = [];
    const killVictim = [];
    const killVictimGuild = [];
    const killFame = [];
    /** Dónde empiezan sus ayudantes en `assistNames`; `assistStart[i + 1]` es el final. */
    const assistStart = [0];
    const assistNames = [];
    /** Una entrada por persona vista en cada kill: `pelea × 2^24 + persona`. */
    const seen = [];
    let lastEventId = null;
    let lastIndex = -1;
    let sizes = null;
    function slotFor(kill) {
        // Sin `battleId` es una pelea de una sola kill.
        const key = kill.battleId ?? -kill.eventId;
        let slot = slotByBattle.get(key);
        if (slot === undefined) {
            slot = battleIds.length;
            slotByBattle.set(key, slot);
            battleIds.push(key);
            battleKills.push(0);
            battleFame.push(0);
            battleStartMs.push(Number.POSITIVE_INFINITY);
            battleStart.push('');
            battleGroup.push(0);
            battleUnseen.push(0);
        }
        return slot;
    }
    /**
     * Registra una kill y devuelve su número. Varias ventanas comparten la cuenta (Hoy, Semana, Todo) y cada una la llama con
     * la misma kill seguida: la repetición no cuenta dos veces.
     */
    function addKill(kill) {
        if (kill.eventId === lastEventId)
            return lastIndex;
        sizes = null;
        const slot = slotFor(kill);
        battleKills[slot] += 1;
        battleFame[slot] += kill.totalFame;
        const at = Date.parse(kill.timestamp);
        if (at < battleStartMs[slot]) {
            battleStartMs[slot] = at;
            battleStart[slot] = kill.timestamp;
        }
        const see = (name) => {
            if (name)
                seen.push(slot * SLOT_SHIFT + textId(name));
        };
        see(kill.killerName);
        see(kill.victimName);
        const killer = (kill.killerName ?? '').toLowerCase();
        const helpers = new Set();
        const participants = kill.participants ?? [];
        for (const p of participants) {
            const name = p?.name;
            if (!name)
                continue;
            see(name);
            if (name.toLowerCase() !== killer)
                helpers.add(name);
        }
        const group = typeof kill.groupSize === 'number' ? kill.groupSize : 0;
        if (group > battleGroup[slot])
            battleGroup[slot] = group;
        const unseen = group - participants.length;
        if (unseen > battleUnseen[slot])
            battleUnseen[slot] = unseen;
        for (const name of helpers)
            assistNames.push(textId(name));
        assistStart.push(assistNames.length);
        killSlot.push(slot);
        killKiller.push(textId(kill.killerName ?? ''));
        killKillerGuild.push(textId(kill.killerGuild ?? ''));
        killVictim.push(textId(kill.victimName ?? ''));
        killVictimGuild.push(textId(kill.victimGuild ?? ''));
        killFame.push(kill.totalFame);
        lastEventId = kill.eventId;
        lastIndex = killSlot.length - 1;
        return lastIndex;
    }
    /** Personas distintas de cada pelea, ordenando las entradas una sola vez cuando ya llegaron las kills. */
    function resolvedSizes() {
        if (sizes)
            return sizes;
        const sorted = Float64Array.from(seen).sort();
        const people = new Int32Array(battleIds.length);
        for (let i = 0; i < sorted.length; i++) {
            if (i > 0 && sorted[i] === sorted[i - 1])
                continue;
            people[Math.floor(sorted[i] / SLOT_SHIFT)] += 1;
        }
        const out = new Int32Array(battleIds.length);
        for (let slot = 0; slot < out.length; slot++) {
            const estimate = Math.round(people[slot] + battleUnseen[slot] / 2);
            out[slot] = Math.max(estimate, battleGroup[slot], fileSize.get(battleIds[slot]) ?? 0);
        }
        sizes = out;
        return out;
    }
    /** Tamaño de una pelea; `undefined` si no tiene kills ni lista en el archivo. */
    function sizeOfBattle(battleId) {
        const slot = slotByBattle.get(battleId);
        return slot === undefined ? fileSize.get(battleId) : resolvedSizes()[slot];
    }
    function killAt(index) {
        const assists = [];
        for (let i = assistStart[index]; i < assistStart[index + 1]; i++)
            assists.push(texts[assistNames[i]]);
        return {
            size: resolvedSizes()[killSlot[index]],
            killerName: texts[killKiller[index]],
            killerGuild: texts[killKillerGuild[index]],
            victimName: texts[killVictim[index]],
            victimGuild: texts[killVictimGuild[index]],
            fame: killFame[index],
            assists,
        };
    }
    /** Las peleas de 3 o más kills que el archivo no trae, armadas con sus kills. */
    function battlesFromKills() {
        const guildsBySlot = new Map();
        for (let slot = 0; slot < battleIds.length; slot++) {
            if (battleKills[slot] >= MIN_BATTLE_KILLS && battleIds[slot] >= 0 && !fileSize.has(battleIds[slot])) {
                guildsBySlot.set(slot, new Map());
            }
        }
        const count = (guilds, guild, field) => {
            if (!texts[guild])
                return;
            let entry = guilds.get(guild);
            if (!entry) {
                entry = { kills: 0, deaths: 0 };
                guilds.set(guild, entry);
            }
            entry[field] += 1;
        };
        for (let i = 0; i < killSlot.length; i++) {
            const guilds = guildsBySlot.get(killSlot[i]);
            if (!guilds)
                continue;
            count(guilds, killKillerGuild[i], 'kills');
            count(guilds, killVictimGuild[i], 'deaths');
        }
        return [...guildsBySlot].map(([slot, guilds]) => ({
            battleId: battleIds[slot],
            startTime: battleStart[slot],
            totalKills: battleKills[slot],
            totalFame: battleFame[slot],
            guilds: [...guilds].map(([guild, n]) => ({ name: texts[guild], ...n })),
        }));
    }
    return { addKill, sizeOfBattle, killAt, battlesFromKills };
}
function guildSizeBucket(participantCount) {
    if (participantCount < 10)
        return 'small';
    if (participantCount < 20)
        return 'medium';
    return 'zvz';
}
/** "10+ ayudas" (ronda 65, pedido del dueño): la kill tuvo 10 o más ayudas, o sea 11+ participantes.
 * NO es un bucket exclusivo: es un subconjunto de "high" (6+), así "6+" sigue incluyendo a estas. */
const MAX_ASSIST_PARTICIPANTS = 11;
/** Personas del lado del atacante (parte 74). La API corta `numberOfParticipants` y `Participants` en 4
 * (medido el 2026-10-05: 0 de 85.928 kills de Américas con más de 4, y lo mismo en agosto y septiembre),
 * así que "6+" y "10+ ayudas" nunca tuvieron nada. El grupo del atacante (`GroupMembers`, que el escáner
 * guarda como `groupSize` desde el 2026-10-05) sí pasa de 4: se toma el mayor de los dos. Las kills
 * guardadas antes, sin `groupSize`, cuentan como siempre. */
export function killPeople(kill) {
    return Math.max(kill.participantsCount, typeof kill.groupSize === 'number' ? kill.groupSize : 0);
}
function assistBucket(participantsCount) {
    if (participantsCount <= 1)
        return 'solo';
    if (participantsCount <= 6)
        return 'low';
    return 'high';
}
/** Chat 174: posición de cada corte en los 12 números por gremio (kills 0-3, muertes 4-7, fama 8-11). */
const GUILD_ASSIST_SLOT = { solo: 0, low: 1, high: 2, max: 3 };
const SCORE_ASSISTS = ['Solo', 'Low', 'High', 'Max'];
export function countAssists(kill, into, zvz) {
    const killer = (kill.killerName ?? '').toLowerCase();
    const seen = new Set();
    for (const p of kill.participants ?? []) {
        const name = p?.name;
        if (!name || name.toLowerCase() === killer || seen.has(name))
            continue;
        seen.add(name);
        into.set(name, (into.get(name) ?? 0) + 1);
        if (zvz)
            zvz.set(name, (zvz.get(name) ?? 0) + 1);
    }
}
export function aggregateCombatRankings(kills, battles, region) {
    const acc = createCombatRankingsAccumulator(battles, region);
    for (const kill of kills)
        acc.addKill(kill);
    return acc.finish();
}
/** Cuántas kills con más fama guarda "Fama caída" (`topFameKills`). */
const TOP_FAME_KILLS_N = 20;
/** Chat 175: kills de más fama que se guardan enteras para «Fama caída» con «ZvZ (20+)» (ver `fameCandidates`). */
export const FAME_ZVZ_CANDIDATES = 1000;
/**
 * Rankings de combate calculados kill por kill, sin retener las kills (BI.3). Antes cada job bajaba
 * TODOS los días a un arreglo y recién después agregaba: con ~490 mil kills por semana en Américas
 * (medido el 30/09, ~37 MB de texto por día) `refreshCraftingLeaderboards` pasaba de 1 GiB y moría
 * cada hora sin guardar ningún servidor, y "Mes" (hasta 31 días, ~2 millones de kills) quedaba al
 * borde de 4 GiB. Ahora el pico es un día descargado más los mapas de jugadores/gremios; de las
 * kills solo quedan las que se muestran (la más grande por filtro y el top 20 de fama).
 *
 * Resultado idéntico al cálculo sobre el arreglo completo: los ids de jugador se resuelven al
 * final con el último id visto por nombre (como antes, que los juntaba en una pasada previa), el
 * top de fama inserta después de los empates (igual que el sort estable) y el recorrido de kills
 * mantiene el mismo orden. `finish()` se llama una sola vez (suma las peleas a los gremios).
 *
 * Chat 160: el tamaño de la pelea sale de `battle-tally` y se conoce al terminar, cuando ya llegaron todas sus kills; lo
 * que depende de él (filtros de gremio y ZvZ) se suma en `finish()`. Las ventanas de una misma corrida comparten `tally`.
 */
export function createCombatRankingsAccumulator(battles, region, sharedTally) {
    const tally = sharedTally ?? createBattleTally(battles);
    /** Las kills de esta ventana, como números de `tally`. */
    const myKills = [];
    const nameToId = new Map();
    const playerStats = new Map();
    const guildStats = new Map();
    const guildStatsBySize = {
        small: new Map(),
        medium: new Map(),
        zvz: new Map(),
    };
    let biggestKill = null;
    const biggestKillByBucket = { solo: null, low: null, high: null };
    let biggestKillMax = null;
    /** Ordenado de mayor a menor fama, como mucho `TOP_FAME_KILLS_N`. */
    const topFameKills = [];
    // Parte 74 (dueño): "Fama caída" también con el filtro de asistencia (1 vs 1, 1-5, 6+, 10+), como
    // Kills/Fama/Muertes. Un top propio por filtro (no un recorte del general: la kill #1 en 1 vs 1 casi
    // nunca está entre las 20 más grandes de todas).
    const topFameKillsByBucket = { solo: [], low: [], high: [] };
    const topFameKillsMax = [];
    // Chat 175 (el dueño: «Fama caída con ZvZ sí se puede»): una kill es ZvZ si su pelea tuvo 20+ personas, y eso se sabe
    // al terminar (`addKillsBySize`). Al terminar, sobre TODAS las kills de la ventana, se eligen por número las 20 de más
    // fama en peleas de 20+ (exacto). La kill entera solo se guarda para las `FAME_ZVZ_CANDIDATES` de más fama: si alguna
    // de las 20 no está ahí (no pasó en ninguna medición), se avisa en el registro y la lista sale con las que hay.
    const fameCandidates = [];
    let topFameKillsZvz = [];
    let sampleSize = 0;
    let finished = false;
    // Asistencias por nombre (parte 81): un número por persona, no una ficha entera — los que solo
    // asisten no entran a ningún top y crear su ficha pesaría en memoria (ver el OOM de la parte 31).
    const assistsByName = new Map();
    const assistsZvzByName = new Map();
    // Chat 174 (dueño): Top y Gremios también filtran por asistencias. Por gremio, 12 números: kills 1vs1, 1-5,
    // 6+, 10+ (0-3), muertes con los mismos cortes (4-7) y fama de esas kills (8-11) (`GUILD_ASSIST_SLOT`).
    // Arreglo y no ficha: no cambia la forma de `ServerGuildRankEntry`, que se escribe en los docs de siempre.
    const guildAssist = new Map();
    function guildAssistOf(name) {
        let slots = guildAssist.get(name);
        if (!slots)
            guildAssist.set(name, (slots = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
        return slots;
    }
    function player(name, guild) {
        let entry = playerStats.get(name);
        if (!entry) {
            entry = {
                name,
                guild,
                // Se resuelve en `finish()` con todas las kills vistas.
                id: null,
                kills: 0,
                deaths: 0,
                fame: 0,
                killsSolo: 0,
                killsLow: 0,
                killsHigh: 0,
                fameSolo: 0,
                fameLow: 0,
                fameHigh: 0,
                deathsSolo: 0,
                deathsLow: 0,
                deathsHigh: 0,
                killsMax: 0,
                fameMax: 0,
                deathsMax: 0,
                killsZvz: 0,
                deathsZvz: 0,
                fameZvz: 0,
            };
            playerStats.set(name, entry);
        }
        else if (guild && !entry.guild) {
            entry.guild = guild;
        }
        return entry;
    }
    function guildIn(map, name) {
        let entry = map.get(name);
        if (!entry) {
            entry = { name, kills: 0, fame: 0, deaths: 0, battlesWon: 0, battlesLost: 0 };
            map.set(name, entry);
        }
        return entry;
    }
    function guild(name) {
        return guildIn(guildStats, name);
    }
    function addTopFameKill(kill, list = topFameKills) {
        const last = list[list.length - 1];
        if (list.length >= TOP_FAME_KILLS_N && kill.totalFame <= last.totalFame)
            return;
        // Después de los empates: mismo orden que el sort estable sobre todas las kills.
        let at = list.length;
        while (at > 0 && list[at - 1].totalFame < kill.totalFame)
            at -= 1;
        list.splice(at, 0, kill);
        if (list.length > TOP_FAME_KILLS_N)
            list.pop();
    }
    /** Igual que `addTopFameKill` (después de los empates), con el número de la kill en `tally`. */
    function addFameCandidate(index, kill) {
        const list = fameCandidates;
        if (list.length >= FAME_ZVZ_CANDIDATES && kill.totalFame <= list[list.length - 1].kill.totalFame)
            return;
        let at = list.length;
        while (at > 0 && list[at - 1].kill.totalFame < kill.totalFame)
            at -= 1;
        list.splice(at, 0, { index, kill });
        if (list.length > FAME_ZVZ_CANDIDATES)
            list.pop();
    }
    function addKill(kill) {
        if (finished)
            throw new Error('createCombatRankingsAccumulator: addKill después de finish');
        sampleSize += 1;
        for (const p of kill.participants) {
            if (p.name && p.id)
                nameToId.set(p.name.toLowerCase(), p.id);
        }
        addTopFameKill(kill);
        if (!biggestKill || kill.totalFame > biggestKill.totalFame)
            biggestKill = kill;
        const people = killPeople(kill);
        const bucket = assistBucket(people);
        if (!biggestKillByBucket[bucket] || kill.totalFame > biggestKillByBucket[bucket].totalFame) {
            biggestKillByBucket[bucket] = kill;
        }
        const isMaxAssist = people >= MAX_ASSIST_PARTICIPANTS;
        if (isMaxAssist && (!biggestKillMax || kill.totalFame > biggestKillMax.totalFame))
            biggestKillMax = kill;
        addTopFameKill(kill, topFameKillsByBucket[bucket]);
        if (isMaxAssist)
            addTopFameKill(kill, topFameKillsMax);
        const tallyIndex = tally.addKill(kill);
        myKills.push(tallyIndex);
        addFameCandidate(tallyIndex, kill);
        countAssists(kill, assistsByName, null);
        if (kill.killerName) {
            const p = player(kill.killerName, kill.killerGuild);
            p.kills += 1;
            p.fame += kill.totalFame;
            if (bucket === 'solo') {
                p.killsSolo += 1;
                p.fameSolo += kill.totalFame;
            }
            else if (bucket === 'low') {
                p.killsLow += 1;
                p.fameLow += kill.totalFame;
            }
            else {
                p.killsHigh += 1;
                p.fameHigh += kill.totalFame;
            }
            if (isMaxAssist) {
                p.killsMax += 1;
                p.fameMax += kill.totalFame;
            }
            if (kill.killerGuild) {
                const g = guild(kill.killerGuild);
                g.kills += 1;
                g.fame += kill.totalFame;
                const slots = guildAssistOf(kill.killerGuild);
                slots[GUILD_ASSIST_SLOT[bucket]] += 1;
                slots[GUILD_ASSIST_SLOT[bucket] + 8] += kill.totalFame;
                if (isMaxAssist) {
                    slots[GUILD_ASSIST_SLOT.max] += 1;
                    slots[GUILD_ASSIST_SLOT.max + 8] += kill.totalFame;
                }
            }
        }
        if (kill.victimName) {
            const p = player(kill.victimName, kill.victimGuild);
            p.deaths += 1;
            if (bucket === 'solo')
                p.deathsSolo += 1;
            else if (bucket === 'low')
                p.deathsLow += 1;
            else
                p.deathsHigh += 1;
            if (isMaxAssist)
                p.deathsMax += 1;
            if (kill.victimGuild) {
                guild(kill.victimGuild).deaths += 1;
                const slots = guildAssistOf(kill.victimGuild);
                slots[GUILD_ASSIST_SLOT[bucket] + 4] += 1;
                if (isMaxAssist)
                    slots[GUILD_ASSIST_SLOT.max + 4] += 1;
            }
        }
    }
    /** Lo que depende del tamaño de la pelea, ya con todas las kills vistas. */
    function addKillsBySize() {
        /** Números de las 20 kills ZvZ de más fama, de mayor a menor (después de los empates, como `addTopFameKill`). */
        const zvzTop = [];
        for (const index of myKills) {
            const kill = tally.killAt(index);
            const bucket = guildSizeBucket(kill.size);
            const isZvz = bucket === 'zvz';
            if (isZvz && (zvzTop.length < TOP_FAME_KILLS_N || kill.fame > zvzTop[zvzTop.length - 1].fame)) {
                let at = zvzTop.length;
                while (at > 0 && zvzTop[at - 1].fame < kill.fame)
                    at -= 1;
                zvzTop.splice(at, 0, { index, fame: kill.fame });
                if (zvzTop.length > TOP_FAME_KILLS_N)
                    zvzTop.pop();
            }
            if (kill.killerName) {
                if (isZvz) {
                    const p = playerStats.get(kill.killerName);
                    p.killsZvz += 1;
                    p.fameZvz += kill.fame;
                }
                if (kill.killerGuild) {
                    const bucketed = guildIn(guildStatsBySize[bucket], kill.killerGuild);
                    bucketed.kills += 1;
                    bucketed.fame += kill.fame;
                }
            }
            if (kill.victimName) {
                if (isZvz)
                    playerStats.get(kill.victimName).deathsZvz += 1;
                if (kill.victimGuild)
                    guildIn(guildStatsBySize[bucket], kill.victimGuild).deaths += 1;
            }
            if (isZvz)
                for (const name of kill.assists)
                    assistsZvzByName.set(name, (assistsZvzByName.get(name) ?? 0) + 1);
        }
        const byIndex = new Map(fameCandidates.map((c) => [c.index, c.kill]));
        topFameKillsZvz = zvzTop.flatMap((z) => {
            const kill = byIndex.get(z.index);
            return kill ? [kill] : [];
        });
        if (topFameKillsZvz.length < zvzTop.length) {
            console.warn(`Fama caída ZvZ: ${zvzTop.length - topFameKillsZvz.length} de ${zvzTop.length} fuera de las ${FAME_ZVZ_CANDIDATES} candidatas`);
        }
    }
    /** `missingBattles`: las peleas de esta ventana que el archivo no trae. Sin él, todas las de `tally`. */
    function finish(missingBattles = tally.battlesFromKills()) {
        if (finished)
            throw new Error('createCombatRankingsAccumulator: finish dos veces');
        finished = true;
        for (const entry of playerStats.values()) {
            entry.id = nameToId.get(entry.name.toLowerCase()) ?? null;
            entry.assists = assistsByName.get(entry.name) ?? 0;
        }
        addKillsBySize();
        const allBattles = [...battles, ...missingBattles];
        for (const battle of allBattles) {
            const size = tally.sizeOfBattle(battle.battleId);
            const bucket = size !== undefined ? guildSizeBucket(size) : null;
            for (const g of battle.guilds) {
                if (!g.name)
                    continue;
                const entry = guild(g.name);
                if (g.kills > g.deaths)
                    entry.battlesWon += 1;
                else if (g.deaths > g.kills)
                    entry.battlesLost += 1;
                if (bucket) {
                    const bucketed = guildIn(guildStatsBySize[bucket], g.name);
                    if (g.kills > g.deaths)
                        bucketed.battlesWon += 1;
                    else if (g.deaths > g.kills)
                        bucketed.battlesLost += 1;
                }
            }
        }
        const players = [...playerStats.values()];
        const guilds = [...guildStats.values()];
        const sortGuilds = (map) => [...map.values()].sort((a, b) => b.kills - a.kills).slice(0, LEADERBOARD_TOP_N);
        const topBy = (key) => [...players].sort((a, b) => b[key] - a[key]).slice(0, LEADERBOARD_TOP_N);
        return {
            topKillers: topBy('kills'),
            topFame: topBy('fame'),
            topDeaths: topBy('deaths'),
            // Pedido explícito del usuario: poder ver el ranking filtrado a solo 1vs1 real (sin ayuda,
            // `participantsCount <= 1`), con 1-5 ayudas, o con 6+ ayudas — no un recorte del top-por-total,
            // sino su propio orden real (el líder de kills totales no siempre es el líder de kills 1vs1).
            topKillersSolo: topBy('killsSolo'),
            topKillersLow: topBy('killsLow'),
            topKillersHigh: topBy('killsHigh'),
            topFameSolo: topBy('fameSolo'),
            topFameLow: topBy('fameLow'),
            topFameHigh: topBy('fameHigh'),
            topDeathsSolo: topBy('deathsSolo'),
            topDeathsLow: topBy('deathsLow'),
            topDeathsHigh: topBy('deathsHigh'),
            topKillersMax: topBy('killsMax'),
            topFameMax: topBy('fameMax'),
            topDeathsMax: topBy('deathsMax'),
            // Chat 174 (dueño): «más de 20 ya es ZvZ». La API no da más de 20 personas por kill (grupo de Albion), así que
            // «ZvZ (20+)» es por el tamaño real de la pelea, sin tope: el mismo corte que Gremios → ZvZ y Top → ZvZ.
            topKillersZvz: topBy('killsZvz'),
            topFameZvz: topBy('fameZvz'),
            topDeathsZvz: topBy('deathsZvz'),
            topGuilds: guilds.sort((a, b) => b.kills - a.kills).slice(0, LEADERBOARD_TOP_N),
            // Mismo ranking de gremios, pero filtrado por el tamaño real de la pelea donde ocurrió cada
            // kill/victoria — pedido explícito del usuario: el mismo filtro </10, 10-19, 20+ (ZvZ) que ya
            // tiene "Peleas de gremio" también en Rankings → Gremios.
            topGuildsSmall: sortGuilds(guildStatsBySize.small),
            topGuildsMedium: sortGuilds(guildStatsBySize.medium),
            topGuildsZvz: sortGuilds(guildStatsBySize.zvz),
            // Chat 174 (dueño): Rankings → Gremios con filtro de asistencia. Kills, muertes y fama del corte; las peleas
            // ganadas y perdidas son las del gremio en todas sus peleas (una pelea no tiene corte de asistencia).
            ...Object.fromEntries(SCORE_ASSISTS.map((cut, i) => {
                const totals = new Map(guilds.map((g) => [g.name, g]));
                return [
                    `topGuilds${cut}`,
                    [...guildAssist.entries()]
                        .filter(([, s]) => s[i] > 0)
                        .map(([name, s]) => ({
                        name,
                        kills: s[i],
                        fame: s[i + 8],
                        deaths: s[i + 4],
                        battlesWon: totals.get(name)?.battlesWon ?? 0,
                        battlesLost: totals.get(name)?.battlesLost ?? 0,
                    }))
                        .sort((a, b) => b.kills - a.kills)
                        .slice(0, LEADERBOARD_TOP_N),
                ];
            })),
            // Top local por puntaje (kills×2 − muertes×3) — se combina con los otros 2 servidores en
            // `refreshCraftingLeaderboards` para armar el doc `leaderboards/global`. Top 100 acá (no 20)
            // porque solo la suma de los 3 recortes locales compone el top 100 global real.
            topScoreLocal: players
                .map((p) => ({
                name: p.name,
                guild: p.guild,
                id: p.id,
                region,
                kills: p.kills,
                deaths: p.deaths,
                assists: p.assists ?? 0,
                score: p.kills * 2 - p.deaths * 3,
            }))
                .sort((a, b) => b.score - a.score)
                .slice(0, GLOBAL_SCORE_TOP_N),
            // Mismo puntaje (kills×2 − muertes×3), pero SOLO contando kills/muertes ocurridas en una pelea
            // de 20+ participantes — "Puntaje ZvZ Jugadores/Gremios" del sitio de referencia, pedido
            // explícito del usuario. Filtra a >0 actividad ZvZ real antes de rankear (si no, el top se
            // llenaría de jugadores con 0/0 que nunca participaron en un ZvZ).
            topScoreZvzLocal: players
                .filter((p) => p.killsZvz > 0 || p.deathsZvz > 0)
                .map((p) => ({
                name: p.name,
                guild: p.guild,
                id: p.id,
                region,
                kills: p.killsZvz,
                deaths: p.deathsZvz,
                assists: assistsZvzByName.get(p.name) ?? 0,
                score: p.killsZvz * 2 - p.deathsZvz * 3,
            }))
                .sort((a, b) => b.score - a.score)
                .slice(0, GLOBAL_SCORE_TOP_N),
            // Chat 174 (dueño): el mismo puntaje con el filtro de asistencia, cada uno con su propio orden real (no un
            // recorte del total), como Kills/Fama/Muertes. Solo quien tuvo actividad en ese corte.
            ...Object.fromEntries(SCORE_ASSISTS.map((cut) => [
                `topScore${cut}Local`,
                players
                    .filter((p) => p[`kills${cut}`] > 0 || p[`deaths${cut}`] > 0)
                    .map((p) => ({
                    name: p.name,
                    guild: p.guild,
                    id: p.id,
                    region,
                    kills: p[`kills${cut}`],
                    deaths: p[`deaths${cut}`],
                    score: p[`kills${cut}`] * 2 - p[`deaths${cut}`] * 3,
                }))
                    .sort((a, b) => b.score - a.score)
                    .slice(0, GLOBAL_SCORE_TOP_N),
            ])),
            // Chat 174: «Gremios» en Top, todas las peleas (no solo ZvZ), con los mismos cortes de asistencia.
            topGuildScoreLocal: guilds
                .map((g) => ({ name: g.name, region, kills: g.kills, deaths: g.deaths ?? 0, score: g.kills * 2 - (g.deaths ?? 0) * 3 }))
                .sort((a, b) => b.score - a.score)
                .slice(0, GLOBAL_SCORE_TOP_N),
            ...Object.fromEntries(SCORE_ASSISTS.map((cut, i) => [
                `topGuildScore${cut}Local`,
                [...guildAssist.entries()]
                    .filter(([, s]) => s[i] > 0 || s[i + 4] > 0)
                    .map(([name, s]) => ({ name, region, kills: s[i], deaths: s[i + 4], score: s[i] * 2 - s[i + 4] * 3 }))
                    .sort((a, b) => b.score - a.score)
                    .slice(0, GLOBAL_SCORE_TOP_N),
            ])),
            topGuildScoreZvzLocal: [...guildStatsBySize.zvz.values()]
                .map((g) => ({
                name: g.name,
                region,
                kills: g.kills,
                deaths: g.deaths,
                score: g.kills * 2 - g.deaths * 3,
            }))
                .sort((a, b) => b.score - a.score)
                .slice(0, GLOBAL_SCORE_TOP_N),
            // Top local de batallas por fama total — se combina con los otros 2 servidores en
            // `refreshCraftingLeaderboards` para armar `leaderboards/global`, igual que `topScoreLocal`.
            topBattlesLocal: allBattles
                .map((b) => ({
                battleId: b.battleId,
                region,
                startTime: b.startTime,
                totalKills: b.totalKills,
                totalFame: b.totalFame,
                topGuildNames: [...b.guilds]
                    .filter((g) => g.name)
                    .sort((a, c) => c.kills - a.kills)
                    .slice(0, 3)
                    .map((g) => g.name),
            }))
                .sort((a, b) => b.totalFame - a.totalFame)
                .slice(0, GLOBAL_SCORE_TOP_N),
            biggestKill,
            // Mismo hero "kill con más fama de la ventana", pero cada uno filtrado a su propio bucket de
            // ayuda — pedido explícito del usuario: al cambiar el filtro de asistencia, el hero de arriba
            // debe cambiar también, no quedarse siempre en la kill más grande de TODAS.
            biggestKillSolo: biggestKillByBucket.solo,
            biggestKillLow: biggestKillByBucket.low,
            biggestKillHigh: biggestKillByBucket.high,
            biggestKillMax,
            // Categoría "Fama caída" del sitio de referencia — a diferencia de `biggestKill` (una sola
            // kill destacada arriba del todo), esto es un top real navegable de las 20 kills con más fama
            // de la ventana, cada una tocable para ver su desglose completo.
            topFameKills: [...topFameKills],
            topFameKillsSolo: [...topFameKillsByBucket.solo],
            topFameKillsLow: [...topFameKillsByBucket.low],
            topFameKillsHigh: [...topFameKillsByBucket.high],
            topFameKillsMax: [...topFameKillsMax],
            // Chat 175: solo va a `leaderboard_top` (`legacyRankings` la quita de los docs que leen las versiones viejas).
            topFameKillsZvz: [...topFameKillsZvz],
            sampleSize,
        };
    }
    return { addKill, finish };
}
export function forEachNdjsonRow(text, onRow) {
    let start = 0;
    while (start < text.length) {
        let end = text.indexOf('\n', start);
        if (end === -1)
            end = text.length;
        const line = text.slice(start, end);
        start = end + 1;
        if (!line.trim())
            continue;
        let row;
        try {
            row = JSON.parse(line);
        }
        catch {
            continue;
        }
        onRow(row);
    }
}

export const RANKING_CORE_SOURCE_SHA = 'a29c37fbbfca2356';
