// Genera `lib/meta-core.mjs` a partir de la parte PURA de `functions/src/meta-armory.ts` (repo Albion World).
// Por qué generado y no reescrito a mano: Meta Armory desde el escáner tiene que dar EXACTAMENTE lo mismo que
// `sampleMetaArmory` con las mismas kills. Copiar el código con el compilador de TypeScript (solo quita los tipos)
// evita las diferencias de una traducción a mano. Si cambia `meta-armory.ts`, se vuelve a correr esto.
//
//   node scripts/generar-meta-core.mjs --src "<Albion World>/functions/src/meta-armory.ts" --ts "<.../node_modules/typescript>"
//
// Toma desde `export const META_SLOTS` hasta justo antes de `async function fetchEventsPage` (sin Firebase ni red).
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const src = arg('--src');
const tsPath = arg('--ts');
if (!src || !tsPath) {
  console.error('uso: node scripts/generar-meta-core.mjs --src <meta-armory.ts> --ts <carpeta de typescript>');
  process.exit(2);
}
const ts = createRequire(import.meta.url)(path.resolve(tsPath));
const full = fs.readFileSync(src, 'utf8').replace(/\r\n/g, '\n');
const start = full.indexOf('export const META_SLOTS');
const end = full.indexOf('async function fetchEventsPage');
if (start < 0 || end < 0 || end < start) throw new Error('no encontré las marcas en meta-armory.ts');
const pure = full.slice(start, end);
if (/firebase|getFirestore|getStorage|onSchedule|\bfetch\(/.test(pure)) throw new Error('la parte pura usa Firebase o red: revisar las marcas');
const out = ts.transpileModule(pure, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, removeComments: false },
}).outputText;
const sha = crypto.createHash('sha256').update(pure).digest('hex').slice(0, 16);
const header = `// GENERADO por scripts/generar-meta-core.mjs: NO editar a mano.\n// Fuente: functions/src/meta-armory.ts (repo Albion World), parte pura, sha256 ${sha}.\n// Es el mismo código que usa \`sampleMetaArmory\`, sin los tipos.\n`;
const target = path.join(here, '..', 'lib', 'meta-core.mjs');
fs.writeFileSync(target, `${header}${out}\nexport { dateStr, mondayOf };\nexport const META_CORE_SOURCE_SHA = '${sha}';\n`);
console.log(`escrito ${path.relative(process.cwd(), target)} (${out.length} caracteres, fuente ${sha})`);
