const express = require('express');
const cors = require('cors');
const { scrapeMultipleAreas } = require('./gasbuddy-scraper');
const { supabase } = require('./supabase');

const app = express();
const PORT = process.env.PORT || 3001;
const GOOGLE_API_KEY = 'AIzaSyA5P0tX5Nh0U1JqjTqpzB0puuBmWnHIzzc';

app.use(cors());
app.use(express.json());

// ─── Background scraper ───────────────────────────────────────────────────────

const SCRAPE_AREAS = [
  'Kitchener ON', 'Waterloo ON', 'Cambridge ON', 'Guelph ON',
  'Hamilton ON', 'Burlington ON', 'Oakville ON', 'Milton ON',
  'Mississauga ON', 'Brampton ON', 'Toronto ON', 'Etobicoke ON',
  'Scarborough ON', 'North York ON', 'Oshawa ON', 'Whitby ON',
  'Ajax ON', 'Pickering ON', 'Barrie ON', 'Brantford ON',
  'London ON', 'Windsor ON', 'Ottawa ON', 'Kingston ON',
  'Peterborough ON', 'Lakefield ON', 'Norwood ON', 'Bridgenorth ON',
];

const SCRAPE_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
let isWorkerRunning = false;

async function backgroundScrapeWorker() {
  if (isWorkerRunning) {
    console.log('[Worker] Already running, skipping cycle');
    return;
  }
  isWorkerRunning = true;
  const start = Date.now();
  console.log('[Worker] Starting scrape at', new Date().toISOString());

  try {
    const stations = await scrapeMultipleAreas(SCRAPE_AREAS, null, null, 30, null);
    console.log(`[Worker] Scraped ${stations.length} stations`);

    const now = new Date().toISOString();
    const withCoords = stations.filter(s => s.lat && s.lng);
    const toSave = withCoords.map(s => ({
      id: s.id,
      name: s.name,
      address: s.address || '',
      lat: s.lat,
      lng: s.lng,
      brand: s.name,
      price_per_l: s.price_per_l ?? null,
      price_updated_at: s.price_per_l ? now : null,
      photo_url: s.photo_url || null,
      updated_at: now,
    }));

    if (toSave.length > 0) {
      const { error } = await supabase
        .from('stations')
        .upsert(toSave, { onConflict: 'id' });

      if (error) console.error('[Worker] DB upsert error:', error.message);
      else console.log(`[Worker] Saved ${toSave.length} stations (${Date.now() - start}ms)`);
    }
  } catch (e) {
    console.error('[Worker] Scrape failed:', e.message);
  } finally {
    isWorkerRunning = false;
  }
}


// ─── Helpers ──────────────────────────────────────────────────────────────────

function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 100) / 100;
}

const VALHALLA_HOSTS = [
  'https://valhalla1.openstreetmap.de',
  'https://valhalla2.openstreetmap.de',
];

async function valhallaRequest(body, attempt = 0) {
  const host = VALHALLA_HOSTS[attempt % VALHALLA_HOSTS.length];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`${host}/sources_to_targets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'GasOptimizer/1.0' },
      body,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const text = await response.text();
    return JSON.parse(text); // throws if not JSON
  } catch (e) {
    clearTimeout(timeout);
    if (attempt < VALHALLA_HOSTS.length - 1) {
      console.warn(`[Driving] Valhalla host ${host} failed, trying next:`, e.message);
      return valhallaRequest(body, attempt + 1);
    }
    throw e;
  }
}

async function getDrivingDistances(originLat, originLng, stations) {
  if (!stations.length) return stations;

  const batchSize = 25;
  const results = [];

  for (let i = 0; i < stations.length; i += batchSize) {
    const batch = stations.slice(i, i + batchSize);
    const body = JSON.stringify({
      sources: [{ lon: originLng, lat: originLat }],
      targets: batch.map(s => ({ lon: s.lng, lat: s.lat })),
      costing: 'auto',
    });
    try {
      const data = await valhallaRequest(body);
      const row = data.sources_to_targets?.[0];
      if (row) {
        row.forEach((element, idx) => {
          if (element?.distance != null && element.distance > 0) {
            batch[idx].driving_distance_km = Math.round(element.distance * 100) / 100;
            batch[idx].driving_duration_min = element.time != null ? Math.round(element.time / 60) : undefined;
          }
        });
        console.log(`[Driving] Valhalla batch ${i / batchSize + 1}: ${batch.length} stations enriched`);
      } else {
        console.warn('[Driving] Valhalla unexpected response:', JSON.stringify(data).slice(0, 200));
      }
    } catch (e) {
      console.warn('[Driving] Valhalla all hosts failed:', e.message);
    }
    results.push(...batch);
  }
  return results;
}

// ─── Location helpers ─────────────────────────────────────────────────────────

// Use Nominatim (free, no key) to find municipality name from coordinates
async function getMunicipalityName(lat, lng) {
  try {
    const url = `https://photon.komoot.io/reverse?lat=${lat}&lon=${lng}&limit=1`;
    const res = await fetch(url, { headers: { 'User-Agent': 'GasOptimizer/1.0' } });
    const data = await res.json();
    const p = data.features?.[0]?.properties || {};
    return p.city || p.town || p.village || p.county || null;
  } catch (e) {
    console.warn('Reverse geocode failed:', e.message);
    return null;
  }
}

// Find all towns/cities within radiusKm of a point using Nominatim.
// Sequential with small delay to avoid rate-limiting (Nominatim blocks parallel bursts).
async function getNearbyMunicipalities(lat, lng, radiusKm) {
  const municipalities = new Set();
  const stepDeg = radiusKm / 111;
  // Use a sparser 3×3 grid (9 calls) rather than 5×5 (25 calls) to stay under rate limit
  const offsets = [-1, 0, 1];

  for (const dLat of offsets) {
    for (const dLng of offsets) {
      const name = await getMunicipalityName(lat + dLat * stepDeg, lng + dLng * stepDeg);
      if (name) municipalities.add(`${name} ON`);
      await new Promise(r => setTimeout(r, 200)); // 200ms between calls
    }
  }

  return Array.from(municipalities);
}

// Cache of recently scraped locations to avoid hammering GasBuddy
const recentlyScrape = new Map(); // key -> timestamp
const SCRAPE_COOLDOWN_MS = 20 * 60 * 1000; // 20 min per area

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/api/stations/nearby', async (req, res) => {
  try {
    const { lat, lng, radius } = req.query;
    const userLat = parseFloat(lat);
    const userLng = parseFloat(lng);
    const maxRadius = parseFloat(radius) || 15;

    if (!userLat || !userLng) {
      return res.status(400).json({ success: false, error: 'lat and lng required' });
    }

    // Query DB for stations near this location
    const getFromDB = async () => {
      const { data: allStations, error } = await supabase
        .from('stations')
        .select('*')
        .not('price_per_l', 'is', null);
      if (error) throw error;
      return allStations
        .map(s => ({
          ...s,
          lat: parseFloat(s.lat),
          lng: parseFloat(s.lng),
          distance_km: haversineDistance(userLat, userLng, parseFloat(s.lat), parseFloat(s.lng)),
        }))
        .filter(s => s.distance_km <= maxRadius)
        .sort((a, b) => a.distance_km - b.distance_km)
        .slice(0, 60);
    };

    let nearby = await getFromDB();

    // If we have fewer than 5 stations, try a dynamic scrape — but always return
    // whatever is in the DB afterwards, even if the scrape fails or fires nothing.
    if (nearby.length < 5) {
      console.log(`Only ${nearby.length} stations in DB near ${userLat},${userLng} — triggering dynamic scrape`);

      try {
        const municipalities = await getNearbyMunicipalities(userLat, userLng, maxRadius);
        console.log('Scraping municipalities:', municipalities);

        const toScrape = municipalities.filter(m => {
          const last = recentlyScrape.get(m);
          return !last || (Date.now() - last > SCRAPE_COOLDOWN_MS);
        });

        if (toScrape.length > 0) {
          const stations = await scrapeMultipleAreas(toScrape, userLat, userLng, 30, null);
          console.log(`Dynamic scrape got ${stations.length} stations`);

          const now = new Date().toISOString();
          const withCoords = stations.filter(s => s.lat && s.lng);
          await enrichWithPhotos(withCoords);
          const toSave = withCoords.map(s => ({
            id: s.id,
            name: s.name,
            address: s.address || '',
            lat: s.lat,
            lng: s.lng,
            brand: s.name,
            price_per_l: s.price_per_l ?? null,
            price_updated_at: s.price_per_l ? now : null,
            photo_url: s.photo_url || null,
            updated_at: now,
          }));

          if (toSave.length > 0) {
            await supabase.from('stations').upsert(toSave, { onConflict: 'id' });
          }

          for (const m of toScrape) recentlyScrape.set(m, Date.now());

          // Re-query DB with fresh data
          nearby = await getFromDB();
        }
      } catch (e) {
        console.error('Dynamic scrape failed:', e.message);
        // Fall through — return whatever is in DB rather than erroring
      }
    }

    const withDriving = await getDrivingDistances(userLat, userLng, nearby);
    res.json({ success: true, stations: withDriving });
  } catch (e) {
    console.error('Nearby error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Worker status endpoint
app.get('/api/worker/status', (req, res) => {
  res.json({ running: isWorkerRunning });
});

// Fueleconomy proxy (used by profile screen)
app.use('/api/fueleconomy', async (req, res) => {
  try {
    const url = `https://www.fueleconomy.gov/ws/rest${req.url}`;
    const response = await fetch(url);
    const body = await response.text();
    res.set('Content-Type', 'application/xml');
    res.status(response.status).send(body);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', workerRunning: isWorkerRunning }));

// ─── Start ────────────────────────────────────────────────────────────────────

async function backfillPhotos() {
  try {
    const { data: stations, error } = await supabase
      .from('stations')
      .select('id, name, address')
      .is('photo_url', null)
      .not('address', 'eq', '');

    if (error || !stations?.length) return;
    console.log(`[Backfill] Fetching photos for ${stations.length} stations...`);

    for (let i = 0; i < stations.length; i += 5) {
      const batch = stations.slice(i, i + 5);
      await Promise.all(batch.map(async (s) => {
        const url = await getGooglePhotoUrl(s.name, s.address);
        if (url) {
          await supabase.from('stations').update({ photo_url: url }).eq('id', s.id);
        }
      }));
    }
    console.log('[Backfill] Done');
  } catch (e) {
    console.warn('[Backfill] Failed:', e.message);
  }
}

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('Proxy server listening on http://localhost:' + PORT);

  // Kick off background scraper immediately, then every 10 minutes
  backgroundScrapeWorker();
  setInterval(backgroundScrapeWorker, SCRAPE_INTERVAL_MS);

  // Backfill photos for existing stations missing them
  setTimeout(backfillPhotos, 5000);
});

server.on('error', (err) => {
  console.error('Server error:', err);
  process.exit(1);
});
