// WebSocket connection
let socket;
let map;
let missionData = null;
let aircraftMarkers = {};
let aircraftPaths = {};
let isPlaying = false;
let currentTime = 0;
let playbackSpeed = 1;
let animationInterval = null;

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    initializeMap();
    initializeWebSocket();
    initializeControls();
});

// Initialize Leaflet map
function initializeMap() {
    map = L.map('map').setView([51.515, -0.065], 13);
    
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors',
        maxZoom: 19
    }).addTo(map);
}

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
}

// Initialize controls
function initializeControls() {
    document.getElementById('playBtn').addEventListener('click', play);
    document.getElementById('pauseBtn').addEventListener('click', pause);
    document.getElementById('resetBtn').addEventListener('click', reset);
    
    const speedControl = document.getElementById('speedControl');
    speedControl.addEventListener('input', (e) => {
        playbackSpeed = parseInt(e.target.value);
        document.getElementById('speedValue').textContent = `${playbackSpeed}x`;
    });
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
        const marker = L.marker([startPos.lat, startPos.lon], {
            icon: L.divIcon({
                html: `<div style="background-color: ${aircraft.color}; width: 16px; height: 16px; border-radius: 50%; border: 2px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.3);"></div>`,
                className: 'aircraft-marker',
                iconSize: [16, 16],
                iconAnchor: [8, 8]
            })
        }).addTo(map);
        
        marker.bindPopup(`
            <div class="popup-aircraft-info">
                <h4>${aircraft.callsign}</h4>
                <p><strong>Type:</strong> ${aircraft.type}</p>
                <p><strong>Altitude:</strong> ${startPos.alt} ft</p>
                <p><strong>Position:</strong> ${startPos.lat.toFixed(4)}, ${startPos.lon.toFixed(4)}</p>
            </div>
        `);
        
        aircraftMarkers[aircraft.id] = marker;
    });
    
    // Fit map to show all routes
    const allCoords = missionData.aircraft.flatMap(aircraft => 
        aircraft.route.map(point => [point.lat, point.lon])
    );
    if (allCoords.length > 0) {
        map.fitBounds(allCoords, { padding: [50, 50] });
    }
    
    // Update aircraft list
    updateAircraftList();
    
    // Reset time
    currentTime = 0;
    updateTimeDisplay();
}

// Update aircraft list in info panel
function updateAircraftList() {
    const listEl = document.getElementById('aircraftList');
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
                    <span class="aircraft-type">(${aircraft.type})</span>
                </div>
                <div class="aircraft-info">
                    <span class="label">Latitude:</span>
                    <span class="value">${currentPos.lat.toFixed(4)}°</span>
                    <span class="label">Longitude:</span>
                    <span class="value">${currentPos.lon.toFixed(4)}°</span>
                    <span class="label">Altitude:</span>
                    <span class="value">${currentPos.alt} ft</span>
                    <span class="label">Status:</span>
                    <span class="value">${currentTime >= getMaxTime(aircraft) ? '✅ Complete' : '✈️ In Flight'}</span>
                </div>
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
    
    animationInterval = setInterval(() => {
        currentTime += 0.1 * playbackSpeed;
        
        // Check if all aircraft have completed their routes
        const maxTime = Math.max(...missionData.aircraft.map(getMaxTime));
        if (currentTime >= maxTime) {
            pause();
            return;
        }
        
        updateAircraftPositions();
        updateTimeDisplay();
        updateAircraftList();
    }, 100);
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
    updateAircraftList();
}

// Update aircraft positions on map
function updateAircraftPositions() {
    if (!missionData) return;
    
    missionData.aircraft.forEach(aircraft => {
        const pos = getCurrentPosition(aircraft, currentTime);
        const marker = aircraftMarkers[aircraft.id];
        if (marker) {
            marker.setLatLng([pos.lat, pos.lon]);
            marker.setPopupContent(`
                <div class="popup-aircraft-info">
                    <h4>${aircraft.callsign}</h4>
                    <p><strong>Type:</strong> ${aircraft.type}</p>
                    <p><strong>Altitude:</strong> ${pos.alt} ft</p>
                    <p><strong>Position:</strong> ${pos.lat.toFixed(4)}, ${pos.lon.toFixed(4)}</p>
                    <p><strong>Time:</strong> ${currentTime.toFixed(1)}s</p>
                </div>
            `);
        }
    });
}

// Update time display
function updateTimeDisplay() {
    document.getElementById('timeDisplay').textContent = `Time: ${currentTime.toFixed(1)}s`;
}
