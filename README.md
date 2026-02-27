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

## Error "Failed to fetch"

Si te aparece ese error en VS Code / navegador:

1. Descarga el ZIP GTFS de TITSA.
2. Guardalo como `Google_transit.zip` dentro de `/data`.
3. Sirve el proyecto por HTTP (no abrir `index.html` directo):

```bash
python3 -m http.server 8080
# abrir http://127.0.0.1:8080
```

## Despliegue en GitHub Pages

1. Sube estos archivos al repo (incluyendo `/data/Google_transit.zip` si quieres evitar CORS).
2. En GitHub: `Settings > Pages`.
3. En "Build and deployment", selecciona `Deploy from a branch`.
4. Elige rama `main` (o la que uses) y carpeta `/ (root)`.
5. Guarda y espera el publish.

## Config inicial

En `/app.js` puedes cambiar lineas iniciales en `CONFIG.initialLines`.
