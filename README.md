# albion-world-stats

Estadísticas de **Albion World** a partir del historial que guarda el scraper de kills (kills, peleas y
equipo de cada kill, desde el 25/07/2026). Corre en GitHub Actions: **0 Firebase**.

| Qué | Dónde (ramas) |
|---|---|
| Resumen de cada día cerrado por región | `rollups/<region>/<fecha>.json.gz` (solo se agregan) |
| Jugadores: kills, muertes, asistencias, fama, daño, curación por ventana, y su mejor día de la semana (`bd`: kills, muertes, daño) | `index/<region>/players/<0-2047>.json` |
| Gremios: kills, muertes, fama, peleas, ganadas/perdidas + rivales (30 días y todo) | `index/<region>/guilds/<0-511>.json` |
| Directorio nombre → id del juego (un id por jugador, todos los vistos) | `index/<region>/ids/<0-1023>.json` |
| Armas: kills y muertes con cada arma | `index/<region>/weapons.json` |
| Lo mismo solo de HOY (cada hora) | `today/<region>/...` |
| Kills por nombre (asesino/víctima): bytes de cada línea en el archivo del día, para que la app pida solo esas líneas por Range (8 días) | `index/<region>/ki/<fecha>/<0-255>.json` (hoy, y ayer hasta que cierra: `today/<region>/ki/...`) |
| Peleas por gremio, igual (32 días) | `index/<region>/bi/<fecha>/<0-31>.json` (hoy: `today/<region>/bi/...`) |
| Salud por región | `index/status.json`, `today/status.json` |

Ventanas del índice: `w` (6 días cerrados), `m` (29), `s` (temporada, desde `config.json`), `a` (todo). La app
les suma `today` para que terminen hoy (7 días, 30 días, temporada, todo, y "hoy").

La parte de un nombre es `FNV-1a(nombre en minúsculas) % 2048` (gremios: `% 512`, ids: `% 1024`): la app baja
**una** parte (~30-60 KB, ~4-10 KB comprimida; un id ~1,5 KB) en vez de los archivos diarios enteros (~45 MB por
día en Europa). Medido el 03/10/2026: con 256 partes un perfil de Europa bajaba 460 KB (75 KB comprimida).

Local: `npm test`, `node build.mjs hourly --region asia`, `node build.mjs daily --region europe --max-days 7`.
