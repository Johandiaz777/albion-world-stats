// Compara el Meta publicado hoy (doc `meta_armory/{región}` de Firestore, lectura pública) con el que arma
// stats-builder (rama `meta`, `armory/<región>.json`). Solo lectura: sirve para la etapa «en paralelo» antes de
// poner `appConfig/metaSource.mode = 'repos'`.
//
//   node scripts/comparar-meta.mjs [ventana=week] [base=https://raw.githubusercontent.com/Johandiaz777/albion-world-stats/meta]
//   (la base también puede ser una carpeta local `metapub` de una corrida de prueba)
//
// Para cada región: kills detrás de cada uno, armas del top 10 en común y la diferencia de su porcentaje de uso,
// piezas (slots) y builds del top 10 en común. Con la muestra (~9-20 % de las kills) y el total, el orden de arriba
// tiene que coincidir casi siempre; las diferencias grandes están en la cola.
const [windowName = 'week', base = 'https://raw.githubusercontent.com/Johandiaz777/albion-world-stats/meta'] = process.argv.slice(2);
const FIRESTORE = 'https://firestore.googleapis.com/v1/projects/albion-world/databases/(default)/documents';

/** Valor de la API REST de Firestore → JS. */
function decode(v) {
  if (!v || typeof v !== 'object') return v;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(decode);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields ?? {}).map(([k, x]) => [k, decode(x)]));
  return v;
}

async function json(url) {
  // Base local (una carpeta `metapub` de una corrida de prueba) en vez de GitHub.
  if (!/^https?:/.test(url)) return JSON.parse((await import('node:fs')).readFileSync(url, 'utf8'));
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

const pct = (n) => `${(n * 100).toFixed(1)} %`;
function share(list, key, count) {
  const total = list.reduce((a, x) => a + count(x), 0) || 1;
  return new Map(list.map((x) => [key(x), count(x) / total]));
}
function compareTop(name, a, b, n = 10) {
  const topA = [...a.keys()].slice(0, n);
  const topB = new Set([...b.keys()].slice(0, n));
  const common = topA.filter((k) => topB.has(k));
  const diffs = common.map((k) => Math.abs((a.get(k) ?? 0) - (b.get(k) ?? 0)));
  const maxDiff = diffs.length ? Math.max(...diffs) : 0;
  return `${name}: ${common.length}/${n} en común, mayor diferencia de porcentaje ${pct(maxDiff)}`;
}

for (const region of ['europe', 'americas', 'asia', 'all']) {
  try {
    const docRaw = await json(`${FIRESTORE}/meta_armory/${region}`);
    const doc = decode({ mapValue: { fields: docRaw.fields } });
    const repo = await json(`${base}/armory/${region}.json`);
    const a = doc[windowName];
    const b = repo[windowName];
    if (!a || !b) {
      console.log(`${region}: falta la ventana ${windowName} (${a ? '' : 'Firestore '}${b ? '' : 'GitHub'})`);
      continue;
    }
    console.log(`${region} (${windowName}): muestra ${a.samples} kills · escáner ${b.samples} kills (×${(b.samples / Math.max(1, a.samples)).toFixed(1)}); Firestore ${doc.source ?? 'sample'} ${doc.updatedAt ?? ''}, GitHub ${repo.builtAt}`);
    const weapons = (w) => share(w.weapons ?? [], (x) => x.w, (x) => (x.k ?? 0) + (x.d ?? 0));
    console.log(`  ${compareTop('armas', weapons(a), weapons(b))}`);
    for (const slot of ['MainHand', 'Armor', 'Head', 'Shoes', 'Cape']) {
      const s = (w) => share(w.slots?.[slot] ?? [], (x) => x.base, (x) => x.c ?? 0);
      console.log(`  ${compareTop(`pieza ${slot}`, s(a), s(b))}`);
    }
    const builds = (w) => share(w.builds ?? [], (x) => x.k, (x) => x.c ?? 0);
    console.log(`  ${compareTop('builds', builds(a), builds(b))}`);
  } catch (err) {
    console.log(`${region}: ${err.message}`);
  }
}
