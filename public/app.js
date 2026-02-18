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

// Mission Editor State
let waypointMode = false;
let tempWaypoints = [];
let tempWaypointMarkers = [];
let aircraftCounter = 0;

// Conflict and Distance state
let showDistanceMatrix = false;
let activeConflicts = [];

// Constants
const DEFAULT_CRUISE_ALTITUDE = 3000;
const DEFAULT_ARRIVAL_ALTITUDE = 1000;

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
    
    socket.on('simulation-update', (data) => {
        updateTimeDisplay(data.time);
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
        playbackSpeed = parseInt(e.target.value);
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
            document.getElementById('speedControl').value = Math.round(speed);
            
            // Update active button
            speedButtons.forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            
            // Update simulation speed if simulation is running
            socket.emit('set-simulation-speed', { speed: playbackSpeed });
        });
    });
}

// Simulation control functions
function startSimulation() {
    socket.emit('start-simulation', { speed: playbackSpeed });
    document.getElementById('playBtn').disabled = true;
    document.getElementById('pauseBtn').disabled = false;
}

function pauseSimulation() {
    socket.emit('pause-simulation');
    document.getElementById('playBtn').disabled = false;
    document.getElementById('pauseBtn').disabled = true;
}

function resetSimulation() {
    socket.emit('reset-simulation');
    document.getElementById('playBtn').disabled = false;
    document.getElementById('pauseBtn').disabled = true;
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
function updateAircraftList(aircraftArray) {
    const listEl = document.getElementById('aircraftList');
    
    // If using simulation-update data
    if (aircraftArray && Array.isArray(aircraftArray)) {
        if (aircraftArray.length === 0) {
            listEl.innerHTML = '<div class="no-aircraft">No active aircraft</div>';
            return;
        }
        
        listEl.innerHTML = aircraftArray.map(ac => {
            const status = ac.position?.active ? '✓ Active' : '○ Waiting';
            
            // Determine vertical speed indicator
            let vspeedIndicator = '➡️';
            let vspeedClass = 'level';
            if (ac.verticalSpeed > 100) {
                vspeedIndicator = '🔼';
                vspeedClass = 'climbing';
            } else if (ac.verticalSpeed < -100) {
                vspeedIndicator = '🔽';
                vspeedClass = 'descending';
            }
            
            const altitudeDisplay = ac.altitude ? `
                <div class="altitude-display">
                    <span class="altitude-indicator ${vspeedClass}">${vspeedIndicator}</span>
                    <span class="altitude-value">${ac.altitude.toLocaleString()} ft</span>
                    ${Math.abs(ac.verticalSpeed || 0) > 100 ? 
                      `<span style="font-size: 10px;">(${ac.verticalSpeed > 0 ? '+' : ''}${ac.verticalSpeed} ft/min)</span>` 
                      : ''}
                </div>
            ` : '';
            
            return `
                <div class="aircraft-card">
                    <div style="display: flex; align-items: center; justify-content: space-between;">
                        <div style="display: flex; align-items: center; gap: 10px; flex: 1;">
                            <div class="aircraft-marker" style="background-color: ${ac.color}; width: 20px; height: 20px; border-radius: 50%; border: 2px solid #333;"></div>
                            <div style="flex: 1;">
                                <div style="font-weight: bold;">${ac.callsign}</div>
                                <div style="font-size: 11px; color: #95a5a6;">${status}</div>
                                ${altitudeDisplay}
                            </div>
                        </div>
                        <button class="btn btn-danger btn-small" onclick="deleteAircraft('${ac.id}')">🗑️</button>
                    </div>
                </div>
            `;
        }).join('');
        return;
    }
    
    // Original behavior for legacy mission data
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
                    <span class="label">Status:</span>
                    <span class="value">${currentTime >= getMaxTime(aircraft) ? '✅ Complete' : '✈️ In Flight'}</span>
                </div>
                <div class="aircraft-actions">
                    <button class="icon-btn btn-delete" onclick="deleteAircraft('${aircraft.id}')">
                        🗑️ Delete
                    </button>
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
function updateAircraftPositions(aircraftData) {
    if (!aircraftData) return;
    
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
                
                // Create custom icon with altitude label
                const icon = L.divIcon({
                    className: 'aircraft-marker-icon',
                    html: `
                      <div style="position: relative; width: 80px; margin-left: -25px; margin-top: -30px;">
                        <div class="aircraft-marker-label callsign">${aircraft.callsign}</div>
                        <div class="aircraft-icon" style="transform: rotate(${aircraft.heading || 0}deg); text-align: center; font-size: 24px;">
                          ✈️
                        </div>
                        <div class="aircraft-marker-label altitude">${altDisplay} <span class="indicator">${vspeedIndicator}</span></div>
                      </div>
                    `,
                    iconSize: [80, 60],
                    iconAnchor: [40, 30]
                });

                const marker = L.marker([lat, lon], { icon: icon }).addTo(map);

                // Create popup content
                const popupContent = `
                    <div class="aircraft-popup">
                      <div class="popup-header" style="background-color: ${aircraft.color}">
                        <strong>${aircraft.callsign}</strong>
                      </div>
                      <div class="popup-body">
                        <div class="popup-row">
                          <span class="popup-label">Altitude:</span>
                          <span class="popup-value">${aircraft.altitude?.toLocaleString() || 0} ft</span>
                        </div>
                        <div class="popup-row">
                          <span class="popup-label">Speed:</span>
                          <span class="popup-value">${aircraft.speed || 0} kts</span>
                        </div>
                        <div class="popup-row">
                          <span class="popup-label">Heading:</span>
                          <span class="popup-value">${aircraft.heading || 0}°</span>
                        </div>
                        ${aircraft.departure ? `
                        <div class="popup-row">
                          <span class="popup-label">From:</span>
                          <span class="popup-value">${aircraft.departure}</span>
                        </div>
                        ` : ''}
                        ${aircraft.arrival ? `
                        <div class="popup-row">
                          <span class="popup-label">To:</span>
                          <span class="popup-value">${aircraft.arrival}</span>
                        </div>
                        ` : ''}
                      </div>
                    </div>
                `;

                marker.bindPopup(popupContent);
                marker.on('click', () => marker.openPopup());

                aircraftMarkers[key] = marker;
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
                
                // Update icon with new altitude and heading
                const icon = L.divIcon({
                    className: 'aircraft-marker-icon',
                    html: `
                      <div style="position: relative; width: 80px; margin-left: -25px; margin-top: -30px;">
                        <div class="aircraft-marker-label callsign">${aircraft.callsign}</div>
                        <div class="aircraft-icon" style="transform: rotate(${aircraft.heading || 0}deg); text-align: center; font-size: 24px;">
                          ✈️
                        </div>
                        <div class="aircraft-marker-label altitude">${altDisplay} <span class="indicator">${vspeedIndicator}</span></div>
                      </div>
                    `,
                    iconSize: [80, 60],
                    iconAnchor: [40, 30]
                });
                
                aircraftMarkers[key].setIcon(icon);

                // Update popup content
                const popupContent = `
                    <div class="aircraft-popup">
                      <div class="popup-header" style="background-color: ${aircraft.color}">
                        <strong>${aircraft.callsign}</strong>
                      </div>
                      <div class="popup-body">
                        <div class="popup-row">
                          <span class="popup-label">Altitude:</span>
                          <span class="popup-value">${aircraft.altitude?.toLocaleString() || 0} ft</span>
                        </div>
                        <div class="popup-row">
                          <span class="popup-label">Speed:</span>
                          <span class="popup-value">${aircraft.speed || 0} kts</span>
                        </div>
                        <div class="popup-row">
                          <span class="popup-label">Heading:</span>
                          <span class="popup-value">${aircraft.heading || 0}°</span>
                        </div>
                        ${aircraft.departure ? `
                        <div class="popup-row">
                          <span class="popup-label">From:</span>
                          <span class="popup-value">${aircraft.departure}</span>
                        </div>
                        ` : ''}
                        ${aircraft.arrival ? `
                        <div class="popup-row">
                          <span class="popup-label">To:</span>
                          <span class="popup-value">${aircraft.arrival}</span>
                        </div>
                        ` : ''}
                      </div>
                    </div>
                `;

                aircraftMarkers[key].setPopupContent(popupContent);
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
function updateTimeDisplay(time) {
    const displayEl = document.getElementById('timeDisplay');
    if (time) {
        // If time is an ISO string from simulation
        const timeObj = new Date(time);
        displayEl.textContent = `Time: ${timeObj.toISOString().split('T')[1].slice(0, 8)}`;
    } else {
        displayEl.textContent = `Time: ${currentTime.toFixed(1)}s`;
    }
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
    
    if (distances.length === 0) {
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
    const listEl = document.getElementById('aircraftList');
    if (!listEl) return;
    
    if (aircraft.length === 0) {
        listEl.innerHTML = '<div class="no-aircraft">No active aircraft</div>';
        return;
    }
    
    listEl.innerHTML = aircraft.map(ac => {
        const status = ac.position?.active ? '✓ Active' : '○ Waiting';
        
        // Determine vertical speed indicator
        let vspeedIndicator = '➡️';
        let vspeedClass = 'level';
        if (ac.verticalSpeed > 100) {
            vspeedIndicator = '🔼';
            vspeedClass = 'climbing';
        } else if (ac.verticalSpeed < -100) {
            vspeedIndicator = '🔽';
            vspeedClass = 'descending';
        }
        
        const altitudeDisplay = ac.altitude ? `
            <div class="altitude-display">
                <span class="altitude-indicator ${vspeedClass}">${vspeedIndicator}</span>
                <span class="altitude-value">${ac.altitude.toLocaleString()} ft</span>
                ${Math.abs(ac.verticalSpeed || 0) > 100 ? 
                  `<span style="font-size: 10px;">(${ac.verticalSpeed > 0 ? '+' : ''}${ac.verticalSpeed} ft/min)</span>` 
                  : ''}
            </div>
        ` : '';
        
        return `
            <div class="aircraft-card">
                <div style="display: flex; align-items: center; justify-content: space-between;">
                    <div style="display: flex; align-items: center; gap: 10px; flex: 1;">
                        <div class="aircraft-marker" style="background-color: ${ac.color}"></div>
                        <div style="flex: 1;">
                            <div style="font-weight: bold;">${ac.callsign}</div>
                            <div style="font-size: 11px; color: #95a5a6;">${status}</div>
                            ${altitudeDisplay}
                        </div>
                    </div>
                    <button class="btn btn-danger btn-small" onclick="deleteAircraft('${ac.id}')">🗑️</button>
                </div>
            </div>
        `;
    }).join('');
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
