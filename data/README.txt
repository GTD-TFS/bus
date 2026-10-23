Google_transit.zip contiene los horarios oficiales de TITSA, las paradas y los recorridos.

Google_transit-embedded.js acompaña el mismo horario para que la app pueda abrirse desde la carpeta en un ordenador sin pedir que se elija un archivo.

No contiene posiciones GPS ni retrasos en tiempo real. El mapa muestra el recorrido y las paradas, no la posición de cada guagua.

Para actualizarlo, descarga el archivo oficial desde https://www.titsa.com/Google_transit.zip y reemplaza este archivo. Mantén exactamente el nombre Google_transit.zip.

Después de cambiar Google_transit.zip, actualiza también Google_transit-embedded.js con `python3 data/build-embedded-feed.py`.

Fuente: TITSA, Portal de datos abiertos de Tenerife. Licencia CC BY.
