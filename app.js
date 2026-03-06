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

// ── Region filter ────────────────────────────────────────────────────────────

const REGIONS = [
  { id: 'pacific', label: 'Pacific Coast', view: { center: [47, 217], zoom: 5 } },
  { id: 'world',   label: 'Worldwide',     view: null }, // null = use INITIAL_VIEW
];

let activeRegion = 'world';

// ── Result limit ─────────────────────────────────────────────────────────────

const RESULT_LIMITS = [
  { value: 1000,  label: '1K'  },
  { value: 5000,  label: '5K'  },
  { value: 10000, label: '10K' },
];

let activeResultLimit = 1000;

// ── localStorage cache ───────────────────────────────────────────────────────

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Cache key encodes all fetch settings so switching region/limit forces a fresh fetch.
function getCacheKey() {
  return `otter-tracker-v3-${activeRegion}-${activeResultLimit}`;
}

function saveCache(resultsById) {
  try {
    localStorage.setItem(getCacheKey(), JSON.stringify({
      savedAt: Date.now(),
      resultsById,
    }));
  } catch {
    // localStorage might be full or unavailable — non-fatal
  }
}

function loadCache() {
  try {
    const raw = localStorage.getItem(getCacheKey());
    if (!raw) return null;
    const { savedAt, resultsById } = JSON.parse(raw);
    if (Date.now() - savedAt > CACHE_TTL_MS) return null;
    return resultsById;
  } catch {
    return null;
  }
}

// ── Map setup ────────────────────────────────────────────────────────────────

const INITIAL_VIEW = { center: [41.44272637767212, 188.34960937500003], zoom: 4 };

const map = L.map('map', {
  minZoom: 2,
  zoomControl: false,
  // Allow one full world wrap so the Pacific (straddling the date line) can be
  // centered: Japan (~140°E) sits left, Alaska/CA (~120–170°W = 190–240°E) right.
  // The right bound at 360° stops infinite panning — the user can go around once.
  maxBounds: [[-85, -180], [85, 360]],
  maxBoundsViscosity: 1.0,
}).setView(INITIAL_VIEW.center, INITIAL_VIEW.zoom);

L.control.zoom({ position: 'topright' }).addTo(map);

L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  {
    attribution: 'Tiles &copy; Esri — Esri, USGS, NOAA',
    maxZoom: 18,
    // noWrap left off so tiles repeat to fill the Pacific-centric view
  }
).addTo(map);

const clusterGroup = L.markerClusterGroup({
  showCoverageOnHover: false,
  maxClusterRadius: 50,
});
map.addLayer(clusterGroup);

// Maps obs.link → its Leaflet marker so recent-sightings cards can zoom to it.
const markerByLink = new Map();

// ── Bounding box (CA coast → Alaska) ────────────────────────────────────────

const BOUNDS = {
  swlat: 32.5, swlng: -170,
  nelat: 62,   nelng: -116.5,
};

// ── Fetch helpers ────────────────────────────────────────────────────────────

// Fetch an array of URLs in sequential batches to avoid hammering rate limits.
async function fetchBatched(urls, batchSize = 5) {
  const results = [];
  for (let i = 0; i < urls.length; i += batchSize) {
    const batch = await Promise.all(
      urls.slice(i, i + batchSize).map(({ url, label }) =>
        fetch(url).then(r => {
          if (!r.ok) throw new Error(`${label} HTTP ${r.status}`);
          return r.json();
        })
      )
    );
    results.push(...batch);
  }
  return results;
}

// ── Fetch functions ──────────────────────────────────────────────────────────
//
// Each fetches all available data (no date filtering — that happens client-side).
// Normalized shape: { lat, lng, date, place, observer, photoUrl, link, obscured, sourceId }
// sourceId (string) is used instead of a source reference so results are JSON-serializable.

async function fetchINaturalist(sourceId) {
  const PAGE_SIZE = 200;
  const maxPages = Math.ceil(activeResultLimit / PAGE_SIZE);

  const baseParams = {
    taxon_id: 41860, // Enhydra lutris
    quality_grade: 'research,needs_id',
    per_page: PAGE_SIZE,
    order: 'desc',
    order_by: 'observed_on',
  };

  if (activeRegion === 'pacific') {
    baseParams.swlat = BOUNDS.swlat;
    baseParams.swlng = BOUNDS.swlng;
    baseParams.nelat = BOUNDS.nelat;
    baseParams.nelng = BOUNDS.nelng;
  }

  // Fetch page 1 first to learn total_results
  const firstRes = await fetch(
    `https://api.inaturalist.org/v1/observations?${new URLSearchParams({ ...baseParams, page: 1 })}`
  );
  if (!firstRes.ok) throw new Error(`iNaturalist HTTP ${firstRes.status}`);
  const firstData = await firstRes.json();

  const totalPages = Math.min(Math.ceil(firstData.total_results / PAGE_SIZE), maxPages);

  // Build remaining page URLs then fetch in batches of 5
  const remainingUrls = Array.from({ length: totalPages - 1 }, (_, i) => i + 2).map(page => ({
    url: `https://api.inaturalist.org/v1/observations?${new URLSearchParams({ ...baseParams, page })}`,
    label: `iNaturalist p${page}`,
  }));
  const extraData = await fetchBatched(remainingUrls);

  return [firstData, ...extraData]
    .flatMap(d => d.results)
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
  const PAGE_SIZE = 200;
  const maxPages = Math.ceil(activeResultLimit / PAGE_SIZE);

  const baseParams = {
    scientificname: 'Enhydra lutris',
    size: PAGE_SIZE,
  };

  if (activeRegion === 'pacific') {
    baseParams.startlat = BOUNDS.swlat;
    baseParams.endlat   = BOUNDS.nelat;
    baseParams.startlon = BOUNDS.swlng;
    baseParams.endlon   = BOUNDS.nelng;
  }

  // Fetch page 1 to learn total count
  const firstRes = await fetch(
    `https://api.obis.org/v3/occurrence?${new URLSearchParams({ ...baseParams, offset: 0 })}`
  );
  if (!firstRes.ok) throw new Error(`OBIS HTTP ${firstRes.status}`);
  const firstData = await firstRes.json();

  const totalPages = Math.min(Math.ceil((firstData.total ?? 0) / PAGE_SIZE), maxPages);

  const remainingUrls = Array.from({ length: totalPages - 1 }, (_, i) => i + 1).map(page => ({
    url: `https://api.obis.org/v3/occurrence?${new URLSearchParams({ ...baseParams, offset: page * PAGE_SIZE })}`,
    label: `OBIS p${page + 1}`,
  }));
  const extraData = await fetchBatched(remainingUrls);

  const normalize = r => ({
    lat: r.decimalLatitude,
    lng: r.decimalLongitude,
    date: r.eventDate?.split('T')[0] ?? r.date_year?.toString() ?? 'Unknown date',
    place: [r.waterBody, r.locality, r.stateProvince].filter(Boolean).join(', ') || 'Unknown location',
    observer: r.institutionCode ?? r.datasetName ?? 'Unknown',
    photoUrl: null,
    link: `https://obis.org/occurrence/${r.id}`,
    obscured: false,
    sourceId,
  });

  return [firstData, ...extraData]
    .flatMap(d => d.results ?? [])
    .filter(r => r.decimalLatitude != null && r.decimalLongitude != null)
    .map(normalize);
}

const FETCH_FN = {
  inaturalist: fetchINaturalist,
  obis: fetchOBIS,
};

// ── Isolation scoring (for "unusual sightings" panel) ────────────────────────
//
// Score each observation by its squared distance to its nearest neighbour in
// the full iNaturalist dataset.  Higher score = more geographically isolated.
// Squared distance avoids sqrt — fine for ranking purposes.

function findIsolatedSightings(allResults, excludeLinks, count = 3) {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const cutoff30 = thirtyDaysAgo.toISOString().split('T')[0];

  // Candidates must be within the last 30 days, pass the active date filter
  // (so a marker always exists in markerByLink), and have a real location name.
  const candidates = allResults.filter(obs =>
    obs.date >= cutoff30 &&
    isInDateRange(obs.date) &&
    obs.place && obs.place !== 'Unknown location' &&
    !excludeLinks.has(obs.link)
  );

  if (candidates.length === 0) return [];

  return candidates
    .map(obs => {
      let minDistSq = Infinity;
      for (const other of allResults) {
        if (other === obs) continue;
        const dlat = obs.lat - other.lat;
        const dlng = obs.lng - other.lng;
        const dSq = dlat * dlat + dlng * dlng;
        if (dSq < minDistSq) minDistSq = dSq;
      }
      return { obs, score: minDistSq };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, count)
    .map(({ obs }) => obs);
}

// ── Hotspot detection ─────────────────────────────────────────────────────────
//
// Among sightings from the last 90 days, find the one with the most neighbours
// within a ~1° radius (~100 km).  That becomes the hotspot centre; we return
// the `count` most recent observations inside that radius.

function findHotspotSightings(allResults, excludeLinks, count = 3) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  const recent = allResults.filter(obs =>
    obs.date && obs.date !== 'Unknown date' && obs.date >= cutoffStr
  );

  if (recent.length === 0) return [];

  const RADIUS_SQ = 1.0; // 1° lat/lng ≈ 100 km

  // Find the recent sighting surrounded by the most other recent sightings
  let bestCenter = null;
  let bestCount = -1;

  for (const obs of recent) {
    let n = 0;
    for (const other of recent) {
      if (other === obs) continue;
      const dlat = obs.lat - other.lat;
      const dlng = obs.lng - other.lng;
      if (dlat * dlat + dlng * dlng <= RADIUS_SQ) n++;
    }
    if (n > bestCount) { bestCount = n; bestCenter = obs; }
  }

  if (!bestCenter) return [];

  return recent
    .filter(obs => {
      if (excludeLinks.has(obs.link)) return false;
      const dlat = obs.lat - bestCenter.lat;
      const dlng = obs.lng - bestCenter.lng;
      return dlat * dlat + dlng * dlng <= RADIUS_SQ;
    })
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, count);
}

// ── Panel expand / collapse ───────────────────────────────────────────────────

const PANEL_IDS = ['recent-sightings', 'interesting-sightings', 'hotspot-sightings'];
const collapsedPanels = new Set();

function applyPanelState() {
  const n = collapsedPanels.size; // 0, 1, or 2 collapsed
  for (const id of PANEL_IDS) {
    const el = document.getElementById(id);
    el.classList.remove('collapsed', 'expanded', 'super-expanded');
    if (collapsedPanels.has(id)) {
      el.classList.add('collapsed');
    } else if (n === 1) {
      el.classList.add('expanded');       // 5 cards
    } else if (n === 2) {
      el.classList.add('super-expanded'); // 9 cards
    }
    // n === 0: no class → 3 cards (default)
  }
}

function togglePanel(panelId) {
  collapsedPanels.has(panelId) ? collapsedPanels.delete(panelId) : collapsedPanels.add(panelId);
  applyPanelState();
}

function buildPanelHeader(text, panelId) {
  const header = document.createElement('div');
  header.className = 'recent-header';
  header.innerHTML = `${text} <span class="panel-chevron">▾</span>`;
  header.addEventListener('click', () => togglePanel(panelId));
  return header;
}

// ── Recent sightings panel ────────────────────────────────────────────────────

const CARDS_MAX = 9; // render up to 9; CSS controls how many are visible per tier

function extraClass(i) {
  if (i >= 4) return ' extra-2'; // visible only when super-expanded (2 others collapsed)
  if (i >= 3) return ' extra-1'; // visible when expanded (1 other collapsed)
  return '';
}

function buildSightingCard(obs, badgeHtml, cls = '') {
  const card = document.createElement('div');
  card.className = 'recent-card' + cls;
  card.title = 'Click to zoom to this sighting';

  if (obs.photoUrl) {
    const img = document.createElement('img');
    img.className = 'recent-photo';
    img.src = obs.photoUrl;
    img.alt = 'Sea otter';
    card.appendChild(img);
  } else {
    const ph = document.createElement('div');
    ph.className = 'recent-photo-placeholder';
    ph.textContent = '🦦';
    card.appendChild(ph);
  }

  const info = document.createElement('div');
  info.className = 'recent-info';
  info.innerHTML = `
    ${badgeHtml}
    <div class="recent-date">${obs.date}</div>
    <div class="recent-place">${obs.place}</div>
  `;
  card.appendChild(info);

  card.addEventListener('click', () => {
    const lngNorm = obs.lng < 0 ? obs.lng + 360 : obs.lng;
    const marker = markerByLink.get(obs.link);
    if (marker) {
      clusterGroup.zoomToShowLayer(marker, () => marker.openPopup());
    } else {
      map.flyTo([obs.lat, lngNorm], 10);
    }
  });

  return card;
}

function renderRecentSightings() {
  const panel = document.getElementById('recent-sightings');
  const inat = DATA_SOURCES.find(s => s.id === 'inaturalist');
  panel.innerHTML = '';
  panel.appendChild(buildPanelHeader('Latest Sightings', 'recent-sightings'));

  if (!inat || inat.results.length === 0) return new Set();

  const recent = [...inat.results]
    .filter(obs => obs.date && obs.date !== 'Unknown date')
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, CARDS_MAX);

  recent.forEach((obs, i) => {
    panel.appendChild(buildSightingCard(obs, '<div class="recent-badge">NEW</div>', extraClass(i)));
  });

  return new Set(recent.map(obs => obs.link));
}

function renderInterestingSightings(excludeLinks) {
  const panel = document.getElementById('interesting-sightings');
  const inat = DATA_SOURCES.find(s => s.id === 'inaturalist');
  panel.innerHTML = '';
  panel.appendChild(buildPanelHeader('Unusual Sightings', 'interesting-sightings'));

  if (!inat || inat.results.length === 0) return new Set();

  const isolated = findIsolatedSightings(inat.results, excludeLinks, CARDS_MAX);
  isolated.forEach((obs, i) => {
    panel.appendChild(buildSightingCard(obs, '<div class="rare-badge">RARE</div>', extraClass(i)));
  });
  return new Set(isolated.map(obs => obs.link));
}

function renderHotspotSightings(excludeLinks) {
  const panel = document.getElementById('hotspot-sightings');
  const inat = DATA_SOURCES.find(s => s.id === 'inaturalist');
  panel.innerHTML = '';
  panel.appendChild(buildPanelHeader('Recent Hotspot', 'hotspot-sightings'));

  if (!inat || inat.results.length === 0) return;

  const hotspot = findHotspotSightings(inat.results, excludeLinks, CARDS_MAX);
  hotspot.forEach((obs, i) => {
    panel.appendChild(buildSightingCard(obs, '<div class="hot-badge">ACTIVE</div>', extraClass(i)));
  });
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderMarkers() {
  clusterGroup.clearLayers();
  markerByLink.clear();

  const counts = {};
  for (const source of DATA_SOURCES) {
    counts[source.id] = 0;
    if (!source.enabled) continue;

    for (const obs of source.results) {
      if (!isInDateRange(obs.date)) continue;

      // Normalize to 0–360° so Pacific-centered view (178°E) places
      // CA/AK sightings (negative lng) to the right of Japan, not the left.
      const lngNorm = obs.lng < 0 ? obs.lng + 360 : obs.lng;

      const marker = L.circleMarker([obs.lat, lngNorm], {
        radius: 7,
        fillColor: source.color,
        color: '#fff',
        weight: 1.5,
        opacity: 1,
        fillOpacity: 0.85,
      });

      marker.bindPopup(() => buildPopup(obs, source), { maxWidth: 260 });
      clusterGroup.addLayer(marker);
      markerByLink.set(obs.link, marker);
      counts[source.id]++;
    }
  }

  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const summary = DATA_SOURCES.map(s => `${s.label}: ${counts[s.id]}`).join(' · ');
  document.getElementById('status').textContent = `${summary} · updated ${time}`;

  const recentLinks = renderRecentSightings();
  const isolatedLinks = renderInterestingSightings(recentLinks);
  renderHotspotSightings(new Set([...recentLinks, ...isolatedLinks]));
  applyPanelState();
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

  const regionLabel = activeRegion === 'world' ? 'worldwide' : 'Pacific Coast';
  statusEl.textContent = `Loading sightings (${regionLabel}, up to ${activeResultLimit.toLocaleString()} per source)…`;
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
    <div class="popup-title"><img class="popup-otter-icon" src="https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/assets/Otter/Color/otter_color.svg" alt="otter"> Sea Otter ${dot} ${source.label}</div>
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

// ── Region filter UI ──────────────────────────────────────────────────────────

function buildRegionUI() {
  const container = document.getElementById('region-filter');

  for (const region of REGIONS) {
    const btn = document.createElement('button');
    btn.className = 'date-btn' + (region.id === activeRegion ? ' active' : '');
    btn.textContent = region.label;
    btn.dataset.region = region.id;
    btn.addEventListener('click', () => {
      if (activeRegion === region.id) return;
      activeRegion = region.id;
      container.querySelectorAll('.date-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.region === region.id)
      );
      const v = region.view ?? INITIAL_VIEW;
      map.flyTo(v.center, v.zoom, { duration: 1.2 });
      fetchAllSources({ force: true }); // bounding box changed — must re-fetch
    });
    container.appendChild(btn);
  }
}

// ── Result limit UI ───────────────────────────────────────────────────────────

function buildLimitUI() {
  const container = document.getElementById('limit-filter');

  for (const limit of RESULT_LIMITS) {
    const btn = document.createElement('button');
    btn.className = 'date-btn' + (limit.value === activeResultLimit ? ' active' : '');
    btn.textContent = limit.label;
    btn.dataset.limit = limit.value;
    btn.addEventListener('click', () => {
      if (activeResultLimit === limit.value) return;
      activeResultLimit = limit.value;
      container.querySelectorAll('.date-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.limit === String(limit.value))
      );
      fetchAllSources({ force: true }); // page count changed — must re-fetch
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
buildRegionUI();
buildLimitUI();
buildSourcesUI();
document.getElementById('refresh-btn').addEventListener('click', () => fetchAllSources({ force: true }));
document.getElementById('reset-btn').addEventListener('click', () => map.setView(INITIAL_VIEW.center, INITIAL_VIEW.zoom));

fetchAllSources();
