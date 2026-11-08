# Argentina, repartida

*#30DayMapChallenge 2026 · Día 8 · Utopía*

¿Y si la tierra argentina se repartiera en partes iguales entre sus 46.234.830 habitantes?
Esta app corta el país en una parcela por persona y te deja recorrerlas sobre imagen satelital,
buscar una por número o saltar a una al azar. Hoy, más de un tercio de los hogares no vive en una
casa propia (INDEC, Censo 2022).

## Cómo se arman las parcelas

- **Qué se reparte:** el territorio continental, Tierra del Fuego y las Islas Malvinas, menos lo que es de todos o
  donde nadie puede vivir:
  - parques y reservas nacionales, parques provinciales y municipales, reservas estrictas y zonas militares;
  - plazas y parques urbanos;
  - lagos, ríos, lagunas y glaciares;
  - las tierras por encima de los 4.500 m (el pueblo más alto del país, Olacapato, está a unos 4.100 m).

  Las reservas de biosfera, los sitios Ramsar y las reservas de uso múltiple quedan adentro, porque
  buena parte de esa tierra es privada y está habitada.
- **La grilla:** franjas de igual altura en latitud, de norte a sur. En cada franja las columnas
  tienen el ancho justo para que todas las parcelas midan exactamente lo mismo sobre la esfera:
  cada una es un cuadrado y las filas quedan apenas corridas, como ladrillos.
- **Qué celdas cuentan:** una celda es parcela si su centro cae en tierra repartible. La superficie
  se ajusta para que alcance para todos, con unas pocas parcelas de sobra.
- **Numeración:** la 1 está en la punta norte, en Jujuy; se numera de oeste a este y después hacia el sur.

Las 46 millones de parcelas nunca se guardan. `public/data/grid.json` tiene, para cada franja,
los tramos de columnas que son parcela, y `src/grid.js` reconstruye cualquier parcela a partir de
su número o de su posición. Los datos se preparan en R con `prep_parcels.R`, en el repositorio del challenge.

## Puntaje y "Top X%"

Cada terreno suma hasta 100 puntos: agua dulce (20), clima (25), servicios como hospital, pueblo,
ruta, escuela y aeropuerto (30), vecinos (15) y mar (10). Las reglas están en `src/score.js`.
El puntaje usa solo los datos preparados, no la imagen satelital, para poder calcularlo igual en
una muestra: `node scripts/score_sample.mjs` puntúa 20.000 parcelas al azar y guarda cuántas sacan
cada puntaje en `public/data/stats/score.json`. Con eso, cada terreno sabe en qué porcentaje está.
Hay que volver a correrlo si cambian los datos.

## Compartir

La ficha arma una imagen de 1600 × 900 con la parcela sobre la imagen satelital, el puntaje y
algunos datos (`src/share.js`). En el celular se comparte directo con el menú del sistema; en la
computadora se descarga, se copia o se manda el link por WhatsApp. No hay registro ni servidor.

## Cómo correrla

```sh
npm install
npm run dev       # servidor local
npm run build     # sitio estático en dist/
```

La compilación usa rutas relativas, así que `dist/` funciona desde cualquier carpeta. El workflow
`.github/workflows/deploy.yml` la publica en GitHub Pages con cada push a `main` (en el repositorio:
Settings > Pages > Source: "GitHub Actions").

## Fuentes

- Población: INDEC, Censo Nacional 2022, resultados definitivos.
- Hogares en vivienda propia: INDEC, Censo 2022, condiciones habitacionales (65,5% del país, 52,9% en la Ciudad).
- Áreas protegidas, zonas militares, agua, glaciares, plazas y parques: © colaboradores de OpenStreetMap, ODbL.
- Altura: Terrain Tiles en AWS (vía elevatr, zoom 7, para excluir la alta montaña; en la ficha, leídos en vivo).
- Clima: WorldClim 2.1, temperatura media y lluvia anual, promedios 1970–2000.
- Ecorregiones: RESOLVE Ecoregions 2017 (CC BY 4.0), con nombres en castellano.
- Vecinos: WorldPop 2020 (población por km²).
- Hospitales, escuelas, pueblos, aeropuertos con código IATA, rutas nacionales, ríos y lagos: OpenStreetMap
  (los datos se preparan con `prep_stats.R`).
- Cobertura del suelo en la ficha: estimada a partir de los colores de la imagen Sentinel-2 cloudless de la parcela.
- País y provincias: Natural Earth (dominio público).
- Imagen: Sentinel-2 cloudless 2020 de EOX IT Services GmbH (contiene datos modificados de Copernicus
  Sentinel 2020), CC BY-NC-SA 4.0, para uso no comercial. Nombres de lugares: EOX, datos © colaboradores de OpenStreetMap.

Hecho por Franco Guiragossian · [dataviz.ar](https://dataviz.ar)
