// WebSocket connection
let socket;
let map;
let militaryLayer = null;
let militaryMarkers = {};
let missionData = null;
let aircraftMarkers = {};
let aircraftPaths = {};
// Cache last icon state for each marker to avoid recreating icons every update (reduces flicker)
let aircraftMarkerStates = {};
// Throttle aircraft list updates to avoid heavy re-renders
let lastAircraftListUpdateMs = 0;
const AIRCRAFT_LIST_MIN_UPDATE_MS = 250; // ms
// Keep stable DOM nodes for the live aircraft list to prevent flicker.
let aircraftListRenderMode = null;
let aircraftListCards = {};
// Airspace layer (airport control zones)
let airspaceLayer = null;
let airspaceVisible = false;
let isPlaying = false;
let currentTime = 0;
let playbackSpeed = 1;
let animationInterval = null;
// Temporary lock to ignore server time updates right after local playback start
let serverSyncLockUntil = 0; // performance.now() timestamp in ms
// Track last time (ms) we received server position for each aircraft
const lastServerUpdateMs = {};
// Track when we last applied a server time correction to avoid rapid small corrections
let lastServerTimeHandledMs = 0;

// Mission Editor State
let waypointMode = false;
let tempWaypoints = [];
let tempWaypointMarkers = [];
let aircraftCounter = 0;
// Preview markers for mission editor departure/arrival fields
let departurePreviewMarker = null;
let arrivalPreviewMarker = null;

// Conflict and Distance state
let showDistanceMatrix = true;
let activeConflicts = [];

// Constants
const DEFAULT_CRUISE_ALTITUDE = 3000;
const DEFAULT_ARRIVAL_ALTITUDE = 1000;
const DAY_START_HOUR = 7; // 07:00 UTC
const DAY_END_HOUR = 18;  // 18:00 UTC
const UI_LOCALE = 'en-US';
const uiNumberFormatter = new Intl.NumberFormat(UI_LOCALE);
const uiDateTimeFormatter = new Intl.DateTimeFormat(UI_LOCALE, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'UTC'
});
// If the server has updated an aircraft within this window, prefer server positions
const SERVER_IGNORE_WINDOW_MS = 3000;

// Helper: format seconds-since-midnight to HH:MM:SS UTC
function formatTimeOfDay(secondsSinceMidnight) {
    const s = Math.floor(secondsSinceMidnight || 0);
    const hh = Math.floor((s % 86400) / 3600).toString().padStart(2, '0');
    const mm = Math.floor((s % 3600) / 60).toString().padStart(2, '0');
    const ss = Math.floor(s % 60).toString().padStart(2, '0');
    return `${hh}:${mm}:${ss} UTC`;
}

function formatNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? uiNumberFormatter.format(num) : '0';
}

function formatDateTimeUTC(value) {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
    return `${uiDateTimeFormatter.format(date)} UTC`;
}

// Haversine distance (meters) between two lat/lon points
function haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000; // meters
    const toRad = (deg) => deg * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

// Compute implicit route times (seconds) for aircraft if not provided on waypoints.
// Uses aircraft.speed (knots) to estimate durations between waypoints.
function ensureRouteTimes(aircraft) {
    if (!aircraft || !aircraft.route || aircraft.route.length === 0) return;
    // If the first waypoint already has a .time property, assume times exist
    if (typeof aircraft.route[0].time === 'number') return;

    // Use speed in knots; fallback to 200 kts if missing
    const speedKts = (aircraft.speed && Number(aircraft.speed) > 0) ? Number(aircraft.speed) : 200;

    // Compute cumulative seconds starting at 0
    let cumulative = 0;
    for (let i = 0; i < aircraft.route.length; i++) {
        if (i === 0) {
            aircraft.route[i].time = 0;
            continue;
        }
        const prev = aircraft.route[i-1];
        const cur = aircraft.route[i];
        const meters = haversineMeters(prev.lat, prev.lon, cur.lat, cur.lon);
        const nm = meters / 1852; // nautical miles
        const hours = nm / speedKts;
        const secs = Math.max(1, Math.round(hours * 3600));
        cumulative += secs;
        aircraft.route[i].time = cumulative;
    }
}

// Airport lookup function
function getAirportCoordinates(icaoCode) {
    const code = icaoCode.toUpperCase().trim();
    return SWEDISH_AIRPORTS[code] || null;
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    initializeMap();
    initializeWebSocket();
    initializeControls();
    initializeMissionEditor();
    // Ensure separation/distance panels are visible by default
    try {
        const matrixEl = document.getElementById('distance-matrix');
        if (matrixEl) matrixEl.style.display = 'block';
        const toggleBtn = document.getElementById('toggle-distances-btn');
        if (toggleBtn) toggleBtn.style.display = 'none';
        const sepPanel = document.getElementById('separation-panel');
        if (sepPanel) sepPanel.style.display = '';
        const conflictPanel = document.getElementById('conflict-panel');
        if (conflictPanel) conflictPanel.style.display = '';
    } catch (e) {}
    // Style the native color input so only the chosen swatch is visible
    try {
        const colorInput = document.getElementById('aircraftColor');
        if (colorInput) {
            const setSwatch = () => { try { colorInput.style.backgroundColor = colorInput.value; } catch (e) {} };
            setSwatch();
            colorInput.addEventListener('input', setSwatch);
        }
    } catch (e) { /* ignore in older browsers */ }
});

// Initialize Leaflet map
function initializeMap() {
    // Center map over Sweden for the tactical view
    map = L.map('map').setView([59.3293, 18.0686], 6);

    const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors',
        maxZoom: 19
    }).addTo(map);

    const posLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; CartoDB',
        maxZoom: 19
    });

    const esriSat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Tiles &copy; Esri',
        maxZoom: 19
    });

    // Add simple basemap selector so users can switch to higher-contrast maps
    try {
        const baseMaps = {
            'OSM Standard': osmLayer,
            'CartoDB Voyager': posLayer,
            'Satellite (Esri)': esriSat
        };
        // keep a reference for adding custom layers later
        window.baseLayerControl = L.control.layers(baseMaps, {}, { position: 'topright' }).addTo(map);
    } catch (e) {
        // ignore if control fails
    }

    // layer to hold military airport markers (cleared/reused to avoid duplicates)
    militaryLayer = L.layerGroup().addTo(map);
    // map of current military markers keyed by ICAO code to avoid duplicates
    militaryMarkers = {};

    // Ensure any existing military markers are removed on startup
    map.whenReady(() => {
        // Clear any existing military markers then add simple circle markers
        removeMilitaryAirportMarkers();
        addMilitaryAirportCircles();
    });
}

// Place markers for the key military airports so they are visible on the map
function addMilitaryAirportMarkers() {
    if (!window.SWEDISH_AIRPORTS || !map) return;
    // Ensure the layer exists; always clear and re-sync to avoid duplicates
    if (!militaryLayer) militaryLayer = L.layerGroup().addTo(map);
    // Clear existing group and our tracking map so we start fresh
    militaryLayer.clearLayers();
    militaryMarkers = {};
    const militaryCodes = ['ESIB', 'ESDF', 'ESCM', 'ESCF', 'ESPE'];

    const coords = [];
    militaryCodes.forEach(code => {
        const airport = SWEDISH_AIRPORTS[code];
        if (!airport) return;

        // If we already had a marker for this code, remove it first (defensive)
        if (militaryMarkers[code]) {
            try {
                militaryLayer.removeLayer(militaryMarkers[code]);
            } catch (e) {
                // ignore
            }
            delete militaryMarkers[code];
        }

        const iconHtml = `
            <div style="display:flex;flex-direction:column;align-items:center;">
                <div style="width:18px;height:18px;border-radius:50%;background:#0033cc;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,0.4);"></div>
                <div style="background:rgba(0,0,0,0.7);color:#fff;padding:2px 6px;border-radius:4px;margin-top:4px;font-size:12px;white-space:nowrap;">${code}</div>
            </div>
        `;

        const icon = L.divIcon({ html: iconHtml, className: '', iconSize: [40, 40], iconAnchor: [20, 20] });
        // Add a standard marker at the exact lat/lon so it's unmistakable
        const marker = L.marker([airport.lat, airport.lon], { icon }).addTo(militaryLayer);
        marker.bindPopup(`<strong>${code}</strong><br>${airport.name}`);
        // Add a permanent tooltip (label) so marker is visible at a glance
        marker.bindTooltip(code, { permanent: true, direction: 'right', className: 'airport-tooltip' }).openTooltip();

        // Track by code to avoid duplicates on subsequent calls
        militaryMarkers[code] = marker;
        coords.push([airport.lat, airport.lon]);
    });

    // If military markers were added, fit map to show them
    if (coords.length > 0) {
        try {
            const bounds = L.latLngBounds(coords);
            map.fitBounds(bounds.pad(0.5), { padding: [50, 50] });
            // Also pan to first marker to ensure visibility
            map.panTo(coords[0]);
        } catch (e) {
            // ignore
        }
        // Completed marker placement; function is idempotent so repeated calls are safe
    }
}

// Remove all military airport markers (safe to call repeatedly)
function removeMilitaryAirportMarkers() {
    try {
        if (militaryLayer) {
            militaryLayer.clearLayers();
        }
    } catch (e) {
        // ignore
    }
    militaryMarkers = {};
}

// Add simple circle markers for the military airports
function addMilitaryAirportCircles() {
    if (!window.SWEDISH_AIRPORTS || !map) return;
    if (!militaryLayer) militaryLayer = L.layerGroup().addTo(map);

    // Clear and rebuild so repeated calls are idempotent
    militaryLayer.clearLayers();
    militaryMarkers = {};

    const militaryCodes = ['ESIB', 'ESDF', 'ESCM', 'ESCF', 'ESPE'];
    const coords = [];

    militaryCodes.forEach(code => {
        const airport = SWEDISH_AIRPORTS[code];
        if (!airport || !airport.lat || !airport.lon) return;

        const circle = L.circleMarker([airport.lat, airport.lon], {
            radius: 6,
            color: '#0033cc',
            fillColor: '#0033cc',
            fillOpacity: 0.9,
            weight: 2
        }).addTo(militaryLayer);

        // No permanent label; keep a popup for details on click
        circle.bindPopup(`<strong>${code}</strong><br>${airport.name}`);

        militaryMarkers[code] = circle;
        coords.push([airport.lat, airport.lon]);
    });

    if (coords.length > 0) {
        try {
            const bounds = L.latLngBounds(coords);
            map.fitBounds(bounds.pad(0.5), { padding: [50, 50] });
        } catch (e) {
            // ignore
        }
    }
}

// Add guaranteed default Leaflet markers (with default icon) for debugging/visibility
// Debug markers removed — production markers handled via `addMilitaryAirportMarkers()`

// Initialize WebSocket connection
function initializeWebSocket() {
    socket = io();
    
    socket.on('connect', () => {
        console.log('Connected to server');
        updateConnectionStatus(true);
        socket.emit('request-mission');
    });
    
    socket.on('disconnect', () => {
        console.log('Disconnected from server');
        updateConnectionStatus(false);
    });
    
    socket.on('mission-data', (data) => {
        console.log('Received mission data:', data);
        missionData = data;
        initializeMission();
    });
    
    socket.on('simulation-update', (data) => {
        // If we recently started playback locally, temporarily ignore server time/positions
        const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        const locked = serverSyncLockUntil && now < serverSyncLockUntil;

        // If server provides mission elapsed seconds, reconcile with our local time
        const serverElapsedSeconds = typeof data.elapsedSeconds === 'number'
            ? data.elapsedSeconds
            : (typeof data.time === 'number' ? data.time : null);
        if (serverElapsedSeconds !== null) {
            if (!locked) {
                const serverTime = serverElapsedSeconds;
                try {
                    const nowMs = Date.now();
                    // If client is not currently playing, follow server exactly and mark handled
                    if (!isPlaying) {
                        currentTime = serverTime;
                        lastServerTimeHandledMs = nowMs;
                    } else {
                        // When playing, rate-limit corrections to avoid rapid small nudges that cause flicker
                        const sinceLast = nowMs - (lastServerTimeHandledMs || 0);
                        if (sinceLast > 800) {
                            const diff = serverTime - currentTime;
                            const absDiff = Math.abs(diff);
                            if (absDiff > 10) {
                                // server is far ahead/behind — snap to server time
                                currentTime = serverTime;
                            } else {
                                // small difference — nudge towards server time (10% of gap)
                                currentTime += diff * 0.1;
                            }
                            lastServerTimeHandledMs = nowMs;
                        }
                    }
                } catch (e) {}
                updateTimeDisplay();
            }
        } else {
            if (!locked) updateTimeDisplay(data.time);
        }

        // If locked, skip updating positions and derived UI that would conflict with local playback
        if (locked) return;

        // Record server timestamps for per-aircraft updates and forward positions
        if (Array.isArray(data.aircraft)) {
            const nowMs = Date.now();
            data.aircraft.forEach(ac => { if (ac && ac.id) lastServerUpdateMs[ac.id] = nowMs; });
        }
        updateAircraftPositions(data.aircraft);
        updateConflictAlerts(data.conflicts || []);
        if (showDistanceMatrix) {
            updateDistanceMatrix(data.distances || []);
        }
        if (data.separations) {
            updateSeparationMonitor(data.separations);
        }
        updateAircraftList(data.aircraft);
    });
    
    socket.on('message-data', (data) => {
        updateAircraftDisplay(data.aircraft);
        
        // Update conflicts if present
        if (data.conflicts) {
            updateConflictAlerts(data.conflicts);
        }
        
        // Update distances if present
        if (data.distances) {
            if (showDistanceMatrix) {
                updateDistanceMatrix(data.distances);
            }
        }
    });
    
    // Handle mission editor responses
    socket.on('mission-saved', (data) => {
        console.log('Mission saved data:', data);
        downloadMissionFile(data);
    });
    
    socket.on('error', (error) => {
        console.error('Server error:', error);
        alert('Error: ' + error.message);
    });
}

// Initialize controls
function initializeControls() {
    // Connect original buttons to simulation engine
    document.getElementById('playBtn').addEventListener('click', startSimulation);
    document.getElementById('pauseBtn').addEventListener('click', pauseSimulation);
    document.getElementById('resetBtn').addEventListener('click', resetSimulation);
    
    const speedControl = document.getElementById('speedControl');
    speedControl.addEventListener('input', (e) => {
        const requestedSpeed = Number.parseFloat(e.target.value);
        playbackSpeed = Number.isFinite(requestedSpeed) ? requestedSpeed : 1;
        document.getElementById('speedValue').textContent = `${playbackSpeed}x`;
        
        // Update simulation speed if simulation is running
        socket.emit('set-simulation-speed', { speed: playbackSpeed });
    });
    
    // Initialize speed preset buttons
    const speedButtons = document.querySelectorAll('.speed-btn');
    speedButtons.forEach(btn => {
        btn.addEventListener('click', (e) => {
            const speed = parseFloat(e.target.dataset.speed);
            
            // Update speed
            playbackSpeed = speed;
            document.getElementById('speedValue').textContent = `${speed}x`;
            document.getElementById('speedControl').value = String(speed);
            
            // Update active button
            speedButtons.forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            
            // Update simulation speed if simulation is running
            socket.emit('set-simulation-speed', { speed: playbackSpeed });
        });
    });
    // Add airspace toggle control
    try { addAirspaceControl(); } catch (e) {}
    // Add custom tile control (satellite / aviation tiles)
    try { addCustomTileControl(); } catch (e) {}
}

// Simulation control functions
function startSimulation() {
    // Send desired start time so server can start from current local timeline
    try { socket.emit('start-simulation', { speed: playbackSpeed, startTime: currentTime }); } catch (e) {}
    // Also start local playback immediately from currentTime
    try { play(); } catch (e) {}
    // Lock out incoming server updates briefly so client playback doesn't get immediately overwritten
    try { serverSyncLockUntil = (typeof performance !== 'undefined' && performance.now) ? performance.now() + 3000 : Date.now() + 3000; } catch (e) {}
    document.getElementById('playBtn').disabled = true;
    document.getElementById('pauseBtn').disabled = false;
}

function pauseSimulation() {
    socket.emit('pause-simulation');
    try { pause(); } catch (e) {}
    document.getElementById('playBtn').disabled = false;
    document.getElementById('pauseBtn').disabled = true;
    // Clear any server-sync lock so incoming updates resume immediately
    serverSyncLockUntil = 0;
}

function resetSimulation() {
    // Tell server to reset simulation and also reset UI immediately
    try {
        socket.emit('reset-simulation');
    } catch (e) {}
    // Reset local playback state and UI
    try {
        reset();
    } catch (e) {}
    document.getElementById('playBtn').disabled = false;
    document.getElementById('pauseBtn').disabled = true;
    // Clear lock to let server set UI back to baseline
    serverSyncLockUntil = 0;
}

// Update connection status indicator
function updateConnectionStatus(connected) {
    const statusEl = document.getElementById('connectionStatus');
    if (connected) {
        statusEl.textContent = '🟢 Connected';
        statusEl.className = 'status-connected';
    } else {
        statusEl.textContent = '🔴 Disconnected';
        statusEl.className = 'status-disconnected';
    }
}

// Initialize mission with aircraft
function initializeMission() {
    if (!missionData || !missionData.aircraft) return;
    
    // Clear existing markers and paths
    Object.values(aircraftMarkers).forEach(marker => map.removeLayer(marker));
    Object.values(aircraftPaths).forEach(path => map.removeLayer(path));
    aircraftMarkers = {};
    aircraftPaths = {};
    
    // Create aircraft markers and paths
    missionData.aircraft.forEach(aircraft => {
        // Ensure route waypoints have time fields (compute from speed/distance if missing)
        try { ensureRouteTimes(aircraft); } catch (e) { /* ignore */ }
        // Create path polyline
        const routeCoords = aircraft.route.map(point => [point.lat, point.lon]);
        const path = L.polyline(routeCoords, {
            color: aircraft.color,
            weight: 3,
            opacity: 0.6,
            dashArray: '5, 10'
        }).addTo(map);
        aircraftPaths[aircraft.id] = path;
        
        // Create aircraft marker
        const startPos = aircraft.route[0];
                    const initialIconHtml = `
                            <div class="ac-icon" style="position: relative; width: 140px; height: 44px;">
                                <div class="ac-rot" style="position: absolute; left: 50%; transform: translateX(-50%); top: -15px;">
                                    <svg width="20" height="20" viewBox="0 0 20 20" style="transform: rotate(${aircraft.heading || 0}deg);">
                                        <polygon points="10,0 0,20 20,20" fill="${aircraft.color}" />
                                    </svg>
                                </div>
                                <div class="ac-labels" style="position: absolute; left: 50%; transform: translateX(-50%); top: 22px; display:flex; align-items:center; gap:8px; font-size:10px; white-space:nowrap;">
                                    <div class="ac-callsign" style="font-weight:700; color:#111;">${aircraft.callsign}</div>
                                    <div class="ac-alt" style="font-size:10px; color:#555;">FL${String(Math.round(startPos.alt/100)).padStart(3,'0')}</div>
                                    <div class="ac-vs" style="font-size:10px; color:#555; margin-left:4px;"></div>
                                </div>
                            </div>
                        `;

                const marker = L.marker([startPos.lat, startPos.lon], {
            icon: L.divIcon({ className: 'aircraft-marker', html: initialIconHtml, iconSize: [140, 44], iconAnchor: [70, 0] })
        }).addTo(map);
        
        marker.bindPopup(buildLegacyPopupContent(aircraft, startPos));
        
        aircraftMarkers[aircraft.id] = marker;
        // Store initial icon state to avoid redundant icon replacements
        try {
            const flightLevel = Math.round(startPos.alt / 100);
            const altDisplay = `FL${String(flightLevel).padStart(3, '0')}`;
            aircraftMarkerStates[aircraft.id] = {
                heading: aircraft.heading || 0,
                color: aircraft.color,
                callsign: aircraft.callsign,
                altDisplay: altDisplay
            };
        } catch (e) {}
    });
    
    // Fit map to show all routes
    const allCoords = missionData.aircraft.flatMap(aircraft => 
        aircraft.route.map(point => [point.lat, point.lon])
    );
    if (allCoords.length > 0) {
        // Include military airport markers so they remain visible
        try {
            const militaryCodes = ['ESIB', 'ESDF', 'ESCM', 'ESCF', 'ESPE'];
            militaryCodes.forEach(code => {
                const ap = SWEDISH_AIRPORTS && SWEDISH_AIRPORTS[code];
                if (ap && ap.lat && ap.lon) allCoords.push([ap.lat, ap.lon]);
            });
        } catch (e) {
            // ignore if SWEDISH_AIRPORTS not available
        }

        map.fitBounds(allCoords, { padding: [50, 50] });
    }
    
    // Update aircraft list
                updateAircraftList({ _force: true });
    
    // Reset time (mission-relative seconds)
    currentTime = 0;
    updateTimeDisplay();
}

function estimateAircraftEndTime(aircraft) {
    if (!aircraft || !aircraft.startTime || !Array.isArray(aircraft.route) || aircraft.route.length < 2) {
        return '-';
    }

    const startDate = new Date(aircraft.startTime);
    if (Number.isNaN(startDate.getTime())) return '-';

    const lastPoint = aircraft.route[aircraft.route.length - 1];
    const routeEndSec = Number(lastPoint && lastPoint.time);
    if (Number.isFinite(routeEndSec) && routeEndSec >= 0) {
        return formatDateTimeUTC(new Date(startDate.getTime() + routeEndSec * 1000));
    }

    const speed = Number(aircraft.speed);
    if (!(Number.isFinite(speed) && speed > 0)) return '-';

    let totalNm = 0;
    for (let i = 0; i < aircraft.route.length - 1; i++) {
        const p1 = aircraft.route[i];
        const p2 = aircraft.route[i + 1];
        const meters = haversineMeters(p1.lat, p1.lon, p2.lat, p2.lon);
        totalNm += meters / 1852;
    }
    if (totalNm <= 0) return '-';

    const hours = totalNm / speed;
    return formatDateTimeUTC(new Date(startDate.getTime() + hours * 3600 * 1000));
}

function createLiveAircraftCard(aircraftId) {
    const el = document.createElement('div');
    el.className = 'aircraft-card';
    el.dataset.aircraftId = aircraftId || '';
    el.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;">
            <div style="display:flex;align-items:center;gap:10px;flex:1;">
                <div style="flex:1;">
                    <div style="display:flex;align-items:center;gap:8px;">
                        <div class="aircraft-color js-card-color" style="width:16px;height:16px;border-radius:50%;border:2px solid white;"></div>
                        <div class="aircraft-callsign js-card-callsign"></div>
                    </div>
                    <div class="js-card-status" style="font-size:11px;color:#95a5a6;"></div>
                    <div class="altitude-display js-card-altitude-wrap">
                        <span class="altitude-indicator js-card-vsi">►</span>
                        <span class="altitude-value js-card-altitude-main">-</span>
                        <span class="js-card-vsrate" style="font-size:10px;display:none;"></span>
                    </div>
                    <div style="font-size:11px;color:#888;margin-top:2px;">
                        <span><b>Start:</b> <span class="js-card-start">-</span></span><br/>
                        <span><b>End:</b> <span class="js-card-end">-</span></span>
                    </div>
                    <div style="font-size:11px;color:#888;margin-top:2px;">
                        <span><b>Lat:</b> <span class="js-card-lat">-</span></span>
                        <span><b>Lon:</b> <span class="js-card-lon">-</span></span><br/>
                        <span><b>Alt:</b> <span class="js-card-alt">-</span></span>
                        <span><b>Hdg:</b> <span class="js-card-hdg">-</span></span><br/>
                        <span><b>Speed:</b> <span class="js-card-speed">-</span></span>
                    </div>
                    <div style="font-size:11px;color:#666;margin-top:6px;">
                        <span><b>Dep:</b> <span class="js-card-dep">-</span></span>
                        <span style="margin-left:12px;"><b>Arr:</b> <span class="js-card-arr">-</span></span>
                    </div>
                </div>
            </div>
            <button class="delete-btn js-card-delete" title="Delete">✖</button>
        </div>
    `;

    const refs = {
        el: el,
        colorEl: el.querySelector('.js-card-color'),
        callsignEl: el.querySelector('.js-card-callsign'),
        statusEl: el.querySelector('.js-card-status'),
        altitudeWrapEl: el.querySelector('.js-card-altitude-wrap'),
        vsiEl: el.querySelector('.js-card-vsi'),
        altitudeMainEl: el.querySelector('.js-card-altitude-main'),
        vsRateEl: el.querySelector('.js-card-vsrate'),
        startEl: el.querySelector('.js-card-start'),
        endEl: el.querySelector('.js-card-end'),
        latEl: el.querySelector('.js-card-lat'),
        lonEl: el.querySelector('.js-card-lon'),
        altEl: el.querySelector('.js-card-alt'),
        hdgEl: el.querySelector('.js-card-hdg'),
        speedEl: el.querySelector('.js-card-speed'),
        depEl: el.querySelector('.js-card-dep'),
        arrEl: el.querySelector('.js-card-arr'),
        deleteBtn: el.querySelector('.js-card-delete')
    };

    if (refs.deleteBtn) {
        refs.deleteBtn.addEventListener('click', () => {
            const id = refs.el && refs.el.dataset ? refs.el.dataset.aircraftId : '';
            if (id) deleteAircraft(id);
        });
    }

    return refs;
}

function updateLiveAircraftCard(refs, aircraft) {
    if (!refs || !aircraft) return;

    refs.el.dataset.aircraftId = aircraft.id || '';
    if (refs.colorEl) refs.colorEl.style.backgroundColor = aircraft.color || '#666';
    if (refs.callsignEl) refs.callsignEl.textContent = aircraft.callsign || aircraft.id || 'Unknown';
    if (refs.statusEl) refs.statusEl.textContent = (aircraft.position && aircraft.position.active) ? 'Active' : 'Waiting';

    const altitude = Number(aircraft.altitude);
    const verticalSpeed = Number(aircraft.verticalSpeed) || 0;
    const hasAltitude = Number.isFinite(altitude) && altitude > 0;

    if (refs.altitudeWrapEl) refs.altitudeWrapEl.style.display = hasAltitude ? '' : 'none';
    if (hasAltitude && refs.altitudeMainEl) refs.altitudeMainEl.textContent = `${formatNumber(altitude)} ft`;
    if (hasAltitude && refs.vsiEl) {
        refs.vsiEl.classList.remove('climbing', 'descending', 'level');
        if (verticalSpeed > 100) {
            refs.vsiEl.classList.add('climbing');
            refs.vsiEl.textContent = '▲';
        } else if (verticalSpeed < -100) {
            refs.vsiEl.classList.add('descending');
            refs.vsiEl.textContent = '▼';
        } else {
            refs.vsiEl.classList.add('level');
            refs.vsiEl.textContent = '►';
        }
    }
    if (refs.vsRateEl) {
        if (hasAltitude && Math.abs(verticalSpeed) > 100) {
            refs.vsRateEl.style.display = '';
            refs.vsRateEl.textContent = `(${verticalSpeed > 0 ? '+' : ''}${Math.round(verticalSpeed)} ft/min)`;
        } else {
            refs.vsRateEl.style.display = 'none';
            refs.vsRateEl.textContent = '';
        }
    }

    if (refs.startEl) refs.startEl.textContent = formatDateTimeUTC(aircraft.startTime);
    if (refs.endEl) refs.endEl.textContent = estimateAircraftEndTime(aircraft);

    const lat = aircraft.position ? Number(aircraft.position.lat) : NaN;
    const lon = aircraft.position ? Number(aircraft.position.lon) : NaN;
    const hdg = aircraft.position ? Number(aircraft.position.heading) : NaN;
    const speed = Number(aircraft.speed);

    if (refs.latEl) refs.latEl.textContent = Number.isFinite(lat) ? lat.toFixed(4) : '-';
    if (refs.lonEl) refs.lonEl.textContent = Number.isFinite(lon) ? lon.toFixed(4) : '-';
    if (refs.altEl) refs.altEl.textContent = hasAltitude ? `${formatNumber(altitude)} ft` : '-';
    if (refs.hdgEl) refs.hdgEl.textContent = Number.isFinite(hdg) ? `${Math.round(hdg)}°` : '-';
    if (refs.speedEl) refs.speedEl.textContent = Number.isFinite(speed) ? `${Math.round(speed)} kts` : '-';
    if (refs.depEl) refs.depEl.textContent = aircraft.departure || '-';
    if (refs.arrEl) refs.arrEl.textContent = aircraft.arrival || '-';
}

// Update aircraft list in info panel
function updateAircraftList(aircraftArray) {
    const nowMs = Date.now();
    const forced = (aircraftArray && aircraftArray._force) || false;
    if (!forced && (nowMs - lastAircraftListUpdateMs) < AIRCRAFT_LIST_MIN_UPDATE_MS) return;
    lastAircraftListUpdateMs = nowMs;

    const listEl = document.getElementById('aircraftList');
    if (!listEl) return;

    // Live simulation data path: update cards in-place to avoid flicker.
    if (aircraftArray && Array.isArray(aircraftArray)) {
        if (aircraftListRenderMode !== 'live') {
            aircraftListRenderMode = 'live';
            aircraftListCards = {};
            listEl.innerHTML = '';
        }

        if (aircraftArray.length === 0) {
            aircraftListCards = {};
            listEl.innerHTML = '<div class="no-aircraft">No active aircraft</div>';
            return;
        }

        if (listEl.querySelector('.no-aircraft')) listEl.innerHTML = '';

        aircraftArray.forEach(a => { try { ensureRouteTimes(a); } catch (e) {} });

        const seenIds = new Set();
        let insertIndex = 0;
        aircraftArray.forEach(ac => {
            if (!ac || !ac.id) return;
            seenIds.add(ac.id);

            let refs = aircraftListCards[ac.id];
            if (!refs) {
                refs = createLiveAircraftCard(ac.id);
                aircraftListCards[ac.id] = refs;
            }

            updateLiveAircraftCard(refs, ac);

            const existingAtIndex = listEl.children[insertIndex];
            if (existingAtIndex !== refs.el) {
                listEl.insertBefore(refs.el, existingAtIndex || null);
            }
            insertIndex += 1;
        });

        Object.keys(aircraftListCards).forEach(id => {
            if (seenIds.has(id)) return;
            const refs = aircraftListCards[id];
            if (refs && refs.el && refs.el.parentNode === listEl) refs.el.parentNode.removeChild(refs.el);
            delete aircraftListCards[id];
        });

        if (insertIndex === 0) {
            aircraftListCards = {};
            listEl.innerHTML = '<div class="no-aircraft">No active aircraft</div>';
        }
        return;
    }

    // Legacy mission data path
    if (aircraftListRenderMode !== 'legacy') {
        aircraftListRenderMode = 'legacy';
        aircraftListCards = {};
    }

    if (!missionData || !missionData.aircraft) {
        listEl.innerHTML = '<p>No aircraft data available</p>';
        return;
    }

    listEl.innerHTML = missionData.aircraft.map(aircraft => {
        const currentPos = getCurrentPosition(aircraft, currentTime);
        return `
            <div class="aircraft-card ${isPlaying ? 'active' : ''}">
                <div class="aircraft-header">
                    <div class="aircraft-color" style="background-color: ${aircraft.color};"></div>
                    <span class="aircraft-callsign">${aircraft.callsign}</span>
                    <span class="aircraft-type">(${aircraft.type || 'Custom'})</span>
                </div>
                <div class="aircraft-info">
                    <span class="label">Latitude:</span>
                    <span class="value">${currentPos.lat.toFixed(4)}°</span>
                    <span class="label">Longitude:</span>
                    <span class="value">${currentPos.lon.toFixed(4)}°</span>
                    <span class="label">Altitude:</span>
                    <span class="value">${currentPos.alt} ft</span>
                    <span class="label">Speed:</span>
                    <span class="value">${aircraft.speed || '-'} kts</span>
                    <span class="label">Status:</span>
                    <span class="value">${currentTime >= getMaxTime(aircraft) ? 'Complete' : 'In Flight'}</span>
                    <div style="font-size:11px;color:#666;margin-top:6px;">
                        <span><b>Dep:</b> ${aircraft.departure || '-'}</span>
                        <span style="margin-left:12px;"><b>Arr:</b> ${aircraft.arrival || '-'}</span>
                    </div>
                </div>
                <button class="delete-btn" onclick="deleteAircraft('${aircraft.id}')" title="Delete">✖</button>
            </div>
        `;
    }).join('');
}

// Get current position of aircraft at given time (with interpolation)
function getCurrentPosition(aircraft, time) {
    const route = aircraft.route;
    
    // If time is before first waypoint
    if (time <= route[0].time) {
        return route[0];
    }
    
    // If time is after last waypoint
    if (time >= route[route.length - 1].time) {
        return route[route.length - 1];
    }
    
    // Find the two waypoints to interpolate between
    for (let i = 0; i < route.length - 1; i++) {
        if (time >= route[i].time && time <= route[i + 1].time) {
            const t1 = route[i].time;
            const t2 = route[i + 1].time;
            const ratio = (time - t1) / (t2 - t1);
            
            return {
                lat: route[i].lat + (route[i + 1].lat - route[i].lat) * ratio,
                lon: route[i].lon + (route[i + 1].lon - route[i].lon) * ratio,
                alt: Math.round(route[i].alt + (route[i + 1].alt - route[i].alt) * ratio)
            };
        }
    }
    
    return route[route.length - 1];
}

// Get maximum time for aircraft route
function getMaxTime(aircraft) {
    return aircraft.route[aircraft.route.length - 1].time;
}

// Play animation
function play() {
    if (!missionData) return;
    
    isPlaying = true;
    document.getElementById('playBtn').disabled = true;
    document.getElementById('pauseBtn').disabled = false;
    
    // Advance time in 1s ticks
    animationInterval = setInterval(() => {
        currentTime += 1 * playbackSpeed;

        // Stop if mission route completed or we've passed the configured day end
        const maxTime = Math.max(...missionData.aircraft.map(getMaxTime));
        if (currentTime >= maxTime || (DAY_START_HOUR * 3600 + currentTime) > (DAY_END_HOUR * 3600)) {
            pause();
            return;
        }
        
        updateAircraftPositions();
        updateTimeDisplay();
        updateAircraftList();
    }, 1000);
}

// Pause animation
function pause() {
    isPlaying = false;
    document.getElementById('playBtn').disabled = false;
    document.getElementById('pauseBtn').disabled = true;
    
    if (animationInterval) {
        clearInterval(animationInterval);
        animationInterval = null;
    }
}

// Reset animation
function reset() {
    pause();
    currentTime = 0;
    updateAircraftPositions();
    updateTimeDisplay();
    updateAircraftList({ _force: true });
}

function buildAircraftPopupContent(aircraft) {
    return `
        <div class="aircraft-popup">
          <div class="popup-header" style="background-color: ${aircraft.color}">
            <strong class="js-popup-callsign">${aircraft.callsign}</strong>
          </div>
          <div class="popup-body">
            <div class="popup-row">
              <span class="popup-label">Altitude:</span>
              <span class="popup-value js-popup-altitude">${formatNumber(aircraft.altitude || 0)} ft</span>
            </div>
            <div class="popup-row">
              <span class="popup-label">Speed:</span>
              <span class="popup-value js-popup-speed">${aircraft.speed || 0} kts</span>
            </div>
            <div class="popup-row">
              <span class="popup-label">Heading:</span>
              <span class="popup-value js-popup-heading">${aircraft.heading || 0}°</span>
            </div>
            <div class="popup-row js-popup-from-row" style="${aircraft.departure ? '' : 'display:none;'}">
              <span class="popup-label">From:</span>
              <span class="popup-value js-popup-from">${aircraft.departure || ''}</span>
            </div>
            <div class="popup-row js-popup-to-row" style="${aircraft.arrival ? '' : 'display:none;'}">
              <span class="popup-label">To:</span>
              <span class="popup-value js-popup-to">${aircraft.arrival || ''}</span>
            </div>
          </div>
        </div>
    `;
}

function updateAircraftPopupDom(marker, aircraft) {
    try {
        const popup = marker && marker.getPopup && marker.getPopup();
        if (!popup) return false;

        const popupEl = popup.getElement && popup.getElement();
        if (!popupEl) return false;

        const callsignEl = popupEl.querySelector('.js-popup-callsign');
        const altitudeEl = popupEl.querySelector('.js-popup-altitude');
        const speedEl = popupEl.querySelector('.js-popup-speed');
        const headingEl = popupEl.querySelector('.js-popup-heading');
        const fromRow = popupEl.querySelector('.js-popup-from-row');
        const fromEl = popupEl.querySelector('.js-popup-from');
        const toRow = popupEl.querySelector('.js-popup-to-row');
        const toEl = popupEl.querySelector('.js-popup-to');
        const headerEl = popupEl.querySelector('.popup-header');

        if (callsignEl) callsignEl.textContent = aircraft.callsign || '';
        if (altitudeEl) altitudeEl.textContent = `${formatNumber(aircraft.altitude || 0)} ft`;
        if (speedEl) speedEl.textContent = `${aircraft.speed || 0} kts`;
        if (headingEl) headingEl.textContent = `${aircraft.heading || 0}°`;
        if (headerEl && aircraft.color) headerEl.style.backgroundColor = aircraft.color;

        if (fromRow) fromRow.style.display = aircraft.departure ? '' : 'none';
        if (fromEl) fromEl.textContent = aircraft.departure || '';
        if (toRow) toRow.style.display = aircraft.arrival ? '' : 'none';
        if (toEl) toEl.textContent = aircraft.arrival || '';

        return true;
    } catch (e) {
        return false;
    }
}

function buildLegacyPopupContent(aircraft, pos) {
    return `
        <div class="popup-aircraft-info">
            <h4 class="js-legacy-callsign">${aircraft.callsign}</h4>
            <p><strong>Type:</strong> <span class="js-legacy-type">${aircraft.type}</span></p>
            <p><strong>Altitude:</strong> <span class="js-legacy-alt">${formatNumber(pos.alt)} ft</span></p>
            <p><strong>Position:</strong> <span class="js-legacy-pos">${pos.lat.toFixed(4)}, ${pos.lon.toFixed(4)}</span></p>
            <p><strong>Time:</strong> <span class="js-legacy-time">${currentTime.toFixed(1)}s</span></p>
        </div>
    `;
}

function updateLegacyPopupDom(marker, aircraft, pos) {
    try {
        const popup = marker && marker.getPopup && marker.getPopup();
        if (!popup) return false;
        const popupEl = popup.getElement && popup.getElement();
        if (!popupEl) return false;

        const callsignEl = popupEl.querySelector('.js-legacy-callsign');
        const typeEl = popupEl.querySelector('.js-legacy-type');
        const altEl = popupEl.querySelector('.js-legacy-alt');
        const posEl = popupEl.querySelector('.js-legacy-pos');
        const timeEl = popupEl.querySelector('.js-legacy-time');

        if (callsignEl) callsignEl.textContent = aircraft.callsign || '';
        if (typeEl) typeEl.textContent = aircraft.type || 'Custom';
        if (altEl) altEl.textContent = `${formatNumber(pos.alt)} ft`;
        if (posEl) posEl.textContent = `${pos.lat.toFixed(4)}, ${pos.lon.toFixed(4)}`;
        if (timeEl) timeEl.textContent = `${currentTime.toFixed(1)}s`;

        return true;
    } catch (e) {
        return false;
    }
}

// Update aircraft positions on map
function updateAircraftPositions(aircraftData) {
    // Handle array of aircraft data (for simulation-update)
    if (Array.isArray(aircraftData)) {
        aircraftData.forEach(aircraft => {
            if (!aircraft.position || !aircraft.position.active) return;

            const { lat, lon } = aircraft.position;
            const key = aircraft.id;

            // Create or update marker
            if (!aircraftMarkers[key]) {
                // Determine vertical speed indicator
                let vspeedIndicator = '►';
                if (aircraft.verticalSpeed > 100) {
                    vspeedIndicator = '▲';
                } else if (aircraft.verticalSpeed < -100) {
                    vspeedIndicator = '▼';
                }
                
                // Create altitude display
                const flightLevel = Math.round(aircraft.altitude / 100);
                const altDisplay = `FL${String(flightLevel).padStart(3, '0')}`;
                
                                // Create custom SVG triangle icon with identifiable classes for in-place updates
                                const iconHtml = `
                                    <div class="ac-icon" style="position: relative; width: 140px; height: 44px;">
                                        <div class="ac-rot" style="position: absolute; left: 50%; transform: translateX(-50%); top: -10px;">
                                            <svg width="20" height="20" viewBox="0 0 20 20" style="transform: rotate(${aircraft.heading || 0}deg);">
                                                <polygon points="10,0 0,20 20,20" fill="${aircraft.color}" />
                                            </svg>
                                        </div>
                                        <div class="ac-labels" style="position: absolute; left: 50%; transform: translateX(-50%); top: 22px; display:flex; align-items:center; gap:8px; font-size:11px; white-space:nowrap;">
                                            <div class="ac-callsign" style="font-weight:700; color:#111;">${aircraft.callsign}</div>
                                            <div class="ac-alt" style="font-size:11px; color:#555;">${altDisplay} <span class="indicator">${vspeedIndicator}</span></div>
                                            <div class="ac-vs" style="font-size:11px; color:#555; margin-left:4px;"></div>
                                        </div>
                                    </div>
                                `;

                                const icon = L.divIcon({ className: 'aircraft-marker-icon', html: iconHtml, iconSize: [140, 44], iconAnchor: [70, 0] });

                const marker = L.marker([lat, lon], { icon: icon }).addTo(map);

                marker.bindPopup(buildAircraftPopupContent(aircraft));
                marker.on('click', () => marker.openPopup());

                aircraftMarkers[key] = marker;
                // Cache icon state to avoid unnecessary setIcon calls
                try {
                    const flightLevel = Math.round(aircraft.altitude / 100);
                    const altDisplay = `FL${String(flightLevel).padStart(3, '0')}`;
                    aircraftMarkerStates[key] = {
                        heading: aircraft.heading || 0,
                        color: aircraft.color,
                        callsign: aircraft.callsign,
                        altDisplay: altDisplay
                    };
                } catch (e) {}
            } else {
                // Update existing marker
                aircraftMarkers[key].setLatLng([lat, lon]);
                
                // Determine vertical speed indicator
                let vspeedIndicator = '►';
                if (aircraft.verticalSpeed > 100) {
                    vspeedIndicator = '▲';
                } else if (aircraft.verticalSpeed < -100) {
                    vspeedIndicator = '▼';
                }
                
                // Create altitude display
                const flightLevel = Math.round(aircraft.altitude / 100);
                const altDisplay = `FL${String(flightLevel).padStart(3, '0')}`;
                
                                // Update icon by mutating DOM in-place when possible (smooth, no DOM replacement)
                                try {
                                    const flightLevel = Math.round(aircraft.altitude / 100);
                                    const altDisplay = `FL${String(flightLevel).padStart(3, '0')}`;
                                    const newState = {
                                        heading: aircraft.heading || 0,
                                        color: aircraft.color,
                                        callsign: aircraft.callsign,
                                        altDisplay: altDisplay
                                    };
                                    const oldState = aircraftMarkerStates[key] || {};
                                    const el = aircraftMarkers[key].getElement && aircraftMarkers[key].getElement();
                                    if (el) {
                                        // Rotate SVG
                                        try { const svg = el.querySelector('svg'); if (svg) svg.style.transform = `rotate(${newState.heading}deg)`; } catch (e) {}
                                        // Update text fields
                                        try { const cs = el.querySelector('.ac-callsign'); if (cs) cs.textContent = newState.callsign; } catch (e) {}
                                        try { const ae = el.querySelector('.ac-alt'); if (ae) ae.textContent = newState.altDisplay; } catch (e) {}
                                        try { const ve = el.querySelector('.ac-vs'); if (ve) ve.textContent = vspeedIndicator; } catch (e) {}
                                        aircraftMarkerStates[key] = newState;
                                    } else {
                                        // Fallback: only recreate the icon if visual state changed
                                        const needIconUpdate = (
                                            oldState.heading !== newState.heading ||
                                            oldState.color !== newState.color ||
                                            oldState.callsign !== newState.callsign ||
                                            oldState.altDisplay !== newState.altDisplay
                                        );
                                        if (needIconUpdate) {
                                            // Avoid recreating the icon element (setIcon) to prevent flicker.
                                            // Instead, cache desired state and attempt to update the marker DOM asynchronously.
                                            aircraftMarkerStates[key] = newState;
                                            tryUpdateMarkerDOM(key, newState, vspeedIndicator);
                                        }
                                    }
                                } catch (e) {}

                if (!updateAircraftPopupDom(aircraftMarkers[key], aircraft)) {
                    aircraftMarkers[key].setPopupContent(buildAircraftPopupContent(aircraft));
                }
            }
        });
        return;
    }
    
    // Original behavior for legacy code
    if (!missionData) return;
    
    missionData.aircraft.forEach(aircraft => {
        const pos = getCurrentPosition(aircraft, currentTime);
        const marker = aircraftMarkers[aircraft.id];
        if (marker) {
            // If the server recently provided a position for this aircraft, prefer that and skip
            // client-side mission-driven updates for a short window to avoid flicker.
            const nowMs = Date.now();
            const lastServerMs = lastServerUpdateMs[aircraft.id] || 0;
            if (lastServerMs && (nowMs - lastServerMs) < SERVER_IGNORE_WINDOW_MS) {
                // Skip all legacy updates for this aircraft while server data is fresh.
                // This prevents popup content flicker from competing update paths.
                return;
            } else {
                marker.setLatLng([pos.lat, pos.lon]);
                // Try updating marker DOM in-place (non-destructive)
                tryUpdateMarkerDOM(aircraft.id, {
                    heading: aircraft.heading || 0,
                    color: aircraft.color,
                    callsign: aircraft.callsign,
                    altDisplay: `FL${String(Math.round(pos.alt/100)).padStart(3,'0')}`
                }, '');
            }
            if (!updateLegacyPopupDom(marker, aircraft, pos)) {
                marker.setPopupContent(buildLegacyPopupContent(aircraft, pos));
            }
        }
    });
}

// Update time display
function updateTimeDisplay(time) {
    const displayEl = document.getElementById('timeDisplay');
    if (time !== undefined && time !== null) {
        try {
            // Accept ISO string, Date, or numeric seconds-since-midnight
            if (typeof time === 'number') {
                // treat as seconds-since-midnight
                displayEl.textContent = `Time: ${formatTimeOfDay(Math.round(time))}`;
            } else {
                const timeObj = new Date(time);
                if (!isNaN(timeObj.getTime())) {
                    // Use UTC time-of-day so label remains consistent
                    const h = timeObj.getUTCHours();
                    const m = timeObj.getUTCMinutes();
                    const s = timeObj.getUTCSeconds();
                    const secondsSinceMidnight = h * 3600 + m * 60 + s;
                    displayEl.textContent = `Time: ${formatTimeOfDay(secondsSinceMidnight)}`;
                } else {
                    // Fallback to currentTime
                    const dayStartSec = DAY_START_HOUR * 3600;
                    displayEl.textContent = `Time: ${formatTimeOfDay(dayStartSec + Math.round(currentTime))}`;
                }
            }
        } catch (e) {
            const dayStartSec = DAY_START_HOUR * 3600;
            displayEl.textContent = `Time: ${formatTimeOfDay(dayStartSec + Math.round(currentTime))}`;
        }
    } else {
        // Show wall-clock time mapped from mission-relative currentTime (rounded)
        const dayStartSec = DAY_START_HOUR * 3600;
        displayEl.textContent = `Time: ${formatTimeOfDay(dayStartSec + Math.round(currentTime))}`;
    }
}

// Try to update a marker's inner DOM when it becomes available.
function tryUpdateMarkerDOM(key, state, vspeedIndicator) {
    try {
        const marker = aircraftMarkers[key];
        if (!marker) return;
        const el = marker.getElement && marker.getElement();
        if (el) {
            try { const svg = el.querySelector('svg'); if (svg) svg.style.transform = `rotate(${state.heading}deg)`; } catch (e) {}
            try { const cs = el.querySelector('.ac-callsign'); if (cs) cs.textContent = state.callsign; } catch (e) {}
            try { const ae = el.querySelector('.ac-alt'); if (ae) ae.textContent = state.altDisplay; } catch (e) {}
            try { const ve = el.querySelector('.ac-vs'); if (ve) ve.textContent = vspeedIndicator || ''; } catch (e) {}
            // update cache
            aircraftMarkerStates[key] = state;
        } else {
            // Retry shortly; don't loop indefinitely
            setTimeout(() => {
                try {
                    const el2 = marker.getElement && marker.getElement();
                    if (el2) {
                        tryUpdateMarkerDOM(key, state, vspeedIndicator);
                    }
                } catch (e) {}
            }, 250);
        }
    } catch (e) {}
}

// ============================================
// CONFLICT AND DISTANCE FUNCTIONS
// ============================================

// Update conflict alerts
function updateConflictAlerts(conflicts) {
    activeConflicts = conflicts;
    const countEl = document.getElementById('conflict-count');
    const listEl = document.getElementById('conflict-list');
    
    if (!countEl || !listEl) return;
    
    countEl.textContent = conflicts.length;
    countEl.style.display = conflicts.length > 0 ? 'inline-block' : 'none';
    
    if (conflicts.length === 0) {
        listEl.innerHTML = '<div style="color: #27ae60; font-size: 12px;">✓ No conflicts detected</div>';
        return;
    }
    
    listEl.innerHTML = conflicts.map(c => `
        <div class="conflict-item ${c.severity.toLowerCase()}">
            <div class="conflict-aircraft">
                ${c.severity === 'CRITICAL' ? '🔴' : '🟡'} 
                ${c.aircraft1.callsign} vs ${c.aircraft2.callsign}
            </div>
            <div class="conflict-metrics">
                H: ${c.horizontalDistance} NM | V: ${c.verticalSeparation} ft
            </div>
        </div>
    `).join('');
}

// Update distance matrix
function updateDistanceMatrix(distances) {
    const matrixEl = document.getElementById('distance-matrix');
    if (!matrixEl) return;

    if (!distances || distances.length === 0) {
        matrixEl.innerHTML = '<div style="color: #95a5a6; font-size: 12px;">No active aircraft pairs</div>';
        return;
    }

    matrixEl.innerHTML = distances.map(d => `
        <div class="distance-item">
            <div class="distance-pair">
                ${d.aircraft1.callsign} ↔ ${d.aircraft2.callsign}
            </div>
            <div class="distance-values">
                Horiz: ${d.horizontal} NM | Vert: ${d.vertical} ft | Total: ${d.total} NM
            </div>
        </div>
    `).join('');
}

// Update separation monitor panel
function updateSeparationMonitor(separations) {
    if (!separations || separations.length === 0) return;
    
    const closestPairEl = document.getElementById('closest-pair-display');
    const allPairsEl = document.getElementById('all-pairs-list');
    
    if (!closestPairEl || !allPairsEl) return;
    
    // Find closest pair
    const closest = separations[0]; // Assuming server sends sorted by distance
    
    // Determine status
    let statusClass = 'safe';
    let statusIcon = '🟢';
    let statusText = 'SAFE';
    
    if (closest.horizontal < 3 && closest.vertical < 500) {
        statusClass = 'conflict';
        statusIcon = '🔴';
        statusText = 'CONFLICT';
    } else if (closest.horizontal < 5 && closest.vertical < 1000) {
        statusClass = 'caution';
        statusIcon = '🟡';
        statusText = 'CAUTION';
    }
    
    // Display closest pair
    closestPairEl.innerHTML = `
        <div class="closest-pair ${statusClass}">
            <div class="pair-aircraft">
                Closest Pair: ${closest.aircraft1} ↔ ${closest.aircraft2}
            </div>
            <div class="pair-metrics">
                <div><span class="metric-label">Horizontal:</span> ${closest.horizontal.toFixed(2)} NM ${statusIcon} ${statusText}</div>
                <div><span class="metric-label">Vertical:</span> ${closest.vertical.toFixed(0)} ft ${statusIcon} ${statusText}</div>
                <div><span class="metric-label">Relative Speed:</span> ${closest.relativeSpeed ? closest.relativeSpeed.toFixed(0) : 'N/A'} kts</div>
                ${closest.timeToCPA ? `<div><span class="metric-label">Time to CPA:</span> ${formatTime(closest.timeToCPA)}</div>` : ''}
            </div>
        </div>
    `;
    
    // Display all pairs
    allPairsEl.innerHTML = separations.map(sep => {
        let statusClass = 'safe';
        let statusIcon = '🟢';

        if (sep.horizontal < 3 && sep.vertical < 500) {
            statusClass = 'conflict';
            statusIcon = '🔴';
        } else if (sep.horizontal < 5 && sep.vertical < 1000) {
            statusClass = 'caution';
            statusIcon = '🟡';
        }

        return `
            <div class="pair-item ${statusClass}">
                <span class="pair-names">${sep.aircraft1} ↔ ${sep.aircraft2}</span>
                <span class="pair-sep">${sep.horizontal.toFixed(1)} NM | ${sep.vertical.toFixed(0)} ft</span>
                <span class="status-indicator">${statusIcon}</span>
            </div>
        `;
    }).join('');
}

// Format time in seconds to MM:SS format
function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

// Update aircraft display with altitude info
function updateAircraftDisplay(aircraft) {
    updateAircraftList(Array.isArray(aircraft) ? aircraft : []);
}

// ============================================
// MISSION EDITOR FUNCTIONS
// ============================================

// Initialize Mission Editor
function initializeMissionEditor() {
    // Toggle editor visibility
    const editorToggle = document.getElementById('editorToggle');
    const editorContent = document.getElementById('editorContent');
    const toggleIcon = editorToggle.querySelector('.toggle-icon');
    
    editorToggle.addEventListener('click', () => {
        editorContent.classList.toggle('hidden');
        toggleIcon.classList.toggle('collapsed');
    });
    
    // Initialize waypoint display
    updateWaypointDisplay();

    // Airport preview inputs: show markers for entered departure/arrival ICAO codes
    const depInput = document.getElementById('aircraftDeparture');
    const arrInput = document.getElementById('aircraftArrival');
    if (depInput) depInput.addEventListener('input', updateDeparturePreview);
    if (arrInput) arrInput.addEventListener('input', updateArrivalPreview);
    
    // Waypoint mode toggle
    const addWaypointBtn = document.getElementById('addWaypointBtn');
    addWaypointBtn.addEventListener('click', toggleWaypointMode);
    
    // Clear waypoints
    const clearWaypointsBtn = document.getElementById('clearWaypointsBtn');
    clearWaypointsBtn.addEventListener('click', clearWaypoints);
    
    // Form submission
    const addAircraftForm = document.getElementById('addAircraftForm');
    addAircraftForm.addEventListener('submit', handleAddAircraft);
    
    // Mission actions
    document.getElementById('saveMissionBtn').addEventListener('click', saveMission);
    document.getElementById('loadMissionBtn').addEventListener('click', () => {
        document.getElementById('missionFileInput').click();
    });
    document.getElementById('missionFileInput').addEventListener('change', handleLoadMission);
    document.getElementById('clearAllBtn').addEventListener('click', clearAllAircraft);
    
    // Initialize distance matrix toggle
    document.getElementById('toggle-distances-btn')?.addEventListener('click', () => {
        showDistanceMatrix = !showDistanceMatrix;
        const matrixEl = document.getElementById('distance-matrix');
        const btn = document.getElementById('toggle-distances-btn');
        
        if (matrixEl && btn) {
            matrixEl.style.display = showDistanceMatrix ? 'block' : 'none';
            btn.textContent = showDistanceMatrix ? 'Hide Matrix' : 'Show Matrix';
        }
    });
}

// Toggle waypoint click mode
function toggleWaypointMode() {
    waypointMode = !waypointMode;
    const addWaypointBtn = document.getElementById('addWaypointBtn');
    
    if (waypointMode) {
        addWaypointBtn.classList.add('active');
        addWaypointBtn.textContent = '✓ Click Map (Active)';
        map.getContainer().classList.add('waypoint-mode');
        
        // Add click listener to map
        map.on('click', handleMapClick);
    } else {
        addWaypointBtn.classList.remove('active');
        addWaypointBtn.textContent = '📍 Click Map to Add';
        map.getContainer().classList.remove('waypoint-mode');
        
        // Remove click listener
        map.off('click', handleMapClick);
    }
}

// Handle map click for adding waypoints
function handleMapClick(e) {
    if (!waypointMode) return;
    
    const { lat, lng } = e.latlng;
    const altitude = prompt('Enter altitude for this waypoint (feet):', '3000');
    const alt = parseInt(altitude) || 3000;
    
    tempWaypoints.push({ lat, lng, alt });
    
    // Add temporary marker (yellow circle)
    const marker = L.circleMarker([lat, lng], {
        radius: 8,
        fillColor: '#FFD700',
        color: '#FFA500',
        weight: 2,
        opacity: 1,
        fillOpacity: 0.8
    }).addTo(map);
    
    marker.bindPopup(`Waypoint ${tempWaypoints.length}<br>Lat: ${lat.toFixed(4)}<br>Lng: ${lng.toFixed(4)}<br>${alt} ft`);
    tempWaypointMarkers.push(marker);
    
    updateWaypointDisplay();
}

// Update departure preview marker based on input field value
function updateDeparturePreview() {
    try {
        const code = document.getElementById('aircraftDeparture')?.value || '';
        const ap = code ? getAirportCoordinates(code) : null;
        if (!ap) {
            if (departurePreviewMarker) {
                try { map.removeLayer(departurePreviewMarker); } catch (e) {}
                departurePreviewMarker = null;
            }
            return;
        }

        // Create or move preview marker
        if (departurePreviewMarker) {
            departurePreviewMarker.setLatLng([ap.lat, ap.lon]);
            departurePreviewMarker.setPopupContent(`<strong>${code.toUpperCase()}</strong><br>${ap.name}`);
        } else {
            departurePreviewMarker = L.circleMarker([ap.lat, ap.lon], {
                radius: 8,
                color: '#0055aa',
                fillColor: '#0055aa',
                weight: 2,
                fillOpacity: 0.9
            }).addTo(map);
            departurePreviewMarker.bindPopup(`<strong>${code.toUpperCase()}</strong><br>${ap.name}`);
        }
    } catch (e) {
        // ignore
    }
}

// Update arrival preview marker based on input field value
function updateArrivalPreview() {
    try {
        const code = document.getElementById('aircraftArrival')?.value || '';
        const ap = code ? getAirportCoordinates(code) : null;
        if (!ap) {
            if (arrivalPreviewMarker) {
                try { map.removeLayer(arrivalPreviewMarker); } catch (e) {}
                arrivalPreviewMarker = null;
            }
            return;
        }

        if (arrivalPreviewMarker) {
            arrivalPreviewMarker.setLatLng([ap.lat, ap.lon]);
            arrivalPreviewMarker.setPopupContent(`<strong>${code.toUpperCase()}</strong><br>${ap.name}`);
        } else {
            arrivalPreviewMarker = L.circleMarker([ap.lat, ap.lon], {
                radius: 8,
                color: '#007700',
                fillColor: '#009900',
                weight: 2,
                fillOpacity: 0.9
            }).addTo(map);
            arrivalPreviewMarker.bindPopup(`<strong>${code.toUpperCase()}</strong><br>${ap.name}`);
        }
    } catch (e) {
        // ignore
    }
}

// Remove both preview markers
function removeAirportPreviews() {
    try {
        if (departurePreviewMarker) { map.removeLayer(departurePreviewMarker); departurePreviewMarker = null; }
    } catch (e) {}
    try {
        if (arrivalPreviewMarker) { map.removeLayer(arrivalPreviewMarker); arrivalPreviewMarker = null; }
    } catch (e) {}
}

// Add a basic airspace layer (control zones) around known airports
function addAirspaceLayer() {
    if (!window.SWEDISH_AIRPORTS || !map) return;
    if (!airspaceLayer) airspaceLayer = L.layerGroup().addTo(map);
    airspaceLayer.clearLayers();

    Object.keys(SWEDISH_AIRPORTS).forEach(code => {
        const ap = SWEDISH_AIRPORTS[code];
        if (!ap || !ap.lat || !ap.lon) return;
        // radius in meters; allow override via airport.controlRadius, default 5000m
        const radius = ap.controlRadius || 5000;
        const circle = L.circle([ap.lat, ap.lon], {
            radius: radius,
            color: '#ff8800',
            fillColor: '#ffcc88',
            fillOpacity: 0.12,
            weight: 2
        }).addTo(airspaceLayer);
        circle.bindPopup(`<div style="color:#222"><strong>${code}</strong><br>${ap.name}<br>CTR ≈ ${Math.round(radius/1000)} km</div>`);
    });
}

function removeAirspaceLayer() {
    try {
        if (airspaceLayer) {
            airspaceLayer.clearLayers();
            map.removeLayer(airspaceLayer);
            airspaceLayer = null;
        }
    } catch (e) {}
}

// Add a small map control to toggle the airspace layer
function addAirspaceControl() {
    const AirspaceControl = L.Control.extend({
        onAdd: function(map) {
            const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
            container.style.background = 'white';
            container.style.padding = '6px';
            container.style.fontSize = '13px';
            container.innerHTML = `<label style="display:flex;align-items:center;gap:6px;cursor:pointer;color:#222;font-weight:600;"><input id="toggleAirspace" type="checkbox">Airspace</label>`;
            L.DomEvent.disableClickPropagation(container);
            return container;
        }
    });

    map.addControl(new AirspaceControl({ position: 'topright' }));
    // Wire up change handler
    setTimeout(() => {
        const cb = document.getElementById('toggleAirspace');
        if (!cb) return;
        cb.addEventListener('change', (e) => {
            airspaceVisible = e.target.checked;
            if (airspaceVisible) addAirspaceLayer(); else removeAirspaceLayer();
        });
    }, 50);
}

// Add a small control to paste a custom tile URL (useful for aviation tile providers/WMS)
function addCustomTileControl() {
    const CustomControl = L.Control.extend({
        onAdd: function(map) {
            const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
            container.style.background = 'white';
            container.style.padding = '6px';
            container.style.fontSize = '13px';
            container.title = 'Add custom tile layer (paste tile URL)';
            container.innerHTML = `<button id="addCustomTileBtn" style="background:none;border:none;cursor:pointer;padding:0;margin:0;font-weight:600;color:#222">Tiles+</button>`;
            L.DomEvent.disableClickPropagation(container);
            return container;
        }
    });

    map.addControl(new CustomControl({ position: 'topright' }));

    setTimeout(() => {
        const btn = document.getElementById('addCustomTileBtn');
        if (!btn) return;
        btn.addEventListener('click', () => {
            const url = prompt('Enter tile URL (use {z}/{x}/{y} tokens) or WMS tile endpoint:');
            if (!url) return;
            const name = prompt('Layer name (display in layer switcher):', 'Custom Tiles');
            try {
                const tile = L.tileLayer(url, { maxZoom: 20 });
                tile.addTo(map);
                if (window.baseLayerControl) {
                    window.baseLayerControl.addBaseLayer(tile, name || 'Custom Tiles');
                } else {
                    // fallback: add simple overlay control
                    L.control.layers({}, { [name || 'Custom Tiles']: tile }, { position: 'topright' }).addTo(map);
                }
                // persist last custom URL for this session
                try { localStorage.setItem('lastCustomTile', url); } catch (e) {}
            } catch (e) {
                alert('Failed to add tile layer. Check URL and CORS.');
            }
        });
        // If a saved custom tile exists, offer to add it silently
        try {
            const last = localStorage.getItem('lastCustomTile');
            if (last) {
                const auto = confirm('Restore last custom tile layer?');
                if (auto) {
                    const tile = L.tileLayer(last, { maxZoom: 20 }).addTo(map);
                    if (window.baseLayerControl) window.baseLayerControl.addBaseLayer(tile, 'Restored Custom Tiles');
                }
            }
        } catch (e) {}
    }, 50);
}

// Update waypoint list display
function updateWaypointDisplay() {
    const waypointList = document.getElementById('waypointList');
    const waypointCount = document.getElementById('waypointCount');
    
    waypointCount.textContent = `(${tempWaypoints.length})`;
    
    if (tempWaypoints.length === 0) {
        waypointList.innerHTML = '<p style="color: #999; font-size: 0.9em;">No waypoints added. Click map to add.</p>';
        return;
    }
    
    waypointList.innerHTML = tempWaypoints.map((wp, index) => `
        <div class="waypoint-item">
            <span class="waypoint-coords">
                ${index + 1}. Lat: ${wp.lat.toFixed(4)}, Lng: ${wp.lng.toFixed(4)} - ${wp.alt || 3000} ft
            </span>
            <button class="waypoint-remove" onclick="removeWaypoint(${index})">Remove</button>
        </div>
    `).join('');
}

// Remove specific waypoint
function removeWaypoint(index) {
    tempWaypoints.splice(index, 1);
    
    // Remove marker
    if (tempWaypointMarkers[index]) {
        map.removeLayer(tempWaypointMarkers[index]);
        tempWaypointMarkers.splice(index, 1);
    }
    
    updateWaypointDisplay();
}

// Clear all waypoints
function clearWaypoints() {
    tempWaypoints = [];
    
    // Remove all markers
    tempWaypointMarkers.forEach(marker => map.removeLayer(marker));
    tempWaypointMarkers = [];
    
    updateWaypointDisplay();
}

// Handle add aircraft form submission
function handleAddAircraft(e) {
    e.preventDefault();
    
    // Get form values
    const callsign = document.getElementById('aircraftCallsign').value;
    const type = (document.getElementById('aircraftType') && document.getElementById('aircraftType').value) || 'Custom';
    const speed = parseInt(document.getElementById('aircraftSpeed').value);
    const startTime = document.getElementById('aircraftStartTime').value;
    const color = document.getElementById('aircraftColor').value;
    const departure = document.getElementById('aircraftDeparture').value.toUpperCase().trim();
    const arrival = document.getElementById('aircraftArrival').value.toUpperCase().trim();
    
    // Build complete route with departure/arrival waypoints
    let completeRoute = [];
    
    // Add departure airport as first waypoint (if provided)
    if (departure) {
        const departureAirport = getAirportCoordinates(departure);
        if (!departureAirport) {
            alert(`Unknown departure airport: ${departure}\nPlease use a valid Swedish ICAO code (e.g., ESSA, ESGG, ESMS)`);
            return;
        }
        completeRoute.push({
            lat: departureAirport.lat,
            lng: departureAirport.lon,
            alt: DEFAULT_CRUISE_ALTITUDE
        });
    }
    
    // Add manually clicked waypoints
    completeRoute.push(...tempWaypoints.map(wp => ({
        lat: wp.lat,
        lng: wp.lng,
        alt: wp.alt || DEFAULT_CRUISE_ALTITUDE
    })));
    
    // Add arrival airport as last waypoint (if provided)
    if (arrival) {
        const arrivalAirport = getAirportCoordinates(arrival);
        if (!arrivalAirport) {
            alert(`Unknown arrival airport: ${arrival}\nPlease use a valid Swedish ICAO code (e.g., ESSA, ESGG, ESMS)`);
            return;
        }
        completeRoute.push({
            lat: arrivalAirport.lat,
            lng: arrivalAirport.lon,
            alt: DEFAULT_ARRIVAL_ALTITUDE
        });
    }
    
    // Validate minimum waypoints
    if (completeRoute.length < 2) {
        alert('Route must have at least 2 waypoints.\n\nYou can either:\n- Enter departure AND arrival airports, OR\n- Click the map to add at least 2 waypoints');
        return;
    }
    
    // Create aircraft object
    aircraftCounter++;
    const aircraft = {
        id: `AC${aircraftCounter}`,
        callsign: callsign,
        type: type,
        speed: speed,
        startTime: `2024-01-01T${startTime}:00Z`,
        color: color,
        departure: departure,
        arrival: arrival,
        route: completeRoute
    };
    
    // Send to server
    socket.emit('addAircraft', aircraft);
    
    // Reset form
    document.getElementById('addAircraftForm').reset();
    clearWaypoints();
    // Remove any preview markers shown for departure/arrival
    removeAirportPreviews();
    
    // Turn off waypoint mode
    if (waypointMode) {
        toggleWaypointMode();
    }
}

// Delete aircraft
function deleteAircraft(aircraftId) {
    if (!confirm('Are you sure you want to delete this aircraft?')) {
        return;
    }
    
    socket.emit('deleteAircraft', { id: aircraftId });
}

// Save mission
function saveMission() {
    socket.emit('getMission');
}

// Download mission file
function downloadMissionFile(missionData) {
    const dataStr = JSON.stringify(missionData, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `mission-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// Handle load mission
function handleLoadMission(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (event) => {
        try {
            const missionData = JSON.parse(event.target.result);
            
            // Validate mission data
            if (!missionData.aircraft || !Array.isArray(missionData.aircraft)) {
                throw new Error('Invalid mission format: missing aircraft array');
            }
            
            // Send to server
            socket.emit('loadMission', missionData);
            
            // Reset file input
            e.target.value = '';
        } catch (error) {
            alert('Error loading mission file: ' + error.message);
        }
    };
    reader.readAsText(file);
}

// Clear all aircraft
function clearAllAircraft() {
    if (!confirm('Are you sure you want to clear all aircraft? This cannot be undone.')) {
        return;
    }
    
    socket.emit('clearAll');
}
