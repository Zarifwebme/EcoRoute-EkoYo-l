/* ════════════════════════════════════════════════
   ECOROUTE — app.js
   LocationIQ autocomplete + Leaflet routing + CO2 calc
════════════════════════════════════════════════ */

'use strict';

/* ── CONFIG ──────────────────────────────────── */
const CONFIG = {
  locationiq_token: 'pk.dd29be8e115bde01a970198bcb579935',
  autocomplete_delay: 350,   // ms debounce
  min_chars: 2,              // min characters before search

  // CO2 koeffitsiyentlari (g/km) — universitetning haqiqiy ma'lumotlaridan
  // Car:  73 ta × 2 × 5km × 240kun × 0.02/100 = 35.04t  → 20 g/km
  // Bus:   4 ta × 50trip × 5km × 240kun × 0.01/100 = 2.4t → 10 g/km
  // Moto:  0 ta → 0 g/km
  // Bike:  emissiya yo'q   → 0 g/km
  co2: {
    car:        20,
    bus:        10,
    motorcycle:  0,
    bicycle:     0,
  },

  university_annual_ton: 1120.37,
};

/* ── STATE ───────────────────────────────────── */
const state = {
  startCoords:  null,   // { lat, lon, display_name }
  endCoords:    null,
  routeLine:    null,   // L.polyline
  markers:      [],
  activeTransport: 'car',
  distanceKm:   0,
  debounceTimers: { start: null, end: null },
};

/* ── ICONS ───────────────────────────────────── */
function makeIcon(color) {
  return L.divIcon({
    className: '',
    html: `<div style="
      width:20px;height:20px;
      background:${color};
      border:3px solid #fff;
      border-radius:50%;
      box-shadow:0 3px 10px rgba(0,0,0,.35);
    "></div>`,
    iconAnchor: [10, 10],
    iconSize:   [20, 20],
  });
}
const ICON_START = makeIcon('#22c55e');
const ICON_END   = makeIcon('#ef4444');

/* ════════════════════════════════════════════════
   MAP INIT
════════════════════════════════════════════════ */
// O'zbekiston chegarasi (SW, NE)
const UZ_BOUNDS = L.latLngBounds(
  L.latLng(37.18, 55.99),
  L.latLng(45.59, 73.13)
);

const map = L.map('map', {
  center: [41.2995, 69.2401],
  zoom: 6,
  zoomControl: true,
  maxBounds: UZ_BOUNDS,
  maxBoundsViscosity: 1.0,
  minZoom: 5,
});

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a>',
  maxZoom: 19,
}).addTo(map);

/* Map click — 2 nuqta tanlash (faqat O'zbekiston) */
map.on('click', function(e) {
  const { lat, lng } = e.latlng;

  // O'zbekiston chegarasidan tashqarida bo'lsa — e'tibor berma
  if (!UZ_BOUNDS.contains(e.latlng)) {
    showToast("Faqat O'zbekiston hududi tanlash mumkin", 'warning');
    return;
  }

  if (!state.startCoords) {
    setStart({ lat, lon: lng, display_name: `${lat.toFixed(5)}, ${lng.toFixed(5)}` });
    document.getElementById('startInput').value = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  } else if (!state.endCoords) {
    setEnd({ lat, lon: lng, display_name: `${lat.toFixed(5)}, ${lng.toFixed(5)}` });
    document.getElementById('endInput').value = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    buildRoute();
  }
  // 2 tadan keyin yangi tanlash uchun clearAll chaqirsin
});

/* ════════════════════════════════════════════════
   LOCATIONIQ AUTOCOMPLETE
════════════════════════════════════════════════ */
async function fetchSuggestions(query) {
  const url = `https://us1.locationiq.com/v1/autocomplete?`
    + `key=${CONFIG.locationiq_token}`
    + `&q=${encodeURIComponent(query)}`
    + `&limit=6`
    + `&dedupe=1`
    + `&countrycodes=uz`
    + `&format=json`;

  const res = await fetch(url);
  if (!res.ok) throw new Error('LocationIQ xatosi: ' + res.status);
  return await res.json();
}

function renderSuggestions(list, results) {
  list.innerHTML = '';
  if (!results || !results.length) {
    list.innerHTML = '<div class="ac-empty">Natija topilmadi</div>';
    list.classList.add('open');
    return;
  }
  results.forEach(item => {
    const div = document.createElement('div');
    div.className = 'ac-item';

    const typeIcon = getTypeIcon(item.type || item.class);
    const mainName = item.display_name.split(',')[0];
    const subName  = item.display_name.split(',').slice(1, 3).join(',').trim();

    div.innerHTML = `
      <i class="bi ${typeIcon} ac-item-icon"></i>
      <div>
        <div class="ac-item-text">${mainName}</div>
        ${subName ? `<div class="ac-item-sub">${subName}</div>` : ''}
      </div>
    `;
    div.addEventListener('mousedown', (e) => {
      e.preventDefault();
      list.dataset.selected = JSON.stringify({
        lat: parseFloat(item.lat),
        lon: parseFloat(item.lon),
        display_name: item.display_name,
      });
      list.dataset.fire = '1';
    });
    list.appendChild(div);
  });
  list.classList.add('open');
}

function getTypeIcon(type) {
  const icons = {
    amenity: 'bi-building',
    road:    'bi-sign-intersection',
    street:  'bi-sign-intersection',
    city:    'bi-buildings-fill',
    town:    'bi-buildings',
    village: 'bi-house-fill',
    place:   'bi-pin-map-fill',
  };
  return icons[type] || 'bi-geo-alt-fill';
}

function setupAutocomplete(inputId, suggestId, onSelect) {
  const input   = document.getElementById(inputId);
  const suggest = document.getElementById(suggestId);

  input.addEventListener('input', () => {
    const q = input.value.trim();
    clearTimeout(state.debounceTimers[inputId]);

    if (q.length < CONFIG.min_chars) {
      suggest.classList.remove('open');
      suggest.innerHTML = '';
      return;
    }

    // Show loading
    suggest.innerHTML = '<div class="ac-loading"><i class="bi bi-arrow-repeat"></i> Qidirilmoqda...</div>';
    suggest.classList.add('open');

    state.debounceTimers[inputId] = setTimeout(async () => {
      try {
        const results = await fetchSuggestions(q);
        renderSuggestions(suggest, results);
      } catch {
        suggest.innerHTML = '<div class="ac-empty">Xatolik yuz berdi. Qaytadan urinib ko\'ring.</div>';
      }
    }, CONFIG.autocomplete_delay);
  });

  // mousedown fires on suggest item (before blur on input)
  suggest.addEventListener('mousedown', (e) => {
    if (suggest.dataset.fire === '1') {
      const data = JSON.parse(suggest.dataset.selected);
      input.value = data.display_name.split(',')[0];
      suggest.classList.remove('open');
      suggest.innerHTML = '';
      delete suggest.dataset.fire;
      onSelect(data);
    }
  });

  input.addEventListener('blur', () => {
    setTimeout(() => {
      suggest.classList.remove('open');
    }, 200);
  });

  input.addEventListener('focus', () => {
    if (suggest.children.length > 0) suggest.classList.add('open');
  });

  // Keyboard navigation
  input.addEventListener('keydown', (e) => {
    const items = suggest.querySelectorAll('.ac-item');
    const active = suggest.querySelector('.ac-item.active');
    let idx = Array.from(items).indexOf(active);

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (active) active.classList.remove('active');
      const next = items[Math.min(idx + 1, items.length - 1)];
      if (next) { next.classList.add('active'); input.value = next.querySelector('.ac-item-text').textContent; }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (active) active.classList.remove('active');
      const prev = items[Math.max(idx - 1, 0)];
      if (prev) { prev.classList.add('active'); input.value = prev.querySelector('.ac-item-text').textContent; }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (active) active.dispatchEvent(new MouseEvent('mousedown'));
      else if (input.value.trim().length >= CONFIG.min_chars) {
        // direct search
        directGeocode(input.value.trim(), onSelect);
        suggest.classList.remove('open');
      }
    } else if (e.key === 'Escape') {
      suggest.classList.remove('open');
    }
  });
}

async function directGeocode(query, onSelect) {
  try {
    const url = `https://us1.locationiq.com/v1/search?`
      + `key=${CONFIG.locationiq_token}`
      + `&q=${encodeURIComponent(query)}`
      + `&format=json&limit=1`
      + `&countrycodes=uz`;
    const res  = await fetch(url);
    const data = await res.json();
    if (data && data[0]) onSelect({
      lat: parseFloat(data[0].lat),
      lon: parseFloat(data[0].lon),
      display_name: data[0].display_name,
    });
  } catch { /* silent */ }
}

/* ════════════════════════════════════════════════
   SET COORDS
════════════════════════════════════════════════ */
function setStart(coords) {
  state.startCoords = coords;
  // Remove old start marker
  state.markers = state.markers.filter(m => {
    if (m._isStart) { map.removeLayer(m); return false; }
    return true;
  });
  const m = L.marker([coords.lat, coords.lon], { icon: ICON_START, draggable: true })
    .addTo(map)
    .bindTooltip('Boshlanish', { permanent: false });
  m._isStart = true;
  m.on('dragend', () => {
    const ll = m.getLatLng();
    state.startCoords = { lat: ll.lat, lon: ll.lng, display_name: `${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}` };
    document.getElementById('startInput').value = state.startCoords.display_name;
    if (state.endCoords) buildRoute();
  });
  state.markers.push(m);
  updateMapStatus();
}

function setEnd(coords) {
  state.endCoords = coords;
  state.markers = state.markers.filter(m => {
    if (m._isEnd) { map.removeLayer(m); return false; }
    return true;
  });
  const m = L.marker([coords.lat, coords.lon], { icon: ICON_END, draggable: true })
    .addTo(map)
    .bindTooltip('Manzil', { permanent: false });
  m._isEnd = true;
  m.on('dragend', () => {
    const ll = m.getLatLng();
    state.endCoords = { lat: ll.lat, lon: ll.lng, display_name: `${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}` };
    document.getElementById('endInput').value = state.endCoords.display_name;
    if (state.startCoords) buildRoute();
  });
  state.markers.push(m);
  updateMapStatus();
}

/* ════════════════════════════════════════════════
   BUILD ROUTE — LocationIQ Directions API
════════════════════════════════════════════════ */
async function buildRoute() {
  if (!state.startCoords || !state.endCoords) return;
  showLoader();

  // Eski chiziqni o'chirish
  if (state.routeLine) {
    map.removeLayer(state.routeLine);
    state.routeLine = null;
  }

  const { lat: slat, lon: slon } = state.startCoords;
  const { lat: elat, lon: elon } = state.endCoords;

  // O'zbekiston chegarasini tekshirish
  if (!UZ_BOUNDS.contains(L.latLng(slat, slon)) || !UZ_BOUNDS.contains(L.latLng(elat, elon))) {
    hideLoader();
    showPlaceholder();
    showToast("Ikkala nuqta ham O'zbekiston ichida bo'lishi kerak", 'warning');
    return;
  }

  // LocationIQ Directions API (OSRM-based, driving)
  const url = `https://us1.locationiq.com/v1/directions/driving/`
    + `${slon},${slat};${elon},${elat}`
    + `?key=${CONFIG.locationiq_token}`
    + `&steps=false&geometries=geojson&overview=full`;

  try {
    const res  = await fetch(url);
    const data = await res.json();

    if (!data.routes || !data.routes.length) {
      throw new Error(data.message || 'Marshrut topilmadi');
    }

    const route    = data.routes[0];
    const km       = parseFloat((route.distance / 1000).toFixed(2));
    const minutes  = Math.round(route.duration / 60);
    const coords   = route.geometry.coordinates; // [ [lng,lat], ... ]

    // GeoJSON polyline — Leaflet uchun [lat,lng] ga aylantirish
    const latLngs = coords.map(c => [c[1], c[0]]);

    state.routeLine = L.polyline(latLngs, {
      color:   '#22c55e',
      weight:  5,
      opacity: .85,
      lineJoin: 'round',
      lineCap:  'round',
    }).addTo(map);

    // Fit map
    map.fitBounds(state.routeLine.getBounds(), { padding: [50, 50] });

    state.distanceKm = km;
    calcAndRender(km, minutes);

    // Footer
    const ri = document.getElementById('routeInfo');
    ri.textContent = `${km} km · ~${minutes} daqiqa`;
    ri.classList.remove('d-none');
    document.getElementById('mapStatus').classList.add('d-none');

  } catch (err) {
    hideLoader();
    showPlaceholder();
    setMapStatus(`⚠️ ${err.message || 'Marshrut topilmadi. Boshqa nuqta sinab ko\'ring.'}`);
    showToast(err.message || 'Marshrut topilmadi', 'error');
  }
}

/* ════════════════════════════════════════════════
   SEARCH ROUTE (button click)
════════════════════════════════════════════════ */
async function searchRoute() {
  const startVal = document.getElementById('startInput').value.trim();
  const endVal   = document.getElementById('endInput').value.trim();

  if (!startVal || !endVal) {
    showToast('Iltimos, ikkala manzilni ham kiriting', 'warning');
    return;
  }

  const btn = document.getElementById('routeBtn');
  btn.classList.add('loading');
  btn.innerHTML = '<i class="bi bi-arrow-repeat spin me-2"></i>Qidirilmoqda...';

  try {
    // Geocode both if not already set from autocomplete
    if (!state.startCoords || !document.getElementById('startInput').value.startsWith(state.startCoords?.display_name?.split(',')[0])) {
      await new Promise(resolve => directGeocode(startVal, (d) => { setStart(d); resolve(); }));
    }
    if (!state.endCoords || !document.getElementById('endInput').value.startsWith(state.endCoords?.display_name?.split(',')[0])) {
      await new Promise(resolve => directGeocode(endVal, (d) => { setEnd(d); resolve(); }));
    }

    if (state.startCoords && state.endCoords) {
      buildRoute();
    } else {
      showToast('Manzil topilmadi. Boshqacha yozing', 'error');
    }
  } finally {
    btn.classList.remove('loading');
    btn.innerHTML = '<i class="bi bi-signpost-2-fill"></i><span>Marshrut</span>';
  }
}

/* ════════════════════════════════════════════════
   CO2 CALCULATION
════════════════════════════════════════════════ */
function calcAndRender(km, minutes) {
  const annualG = CONFIG.university_annual_ton * 1_000_000;

  function calc(transport) {
    const g   = parseFloat((km * CONFIG.co2[transport]).toFixed(2));
    const kg  = parseFloat((g / 1000).toFixed(4));
    const pct = annualG ? parseFloat((g / annualG * 100).toFixed(6)) : 0;
    return { g, kg, pct };
  }

  const results = {
    car:        calc('car'),
    bus:        calc('bus'),
    motorcycle: calc('motorcycle'),
    bicycle:    calc('bicycle'),
  };

  const carG       = results.car.g;
  const savedByBike = parseFloat((carG - results.bicycle.g).toFixed(2));
  const maxG       = carG || 1;

  // --- Render ---
  hideLoader();
  document.getElementById('dashPlaceholder').style.display = 'none';
  const res = document.getElementById('dashResults');
  res.style.display = 'flex';

  // Distance
  document.getElementById('distVal').textContent  = km;
  document.getElementById('distTime').textContent = minutes ? `Taxminan ${minutes} daqiqa (avtomobil)` : '';

  // Car
  document.getElementById('carVal').textContent = results.car.g.toLocaleString();
  document.getElementById('carKg').textContent  = `≈ ${results.car.kg} kg CO₂`;

  // Bus
  document.getElementById('busVal').textContent = results.bus.g.toLocaleString();
  document.getElementById('busKg').textContent  = `≈ ${results.bus.kg} kg CO₂`;

  // Savings
  document.getElementById('savVal').textContent = savedByBike.toLocaleString();

  // Annual %
  document.getElementById('pctVal').textContent = results.car.pct.toFixed(4);

  // Progress bars — animate
  requestAnimationFrame(() => {
    setTimeout(() => {
      document.getElementById('carBar').style.width  = '100%';
      document.getElementById('busBar').style.width  = (results.bus.g / maxG * 100).toFixed(1) + '%';
    }, 80);
  });

  // Highlight active transport card
  highlightActiveCard();
}

function highlightActiveCard() {
  document.querySelectorAll('.co2-card').forEach(c => c.style.opacity = '.65');
  const active = document.getElementById(`card-${state.activeTransport}`);
  if (active) { active.style.opacity = '1'; active.style.transform = 'translateY(-4px)'; }
}

/* ════════════════════════════════════════════════
   TRANSPORT TABS
════════════════════════════════════════════════ */
document.querySelectorAll('.transport-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.transport-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    state.activeTransport = tab.dataset.mode;
    if (state.distanceKm > 0) highlightActiveCard();
  });
});

/* ════════════════════════════════════════════════
   SWAP BUTTON
════════════════════════════════════════════════ */
document.getElementById('swapBtn').addEventListener('click', () => {
  const sv = document.getElementById('startInput').value;
  const ev = document.getElementById('endInput').value;
  document.getElementById('startInput').value = ev;
  document.getElementById('endInput').value   = sv;
  const sc = state.startCoords;
  state.startCoords = state.endCoords;
  state.endCoords   = sc;
  if (state.startCoords && state.endCoords) buildRoute();
});

/* ════════════════════════════════════════════════
   CLEAR ALL
════════════════════════════════════════════════ */
function clearAll() {
  // Remove markers
  state.markers.forEach(m => map.removeLayer(m));
  state.markers = [];
  state.startCoords = null;
  state.endCoords   = null;
  state.distanceKm  = 0;

  // Remove route line
  if (state.routeLine) {
    map.removeLayer(state.routeLine);
    state.routeLine = null;
  }

  // Reset inputs
  document.getElementById('startInput').value = '';
  document.getElementById('endInput').value   = '';

  // Reset UI
  showPlaceholder();
  document.getElementById('routeInfo').classList.add('d-none');
  document.getElementById('mapStatus').classList.remove('d-none');
  setMapStatus('<i class="bi bi-cursor-fill me-1"></i> Manzil tanlash uchun xaritaga bosing');

  // Reset bars
  document.getElementById('carBar').style.width = '0%';
  document.getElementById('busBar').style.width = '0%';
}

/* ════════════════════════════════════════════════
   UI HELPERS
════════════════════════════════════════════════ */
function showLoader() {
  document.getElementById('dashPlaceholder').style.display = 'none';
  document.getElementById('dashResults').style.display     = 'none';
  document.getElementById('dashLoader').classList.add('on');
}
function hideLoader() {
  document.getElementById('dashLoader').classList.remove('on');
}
function showPlaceholder() {
  hideLoader();
  document.getElementById('dashResults').style.display     = 'none';
  document.getElementById('dashPlaceholder').style.display = 'block';
}
function setMapStatus(html) {
  document.getElementById('mapStatus').innerHTML = html;
}
function updateMapStatus() {
  if (!state.startCoords) {
    setMapStatus('<i class="bi bi-cursor-fill me-1"></i> Boshlang\'ich nuqta belgilandi — oxirgi nuqtani tanlang');
  } else if (!state.endCoords) {
    setMapStatus('<i class="bi bi-cursor-fill me-1"></i> Manzilni (oxirgi nuqta) belgilang');
  }
}

/* Toast notification */
function showToast(msg, type = 'info') {
  const colors = { info: '#22c55e', warning: '#f59e0b', error: '#ef4444' };
  const toast  = document.createElement('div');
  toast.style.cssText = `
    position:fixed; bottom:24px; left:50%; transform:translateX(-50%);
    background:${colors[type]}; color:#fff;
    padding:12px 24px; border-radius:99px;
    font-size:.85rem; font-weight:600;
    box-shadow:0 8px 24px rgba(0,0,0,.2);
    z-index:9999; animation:fadeUp .3s ease;
    font-family:'DM Sans',sans-serif;
  `;
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

/* ════════════════════════════════════════════════
   INIT AUTOCOMPLETE
════════════════════════════════════════════════ */
setupAutocomplete('startInput', 'startSuggest', (coords) => {
  setStart(coords);
  if (state.endCoords) buildRoute();
});

setupAutocomplete('endInput', 'endSuggest', (coords) => {
  setEnd(coords);
  if (state.startCoords) buildRoute();
});

/* CSS for spinning icon */
const style = document.createElement('style');
style.textContent = '.spin { animation: spin .7s linear infinite; display:inline-block; }';
document.head.appendChild(style);