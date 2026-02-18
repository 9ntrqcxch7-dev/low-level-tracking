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

// Mission editor state
let waypointMode = false;
let tempWaypoints = [];
let tempMarkers = [];
let editingAircraftId = null;
let aircraftIdCounter = 1;

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    initializeMap();
    initializeWebSocket();
    initializeControls();
    initializeMissionEditor();
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

    // Handle mission data for save
    socket.on('missionData', (data) => {
        // Download as JSON file
        const dataStr = JSON.stringify(data.mission, null, 2);
        const dataBlob = new Blob([dataStr], { type: 'application/json' });
        const url = URL.createObjectURL(dataBlob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'mission_' + new Date().toISOString().slice(0,10) + '.json';
        link.click();
        URL.revokeObjectURL(url);
    });

    // Handle aircraft added/deleted (will be handled by re-init)
    socket.on('aircraftAdded', (data) => {
        console.log('Aircraft added:', data);
    });

    socket.on('aircraftDeleted', (data) => {
        console.log('Aircraft deleted:', data);
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
        const status = currentTime >= getMaxTime(aircraft) ? '✅ Complete' : '✈️ In Flight';
        return `
            <div class="aircraft-card ${isPlaying ? 'active' : ''}">
                <div class="aircraft-header">
                    <div class="aircraft-color" style="background-color: ${aircraft.color};"></div>
                    <span class="aircraft-callsign">${aircraft.callsign}</span>
                    <span class="aircraft-type">(${aircraft.type || 'Unknown'})</span>
                    <button class="btn-icon" onclick="deleteAircraft('${aircraft.id}')">🗑️</button>
                </div>
                <div class="aircraft-info">
                    <span class="label">Latitude:</span>
                    <span class="value">${currentPos.lat.toFixed(4)}°</span>
                    <span class="label">Longitude:</span>
                    <span class="value">${currentPos.lon.toFixed(4)}°</span>
                    <span class="label">Altitude:</span>
                    <span class="value">${currentPos.alt} ft</span>
                    <span class="label">Status:</span>
                    <span class="value">${status}</span>
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

// Mission Editor Functions
function initializeMissionEditor() {
    // Toggle editor panel
    document.getElementById('toggle-editor-btn').addEventListener('click', () => {
        const panel = document.getElementById('editor-panel');
        const btn = document.getElementById('toggle-editor-btn');
        if (panel.style.display === 'none') {
            panel.style.display = 'block';
            btn.textContent = 'Hide Editor';
        } else {
            panel.style.display = 'none';
            btn.textContent = 'Show Editor';
        }
    });

    // Waypoint mode toggle
    document.getElementById('add-waypoint-btn').addEventListener('click', () => {
        waypointMode = !waypointMode;
        const btn = document.getElementById('add-waypoint-btn');
        if (waypointMode) {
            btn.textContent = '✓ Click Map (Active)';
            btn.classList.add('btn-success');
            btn.classList.remove('btn-info');
            map.getContainer().style.cursor = 'crosshair';
        } else {
            btn.textContent = '📍 Click Map to Add';
            btn.classList.add('btn-info');
            btn.classList.remove('btn-success');
            map.getContainer().style.cursor = '';
        }
    });

    // Map click for waypoints
    map.on('click', (e) => {
        if (waypointMode) {
            const lat = e.latlng.lat.toFixed(4);
            const lng = e.latlng.lng.toFixed(4);
            tempWaypoints.push({ lat: parseFloat(lat), lng: parseFloat(lng) });
            
            // Add temporary marker
            const marker = L.circleMarker([lat, lng], {
                radius: 6,
                fillColor: '#ffff00',
                color: '#000',
                weight: 2,
                fillOpacity: 0.8
            }).addTo(map);
            tempMarkers.push(marker);
            
            // Update waypoint list
            updateWaypointList();
        }
    });

    // Clear waypoints button
    document.getElementById('clear-waypoints-btn').addEventListener('click', () => {
        tempWaypoints = [];
        tempMarkers.forEach(m => m.remove());
        tempMarkers = [];
        updateWaypointList();
    });

    // Aircraft form submit
    document.getElementById('aircraft-form').addEventListener('submit', (e) => {
        e.preventDefault();
        
        if (tempWaypoints.length < 2) {
            alert('Please add at least 2 waypoints!');
            return;
        }
        
        const callsign = document.getElementById('input-callsign').value;
        const speed = parseInt(document.getElementById('input-speed').value);
        const startTime = document.getElementById('input-start-time').value;
        const color = document.getElementById('input-color').value;
        
        // Create start time as Date object
        const [hours, minutes] = startTime.split(':');
        const startDate = new Date('2026-01-01T' + hours.padStart(2, '0') + ':' + minutes.padStart(2, '0') + ':00Z');
        
        const newAircraft = {
            id: 'AC' + aircraftIdCounter++,
            callsign: callsign,
            type: 'Custom',
            startTime: startDate.toISOString(),
            speed: speed,
            color: color,
            route: tempWaypoints.map((wp, idx) => ({ 
                lat: wp.lat, 
                lon: wp.lng, 
                alt: 300,
                time: idx * 30
            }))
        };
        
        // Send to server
        socket.emit('addAircraft', { aircraft: newAircraft });
        
        // Clear form
        document.getElementById('aircraft-form').reset();
        tempWaypoints = [];
        tempMarkers.forEach(m => m.remove());
        tempMarkers = [];
        updateWaypointList();
        waypointMode = false;
        const btn = document.getElementById('add-waypoint-btn');
        btn.textContent = '📍 Click Map to Add';
        btn.classList.add('btn-info');
        btn.classList.remove('btn-success');
        map.getContainer().style.cursor = '';
    });

    // Save mission button
    document.getElementById('save-mission-btn').addEventListener('click', () => {
        socket.emit('getMission');
    });

    // Load mission button
    document.getElementById('load-mission-btn').addEventListener('click', () => {
        document.getElementById('mission-file-input').click();
    });

    // Mission file input
    document.getElementById('mission-file-input').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (event) => {
                try {
                    const mission = JSON.parse(event.target.result);
                    socket.emit('loadMission', { mission: mission });
                } catch (err) {
                    alert('Invalid mission file!');
                }
            };
            reader.readAsText(file);
        }
    });

    // Clear all button
    document.getElementById('clear-all-btn').addEventListener('click', () => {
        if (confirm('Clear all aircraft? This cannot be undone!')) {
            socket.emit('clearAll');
        }
    });
}

// Update waypoint list
function updateWaypointList() {
    const list = document.getElementById('waypoint-list');
    const count = document.getElementById('waypoint-count');
    count.textContent = tempWaypoints.length;
    
    list.innerHTML = tempWaypoints.map((wp, idx) => `
        <div class="waypoint-item">
            <span>${idx + 1}. ${wp.lat.toFixed(4)}, ${wp.lng.toFixed(4)}</span>
            <button class="btn-icon" onclick="removeWaypoint(${idx})">❌</button>
        </div>
    `).join('');
}

// Remove waypoint
function removeWaypoint(index) {
    tempWaypoints.splice(index, 1);
    tempMarkers[index].remove();
    tempMarkers.splice(index, 1);
    updateWaypointList();
}

// Delete aircraft
function deleteAircraft(id) {
    if (confirm('Delete this aircraft?')) {
        socket.emit('deleteAircraft', { id: id });
    }
}

// Expose functions to window for onclick handlers
window.removeWaypoint = removeWaypoint;
window.deleteAircraft = deleteAircraft;
