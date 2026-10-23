# TITSA Tracker (lineas + sentido)

App web estatica para GitHub Pages que muestra:

- Mapa de las lineas seleccionadas.
- Selector UI de lineas (multiseleccion).
- Filtro por sentido: todas, ida (0), vuelta (1).
- Guaguas activas estimadas por horario GTFS.
- ETAs por parada y popup ETA al hacer clic en cada parada del mapa.

## Fuente de datos

La app intenta cargar GTFS en este orden:

1. `/data/Google_transit.zip` (recomendado)
2. `https://www.titsa.com/Google_transit.zip` (puede fallar por CORS)

## Importante

Esta app **no** usa GPS oficial de cada guagua. La posicion y ETA se calculan con horarios GTFS.

## Abrir la app

- En un ordenador, abre `index.html` desde esta carpeta. El horario guardado acompaña a la app.
- En un móvil, abre la copia publicada con un enlace seguro y añádela a la pantalla de inicio.
- Los minutos salen del horario publicado. TITSA no incluye en este archivo la ubicación real de cada guagua.

## Despliegue en GitHub Pages

1. Sube estos archivos al repo (incluyendo `/data/Google_transit.zip` si quieres evitar CORS).
2. En GitHub: `Settings > Pages`.
3. En "Build and deployment", selecciona `Deploy from a branch`.
4. Elige rama `main` (o la que uses) y carpeta `/ (root)`.
5. Guarda y espera el publish.

## Config inicial

En `/app.js` puedes cambiar lineas iniciales en `CONFIG.initialLines`.
