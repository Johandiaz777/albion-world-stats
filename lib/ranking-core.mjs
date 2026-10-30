// GENERADO por scripts/generar-ranking-core.mjs: NO editar a mano.
// Fuente: functions/src/index.ts + leaderboard-season.ts (repo Albion World), sha256 5290337c6871d221.
// Es el mismo acumulador que usa `refreshCraftingLeaderboards`, sin los tipos.
const LEADERBOARD_TOP_N = 50;
const GLOBAL_SCORE_TOP_N = 100;
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
 */
export function createCombatRankingsAccumulator(battles, region) {
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
    let sampleSize = 0;
    let finished = false;
    // Asistencias por nombre (parte 81): un número por persona, no una ficha entera — los que solo
    // asisten no entran a ningún top y crear su ficha pesaría en memoria (ver el OOM de la parte 31).
    const assistsByName = new Map();
    const assistsZvzByName = new Map();
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
    // battleId → tamaño real de esa pelea (roster completo, no solo el grupo del killer en un kill
    // puntual) — permite bucketizar también las kills sueltas por el tamaño de la pelea a la que
    // pertenecen, no solo las victorias/derrotas por pelea que ya vienen agregadas en `battles`.
    const battleSizeById = new Map();
    for (const battle of battles) {
        if (battle.players)
            battleSizeById.set(battle.battleId, battle.players.length);
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
        const battleSize = kill.battleId !== null ? battleSizeById.get(kill.battleId) : undefined;
        const battleSizeBucket = battleSize !== undefined ? guildSizeBucket(battleSize) : null;
        const isZvz = battleSizeBucket === 'zvz';
        countAssists(kill, assistsByName, isZvz ? assistsZvzByName : null);
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
            if (isZvz)
                p.killsZvz += 1;
            if (kill.killerGuild) {
                const g = guild(kill.killerGuild);
                g.kills += 1;
                g.fame += kill.totalFame;
                if (battleSizeBucket) {
                    const bucketed = guildIn(guildStatsBySize[battleSizeBucket], kill.killerGuild);
                    bucketed.kills += 1;
                    bucketed.fame += kill.totalFame;
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
            if (isZvz)
                p.deathsZvz += 1;
            if (kill.victimGuild) {
                guild(kill.victimGuild).deaths += 1;
                if (battleSizeBucket)
                    guildIn(guildStatsBySize[battleSizeBucket], kill.victimGuild).deaths += 1;
            }
        }
    }
    function finish() {
        if (finished)
            throw new Error('createCombatRankingsAccumulator: finish dos veces');
        finished = true;
        for (const entry of playerStats.values()) {
            entry.id = nameToId.get(entry.name.toLowerCase()) ?? null;
            entry.assists = assistsByName.get(entry.name) ?? 0;
        }
        for (const battle of battles) {
            const bucket = battle.players ? guildSizeBucket(battle.players.length) : null;
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
            topGuilds: guilds.sort((a, b) => b.kills - a.kills).slice(0, LEADERBOARD_TOP_N),
            // Mismo ranking de gremios, pero filtrado por el tamaño real de la pelea donde ocurrió cada
            // kill/victoria — pedido explícito del usuario: el mismo filtro </10, 10-19, 20+ (ZvZ) que ya
            // tiene "Peleas de gremio" también en Rankings → Gremios.
            topGuildsSmall: sortGuilds(guildStatsBySize.small),
            topGuildsMedium: sortGuilds(guildStatsBySize.medium),
            topGuildsZvz: sortGuilds(guildStatsBySize.zvz),
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
            topBattlesLocal: battles
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

export const RANKING_CORE_SOURCE_SHA = '5290337c6871d221';
