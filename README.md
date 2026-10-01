# albion-world-stats

Estadísticas de **Albion World** a partir del historial que guarda el scraper de kills (kills, peleas y
equipo de cada kill, desde el 25/07/2026). Corre en GitHub Actions: **0 Firebase**.

| Qué | Dónde (ramas) |
|---|---|
| Resumen de cada día cerrado por región | `rollups/<region>/<fecha>.json.gz` (solo se agregan) |
| Jugadores: kills, muertes, asistencias, fama, daño, curación por ventana, y su mejor día de la semana (`bd`: kills, muertes, daño) | `index/<region>/p/<0-255>.json` |
| Gremios: kills, muertes, fama, peleas, ganadas/perdidas + rivales (30 días y todo) | `index/<region>/g/<0-31>.json` |
| Armas: kills y muertes con cada arma | `index/<region>/weapons.json` |
| Lo mismo solo de HOY (cada hora) | `today/<region>/...` |
| Salud por región | `index/status.json`, `today/status.json` |

Ventanas del índice: `w` (6 días cerrados), `m` (29), `s` (temporada, desde `config.json`), `a` (todo). La app
les suma `today` para que terminen hoy (7 días, 30 días, temporada, todo, y "hoy").

La parte de un nombre es `FNV-1a(nombre en minúsculas) % 256` (gremios: `% 32`): la app baja **una** parte
(~40 KB, ~10 KB comprimida) en vez de los archivos diarios enteros (~45 MB por día en Europa).

Local: `npm test`, `node build.mjs hourly --region asia`, `node build.mjs daily --region europe --max-days 7`.
