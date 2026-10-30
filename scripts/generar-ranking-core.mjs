// Genera `lib/ranking-core.mjs` a partir del acumulador de Rankings de las funciones (repo Albion World): el MISMO
// código que usa `refreshCraftingLeaderboards`, sin los tipos. Igual que `generar-meta-core.mjs`: así Rankings
// desde stats-builder da exactamente lo mismo que hoy con las mismas kills.
//
//   node scripts/generar-ranking-core.mjs --functions "<Albion World>/functions/src" --ts "<.../node_modules/typescript>"
//
// Trozos (si cambian las marcas, el script falla en vez de generar algo a medias):
//  - index.ts: desde `export type ServerStoredKill` hasta antes de `function lastNDatesUTC` (tipos, umbrales,
//    `killPeople`, `assistBucket`, `guildSizeBucket`);
//  - index.ts: desde `export function aggregateCombatRankings` hasta antes de `async function fetchCraftingFame`
//    (`createCombatRankingsAccumulator`);
//  - leaderboard-season.ts: `countAssists`;
//  - index.ts: `forEachNdjsonRow` (cómo se leen las líneas: una rota se salta);
//  - las constantes `RANKING_TOP_N` (ranking-top.ts) y `GLOBAL_SCORE_TOP_N` (index.ts), por su valor.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const dir = arg('--functions');
const tsPath = arg('--ts');
if (!dir || !tsPath) {
  console.error('uso: node scripts/generar-ranking-core.mjs --functions <functions/src> --ts <carpeta de typescript>');
  process.exit(2);
}
const ts = createRequire(import.meta.url)(path.resolve(tsPath));
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n');
const index = read('index.ts');
const season = read('leaderboard-season.ts');
const top = read('ranking-top.ts');

function slice(text, from, to, name) {
  const a = text.indexOf(from);
  const b = text.indexOf(to, a + 1);
  if (a < 0 || b < 0) throw new Error(`no encontré las marcas de ${name}`);
  return text.slice(a, b);
}
const parts = [
  slice(index, 'export type ServerStoredKill', 'function lastNDatesUTC', 'tipos y umbrales'),
  slice(season, 'export function countAssists', 'const TOP_FAME_KILLS_N', 'countAssists'),
  slice(index, 'export function aggregateCombatRankings', 'async function fetchCraftingFame', 'acumulador'),
  slice(index, 'export function forEachNdjsonRow', '/** Días encontrados en el escáner', 'forEachNdjsonRow'),
];
const pure = parts.join('\n');
if (/firebase|getFirestore|getStorage|onSchedule|\bfetch\(|await /.test(pure)) throw new Error('el trozo usa Firebase, red o await: revisar las marcas');
const topN = Number(/export const RANKING_TOP_N = (\d+);/.exec(top)?.[1]);
const globalN = Number(/const GLOBAL_SCORE_TOP_N = (\d+);/.exec(index)?.[1]);
if (!topN || !globalN) throw new Error('no encontré RANKING_TOP_N o GLOBAL_SCORE_TOP_N');
const out = ts.transpileModule(pure, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, removeComments: false } }).outputText;
const sha = crypto.createHash('sha256').update(`${topN}|${globalN}|${pure}`).digest('hex').slice(0, 16);
const header = [
  '// GENERADO por scripts/generar-ranking-core.mjs: NO editar a mano.',
  `// Fuente: functions/src/index.ts + leaderboard-season.ts (repo Albion World), sha256 ${sha}.`,
  '// Es el mismo acumulador que usa `refreshCraftingLeaderboards`, sin los tipos.',
  `const LEADERBOARD_TOP_N = ${topN};`,
  `const GLOBAL_SCORE_TOP_N = ${globalN};`,
  '',
].join('\n');
const target = path.join(here, '..', 'lib', 'ranking-core.mjs');
fs.writeFileSync(target, `${header}${out}\nexport const RANKING_CORE_SOURCE_SHA = '${sha}';\n`);
console.log(`escrito ${path.relative(process.cwd(), target)} (${out.length} caracteres, fuente ${sha})`);
