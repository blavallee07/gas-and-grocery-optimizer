const puppeteer = require('puppeteer');
const { supabase } = require('./supabase');

// Ontario cities/towns to search
const ONTARIO_LOCATIONS = [
  // Major cities
  'Toronto ON', 'Ottawa ON', 'Mississauga ON', 'Brampton ON', 'Hamilton ON',
  'London ON', 'Markham ON', 'Vaughan ON', 'Kitchener ON', 'Windsor ON',
  'Richmond Hill ON', 'Oakville ON', 'Burlington ON', 'Sudbury ON', 'Oshawa ON',
  'Barrie ON', 'St Catharines ON', 'Cambridge ON', 'Kingston ON', 'Guelph ON',
  'Thunder Bay ON', 'Waterloo ON', 'Brantford ON', 'Pickering ON', 'Niagara Falls ON',
  'Peterborough ON', 'Sault Ste Marie ON', 'Sarnia ON', 'Norfolk ON', 'Welland ON',
  'Belleville ON', 'North Bay ON', 'Cornwall ON', 'Woodstock ON', 'Chatham ON',
  // Smaller towns near you
  'Selwyn ON', 'Lakefield ON', 'Bridgenorth ON', 'Lindsay ON', 'Cobourg ON',
  'Port Hope ON', 'Bowmanville ON', 'Whitby ON', 'Ajax ON', 'Courtice ON',
  'Millbrook ON', 'Norwood ON', 'Havelock ON', 'Campbellford ON', 'Stirling ON',
  'Madoc ON', 'Tweed ON', 'Bancroft ON', 'Minden ON', 'Haliburton ON',
  'Bobcaygeon ON', 'Fenelon Falls ON', 'Omemee ON', 'Kawartha Lakes ON',
  // More coverage
  'Orillia ON', 'Midland ON', 'Collingwood ON', 'Orangeville ON', 'Alliston ON',
  'Newmarket ON', 'Aurora ON', 'Stouffville ON', 'Uxbridge ON', 'Port Perry ON',
  'Gravenhurst ON', 'Bracebridge ON', 'Huntsville ON', 'Parry Sound ON',
  'Owen Sound ON', 'Tobermory ON', 'Wiarton ON', 'Kincardine ON', 'Goderich ON',
  'Stratford ON', 'St Thomas ON', 'Tillsonburg ON', 'Simcoe ON', 'Dunnville ON',
  'Grimsby ON', 'Smiths Falls ON', 'Carleton Place ON', 'Arnprior ON', 'Pembroke ON',
  'Renfrew ON', 'Petawawa ON', 'Deep River ON', 'Brockville ON', 'Prescott ON',
  'Kemptville ON', 'Morrisburg ON', 'Hawkesbury ON', 'Casselman ON', 'Rockland ON',
  'Timmins ON', 'Kirkland Lake ON', 'New Liskeard ON', 'Kapuskasing ON', 'Hearst ON',
  'Kenora ON', 'Fort Frances ON', 'Dryden ON', 'Sioux Lookout ON', 'Red Lake ON'
];

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms + Math.random() * 3000));
}

async function scrapeStationDetails(browser, stationId) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  
  try {
    await page.goto(`https://www.gasbuddy.com/station/${stationId}`, { 
      waitUntil: 'networkidle2', 
      timeout: 25000 
    });
    
    await delay(2000);
    
    const details = await page.evaluate(() => {
      const html = document.body.innerHTML;
      const latMatch = html.match(/"latitude":\s*([-\d.]+)/);
      const lngMatch = html.match(/"longitude":\s*([-\d.]+)/);
      const addressEl = document.querySelector('address, [class*="Address"]');
      
      return {
        lat: latMatch ? parseFloat(latMatch[1]) : null,
        lng: lngMatch ? parseFloat(lngMatch[1]) : null,
        address: addressEl?.textContent?.trim() || '',
      };
    });
    
    await page.close();
    return details;
  } catch (e) {
    await page.close().catch(() => {});
    return null;
  }
}

async function populateDatabase() {
  console.log('Starting Ontario gas station database population...');
  console.log(`Will search ${ONTARIO_LOCATIONS.length} locations\n`);
  
  const browser = await puppeteer.launch({ 
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1366, height: 768 });
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  });
  
  const allStations = new Map();
  let consecutiveEmpty = 0;
  
  // Step 1: Collect station IDs from all locations
  for (let i = 0; i < ONTARIO_LOCATIONS.length; i++) {
    const location = ONTARIO_LOCATIONS[i];
    console.log(`[${i + 1}/${ONTARIO_LOCATIONS.length}] Searching: ${location}`);
    
    // If we get too many empty results, take a longer break
    if (consecutiveEmpty >= 3) {
      console.log('\nDetected possible rate limiting. Taking a 2 minute break...\n');
      await delay(120000);
      consecutiveEmpty = 0;
      
      // Restart browser to get fresh session
      await page.close();
      await browser.close();
      const newBrowser = await puppeteer.launch({ 
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
      const newPage = await newBrowser.newPage();
      await newPage.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      await newPage.setViewport({ width: 1366, height: 768 });
      // Continue with new browser/page reference
    }
    
    try {
      const url = `https://www.gasbuddy.com/home?search=${encodeURIComponent(location)}&fuel=1`;
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      await delay(4000); // Longer delay to seem more human
      
      const stations = await page.evaluate(() => {
        const results = [];
        const items = document.querySelectorAll('[class*="GenericStationListItem"]');
        
        items.forEach((el) => {
          const link = el.querySelector('a[href*="/station/"]');
          const stationUrl = link?.getAttribute('href') || '';
          const stationId = stationUrl.match(/\/station\/(\d+)/)?.[1];
          const name = link?.textContent?.trim();
          
          if (stationId && name) {
            results.push({ id: stationId, name });
          }
        });
        
        return results;
      });
      
      if (stations.length === 0) {
        consecutiveEmpty++;
        console.log(`  Found 0 stations (might be blocked, consecutive empty: ${consecutiveEmpty})`);
      } else {
        consecutiveEmpty = 0;
        stations.forEach(s => {
          if (!allStations.has(s.id)) {
            allStations.set(s.id, s);
          }
        });
        console.log(`  Found ${stations.length} stations (total unique: ${allStations.size})`);
      }
      
    } catch (e) {
      console.log(`  Error: ${e.message}`);
      consecutiveEmpty++;
    }
    
    // Random delay between searches (3-7 seconds)
    await delay(3000);
    
    // Save progress every 10 locations
    if ((i + 1) % 10 === 0) {
      console.log(`\n--- Progress: ${allStations.size} unique stations found ---\n`);
    }
  }
  
  console.log(`\n========================================`);
  console.log(`Total unique stations found: ${allStations.size}`);
  console.log(`========================================\n`);
  
  // Step 2: Check which stations are already in database
  const stationIds = Array.from(allStations.keys());
  
  // Query in batches of 100 to avoid URL length limits
  const existingIds = new Set();
  for (let i = 0; i < stationIds.length; i += 100) {
    const batch = stationIds.slice(i, i + 100);
    const { data: existingStations } = await supabase
      .from('stations')
      .select('id')
      .in('id', batch);
    
    (existingStations || []).forEach(s => existingIds.add(s.id));
  }
  
  const newStations = Array.from(allStations.values()).filter(s => !existingIds.has(s.id));
  
  console.log(`Stations already in DB: ${existingIds.size}`);
  console.log(`New stations to fetch: ${newStations.length}\n`);
  
  if (newStations.length === 0) {
    console.log('No new stations to fetch. Done!');
    await browser.close();
    return;
  }
  
  // Step 3: Fetch coordinates for new stations
  const stationsToSave = [];
  
  for (let i = 0; i < newStations.length; i++) {
    const station = newStations[i];
    console.log(`[${i + 1}/${newStations.length}] Fetching: ${station.name} (${station.id})`);
    
    const details = await scrapeStationDetails(browser, station.id);
    
    if (details && details.lat && details.lng) {
      stationsToSave.push({
        id: station.id,
        name: station.name,
        lat: details.lat,
        lng: details.lng,
        address: details.address || '',
        brand: station.name,
        updated_at: new Date().toISOString(),
      });
      console.log(`  ✓ Got coords: ${details.lat}, ${details.lng}`);
    } else {
      console.log(`  ✗ No coords found (might be blocked)`);
    }
    
    // Save batch every 25 stations
    if (stationsToSave.length >= 25) {
      const { error } = await supabase.from('stations').upsert(stationsToSave, { onConflict: 'id' });
      if (error) {
        console.log(`  DB error: ${error.message}`);
      } else {
        console.log(`\n--- Saved ${stationsToSave.length} stations to database ---\n`);
      }
      stationsToSave.length = 0;
    }
    
    // Random delay between station fetches (2-5 seconds)
    await delay(2000);
  }
  
  // Save remaining stations
  if (stationsToSave.length > 0) {
    const { error } = await supabase.from('stations').upsert(stationsToSave, { onConflict: 'id' });
    if (error) {
      console.log(`DB error: ${error.message}`);
    } else {
      console.log(`\nSaved final ${stationsToSave.length} stations to database`);
    }
  }
  
  await browser.close();
  
  // Final count
  const { count } = await supabase.from('stations').select('*', { count: 'exact', head: true });
  console.log(`\n========================================`);
  console.log(`DONE! Total stations in database: ${count}`);
  console.log(`========================================\n`);
}

populateDatabase().catch(console.error);
