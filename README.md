# 🦦 Otter Tracker

A real-time sea otter sighting map powered by public biodiversity databases. Live at **[ottertracker.org](https://ottertracker.org)**.

## What It Does

Otter Tracker aggregates verified sea otter observations from two public APIs and plots them on an interactive satellite map. Sightings update automatically every 24 hours via browser-side caching — no server required.

## Data Sources

| Source | What it provides | Color |
|---|---|---|
| [iNaturalist](https://www.inaturalist.org) | Community wildlife observations (Research Grade + Needs ID) | Amber |
| [OBIS](https://obis.org) | Ocean biodiversity occurrence records | Teal |

## Features

- **Pacific-centered map** — the date line sits in the middle so Japan, Alaska, and California otter habitat are all visible at once
- **Worldwide or Pacific Coast** region toggle — worldwide fetches global records; Pacific Coast filters to the CA–Alaska coastline (32.5°N–62°N, 170°W–116.5°W)
- **Result limit** — fetch up to 1K, 5K, or 10K records per source; pages are batched to stay within API rate limits
- **Date filter** — client-side filtering by 30 days, 6 months, 1 year, or all time with no extra API calls
- **Source toggles** — show/hide iNaturalist and OBIS layers independently
- **24-hour localStorage cache** — instant repeat loads; Refresh button forces a new fetch
- **Marker clustering** — dense sighting areas cluster automatically and expand on zoom
- **Photo popups** — click any marker to see the observation photo, date, location, observer, and a link to the source record

## Wanted: More Data

The map is only as good as the data behind it, and there's a lot of sea otter monitoring happening that isn't yet on here. If you know of a dataset, API, or institution that could strengthen coverage — especially outside California — I'd love to hear from you.

Particularly interested in:

- **Alaska and Aleutian Island surveys** — population counts, range data, telemetry feeds
- **Russian Far East and Japan** — Kuril Islands, Hokkaido, and Sea of Okhotsk populations are underrepresented in public databases
- **Historical museum collections** — range reconstruction benefits enormously from digitized specimen records
- **Real-time telemetry** — tagged individual tracking data that could be integrated with appropriate data-sharing agreements

If you maintain or know of a relevant dataset, [open an issue](https://github.com/Austin795/otter-tracker/issues/new) or reach out directly. Even a pointer to a database or contact at an institution is helpful.

## Contributing Data

Sea otter sightings submitted to iNaturalist appear on this map automatically within 24 hours once they reach Needs ID or Research Grade status. See the [Contribute Data](https://ottertracker.org/contribute.html) page for full instructions, tips for quality observations, and information on institutional data integration.

## Adding a New Data Source

The `DATA_SOURCES` array in [app.js](app.js) is the single source of truth. Add an entry there and implement a matching fetch function — the UI, caching, rendering, and source toggles all update automatically.

```js
const DATA_SOURCES = [
  { id: 'mysource', label: 'My Source', color: '#ff6600', enabled: true, results: [] },
  // ...
];

async function fetchMysource(sourceId) {
  // fetch, normalize to { lat, lng, date, place, observer, photoUrl, link, obscured, sourceId }
  // return array of normalized observations
}

const FETCH_FN = { mysource: fetchMysource, /* ... */ };
```

## Running Locally

Just open `index.html` in a browser. No server or build process needed.

```bash
git clone https://github.com/Austin795/otter-tracker.git
cd otter-tracker
open index.html   # or double-click in your file explorer
```

## License

MIT
