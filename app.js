// ── Data sources ────────────────────────────────────────────────────────────
// Add a new source here and the UI + fetching/rendering all update automatically.

const DATA_SOURCES = [
  {
    id: 'inaturalist',
    label: 'iNaturalist',
    color: '#f0a500',
    enabled: true,
    results: [],
  },
  {
    id: 'obis',
    label: 'OBIS',
    color: '#2ec4b6',
    enabled: true,
    results: [],
  },
];

// ── Date filter ──────────────────────────────────────────────────────────────

const DATE_PRESETS = [
  { id: '30d', label: '30 Days' },
  { id: '6m',  label: '6 Months' },
  { id: '1y',  label: '1 Year' },
  { id: 'all', label: 'All Time' },
];

let activeDatePreset = '1y';

// Returns the cutoff ISO date string (YYYY-MM-DD) for the active preset, or null for all time.
function getDateCutoff() {
  const now = new Date();
  if (activeDatePreset === '30d') {
    now.setDate(now.getDate() - 30);
  } else if (activeDatePreset === '6m') {
    now.setMonth(now.getMonth() - 6);
  } else if (activeDatePreset === '1y') {
    now.setFullYear(now.getFullYear() - 1);
  } else {
    return null; // all time — no filtering
  }
  return now.toISOString().split('T')[0];
}

// YYYY-MM-DD string comparison is safe for lexicographic date ordering.
function isInDateRange(dateStr) {
  const cutoff = getDateCutoff();
  if (!cutoff) return true;
  if (!dateStr || dateStr === 'Unknown date') return false;
  return dateStr >= cutoff;
}

// ── localStorage cache ───────────────────────────────────────────────────────

const CACHE_KEY = 'otter-tracker-v2';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function saveCache(resultsById) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      savedAt: Date.now(),
      resultsById,
    }));
  } catch {
    // localStorage might be full or unavailable — non-fatal
  }
}

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { savedAt, resultsById } = JSON.parse(raw);
    if (Date.now() - savedAt > CACHE_TTL_MS) return null;
    return resultsById;
  } catch {
    return null;
  }
}

// ── Map setup ────────────────────────────────────────────────────────────────

const map = L.map('map').setView([38.5, -123], 6);

L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  {
    attribution: 'Tiles &copy; Esri — Esri, USGS, NOAA',
    maxZoom: 18,
  }
).addTo(map);

const clusterGroup = L.markerClusterGroup({
  showCoverageOnHover: false,
  maxClusterRadius: 50,
});
map.addLayer(clusterGroup);

// ── Bounding box (CA → WA coastline) ────────────────────────────────────────

const BOUNDS = {
  swlat: 32.5, swlng: -125.5,
  nelat: 48.5, nelng: -116.5,
};

// WKT polygon for APIs that need it (lng lat order per WKT spec)
const BOUNDS_WKT =
  `POLYGON((${BOUNDS.swlng} ${BOUNDS.swlat},${BOUNDS.nelng} ${BOUNDS.swlat},` +
  `${BOUNDS.nelng} ${BOUNDS.nelat},${BOUNDS.swlng} ${BOUNDS.nelat},` +
  `${BOUNDS.swlng} ${BOUNDS.swlat}))`;

// ── Fetch functions ──────────────────────────────────────────────────────────
//
// Each fetches all available data (no date filtering — that happens client-side).
// Normalized shape: { lat, lng, date, place, observer, photoUrl, link, obscured, sourceId }
// sourceId (string) is used instead of a source reference so results are JSON-serializable.

async function fetchINaturalist(sourceId) {
  const params = new URLSearchParams({
    taxon_id: 41860, // Enhydra lutris
    swlat: BOUNDS.swlat, swlng: BOUNDS.swlng,
    nelat: BOUNDS.nelat, nelng: BOUNDS.nelng,
    quality_grade: 'research',
    per_page: 200,
    order: 'desc',
    order_by: 'observed_on',
  });

  const res = await fetch(`https://api.inaturalist.org/v1/observations?${params}`);
  if (!res.ok) throw new Error(`iNaturalist HTTP ${res.status}`);
  const data = await res.json();

  return data.results
    .filter(obs => obs.location)
    .map(obs => {
      const [lat, lng] = obs.location.split(',').map(Number);
      return {
        lat, lng,
        date: obs.observed_on ?? 'Unknown date',
        place: obs.place_guess ?? 'Unknown location',
        observer: obs.user?.name || obs.user?.login || 'Unknown',
        photoUrl: obs.photos?.[0]?.url?.replace('square', 'medium') ?? null,
        link: obs.uri,
        obscured: obs.obscured ?? false,
        sourceId,
      };
    });
}

async function fetchOBIS(sourceId) {
  const params = new URLSearchParams({
    scientificname: 'Enhydra lutris',
    startlat: BOUNDS.swlat, endlat: BOUNDS.nelat,
    startlon: BOUNDS.swlng, endlon: BOUNDS.nelng,
    size: 200,
  });

  const res = await fetch(`https://api.obis.org/v3/occurrence?${params}`);
  if (!res.ok) throw new Error(`OBIS HTTP ${res.status}`);
  const data = await res.json();

  return (data.results ?? [])
    .filter(r => r.decimalLatitude != null && r.decimalLongitude != null)
    .map(r => ({
      lat: r.decimalLatitude,
      lng: r.decimalLongitude,
      date: r.eventDate?.split('T')[0] ?? r.date_year?.toString() ?? 'Unknown date',
      place: [r.waterBody, r.locality, r.stateProvince].filter(Boolean).join(', ') || 'Unknown location',
      observer: r.institutionCode ?? r.datasetName ?? 'Unknown',
      photoUrl: null,
      link: `https://obis.org/occurrence/${r.id}`,
      obscured: false,
      sourceId,
    }));
}

const FETCH_FN = {
  inaturalist: fetchINaturalist,
  obis: fetchOBIS,
};

// ── Rendering ────────────────────────────────────────────────────────────────

function renderMarkers() {
  clusterGroup.clearLayers();

  const counts = {};
  for (const source of DATA_SOURCES) {
    counts[source.id] = 0;
    if (!source.enabled) continue;

    for (const obs of source.results) {
      if (!isInDateRange(obs.date)) continue;

      const marker = L.circleMarker([obs.lat, obs.lng], {
        radius: 7,
        fillColor: source.color,
        color: '#fff',
        weight: 1.5,
        opacity: 1,
        fillOpacity: 0.85,
      });

      marker.bindPopup(() => buildPopup(obs, source), { maxWidth: 260 });
      clusterGroup.addLayer(marker);
      counts[source.id]++;
    }
  }

  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const summary = DATA_SOURCES.map(s => `${s.label}: ${counts[s.id]}`).join(' · ');
  document.getElementById('status').textContent = `${summary} · updated ${time}`;
}

// ── Fetching ─────────────────────────────────────────────────────────────────

async function fetchAllSources({ force = false } = {}) {
  const statusEl = document.getElementById('status');
  const refreshBtn = document.getElementById('refresh-btn');

  // Try the cache first unless the user explicitly hit Refresh
  if (!force) {
    const cached = loadCache();
    if (cached) {
      for (const source of DATA_SOURCES) {
        source.results = cached[source.id] ?? [];
      }
      renderMarkers();
      return;
    }
  }

  statusEl.textContent = 'Loading sightings...';
  refreshBtn.disabled = true;

  await Promise.all(
    DATA_SOURCES.map(async source => {
      try {
        source.results = await FETCH_FN[source.id](source.id);
      } catch (err) {
        console.error(`Failed to fetch ${source.label}:`, err);
        source.results = [];
      }
    })
  );

  // Persist to localStorage so the next page load is instant
  const resultsById = Object.fromEntries(
    DATA_SOURCES.map(s => [s.id, s.results])
  );
  saveCache(resultsById);

  renderMarkers();
  refreshBtn.disabled = false;
}

// ── Popup ────────────────────────────────────────────────────────────────────

function buildPopup(obs, source) {
  const container = document.createElement('div');
  container.className = 'popup-content';

  if (obs.photoUrl) {
    const img = document.createElement('img');
    img.src = obs.photoUrl;
    img.alt = 'Sea otter photo';
    container.appendChild(img);
  }

  const dot = `<span class="popup-source-dot" style="background:${source.color}"></span>`;

  container.innerHTML += `
    <div class="popup-title">🦦 Sea Otter ${dot} ${source.label}</div>
    <div class="popup-meta">
      📅 ${obs.date}<br>
      📍 ${obs.place}<br>
      👤 ${obs.observer}
      ${obs.obscured ? '<br><span class="popup-obscured">⚠ Approximate location</span>' : ''}
    </div>
    <a class="popup-link" href="${obs.link}" target="_blank" rel="noopener">
      View on ${source.label} →
    </a>
  `;

  return container;
}

// ── Date filter UI ───────────────────────────────────────────────────────────

function buildDateFilterUI() {
  const container = document.getElementById('date-filter');

  for (const preset of DATE_PRESETS) {
    const btn = document.createElement('button');
    btn.className = 'date-btn' + (preset.id === activeDatePreset ? ' active' : '');
    btn.textContent = preset.label;
    btn.dataset.preset = preset.id;
    btn.addEventListener('click', () => {
      if (activeDatePreset === preset.id) return;
      activeDatePreset = preset.id;
      container.querySelectorAll('.date-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.preset === preset.id)
      );
      renderMarkers(); // instant — no API call
    });
    container.appendChild(btn);
  }
}

// ── Source toggle UI ─────────────────────────────────────────────────────────

function buildSourcesUI() {
  const container = document.getElementById('sources');

  for (const source of DATA_SOURCES) {
    const label = document.createElement('label');
    label.className = 'source-chip';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = source.enabled;
    checkbox.addEventListener('change', () => {
      source.enabled = checkbox.checked;
      renderMarkers();
    });

    const dot = document.createElement('span');
    dot.className = 'source-dot';
    dot.style.background = source.color;

    label.appendChild(checkbox);
    label.appendChild(dot);
    label.appendChild(document.createTextNode(source.label));
    container.appendChild(label);
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────

buildDateFilterUI();
buildSourcesUI();
document.getElementById('refresh-btn').addEventListener('click', () => fetchAllSources({ force: true }));

fetchAllSources();
