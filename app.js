const CONFIG = {
  gtfsZipUrls: ["./data/Google_transit.zip", "https://www.titsa.com/Google_transit.zip"],
  initialLines: ["470"],
  refreshMs: 30_000,
  minutesWindow: 120,
  maxShapesToDraw: 4,
  plannerWindowMinutes: 720,
  minTransferSeconds: 120,
  maxTransferStopsFromOrigin: 16,
  maxTransferStopsMid: 0,
  maxLegCandidates: 20,
  maxSecondLegEvents: 14,
  maxThirdLegEvents: 0,
  maxPlannerResults: 10,
  confitalStopIds: ["7276", "7346"],
  confitalDirectionByStop: {
    "7276": "Hacia Los Cristianos",
    "7346": "Hacia El Medano",
  },
};

const state = {
  raw: {},
  map: null,
  layers: {
    route: null,
    stops: null,
  },
  agencyTimezone: "Atlantic/Canary",
  routeById: new Map(),
  stopById: new Map(),
  shapesById: new Map(),
  allTrips: [],
  tripById: new Map(),
  stopTimesByTripAll: new Map(),
  stopTripIndex: new Map(),
  selectedLines: new Set(CONFIG.initialLines),
  selectedRouteIds: new Set(),
  filteredTrips: [],
  filteredStopTimesByTrip: new Map(),
  activeServiceIds: new Set(),
  previousActiveServiceIds: new Set(),
  activeTripIds: new Set(),
  maxServiceTimeSec: 0,
  feedServiceRange: null,
  lineOptions: [],
  lastUpcomingByStop: new Map(),
  stopMarkers: new Map(),
  confitalStops: new Set(),
  plannerStopIds: [],
  currentPos: null,
  currentOriginStopIds: [],
  plannerCache: new Map(),
  userLocationMarker: null,
  timer: null,
};

const el = {
  linePickerLabel: document.getElementById("linePickerLabel"),
  lineOptions: document.getElementById("lineOptions"),
  linePicker: document.getElementById("linePicker"),
  confitalSummary: document.getElementById("confitalSummary"),
  dataNotice: document.getElementById("dataNotice"),
  mapWrap: document.querySelector(".mapWrap"),
  mapCloseBtn: document.getElementById("mapCloseBtn"),
  mapExpandHint: document.getElementById("mapExpandHint"),
};

init().catch((err) => {
  el.confitalSummary.textContent = "No se pudieron cargar los horarios.";
  el.dataNotice.textContent = window.location.protocol === "file:"
    ? "No pude abrir el horario guardado junto a la app. Comprueba que la carpeta data sigue junto a index.html."
    : "No pude cargar los horarios. Comprueba la conexión y vuelve a cargar la página.";
  console.error(err);
});

async function init() {
  initMap();
  initMapExpandControls();
  el.confitalSummary.textContent = "Cargando horarios...";
  await loadGtfs();
  await finishStartup();
}

async function finishStartup() {
  state.feedServiceRange = getFeedServiceDateRange();
  buildGlobalIndexes();
  initControls();
  applyFiltersAndRender(true);
  if (!state.timer) state.timer = setInterval(refreshDynamicPanels, CONFIG.refreshMs);
}

function initMap() {
  state.map = L.map("map", {
    zoomControl: true,
    preferCanvas: true,
  }).setView([28.33, -16.51], 11);

  L.maplibreGL({
    style: "https://tiles.openfreemap.org/styles/liberty",
  }).addTo(state.map);

  state.layers.route = L.layerGroup().addTo(state.map);
  state.layers.stops = L.layerGroup().addTo(state.map);
}

function initMapExpandControls() {
  const expand = () => {
    el.mapWrap.classList.add("expanded");
    setTimeout(() => state.map?.invalidateSize(), 80);
  };
  const close = () => {
    el.mapWrap.classList.remove("expanded");
    setTimeout(() => state.map?.invalidateSize(), 80);
  };
  el.mapExpandHint.addEventListener("click", expand);
  el.mapCloseBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    close();
  });
  el.mapWrap.addEventListener("click", (ev) => {
    if (el.mapWrap.classList.contains("expanded")) return;
    if (ev.target === el.mapCloseBtn) return;
    expand();
  });
}

async function loadGtfs() {
  const zip = window.location.protocol === "file:"
    ? await loadBundledGtfsArchive()
    : await JSZip.loadAsync(await fetchGtfsZipData());

  state.raw.routes = await readCsv(zip, "routes.txt");
  state.raw.trips = await readCsv(zip, "trips.txt");
  state.raw.stop_times = await readCsv(zip, "stop_times.txt");
  state.raw.stops = await readCsv(zip, "stops.txt");
  state.raw.shapes = await readCsv(zip, "shapes.txt", true);
  state.raw.calendar = await readCsv(zip, "calendar.txt", true);
  state.raw.calendar_dates = await readCsv(zip, "calendar_dates.txt", true);
  state.raw.agency = await readCsv(zip, "agency.txt", true);

  if (state.raw.agency?.length && state.raw.agency[0].agency_timezone) {
    state.agencyTimezone = state.raw.agency[0].agency_timezone;
  }
}

async function loadBundledGtfsArchive() {
  if (!window.TITSA_GTFS_ARCHIVE_B64) {
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = new URL("./data/Google_transit-embedded.js", document.baseURI).href;
      script.onload = resolve;
      script.onerror = () => reject(new Error("No se pudo abrir el horario guardado junto a la app."));
      document.head.appendChild(script);
    });
  }

  const archive = window.TITSA_GTFS_ARCHIVE_B64;
  if (!archive) throw new Error("Falta el horario guardado junto a la app.");

  const zip = await JSZip.loadAsync(archive, { base64: true });
  window.TITSA_GTFS_ARCHIVE_B64 = "";
  return zip;
}

async function fetchGtfsZipData() {
  const errors = [];

  for (const url of CONFIG.gtfsZipUrls) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) {
        errors.push(`${url} -> HTTP ${res.status}`);
        continue;
      }
      return await res.arrayBuffer();
    } catch (err) {
      errors.push(`${url} -> ${err.message}`);
    }
  }

  throw new Error(`No se encontró el horario. ${errors.join(" | ")}`);
}

async function readCsv(zip, filename, optional = false) {
  const file = zip.file(filename);
  if (!file) {
    if (optional) return [];
    throw new Error(`Falta archivo GTFS obligatorio: ${filename}`);
  }

  const text = await file.async("text");
  const parsed = Papa.parse(text, {
    header: true,
    skipEmptyLines: true,
  });

  if (parsed.errors?.length) {
    console.warn(`CSV warnings en ${filename}:`, parsed.errors.slice(0, 3));
  }

  return parsed.data;
}

function buildGlobalIndexes() {
  state.routeById = new Map(state.raw.routes.map((r) => [r.route_id, r]));
  state.stopById = new Map(state.raw.stops.map((s) => [s.stop_id, s]));
  state.confitalStops = new Set(CONFIG.confitalStopIds.filter((id) => state.stopById.has(id)));
  state.allTrips = state.raw.trips;
  state.tripById = new Map(state.raw.trips.map((t) => [t.trip_id, t]));

  state.stopTimesByTripAll = new Map();
  for (const st of state.raw.stop_times) {
    const arrivalSec = parseGtfsTime(st.arrival_time);
    const departureSec = parseGtfsTime(st.departure_time);
    if (Number.isFinite(arrivalSec)) state.maxServiceTimeSec = Math.max(state.maxServiceTimeSec, arrivalSec);
    if (Number.isFinite(departureSec)) state.maxServiceTimeSec = Math.max(state.maxServiceTimeSec, departureSec);
    if (!state.stopTimesByTripAll.has(st.trip_id)) state.stopTimesByTripAll.set(st.trip_id, []);
    state.stopTimesByTripAll.get(st.trip_id).push(st);
  }
  for (const [, arr] of state.stopTimesByTripAll) {
    arr.sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));
  }

  state.stopTripIndex = new Map();
  for (const [tripId, arr] of state.stopTimesByTripAll.entries()) {
    for (let idx = 0; idx < arr.length; idx++) {
      const row = arr[idx];
      if (!state.stopTripIndex.has(row.stop_id)) state.stopTripIndex.set(row.stop_id, []);
      state.stopTripIndex.get(row.stop_id).push({ tripId, idx });
    }
  }
  state.plannerStopIds = [...state.stopTripIndex.keys()]
    .filter((stopId) => !state.confitalStops.has(stopId))
    .sort((a, b) => {
      const sa = state.stopById.get(a)?.stop_name || a;
      const sb = state.stopById.get(b)?.stop_name || b;
      return sa.localeCompare(sb, "es");
    });

  state.shapesById = new Map();
  for (const row of state.raw.shapes) {
    if (!state.shapesById.has(row.shape_id)) state.shapesById.set(row.shape_id, []);
    state.shapesById.get(row.shape_id).push(row);
  }
  for (const [, arr] of state.shapesById) {
    arr.sort((a, b) => Number(a.shape_pt_sequence) - Number(b.shape_pt_sequence));
  }

  const foundLines = [...new Set(state.raw.routes.map((r) => String(r.route_short_name || "").trim()).filter(Boolean))];
  state.lineOptions = foundLines.sort(sortLineNames);

  const validInitial = CONFIG.initialLines.filter((line) => state.lineOptions.includes(line));
  state.selectedLines = new Set(validInitial.length ? validInitial : [state.lineOptions[0]].filter(Boolean));
}

function initControls() {
  el.lineOptions.innerHTML = state.lineOptions
    .map((line) => {
      const checked = state.selectedLines.has(line) ? " checked" : "";
      return `<label><input type="radio" name="line_choice" value="${escapeHtml(line)}"${checked}/> ${escapeHtml(
        line
      )}</label>`;
    })
    .join("");

  el.lineOptions.addEventListener("change", () => {
    const picked = el.lineOptions.querySelector("input[name='line_choice']:checked")?.value || CONFIG.initialLines[0];
    state.selectedLines = new Set([picked]);
    el.linePicker.open = false;
    syncLinePickerLabel();
    applyFiltersAndRender(true);
  });

  syncLinePickerLabel();
}

function applyFiltersAndRender(fitMap = false) {
  buildFilteredIndexes();
  renderStaticLayers(fitMap);
  refreshDynamicPanels();
}

function buildFilteredIndexes() {
  const selected = state.selectedLines;
  if (!selected.size) {
    state.selectedRouteIds = new Set();
    state.filteredTrips = [];
    state.filteredStopTimesByTrip = new Map();
    return;
  }

  const selectedRoutes = state.raw.routes.filter((r) => selected.has(String(r.route_short_name).trim()));
  state.selectedRouteIds = new Set(selectedRoutes.map((r) => r.route_id));

  const trips = state.allTrips.filter((t) => state.selectedRouteIds.has(t.route_id));
  state.filteredTrips = trips;
  state.filteredStopTimesByTrip = new Map();

  for (const t of trips) {
    const arr = state.stopTimesByTripAll.get(t.trip_id);
    if (arr?.length) state.filteredStopTimesByTrip.set(t.trip_id, arr);
  }
}

function syncLinePickerLabel() {
  const txt = [...state.selectedLines].sort(sortLineNames).join(", ");
  el.linePickerLabel.textContent = txt || CONFIG.initialLines.join(", ");
}

function requestCurrentLocation() {
  if (!window.isSecureContext) {
    el.locStatus.textContent = "Para encontrar tu ubicación, abre Ande bus desde su enlace seguro.";
    return;
  }
  if (!navigator.geolocation) {
    el.locStatus.textContent = "Este navegador no permite consultar la ubicación.";
    return;
  }
  el.locateBtn.disabled = true;
  el.locStatus.textContent = "Buscando tu ubicación…";

  const onSuccess = (pos) => {
    state.currentPos = {
      lat: pos.coords.latitude,
      lon: pos.coords.longitude,
      accuracy: pos.coords.accuracy,
    };
    state.currentOriginStopIds = findNearestPlannerStops(state.currentPos.lat, state.currentPos.lon, 8).map((x) => x.stopId);
    const nearest = state.currentOriginStopIds[0];
    const nearestName = nearest ? state.stopById.get(nearest)?.stop_name || nearest : "sin parada";
    el.locStatus.textContent = nearest
      ? `La parada más cercana es ${nearestName}.`
      : "No encontré paradas cerca de tu ubicación.";
    updateUserLocationMarker();
    if (nearest) {
      state.map.setView([state.currentPos.lat, state.currentPos.lon], 15);
    }
    const now = getNowForTimezone(state.agencyTimezone);
    recomputeActiveTripsByService(now);
    renderToConfitalPlanner(now.seconds);
    refreshDynamicPanels();
    el.locateBtn.disabled = false;
  };

  const onError = () => {
    el.locStatus.textContent = "No pude encontrarte. Comprueba que el móvil permite usar la ubicación e inténtalo otra vez.";
    el.locateBtn.disabled = false;
  };

  navigator.geolocation.getCurrentPosition(
    onSuccess,
    onError,
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
  );
}

function updateUserLocationMarker() {
  if (!state.currentPos || !state.map) return;
  const point = [state.currentPos.lat, state.currentPos.lon];
  if (state.userLocationMarker) {
    state.userLocationMarker.setLatLng(point);
    return;
  }
  state.userLocationMarker = L.marker(point, {
    zIndexOffset: 1500,
    icon: L.divIcon({
      className: "user-map-icon",
      html: '<div class="user-location-dot" aria-label="Tu ubicación"></div>',
      iconSize: [20, 20],
      iconAnchor: [10, 10],
    }),
  })
    .bindPopup("Estás aquí")
    .addTo(state.map);
}

function findNearestPlannerStops(lat, lon, limit = 5) {
  const all = [];
  for (const stopId of state.plannerStopIds) {
    const s = state.stopById.get(stopId);
    if (!s) continue;
    const d = squaredDistance(lat, lon, Number(s.stop_lat), Number(s.stop_lon));
    if (!Number.isFinite(d)) continue;
    all.push({ stopId, d });
  }
  all.sort((a, b) => a.d - b.d);
  return all.slice(0, limit);
}

function squaredDistance(lat1, lon1, lat2, lon2) {
  const dy = lat1 - lat2;
  const dx = lon1 - lon2;
  return dy * dy + dx * dx;
}

function findBestRouteFromCurrent(nowSec, targetStopSet) {
  let best = null;
  for (const originStopId of state.currentOriginStopIds) {
    const options = getBestTripsToTargets(nowSec, originStopId, targetStopSet);
    if (!options.length) continue;
    const opt = options[0];
    if (!best || opt.totalMin < best.option.totalMin) {
      best = { originStopId, option: opt, targetStopId: opt.targetStopId };
    }
  }
  return best;
}

function renderStaticLayers(fitMap = false) {
  state.layers.route.clearLayers();
  state.layers.stops.clearLayers();
  state.stopMarkers = new Map();

  if (!state.filteredTrips.length) {
    if (fitMap) state.map.setView([28.33, -16.51], 11);
    return;
  }

  const tripsWithShape = state.filteredTrips.filter((t) => t.shape_id && state.shapesById.has(t.shape_id));
  const shapeCounts = new Map();
  for (const t of tripsWithShape) {
    shapeCounts.set(t.shape_id, (shapeCounts.get(t.shape_id) || 0) + 1);
  }

  const topShapes = [...shapeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, CONFIG.maxShapesToDraw)
    .map((x) => x[0]);

  for (const shapeId of topShapes) {
    const pts = (state.shapesById.get(shapeId) || []).map((p) => [Number(p.shape_pt_lat), Number(p.shape_pt_lon)]);
    if (pts.length > 1) {
      drawHighlightedRoute(pts);
    }
  }

  if (!topShapes.length) {
    const trip = state.filteredTrips[0];
    const st = trip ? state.filteredStopTimesByTrip.get(trip.trip_id) || [] : [];
    const pts = st
      .map((row) => state.stopById.get(row.stop_id))
      .filter(Boolean)
      .map((s) => [Number(s.stop_lat), Number(s.stop_lon)]);
    if (pts.length > 1) {
      drawHighlightedRoute(pts);
    }
  }

  const stopIds = new Set();
  for (const t of state.filteredTrips) {
    const arr = state.filteredStopTimesByTrip.get(t.trip_id) || [];
    for (const row of arr) stopIds.add(row.stop_id);
  }

  const bounds = [];
  for (const stopId of stopIds) {
    const s = state.stopById.get(stopId);
    if (!s) continue;
    const lat = Number(s.stop_lat);
    const lon = Number(s.stop_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    bounds.push([lat, lon]);

    const isConfital = state.confitalStops.has(stopId);
    const marker = isConfital
      ? L.marker([lat, lon], {
          title: s.stop_name || "Parada El Confital",
          zIndexOffset: 800,
          icon: L.divIcon({
            className: "confital-map-icon",
            html: '<div class="confital-stop-hit"><span class="confital-home-marker" aria-label="Parada El Confital">🏠</span></div>',
            iconSize: [48, 48],
            iconAnchor: [24, 24],
          }),
        })
      : L.marker([lat, lon], {
          title: s.stop_name || "Parada de guagua",
          zIndexOffset: 300,
          icon: L.divIcon({
            className: "stop-map-icon",
            html: '<span class="stop-marker-hit"><span class="stop-marker-dot" aria-label="Parada de guagua"></span></span>',
            iconSize: [48, 48],
            iconAnchor: [24, 24],
          }),
        });

    marker.bindPopup(buildStopPopup(stopId), {
      className: "busStopPopup",
      closeButton: true,
      maxWidth: 340,
      minWidth: 260,
      autoPanPadding: [20, 24],
    });

    marker.addTo(state.layers.stops);
    state.stopMarkers.set(stopId, marker);
  }

  if (fitMap && bounds.length) {
    state.map.fitBounds(bounds, { padding: [24, 24] });
  }
}

function drawHighlightedRoute(points) {
  const isLine470 = state.selectedLines.has("470");
  const routeColor = isLine470 ? "#f97316" : "#0a6e6e";

  L.polyline(points, {
    color: "#ffffff",
    weight: isLine470 ? 11 : 8,
    opacity: 0.95,
    interactive: false,
  }).addTo(state.layers.route);

  L.polyline(points, {
    color: routeColor,
    weight: isLine470 ? 7 : 5,
    opacity: 1,
    interactive: false,
  }).addTo(state.layers.route);
}

function refreshDynamicPanels() {
  const now = getNowForTimezone(state.agencyTimezone);
  recomputeActiveTripsByService(now);
  updateDataNotice(now);

  if (!isServiceDateDataAvailable(now)) {
    state.lastUpcomingByStop = new Map();
    renderConfitalSummary(new Map());
    renderNearbyStops(new Map());
    refreshStopPopups();
    return;
  }

  const upcomingByStop = computeUpcomingByStop(now.seconds);

  state.lastUpcomingByStop = upcomingByStop;

  renderConfitalSummary(upcomingByStop);
  renderNearbyStops(upcomingByStop);
  refreshStopPopups();
}

function refreshStopPopups() {
  for (const [stopId, marker] of state.stopMarkers) {
    marker.setPopupContent(buildStopPopup(stopId));
  }
}

function renderNearbyStops(upcomingByStop) {
  if (!state.currentPos) return;

  const servedStops = new Set();
  for (const stopTimes of state.filteredStopTimesByTrip.values()) {
    for (const row of stopTimes) servedStops.add(row.stop_id);
  }

  const nearest = [...servedStops]
    .map((stopId) => {
      const stop = state.stopById.get(stopId);
      if (!stop) return null;
      return {
        stopId,
        distance: squaredDistance(
          state.currentPos.lat,
          state.currentPos.lon,
          Number(stop.stop_lat),
          Number(stop.stop_lon)
        ),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3)
    .map((item) => item.stopId);

  if (!nearest.length) {
    el.nearbyStops.innerHTML = '<p class="nearbyEmpty">Esta línea no tiene paradas en el horario cargado.</p>';
    return;
  }

  el.nearbyStops.innerHTML = nearest
    .map((stopId) => {
      const stopName = state.stopById.get(stopId)?.stop_name || stopId;
      const next = (upcomingByStop.get(stopId) || [])[0];
      if (!next) {
        return `<article class="nearbyStop"><div><div class="nearbyStopName">${escapeHtml(
          stopName
        )}</div><div class="nearbyStopMeta">Línea ${escapeHtml([...state.selectedLines].join(", "))}</div></div><span class="nearbyEta">Sin salida</span></article>`;
      }

      return `<article class="nearbyStop"><div><div class="nearbyStopName">${escapeHtml(
        stopName
      )}</div><div class="nearbyStopMeta">${escapeHtml(next.headsign || next.direction)}</div></div><span class="nearbyEta"><strong>${
        next.etaMin
      }</strong> min</span></article>`;
    })
    .join("");
}

function recomputeActiveTripsByService(now) {
  state.activeServiceIds = getActiveServiceIds(now.dateYYYYMMDD, now.weekday);
  const previousDay = getPreviousServiceDay(now.dateYYYYMMDD);
  state.previousActiveServiceIds = isFeedDateCovered(previousDay.date)
    ? getActiveServiceIds(previousDay.date, previousDay.weekday)
    : new Set();
  const activeServiceIds = new Set([...state.activeServiceIds, ...state.previousActiveServiceIds]);
  state.activeTripIds = new Set(state.allTrips.filter((t) => activeServiceIds.has(t.service_id)).map((t) => t.trip_id));
}

function computeUpcomingByStop(nowSec) {
  const tripMeta = new Map(state.filteredTrips.map((t) => [t.trip_id, t]));
  const upcomingByStop = new Map();
  const horizon = nowSec + CONFIG.minutesWindow * 60;

  addUpcomingTrips(upcomingByStop, tripMeta, state.activeServiceIds, 0, nowSec, horizon);
  addUpcomingTrips(upcomingByStop, tripMeta, state.previousActiveServiceIds, 86400, nowSec, horizon);

  for (const [, items] of upcomingByStop) {
    items.sort((a, b) => a.etaMin - b.etaMin);
  }

  return upcomingByStop;
}

function addUpcomingTrips(upcomingByStop, tripMeta, activeServiceIds, serviceTimeOffset, nowSec, horizon) {
  const scheduleNow = nowSec + serviceTimeOffset;
  const scheduleHorizon = horizon + serviceTimeOffset;

  for (const [tripId, arr] of state.filteredStopTimesByTrip) {
    const meta = tripMeta.get(tripId);
    if (!meta || !activeServiceIds.has(meta.service_id)) continue;
    const destination = meta.trip_headsign ||
      state.stopById.get(arr[arr.length - 1]?.stop_id)?.stop_name ||
      "Destino no indicado";

    for (const row of arr) {
      const arrivalSec = parseGtfsTime(row.arrival_time || row.departure_time);
      if (!Number.isFinite(arrivalSec) || arrivalSec < scheduleNow || arrivalSec > scheduleHorizon) continue;
      if (serviceTimeOffset > 0 && arrivalSec < 86400) continue;

      const etaMin = Math.max(0, Math.ceil((arrivalSec - scheduleNow) / 60));
      if (!upcomingByStop.has(row.stop_id)) upcomingByStop.set(row.stop_id, []);
      upcomingByStop.get(row.stop_id).push({
        etaMin,
        tripId,
        line: state.routeById.get(meta.route_id)?.route_short_name || [...state.selectedLines].join(", "),
        headsign: destination,
        direction: directionLabel(meta.direction_id),
      });
    }
  }
}

function renderConfitalSummary(upcomingByStop) {
  const ids = CONFIG.confitalStopIds.filter((id) => state.stopById.has(id));
  if (!ids.length) {
    el.confitalSummary.textContent = "El Confital no disponible";
    return;
  }

  const rows = ids
    .map((stopId) => {
      const stop = state.stopById.get(stopId);
      const items = (upcomingByStop.get(stopId) || []).slice(0, 3);
      return { stopId, stopName: stop?.stop_name || stopId, items };
    })
    .sort((a, b) => {
      const ax = a.items[0]?.etaMin ?? Number.POSITIVE_INFINITY;
      const bx = b.items[0]?.etaMin ?? Number.POSITIVE_INFINITY;
      return ax - bx;
    });

  const anyEta = rows.some((r) => r.items.length);
  if (!anyEta) {
    el.confitalSummary.innerHTML = '<p class="confitalEmpty">No hay salidas próximas en el horario para hoy.</p>';
    return;
  }

  el.confitalSummary.innerHTML = rows
    .map((row) => {
      const fixedDest = CONFIG.confitalDirectionByStop[row.stopId] || "Destino";
      if (!row.items.length) {
        return `<article class="confitalRow"><div><h3>🏠 ${escapeHtml(row.stopName)}</h3><p>${escapeHtml(
          fixedDest
        )} · Sin salida próxima</p></div></article>`;
      }

      const first = row.items[0];
      const later = row.items.slice(1).map((it) => `${it.etaMin} min`).join(" · ");
      return `<article class="confitalRow"><div><h3>🏠 ${escapeHtml(row.stopName)}</h3><p>${escapeHtml(
        fixedDest
      )}</p></div><p class="confitalEta">${first.etaMin} min</p>${
        later ? `<p>Después: ${escapeHtml(later)}</p>` : ""
      }</article>`;
    })
    .join("");
}

function renderToConfitalPlanner(nowSec) {
  el.toConfitalResult.hidden = !state.currentOriginStopIds.length;
  if (!state.currentOriginStopIds.length) {
    return;
  }
  const best = findBestRouteFromCurrent(nowSec, state.confitalStops);
  if (!best) {
    el.toConfitalResult.innerHTML = "No encuentro una ruta próxima desde aquí hasta El Confital.";
    return;
  }
  const fromStopName = state.stopById.get(best.originStopId)?.stop_name || best.originStopId;
  const opt = best.option;
  const dest = CONFIG.confitalDirectionByStop[best.targetStopId] || "El Confital";
  const head = `En horario: ${opt.totalMin} min${opt.fallback ? " (aprox.)" : ""}`;
  if (opt.mode === "direct") {
    el.toConfitalResult.innerHTML = `<strong>Ruta hasta El Confital</strong><br/>${head}<br/>Desde ${escapeHtml(
      fromStopName
    )}: espera ${opt.waitMin} min y toma la línea ${escapeHtml(opt.line1)} hasta ${escapeHtml(dest)}.`;
    return;
  }
  const transferName = state.stopById.get(opt.transferStopId)?.stop_name || opt.transferStopId;
  el.toConfitalResult.innerHTML = `<strong>Ruta hasta El Confital</strong><br/>${head}<br/>Desde ${escapeHtml(
    fromStopName
  )}: espera ${opt.waitMin} min, toma la línea ${escapeHtml(opt.line1)} hasta ${escapeHtml(
    transferName
  )} y cambia a la línea ${escapeHtml(opt.line2)} para llegar a ${escapeHtml(dest)}.`;
}

function getBestTripsToTargets(nowSec, fromStopId, targetStopSet) {
  const targetKey = [...targetStopSet].sort().join(",");
  const key = `${fromStopId}|${targetKey}|${Math.floor(nowSec / 60)}`;
  const cached = state.plannerCache.get(key);
  if (cached) return cached;
  const strict = computeTripsToTargets(nowSec, fromStopId, targetStopSet, { strictService: true, wrapToNextDay: false });
  if (strict.length) {
    state.plannerCache.set(key, strict);
    return strict;
  }
  const fallback = computeTripsToTargets(nowSec, fromStopId, targetStopSet, { strictService: false, wrapToNextDay: true }).map((x) => ({
    ...x,
    fallback: true,
  }));
  state.plannerCache.set(key, fallback);
  if (state.plannerCache.size > 120) {
    const firstKey = state.plannerCache.keys().next().value;
    state.plannerCache.delete(firstKey);
  }
  return fallback;
}

function computeTripsToTargets(nowSec, fromStopId, targetStopSet, opts = {}) {
  const strictService = opts.strictService !== false;
  const wrapToNextDay = opts.wrapToNextDay === true;
  const maxSec = nowSec + (wrapToNextDay ? 36 * 3600 : CONFIG.plannerWindowMinutes * 60);
  const firstLegs = getCandidateDepartures(fromStopId, nowSec, {
    strictService,
    wrapToNextDay,
    maxSec,
    limit: CONFIG.maxLegCandidates,
  });

  const out = [];
  const seen = new Set();

  for (const leg1 of firstLegs.slice(0, CONFIG.maxLegCandidates)) {
    const trip1 = state.tripById.get(leg1.tripId);
    if (!trip1) continue;
    const line1 = state.routeById.get(trip1.route_id)?.route_short_name || "?";

    const direct = findNextTargetInTrip(leg1.arr, leg1.idx + 1, targetStopSet);
    if (direct) {
      let directArr = direct.arrSec;
      if (wrapToNextDay) {
        while (directArr < leg1.depSec) directArr += 24 * 3600;
      }
      const key = `${line1}|${direct.stopId}|D`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({
          mode: "direct",
          line1,
          waitMin: Math.ceil((leg1.depSec - nowSec) / 60),
          totalMin: Math.ceil((directArr - nowSec) / 60),
          targetStopId: direct.stopId,
          depSec: leg1.depSec,
        });
      }
    }

    const maxIdx = Math.min(leg1.arr.length - 1, leg1.idx + CONFIG.maxTransferStopsFromOrigin);
    for (let i = leg1.idx + 1; i <= maxIdx; i++) {
      const transferStopId = leg1.arr[i].stop_id;
      if (targetStopSet.has(transferStopId)) continue;
      let arriveTransferSec = parseGtfsTime(leg1.arr[i].arrival_time || leg1.arr[i].departure_time);
      if (wrapToNextDay) {
        while (arriveTransferSec < leg1.depSec) arriveTransferSec += 24 * 3600;
      }
      if (!Number.isFinite(arriveTransferSec) || arriveTransferSec >= maxSec) continue;

      const secondLegEvents = getCandidateDepartures(transferStopId, arriveTransferSec + CONFIG.minTransferSeconds, {
        strictService,
        wrapToNextDay,
        maxSec,
        limit: CONFIG.maxSecondLegEvents,
        excludeTripIds: new Set([leg1.tripId]),
      });
      for (const ev2 of secondLegEvents) {
        const arr2 = ev2.arr;
        const dep2 = ev2.depSec;

        const conf2 = findNextTargetInTrip(arr2, ev2.idx + 1, targetStopSet);
        const trip2 = state.tripById.get(ev2.tripId);
        if (!trip2) continue;
        const line2 = state.routeById.get(trip2.route_id)?.route_short_name || "?";
        if (conf2) {
          let conf2Arr = conf2.arrSec;
          if (wrapToNextDay) {
            while (conf2Arr < dep2) conf2Arr += 24 * 3600;
          }
          const key = `${line1}>${line2}|${conf2.stopId}|${Math.floor(dep2 / 300)}`;
          if (!seen.has(key)) {
            seen.add(key);
            out.push({
              mode: "transfer",
              line1,
              line2,
              transferStopId,
              waitMin: Math.ceil((leg1.depSec - nowSec) / 60),
              totalMin: Math.ceil((conf2Arr - nowSec) / 60),
              targetStopId: conf2.stopId,
              depSec: leg1.depSec,
            });
          }
        }

        if (out.length >= CONFIG.maxPlannerResults) {
          out.sort((a, b) => a.totalMin - b.totalMin || a.depSec - b.depSec);
          return out;
        }
        if (out.length >= CONFIG.maxPlannerResults) break;
      }
      if (out.length >= CONFIG.maxPlannerResults) break;
    }
    if (out.length >= CONFIG.maxPlannerResults) break;
  }

  out.sort((a, b) => a.totalMin - b.totalMin || a.depSec - b.depSec);
  return out;
}

function findNextTargetInTrip(stopTimes, fromIdx, targetStopSet) {
  for (let i = fromIdx; i < stopTimes.length; i++) {
    const sid = stopTimes[i].stop_id;
    if (!targetStopSet.has(sid)) continue;
    const arrSec = parseGtfsTime(stopTimes[i].arrival_time || stopTimes[i].departure_time);
    if (!Number.isFinite(arrSec)) continue;
    return { stopId: sid, arrSec };
  }
  return null;
}

function getCandidateDepartures(stopId, earliestSec, opts = {}) {
  const strictService = opts.strictService !== false;
  const wrapToNextDay = opts.wrapToNextDay === true;
  const maxSec = Number.isFinite(opts.maxSec) ? opts.maxSec : earliestSec + 6 * 3600;
  const limit = Number.isFinite(opts.limit) ? opts.limit : 20;
  const excludeTripIds = opts.excludeTripIds || new Set();

  const events = state.stopTripIndex.get(stopId) || [];
  const out = [];
  for (const ev of events) {
    if (excludeTripIds.has(ev.tripId)) continue;
    if (strictService && !state.activeTripIds.has(ev.tripId)) continue;
    const arr = state.stopTimesByTripAll.get(ev.tripId);
    if (!arr?.length) continue;

    let depSec = parseGtfsTime(arr[ev.idx].departure_time || arr[ev.idx].arrival_time);
    if (!Number.isFinite(depSec)) continue;
    if (wrapToNextDay) {
      while (depSec < earliestSec) depSec += 24 * 3600;
    }
    if (depSec < earliestSec || depSec > maxSec) continue;

    out.push({ tripId: ev.tripId, idx: ev.idx, depSec, arr });
  }
  out.sort((a, b) => a.depSec - b.depSec);
  return out.slice(0, limit);
}

function buildStopPopup(stopId) {
  const stop = state.stopById.get(stopId);
  const items = state.lastUpcomingByStop.get(stopId) || [];
  const line = [...state.selectedLines].sort(sortLineNames).join(", ") || "—";
  const stopNumber = stop?.stop_code || stopId;
  const title = escapeHtml(stop?.stop_name || "Parada de guagua");
  if (!items.length) {
    return `<div class="stopPopup"><p class="stopPopupKicker">PARADA ${escapeHtml(
      stopNumber
    )}</p><h2 class="stopPopupTitle">${title}</h2><div class="stopEmpty">No hay salidas próximas para la línea ${escapeHtml(
      line
    )} en el horario de hoy.</div><p class="stopPopupFoot">Puede haber cambios o retrasos.</p></div>`;
  }

  const rows = items
    .slice(0, 5)
    .map((it) => {
      const eta = it.etaMin === 0 ? "Ahora" : String(it.etaMin);
      const unit = it.etaMin === 0 ? "" : "min";
      const caption = it.etaMin === 0 ? "LLEGADA" : "LLEGA EN";
      return `<li class="stopArrival"><span class="stopLineBadge">Línea ${escapeHtml(
        it.line || line
      )}</span><span class="stopDestination"><span class="stopFieldLabel">Destino</span><strong>${escapeHtml(
        it.headsign || "Sin destino indicado"
      )}</strong></span><span class="stopEta"><span class="stopEtaCaption">${caption}</span><strong>${eta}</strong><span class="stopEtaUnit">${unit}</span></span></li>`;
    })
    .join("");

  return `<div class="stopPopup"><p class="stopPopupKicker">PARADA ${escapeHtml(
    stopNumber
  )}</p><h2 class="stopPopupTitle">${title}</h2><p class="stopPopupSubheading">Próximas guaguas</p><ul class="stopArrivalList">${rows}</ul><p class="stopPopupFoot">Minutos según el horario; puede haber retrasos.</p></div>`;
}

function getActiveServiceIds(dateYYYYMMDD, weekday) {
  const base = new Set();
  const dayCol = weekdayToGtfsField(weekday);

  for (const c of state.raw.calendar) {
    if (!c.service_id) continue;
    const start = Number(c.start_date || 0);
    const end = Number(c.end_date || 0);
    const dateNum = Number(dateYYYYMMDD);

    if (dateNum < start || dateNum > end) continue;
    if (String(c[dayCol] || "0") !== "1") continue;

    base.add(c.service_id);
  }

  for (const d of state.raw.calendar_dates) {
    if (!d.service_id || d.date !== dateYYYYMMDD) continue;
    if (String(d.exception_type) === "1") base.add(d.service_id);
    if (String(d.exception_type) === "2") base.delete(d.service_id);
  }

  return base;
}

function getFeedServiceDateRange() {
  const dates = [];

  for (const calendar of state.raw.calendar) {
    if (/^\d{8}$/.test(calendar.start_date || "")) dates.push(calendar.start_date);
    if (/^\d{8}$/.test(calendar.end_date || "")) dates.push(calendar.end_date);
  }
  for (const exception of state.raw.calendar_dates) {
    if (/^\d{8}$/.test(exception.date || "")) dates.push(exception.date);
  }

  if (!dates.length) return null;
  dates.sort();
  return { start: dates[0], end: dates[dates.length - 1] };
}

function isFeedDateCovered(dateYYYYMMDD) {
  const range = state.feedServiceRange;
  return Boolean(range && dateYYYYMMDD >= range.start && dateYYYYMMDD <= range.end);
}

function getPreviousServiceDay(dateYYYYMMDD) {
  const [, year, month, day] = dateYYYYMMDD.match(/^(\d{4})(\d{2})(\d{2})$/) || [];
  if (!year) return { date: "", weekday: "" };

  const previous = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)) - 86400000);
  const y = previous.getUTCFullYear();
  const m = String(previous.getUTCMonth() + 1).padStart(2, "0");
  const d = String(previous.getUTCDate()).padStart(2, "0");
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return { date: `${y}${m}${d}`, weekday: weekdays[previous.getUTCDay()] };
}

function isServiceDateDataAvailable(now) {
  if (isFeedDateCovered(now.dateYYYYMMDD)) return true;

  const overnightWindowSec = Math.max(0, state.maxServiceTimeSec - 86400);
  if (now.seconds >= overnightWindowSec) return false;
  return isFeedDateCovered(getPreviousServiceDay(now.dateYYYYMMDD).date);
}

function updateDataNotice(now = getNowForTimezone(state.agencyTimezone)) {
  const range = state.feedServiceRange;
  const available = isServiceDateDataAvailable(now);
  el.dataNotice.hidden = false;
  el.dataNotice.classList.toggle("isStale", !available);

  if (!range) {
    el.dataNotice.textContent = "No pude comprobar la vigencia del horario.";
    return;
  }

  const start = formatGtfsDate(range.start);
  const end = formatGtfsDate(range.end);
  if (!isFeedDateCovered(now.dateYYYYMMDD) && available) {
    el.dataNotice.textContent = `Horario oficial hasta ${end}. Solo aparecen guaguas que siguen de ayer.`;
    return;
  }
  if (!available) {
    el.dataNotice.innerHTML = `Horario vencido (${start}–${end}); no hay datos fiables para hoy. <a href="https://www.titsa.com/Google_transit.zip" target="_blank" rel="noopener">Descargar horario nuevo</a>.`;
    return;
  }

  el.dataNotice.textContent = "";
  el.dataNotice.hidden = true;
}

function formatGtfsDate(date) {
  const [, year, month, day] = date.match(/^(\d{4})(\d{2})(\d{2})$/) || [];
  if (!year) return date;
  return new Intl.DateTimeFormat("es-ES", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))));
}

function getNowForTimezone(timeZone) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  }).formatToParts(now);

  const obj = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const year = obj.year;
  const month = obj.month;
  const day = obj.day;
  const hour = Number(obj.hour);
  const minute = Number(obj.minute);
  const second = Number(obj.second);
  const weekday = (obj.weekday || "Mon").slice(0, 3);

  return {
    dateYYYYMMDD: `${year}${month}${day}`,
    dateISO: `${year}-${month}-${day}`,
    weekday,
    seconds: hour * 3600 + minute * 60 + second,
  };
}

function weekdayToGtfsField(weekday) {
  const map = {
    Mon: "monday",
    Tue: "tuesday",
    Wed: "wednesday",
    Thu: "thursday",
    Fri: "friday",
    Sat: "saturday",
    Sun: "sunday",
  };
  return map[weekday] || "monday";
}

function parseGtfsTime(raw) {
  if (!raw || typeof raw !== "string") return NaN;
  const parts = raw.split(":");
  if (parts.length < 2) return NaN;
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  const s = Number(parts[2] || 0);
  if (![h, m, s].every(Number.isFinite)) return NaN;
  return h * 3600 + m * 60 + s;
}

function toHms(sec) {
  const h = Math.floor(sec / 3600)
    .toString()
    .padStart(2, "0");
  const m = Math.floor((sec % 3600) / 60)
    .toString()
    .padStart(2, "0");
  const s = Math.floor(sec % 60)
    .toString()
    .padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function directionLabel(directionId) {
  if (String(directionId) === "0") return "Ida";
  if (String(directionId) === "1") return "Vuelta";
  return "Todas";
}

function sortLineNames(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a.localeCompare(b, "es");
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
