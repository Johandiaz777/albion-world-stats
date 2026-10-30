// Dónde guarda Meta Armory (desde el escáner) su estado y sus días (parte 136/137, fase 2).
//
// Un mismo almacén para el disco (build.mjs, en el runner) y para la memoria (pruebas): solo cambia `io`.
//
//   metastate/<región>/state.json.gz        cursores de los archivos del escáner y kills sin pareja
//   metastate/<región>/days/<día>.json.gz   días que todavía pueden cambiar: abiertos (sin topes) y cerrados (con
//                                           topes, aceptan kills tardías del relleno de huecos). Llevan los ids de
//                                           todas sus kills para no contar ninguna dos veces.
//   rollups/meta/<región>/<día>.json.gz     días FINALES: ya no cambian (sin ids). Rama `rollups`, solo se agregan.
//   rollups/meta/<región>/months/<mes>.json.gz  meses compactados (solo meses con todos sus días finales).
//
// Un día final se escribe en `rollups` y su copia en `metastate` queda marcada `final` hasta que una corrida
// siguiente lo vea ya PUBLICADO en la rama `rollups` (lo trae el clon). Así, si falla el push de una de las dos
// ramas, el día no se pierde: se vuelve a escribir desde la copia de `metastate`.
import fs from 'node:fs';
import path from 'node:path';

import { readJson, writeJson } from './store.mjs';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

/** Entrada/salida sobre carpetas reales (`root` = la carpeta del repo de stats). */
export function diskIo(root) {
  return {
    read: (rel) => readJson(path.join(root, rel), null),
    write: (rel, value) => writeJson(path.join(root, rel), value),
    remove: (rel) => fs.rmSync(path.join(root, rel), { force: true }),
    exists: (rel) => fs.existsSync(path.join(root, rel)),
    list: (rel) => {
      const dir = path.join(root, rel);
      return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    },
  };
}

/** Entrada/salida en memoria (pruebas). `files` = Map ruta → valor (se guarda una copia, como en disco). */
export function memoryIo(files = new Map()) {
  const clone = (v) => (v === null || v === undefined ? null : JSON.parse(JSON.stringify(v)));
  return {
    files,
    read: (rel) => clone(files.get(rel) ?? null),
    write: (rel, value) => {
      files.set(rel, clone(value));
      return JSON.stringify(value).length;
    },
    remove: (rel) => files.delete(rel),
    exists: (rel) => files.has(rel),
    list: (rel) => {
      const prefix = rel.endsWith('/') ? rel : `${rel}/`;
      const out = new Set();
      for (const key of files.keys()) if (key.startsWith(prefix)) out.add(key.slice(prefix.length).split('/')[0]);
      return [...out];
    },
  };
}

const dayOfFile = (name) => name.replace(/\.json\.gz$/, '');

/**
 * Almacén de UNA región. `publishedFinal` = días finales que ya estaban en la rama `rollups` al empezar la corrida
 * (se calcula solo, al crear el almacén: es lo que trajo el clon).
 */
export function createMetaStore(io, region) {
  const statePath = `metastate/${region}/state.json.gz`;
  const daysDir = `metastate/${region}/days`;
  const finalDir = `rollups/meta/${region}`;
  const monthsDir = `rollups/meta/${region}/months`;
  const dayPath = (date) => `${daysDir}/${date}.json.gz`;
  const finalPath = (date) => `${finalDir}/${date}.json.gz`;
  const monthPath = (month) => `${monthsDir}/${month}.json.gz`;
  const listDates = (dir) => io.list(dir).map(dayOfFile).filter((d) => DATE_RE.test(d));
  const publishedFinal = new Set(listDates(finalDir));
  const writtenFinal = new Set();
  /** Estado de cada día de `metastate` (se lee una vez por corrida y se mantiene al escribir). */
  let statuses = null;
  const statusIndex = () => {
    if (!statuses) {
      statuses = new Map();
      for (const d of listDates(daysDir)) statuses.set(d, io.read(dayPath(d))?.status ?? 'open');
    }
    return statuses;
  };

  return {
    region,
    readState: () => io.read(statePath),
    writeState: (state) => io.write(statePath, state),
    /** El día desde `metastate` (si todavía puede cambiar o espera publicarse) o desde `rollups` (final). */
    readDay(date) {
      const mutable = io.read(dayPath(date));
      if (mutable) return mutable;
      const final = io.read(finalPath(date));
      return final ? { ...final, status: 'final' } : null;
    },
    /** Guarda un día abierto o cerrado (todavía puede cambiar). */
    writeDay(day) {
      if (day.status === 'final') throw new Error(`writeDay con un día final (${day.date}): usar finalizeDay`);
      statusIndex().set(day.date, day.status ?? 'open');
      return io.write(dayPath(day.date), day);
    },
    /** Día final: va a `rollups` sin ids; la copia de `metastate` queda marcada hasta verla publicada. */
    finalizeDay(day) {
      const { ids: _ids, ...rest } = day;
      const final = { ...rest, status: 'final' };
      io.write(finalPath(day.date), final);
      io.write(dayPath(day.date), { ...final, ids: day.ids ?? '' });
      writtenFinal.add(day.date);
      statusIndex().set(day.date, 'final');
    },
    /** Borra de `metastate` los días finales que la rama `rollups` ya tenía publicados al empezar esta corrida. */
    pruneFinal() {
      const removed = [];
      for (const [date, status] of [...statusIndex()]) {
        if (status !== 'final' || writtenFinal.has(date) || !publishedFinal.has(date)) continue;
        io.remove(dayPath(date));
        statuses.delete(date);
        removed.push(date);
      }
      return removed;
    },
    /** Días de `metastate` por estado ('open', 'closed' o 'final'). */
    listMutable(status) {
      return [...statusIndex()]
        .filter(([, s]) => s === status)
        .map(([d]) => d)
        .sort();
    },
    /** Todos los días con resumen (los de `metastate` y los finales). */
    listDays: () => [...new Set([...listDates(daysDir), ...listDates(finalDir)])].sort(),
    /** Días que ya no cambian (finales en `rollups`, publicados o recién escritos). */
    listFinalDays: () => listDates(finalDir).sort(),
    readMonth: (month) => (MONTH_RE.test(month) ? io.read(monthPath(month)) : null),
    writeMonth: (month, value) => io.write(monthPath(month), value),
  };
}
