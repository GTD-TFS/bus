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
    buses: null,
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
  activeTripIds: new Set(),
  lineOptions: [],
  lastUpcomingByStop: new Map(),
  confitalStops: new Set(),
  plannerStopIds: [],
  currentPos: null,
  currentOriginStopIds: [],
  placeTargetStopIds: [],
  placeTargetLabel: "",
  plannerCache: new Map(),
  timer: null,
};

const el = {
  linePickerLabel: document.getElementById("linePickerLabel"),
  lineOptions: document.getElementById("lineOptions"),
  confitalSummary: document.getElementById("confitalSummary"),
  locateBtn: document.getElementById("locateBtn"),
  locStatus: document.getElementById("locStatus"),
  toConfitalResult: document.getElementById("toConfitalResult"),
  placeInput: document.getElementById("placeInput"),
  placeSearchBtn: document.getElementById("placeSearchBtn"),
  placeRouteResult: document.getElementById("placeRouteResult"),
  mapWrap: document.querySelector(".mapWrap"),
  mapCloseBtn: document.getElementById("mapCloseBtn"),
  mapExpandHint: document.getElementById("mapExpandHint"),
};

init().catch((err) => {
  el.confitalSummary.textContent = `Error: ${err.message}`;
  console.error(err);
});

async function init() {
  initMap();
  initMapExpandControls();
  el.confitalSummary.textContent = "Cargando GTFS...";
  await loadGtfs();
  buildGlobalIndexes();
  initControls();
  applyFiltersAndRender(true);
  const now = getNowForTimezone(state.agencyTimezone);
  recomputeActiveTripsByService(now);
  renderToConfitalPlanner(now.seconds);
  state.timer = setInterval(refreshDynamicPanels, CONFIG.refreshMs);
}

function initMap() {
  state.map = L.map("map", {
    zoomControl: true,
    preferCanvas: true,
  }).setView([28.33, -16.51], 11);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(state.map);

  state.layers.route = L.layerGroup().addTo(state.map);
  state.layers.stops = L.layerGroup().addTo(state.map);
  state.layers.buses = L.layerGroup().addTo(state.map);
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
  const zipData = await fetchGtfsZipData();
  const zip = await JSZip.loadAsync(zipData);

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

  throw new Error(
    `No se pudo cargar GTFS. Prueba colocando Google_transit.zip en /data/Google_transit.zip. Detalle: ${errors.join(
      " | "
    )}`
  );
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
      return `<label><input type="checkbox" value="${escapeHtml(line)}"${checked}/> ${escapeHtml(line)}</label>`;
    })
    .join("");

  el.lineOptions.addEventListener("change", () => {
    const picked = [...el.lineOptions.querySelectorAll("input[type='checkbox']:checked")].map((x) => x.value);
    state.selectedLines = new Set(picked.length ? picked : CONFIG.initialLines);
    if (!picked.length) {
      for (const input of el.lineOptions.querySelectorAll("input[type='checkbox']")) {
        input.checked = state.selectedLines.has(input.value);
      }
    }
    syncLinePickerLabel();
    applyFiltersAndRender(true);
  });

  el.locateBtn.addEventListener("click", requestCurrentLocation);
  requestCurrentLocation();

  const searchPlace = async () => {
    const q = String(el.placeInput.value || "").trim();
    if (!q) return;
    el.placeRouteResult.textContent = "Buscando lugar...";
    try {
      const targetStopIds = await resolvePlaceToNearestStopIds(q);
      if (!targetStopIds.length) {
        el.placeRouteResult.textContent = "Lugar no encontrado";
        return;
      }
      state.placeTargetStopIds = targetStopIds;
      state.placeTargetLabel = q;
      const now = getNowForTimezone(state.agencyTimezone);
      recomputeActiveTripsByService(now);
      renderPlacePlannerResult(now.seconds);
    } catch (err) {
      el.placeRouteResult.textContent = "No se pudo buscar";
    }
  };
  el.placeSearchBtn.addEventListener("click", searchPlace);
  el.placeInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") searchPlace();
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
  if (!navigator.geolocation) {
    el.locStatus.textContent = "Geolocalizacion no disponible";
    return;
  }
  el.locStatus.textContent = "Buscando ubicacion...";
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.currentPos = {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
      };
      state.currentOriginStopIds = findNearestPlannerStops(state.currentPos.lat, state.currentPos.lon, 8).map((x) => x.stopId);
      const nearest = state.currentOriginStopIds[0];
      const nearestName = nearest ? state.stopById.get(nearest)?.stop_name || nearest : "sin parada";
      el.locStatus.textContent = `Ubicacion OK (${Math.round(state.currentPos.accuracy)}m) · parada cercana: ${nearestName}`;
      if (nearest) {
        state.map.setView([state.currentPos.lat, state.currentPos.lon], 13);
      }
      const now = getNowForTimezone(state.agencyTimezone);
      recomputeActiveTripsByService(now);
      renderToConfitalPlanner(now.seconds);
      renderPlacePlannerResult(now.seconds);
    },
    () => {
      el.locStatus.textContent = "No se pudo obtener ubicacion";
    },
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
  );
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

async function resolvePlaceToNearestStopIds(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=es&q=${encodeURIComponent(
    `${query}, Tenerife`
  )}`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
  });
  if (!res.ok) return "";
  const data = await res.json();
  if (!Array.isArray(data) || !data.length) return "";
  const lat = Number(data[0].lat);
  const lon = Number(data[0].lon);
  const nearest = findNearestPlannerStops(lat, lon, 8);
  return nearest.map((x) => x.stopId);
}

function renderPlacePlannerResult(nowSec = null) {
  if (!state.currentOriginStopIds.length || !state.placeTargetStopIds.length) return;
  const refSec = Number.isFinite(nowSec) ? nowSec : getNowForTimezone(state.agencyTimezone).seconds;
  const best = findBestRouteFromCurrent(refSec, new Set(state.placeTargetStopIds));
  if (!best) {
    el.placeRouteResult.innerHTML = `Destino: ${escapeHtml(state.placeTargetLabel || "lugar")}<br/>Sin ruta ahora`;
    return;
  }
  const originStopName = state.stopById.get(best.originStopId)?.stop_name || best.originStopId;
  const targetStopName = state.stopById.get(best.targetStopId)?.stop_name || best.targetStopId;
  const opt = best.option;
  const approx = opt.fallback ? " (aprox)" : "";
  if (opt.mode === "direct") {
    el.placeRouteResult.innerHTML = `Origen: ${escapeHtml(originStopName)}${approx}<br/>1) Espera ${opt.waitMin} min<br/>2) Toma L${escapeHtml(
      opt.line1
    )}<br/>3) Baja en ${escapeHtml(targetStopName)}`;
    return;
  }
  const transferName = state.stopById.get(opt.transferStopId)?.stop_name || opt.transferStopId;
  el.placeRouteResult.innerHTML = `Origen: ${escapeHtml(originStopName)}${approx}<br/>1) Espera ${opt.waitMin} min<br/>2) L${escapeHtml(
    opt.line1
  )} hasta ${escapeHtml(transferName)}<br/>3) Cambia a L${escapeHtml(opt.line2)}<br/>4) Baja en ${escapeHtml(targetStopName)}`;
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
      L.polyline(pts, { color: "#0a6e6e", weight: 4, opacity: 0.8 }).addTo(state.layers.route);
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
      L.polyline(pts, { color: "#0a6e6e", weight: 4, opacity: 0.8 }).addTo(state.layers.route);
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
    const marker = L.circleMarker([lat, lon], {
      radius: isConfital ? 7 : 4,
      color: isConfital ? "#b45309" : "#1d4ed8",
      fillColor: isConfital ? "#f59e0b" : "#60a5fa",
      fillOpacity: 0.9,
      weight: isConfital ? 2 : 1,
    });

    marker.on("click", () => {
      marker.bindPopup(buildStopPopup(stopId)).openPopup();
    });

    marker.addTo(state.layers.stops);
  }

  if (fitMap && bounds.length) {
    state.map.fitBounds(bounds, { padding: [24, 24] });
  }
}

function refreshDynamicPanels() {
  const now = getNowForTimezone(state.agencyTimezone);
  recomputeActiveTripsByService(now);
  const activeTrips = computeActiveTrips(now.seconds);
  const upcomingByStop = computeUpcomingByStop(now.seconds);

  state.lastUpcomingByStop = upcomingByStop;

  renderConfitalSummary(upcomingByStop);
  renderToConfitalPlanner(now.seconds);
  renderPlacePlannerResult(now.seconds);
  renderBusMarkers(activeTrips);
}

function recomputeActiveTripsByService(now) {
  state.activeServiceIds = getActiveServiceIds(now.dateYYYYMMDD, now.weekday);
  state.activeTripIds = new Set(state.allTrips.filter((t) => state.activeServiceIds.has(t.service_id)).map((t) => t.trip_id));
}

function computeActiveTrips(nowSec) {
  const tripMeta = new Map(state.filteredTrips.map((t) => [t.trip_id, t]));
  const list = [];

  for (const [tripId, arr] of state.filteredStopTimesByTrip.entries()) {
    const meta = tripMeta.get(tripId);
    if (!meta || !state.activeServiceIds.has(meta.service_id)) continue;

    const first = parseGtfsTime(arr[0].departure_time || arr[0].arrival_time);
    const last = parseGtfsTime(arr[arr.length - 1].arrival_time || arr[arr.length - 1].departure_time);

    if (!Number.isFinite(first) || !Number.isFinite(last)) continue;
    if (nowSec < first || nowSec > last) continue;

    let nextIdx = arr.findIndex((row) => parseGtfsTime(row.arrival_time || row.departure_time) >= nowSec);
    if (nextIdx < 0) nextIdx = arr.length - 1;

    const nextStopRow = arr[nextIdx];
    const nextEtaSec = parseGtfsTime(nextStopRow.arrival_time || nextStopRow.departure_time) - nowSec;
    const etaMin = Math.max(0, Math.ceil(nextEtaSec / 60));

    const nextStop = state.stopById.get(nextStopRow.stop_id);
    const progress = Math.min(1, Math.max(0, (nowSec - first) / Math.max(1, last - first)));

    list.push({
      tripId,
      headsign: meta.trip_headsign || "Sin headsign",
      direction: directionLabel(meta.direction_id),
      nextStopName: nextStop?.stop_name || nextStopRow.stop_id,
      etaMin,
      progress,
      pos: estimateTripPosition(arr, nowSec),
    });
  }

  list.sort((a, b) => a.etaMin - b.etaMin);
  return list;
}

function computeUpcomingByStop(nowSec) {
  const tripMeta = new Map(state.filteredTrips.map((t) => [t.trip_id, t]));
  const upcomingByStop = new Map();
  const horizon = nowSec + CONFIG.minutesWindow * 60;

  for (const [tripId, arr] of state.filteredStopTimesByTrip.entries()) {
    const meta = tripMeta.get(tripId);
    if (!meta || !state.activeServiceIds.has(meta.service_id)) continue;

    for (const row of arr) {
      const arrSec = parseGtfsTime(row.arrival_time || row.departure_time);
      if (!Number.isFinite(arrSec) || arrSec < nowSec || arrSec > horizon) continue;

      const etaMin = Math.max(0, Math.ceil((arrSec - nowSec) / 60));
      if (!upcomingByStop.has(row.stop_id)) upcomingByStop.set(row.stop_id, []);
      upcomingByStop.get(row.stop_id).push({
        etaMin,
        tripId,
        headsign: meta.trip_headsign || "Sin headsign",
        direction: directionLabel(meta.direction_id),
      });
    }
  }

  for (const [, items] of upcomingByStop) {
    items.sort((a, b) => a.etaMin - b.etaMin);
  }

  return upcomingByStop;
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
    el.confitalSummary.innerHTML = "Sin ETAs para este filtro";
    return;
  }

  el.confitalSummary.innerHTML = rows
    .map((row) => {
      const fixedDest = CONFIG.confitalDirectionByStop[row.stopId] || "Destino";
      if (!row.items.length) {
        return `<article class="confitalRow"><h3>${escapeHtml(row.stopName)} (${escapeHtml(
          row.stopId
        )})</h3><p>${escapeHtml(fixedDest)}</p><p>Sin ETA</p></article>`;
      }

      const first = row.items[0];
      const short = row.items.map((it) => `${it.etaMin}m`).join(" · ");
      return `<article class="confitalRow"><h3>${escapeHtml(row.stopName)} (${escapeHtml(
        row.stopId
      )})</h3><p>${escapeHtml(fixedDest)}</p><p><span class="confitalEta">${first.etaMin} min</span> · ${escapeHtml(
        short
      )}</p></article>`;
    })
    .join("");
}

function renderToConfitalPlanner(nowSec) {
  if (!state.currentOriginStopIds.length) {
    el.toConfitalResult.textContent = "Pulsa: Usar mi ubicacion";
    return;
  }
  const best = findBestRouteFromCurrent(nowSec, state.confitalStops);
  if (!best) {
    el.toConfitalResult.innerHTML = "Sin ruta ahora";
    return;
  }
  const fromStopName = state.stopById.get(best.originStopId)?.stop_name || best.originStopId;
  const opt = best.option;
  const dest = CONFIG.confitalDirectionByStop[best.targetStopId] || "El Confital";
  const head = `Opcion: ${opt.totalMin} min${opt.fallback ? " (aprox)" : ""}`;
  if (opt.mode === "direct") {
    el.toConfitalResult.innerHTML = `<strong>${head}</strong><br/>Origen: ${escapeHtml(
      fromStopName
    )}<br/>1) Espera ${opt.waitMin} min<br/>2) Toma L${escapeHtml(opt.line1)}<br/>3) Baja en ${escapeHtml(dest)}`;
    return;
  }
  const transferName = state.stopById.get(opt.transferStopId)?.stop_name || opt.transferStopId;
  el.toConfitalResult.innerHTML = `<strong>${head}</strong><br/>Origen: ${escapeHtml(
    fromStopName
  )}<br/>1) Espera ${opt.waitMin} min<br/>2) Toma L${escapeHtml(opt.line1)} hasta ${escapeHtml(
    transferName
  )}<br/>3) Cambia a L${escapeHtml(opt.line2)}<br/>4) Baja en ${escapeHtml(dest)}`;
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

function renderBusMarkers(activeTrips) {
  state.layers.buses.clearLayers();

  for (const t of activeTrips) {
    if (!t.pos) continue;

    const marker = L.marker([t.pos.lat, t.pos.lon], {
      icon: L.divIcon({
        className: "",
        html: '<div class="bus-dot"></div>',
        iconSize: [16, 16],
        iconAnchor: [8, 8],
      }),
    });

    marker.bindPopup(
      `<strong>Viaje ${escapeHtml(t.tripId)}</strong><br/>Destino: ${escapeHtml(t.headsign)}<br/>Sentido: ${escapeHtml(
        t.direction
      )}<br/>ETA prox. parada: ${t.etaMin} min`
    );

    marker.addTo(state.layers.buses);
  }
}

function buildStopPopup(stopId) {
  const stop = state.stopById.get(stopId);
  const items = state.lastUpcomingByStop.get(stopId) || [];
  const fixedDest = CONFIG.confitalDirectionByStop[stopId] || "";
  if (!items.length) {
    return `<strong>${escapeHtml(stop?.stop_name || stopId)}</strong><br/>Parada: ${escapeHtml(
      stopId
    )}<br/>${fixedDest ? `Destino: ${escapeHtml(fixedDest)}<br/>` : ""}Sin ETA.`;
  }

  const rows = items
    .slice(0, 6)
    .map((it) => `<li>${it.etaMin} min | ${escapeHtml(it.headsign)}</li>`)
    .join("");

  return `<strong>${escapeHtml(stop?.stop_name || stopId)}</strong><br/>Parada: ${escapeHtml(
    stopId
  )}<br/>${fixedDest ? `Destino: ${escapeHtml(fixedDest)}<br/>` : ""}<ul style="margin:6px 0 0 18px; padding:0;">${rows}</ul>`;
}

function estimateTripPosition(stopTimes, nowSec) {
  if (!stopTimes.length) return null;

  let prev = stopTimes[0];
  let next = stopTimes[stopTimes.length - 1];

  for (let i = 1; i < stopTimes.length; i++) {
    const curr = stopTimes[i];
    const currT = parseGtfsTime(curr.arrival_time || curr.departure_time);
    if (currT >= nowSec) {
      next = curr;
      prev = stopTimes[i - 1];
      break;
    }
  }

  const prevStop = state.stopById.get(prev.stop_id);
  const nextStop = state.stopById.get(next.stop_id);
  if (!prevStop || !nextStop) return null;

  const t0 = parseGtfsTime(prev.departure_time || prev.arrival_time);
  const t1 = parseGtfsTime(next.arrival_time || next.departure_time);
  const ratio = t1 > t0 ? (nowSec - t0) / (t1 - t0) : 0;
  const clamped = Math.min(1, Math.max(0, ratio));

  const lat0 = Number(prevStop.stop_lat);
  const lon0 = Number(prevStop.stop_lon);
  const lat1 = Number(nextStop.stop_lat);
  const lon1 = Number(nextStop.stop_lon);

  if (![lat0, lon0, lat1, lon1].every(Number.isFinite)) return null;

  return {
    lat: lat0 + (lat1 - lat0) * clamped,
    lon: lon0 + (lon1 - lon0) * clamped,
  };
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

  if (!base.size) {
    for (const t of state.filteredTrips) base.add(t.service_id);
  }

  return base;
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
