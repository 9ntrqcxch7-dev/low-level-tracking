const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: "*", // Allow all origins for development. For production, restrict to specific domains.
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;
const SIMULATION_BASE_TIME = new Date('2024-01-01T07:00:00Z');
const DEFAULT_AIRCRAFT_SPEED = 250;
const DEFAULT_AIRCRAFT_ALTITUDE = 3000;
const MAX_AIRCRAFT = Number(process.env.MAX_AIRCRAFT) || 200;
const MAX_ROUTE_POINTS = Number(process.env.MAX_ROUTE_POINTS) || 200;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Add at the top after initial declarations
const CONFLICT_THRESHOLDS = {
  CRITICAL: { horizontal: 5, vertical: 1000 },  // 5 NM, 1000 ft
  WARNING: { horizontal: 10, vertical: 2000 }    // 10 NM, 2000 ft
};

// Simulation state
let simulationInterval = null;
let simulationRunning = false;
let simulationTime = new Date(SIMULATION_BASE_TIME.getTime()); // Start time
let simulationSpeed = 1; // Speed multiplier

// Load mission data
let missionData = null;
let simulation = {
  aircraft: [],
  aircraftCounter: 0
};

try {
  const missionPath = path.join(__dirname, '../missions/example-mission.json');
  missionData = JSON.parse(fs.readFileSync(missionPath, 'utf8'));
  simulation.aircraft = missionData.aircraft || [];
  // Set counter based on existing aircraft
  simulation.aircraftCounter = simulation.aircraft.length;
  console.log('Mission data loaded successfully');
} catch (error) {
  console.error('Error loading mission data:', error.message);
  simulation.aircraft = [];
}

// API endpoints
app.get('/api/mission', (req, res) => {
  const responseData = {
    mission: missionData ? missionData.mission : 'Current Mission',
    aircraft: simulation.aircraft
  };
  res.json(responseData);
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Haversine distance calculation (in nautical miles)
function haversineDistance(pos1, pos2) {
  const R = 3440.065; // Earth radius in nautical miles
  const lat1 = pos1.lat * Math.PI / 180;
  const lat2 = pos2.lat * Math.PI / 180;
  const deltaLat = (pos2.lat - pos1.lat) * Math.PI / 180;
  const deltaLon = (pos2.lon - pos1.lon) * Math.PI / 180;

  const a = Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
            Math.cos(lat1) * Math.cos(lat2) *
            Math.sin(deltaLon / 2) * Math.sin(deltaLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

function toFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sanitizeText(value, maxLength = 32) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[<>&"']/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function sanitizeAircraftId(value, fallbackId) {
  const raw = sanitizeText(String(value || ''), 32);
  const normalized = raw.replace(/[^A-Za-z0-9_-]/g, '');
  return normalized || fallbackId;
}

function sanitizeIcao(value) {
  const code = sanitizeText(String(value || ''), 4).toUpperCase();
  return /^[A-Z]{4}$/.test(code) ? code : '';
}

function normalizeColor(value) {
  const color = typeof value === 'string' ? value.trim() : '';
  return /^#[A-Fa-f0-9]{6}$/.test(color) ? color.toUpperCase() : '#3388FF';
}

function normalizeRoutePoint(point) {
  if (!point || typeof point !== 'object') return null;

  const lat = toFiniteNumber(point.lat);
  const lon = toFiniteNumber(point.lon ?? point.lng);
  if (lat === null || lon === null) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  const altCandidate = toFiniteNumber(point.alt);
  const altitude = Math.round(
    altCandidate === null ? DEFAULT_AIRCRAFT_ALTITUDE : clamp(altCandidate, 0, 60000)
  );

  return {
    lat,
    lon,
    alt: altitude
  };
}

function resolveUniqueAircraftId(candidateId, usedIds) {
  if (!usedIds.has(candidateId)) {
    usedIds.add(candidateId);
    return candidateId;
  }

  let suffix = 1;
  let nextId = `${candidateId}-${suffix}`;
  while (usedIds.has(nextId)) {
    suffix += 1;
    nextId = `${candidateId}-${suffix}`;
  }
  usedIds.add(nextId);
  return nextId;
}

function normalizeAircraft(rawAircraft, fallbackId, usedIds) {
  if (!rawAircraft || typeof rawAircraft !== 'object') return null;

  const route = Array.isArray(rawAircraft.route) ? rawAircraft.route : [];
  if (route.length < 2 || route.length > MAX_ROUTE_POINTS) return null;

  const normalizedRoute = route
    .map(normalizeRoutePoint)
    .filter(Boolean);
  if (normalizedRoute.length < 2) return null;

  const speedCandidate = toFiniteNumber(rawAircraft.speed);
  const speed = speedCandidate === null
    ? DEFAULT_AIRCRAFT_SPEED
    : clamp(speedCandidate, 50, 1200);

  const startTimeRaw = rawAircraft.startTime ? new Date(rawAircraft.startTime) : null;
  const startTime = startTimeRaw && !Number.isNaN(startTimeRaw.getTime())
    ? startTimeRaw.toISOString()
    : simulationTime.toISOString();

  const idBase = sanitizeAircraftId(rawAircraft.id, fallbackId);
  const id = resolveUniqueAircraftId(idBase, usedIds);

  return {
    id,
    callsign: sanitizeText(rawAircraft.callsign, 24) || id,
    type: sanitizeText(rawAircraft.type, 24) || 'Custom',
    color: normalizeColor(rawAircraft.color),
    speed: Math.round(speed),
    startTime,
    departure: sanitizeIcao(rawAircraft.departure),
    arrival: sanitizeIcao(rawAircraft.arrival),
    route: normalizedRoute
  };
}

// Calculate current position and altitude for an aircraft
function calculateAircraftState(aircraft, currentTime) {
  if (!aircraft.route || aircraft.route.length < 2) {
    return null;
  }

  const startTime = new Date(aircraft.startTime || simulationTime);
  const elapsed = (currentTime - startTime) / 1000; // seconds

  if (elapsed < 0) {
    return {
      active: false,
      lat: aircraft.route[0].lat,
      lon: aircraft.route[0].lon,
      altitude: aircraft.route[0].alt || 3000,
      heading: 0
    };
  }

  // Calculate position along route
  const speed = aircraft.speed || 250; // knots
  const speedNmPerSec = speed / 3600; // nautical miles per second
  const distanceTraveled = elapsed * speedNmPerSec;

  // Calculate cumulative distances between waypoints
  const segments = [];
  for (let i = 0; i < aircraft.route.length - 1; i++) {
    const p1 = aircraft.route[i];
    const p2 = aircraft.route[i + 1];
    const segmentDist = haversineDistance(
      { lat: p1.lat, lon: p1.lon },
      { lat: p2.lat, lon: p2.lon }
    );
    segments.push({
      start: p1,
      end: p2,
      distance: segmentDist,
      startAlt: p1.alt || 3000,
      endAlt: p2.alt || 3000
    });
  }

  const totalDistance = segments.reduce((sum, seg) => sum + seg.distance, 0);

  // Check if aircraft has completed route
  if (distanceTraveled >= totalDistance) {
    const lastPoint = aircraft.route[aircraft.route.length - 1];
    return {
      active: true,
      completed: true,
      lat: lastPoint.lat,
      lon: lastPoint.lon,
      altitude: lastPoint.alt || 3000,
      heading: 0,
      verticalSpeed: 0
    };
  }

  // Find current segment
  let cumulativeDist = 0;
  let currentSegment = null;
  let segmentProgress = 0;

  for (const segment of segments) {
    if (distanceTraveled <= cumulativeDist + segment.distance) {
      currentSegment = segment;
      segmentProgress = segment.distance > 0
        ? (distanceTraveled - cumulativeDist) / segment.distance
        : 1;
      break;
    }
    cumulativeDist += segment.distance;
  }

  if (!currentSegment) {
    currentSegment = segments[segments.length - 1];
    segmentProgress = 1;
  }

  // Interpolate position
  const lat = currentSegment.start.lat + 
              (currentSegment.end.lat - currentSegment.start.lat) * segmentProgress;
  const lon = currentSegment.start.lon + 
              (currentSegment.end.lon - currentSegment.start.lon) * segmentProgress;

  // Interpolate altitude
  const altitude = currentSegment.startAlt + 
                   (currentSegment.endAlt - currentSegment.startAlt) * segmentProgress;

  // Calculate vertical speed (ft/min)
  const altDiff = currentSegment.endAlt - currentSegment.startAlt;
  const timeForSegment = currentSegment.distance > 0
    ? (currentSegment.distance / speedNmPerSec)
    : 0;
  const verticalSpeed = timeForSegment > 0 ? (altDiff / timeForSegment) * 60 : 0; // ft/min

  // Calculate heading
  const deltaLon = currentSegment.end.lon - currentSegment.start.lon;
  const deltaLat = currentSegment.end.lat - currentSegment.start.lat;
  const heading = (Math.atan2(deltaLon, deltaLat) * 180 / Math.PI + 360) % 360;

  return {
    active: true,
    lat: lat,
    lon: lon,
    altitude: Math.round(altitude),
    heading: Math.round(heading),
    verticalSpeed: Math.round(verticalSpeed)
  };
}

// Detect conflicts between aircraft
function detectConflicts(aircraftStates) {
  const conflicts = [];

  for (let i = 0; i < aircraftStates.length; i++) {
    for (let j = i + 1; j < aircraftStates.length; j++) {
      const ac1 = aircraftStates[i];
      const ac2 = aircraftStates[j];

      if (!ac1.position.active || !ac2.position.active) continue;

      const horizontalDist = haversineDistance(
        { lat: ac1.position.lat, lon: ac1.position.lon },
        { lat: ac2.position.lat, lon: ac2.position.lon }
      );

      const verticalSep = Math.abs(ac1.altitude - ac2.altitude);

      let severity = null;
      if (horizontalDist < CONFLICT_THRESHOLDS.CRITICAL.horizontal && 
          verticalSep < CONFLICT_THRESHOLDS.CRITICAL.vertical) {
        severity = 'CRITICAL';
      } else if (horizontalDist < CONFLICT_THRESHOLDS.WARNING.horizontal && 
                 verticalSep < CONFLICT_THRESHOLDS.WARNING.vertical) {
        severity = 'WARNING';
      }

      if (severity) {
        conflicts.push({
          aircraft1: { id: ac1.id, callsign: ac1.callsign },
          aircraft2: { id: ac2.id, callsign: ac2.callsign },
          horizontalDistance: horizontalDist.toFixed(1),
          verticalSeparation: Math.round(verticalSep),
          severity: severity
        });
      }
    }
  }

  return conflicts;
}

// Calculate distances between all aircraft pairs
function calculateDistances(aircraftStates) {
  const distances = [];

  for (let i = 0; i < aircraftStates.length; i++) {
    for (let j = i + 1; j < aircraftStates.length; j++) {
      const ac1 = aircraftStates[i];
      const ac2 = aircraftStates[j];

      if (!ac1.position.active || !ac2.position.active) continue;

      const horizontalDist = haversineDistance(
        { lat: ac1.position.lat, lon: ac1.position.lon },
        { lat: ac2.position.lat, lon: ac2.position.lon }
      );

      const verticalSep = Math.abs(ac1.altitude - ac2.altitude);
      const distance3D = Math.sqrt(
        Math.pow(horizontalDist, 2) + 
        Math.pow(verticalSep / 6076.12, 2) // Convert feet to NM
      );

      distances.push({
        aircraft1: { id: ac1.id, callsign: ac1.callsign },
        aircraft2: { id: ac2.id, callsign: ac2.callsign },
        horizontal: horizontalDist.toFixed(1),
        vertical: Math.round(verticalSep),
        total: distance3D.toFixed(1)
      });
    }
  }

  return distances;
}

// Calculate detailed separations for separation monitor
function calculateSeparations(aircraftStates) {
  const separations = [];

  for (let i = 0; i < aircraftStates.length; i++) {
    for (let j = i + 1; j < aircraftStates.length; j++) {
      const ac1 = aircraftStates[i];
      const ac2 = aircraftStates[j];

      if (!ac1.position.active || !ac2.position.active) continue;

      const horizontalDist = haversineDistance(
        { lat: ac1.position.lat, lon: ac1.position.lon },
        { lat: ac2.position.lat, lon: ac2.position.lon }
      );

      const verticalSep = Math.abs(ac1.altitude - ac2.altitude);
      
      // Calculate relative speed (approximate)
      const speed1 = ac1.speed || 250;
      const speed2 = ac2.speed || 250;
      const relativeSpeed = Math.abs(speed1 - speed2);
      
      // Estimate time to CPA (simple approximation)
      let timeToCPA = null;
      if (relativeSpeed > 0 && horizontalDist < 20) {
        // Convert NM/hour to NM/second, then calculate time
        timeToCPA = (horizontalDist / (relativeSpeed / 3600));
      }

      separations.push({
        aircraft1: ac1.callsign,
        aircraft2: ac2.callsign,
        horizontal: horizontalDist,
        vertical: verticalSep,
        relativeSpeed: relativeSpeed,
        timeToCPA: timeToCPA
      });
    }
  }

  // Sort by horizontal distance (closest first)
  separations.sort((a, b) => a.horizontal - b.horizontal);

  return separations;
}

// Simulation update function
function updateSimulation() {
  if (!simulationRunning) return;

  const aircraftStates = simulation.aircraft.map(ac => {
    const state = calculateAircraftState(ac, simulationTime);
    if (!state) return null;

    return {
      id: ac.id,
      callsign: ac.callsign,
      type: ac.type || 'Unknown',
      color: ac.color,
      speed: ac.speed || 250,
      departure: ac.departure || '',
      arrival: ac.arrival || '',
      startTime: ac.startTime || null,
      route: ac.route || [],
      position: state,
      altitude: state.altitude,
      heading: state.heading,
      verticalSpeed: state.verticalSpeed || 0
    };
  }).filter(ac => ac !== null);

  const conflicts = detectConflicts(aircraftStates);
  const distances = calculateDistances(aircraftStates);
  const separations = calculateSeparations(aircraftStates);

  // Broadcast update to all clients
  io.emit('simulation-update', {
    time: simulationTime.toISOString(),
    elapsedSeconds: Math.max(0, Math.round((simulationTime - SIMULATION_BASE_TIME) / 1000)),
    aircraft: aircraftStates,
    conflicts: conflicts,
    distances: distances,
    separations: separations
  });

  // Advance simulation time
  simulationTime = new Date(simulationTime.getTime() + (1000 * simulationSpeed));
}

// WebSocket connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Send mission data on connection
  const responseData = {
    mission: missionData ? missionData.mission : 'Current Mission',
    aircraft: simulation.aircraft
  };
  socket.emit('mission-data', responseData);

  // Handle client requests
  socket.on('request-mission', () => {
    const responseData = {
      mission: missionData ? missionData.mission : 'Current Mission',
      aircraft: simulation.aircraft
    };
    socket.emit('mission-data', responseData);
  });
  
  // Add aircraft
  socket.on('addAircraft', (aircraft) => {
    try {
      console.log('Adding aircraft:', aircraft);

      if (simulation.aircraft.length >= MAX_AIRCRAFT) {
        socket.emit('error', { message: `Maximum number of aircraft reached (${MAX_AIRCRAFT})` });
        return;
      }

      const usedIds = new Set(simulation.aircraft.map(ac => ac.id));
      const fallbackId = `AC${simulation.aircraftCounter + 1}`;
      const processedAircraft = normalizeAircraft(aircraft, fallbackId, usedIds);
      if (!processedAircraft) {
        socket.emit('error', { message: 'Invalid aircraft payload. Route must contain at least 2 valid waypoints.' });
        return;
      }

      simulation.aircraft.push(processedAircraft);
      simulation.aircraftCounter++;
      
      // Broadcast updated mission to all clients
      const responseData = {
        mission: 'Current Mission',
        aircraft: simulation.aircraft
      };
      io.emit('mission-data', responseData);
      
      console.log('Aircraft added successfully');
    } catch (error) {
      console.error('Error adding aircraft:', error);
      socket.emit('error', { message: 'Failed to add aircraft' });
    }
  });
  
  // Delete aircraft
  socket.on('deleteAircraft', (data) => {
    try {
      console.log('Deleting aircraft:', data.id);
      
      const index = simulation.aircraft.findIndex(ac => ac.id === data.id);
      if (index !== -1) {
        simulation.aircraft.splice(index, 1);
        
        // Broadcast updated mission to all clients
        const responseData = {
          mission: 'Current Mission',
          aircraft: simulation.aircraft
        };
        io.emit('mission-data', responseData);
        
        console.log('Aircraft deleted successfully');
      } else {
        socket.emit('error', { message: 'Aircraft not found' });
      }
    } catch (error) {
      console.error('Error deleting aircraft:', error);
      socket.emit('error', { message: 'Failed to delete aircraft' });
    }
  });
  
  // Get mission (for save)
  socket.on('getMission', () => {
    try {
      const missionToSave = {
        mission: missionData?.mission || 'Custom Mission',
        name: missionData?.mission || 'Custom Mission',
        description: missionData?.description || 'User-created mission',
        startTime: simulationTime.toISOString(),
        aircraft: simulation.aircraft.map(ac => ({
          id: ac.id,
          callsign: ac.callsign,
          type: ac.type || 'Custom',
          startTime: ac.startTime || simulationTime.toISOString(),
          speed: ac.speed || DEFAULT_AIRCRAFT_SPEED,
          color: ac.color,
          departure: ac.departure || '',
          arrival: ac.arrival || '',
          route: ac.route.map(point => ({
            lat: point.lat,
            lon: point.lon,
            alt: point.alt ?? DEFAULT_AIRCRAFT_ALTITUDE
          }))
        }))
      };
      
      socket.emit('mission-saved', missionToSave);
      console.log('Mission data sent for saving');
    } catch (error) {
      console.error('Error getting mission:', error);
      socket.emit('error', { message: 'Failed to get mission data' });
    }
  });
  
  // Load mission
  socket.on('loadMission', (loadedMission) => {
    try {
      console.log('Loading mission:', loadedMission);

      if (!loadedMission || !Array.isArray(loadedMission.aircraft)) {
        socket.emit('error', { message: 'Invalid mission payload' });
        return;
      }

      if (loadedMission.aircraft.length > MAX_AIRCRAFT) {
        socket.emit('error', { message: `Mission has too many aircraft (max ${MAX_AIRCRAFT})` });
        return;
      }

      const usedIds = new Set();
      const processedAircraft = loadedMission.aircraft
        .map((ac, index) => normalizeAircraft(ac, `AC${index + 1}`, usedIds))
        .filter(Boolean);

      if (processedAircraft.length === 0) {
        socket.emit('error', { message: 'Mission does not contain any valid aircraft' });
        return;
      }

      simulation.aircraft = processedAircraft;
      simulation.aircraftCounter = processedAircraft.length;
      missionData = {
        mission: sanitizeText(loadedMission.name || loadedMission.mission || 'Loaded Mission', 64),
        description: sanitizeText(loadedMission.description || '', 256),
        aircraft: processedAircraft
      };
      
      // Broadcast updated mission to all clients
      const responseData = {
        mission: missionData.mission || 'Loaded Mission',
        aircraft: simulation.aircraft
      };
      io.emit('mission-data', responseData);
      
      console.log('Mission loaded successfully');
    } catch (error) {
      console.error('Error loading mission:', error);
      socket.emit('error', { message: 'Failed to load mission' });
    }
  });
  
  // Clear all aircraft
  socket.on('clearAll', () => {
    try {
      console.log('Clearing all aircraft');
      
      simulation.aircraft = [];
      simulation.aircraftCounter = 0;
      
      // Broadcast updated mission to all clients
      const responseData = {
        mission: 'Empty Mission',
        aircraft: []
      };
      io.emit('mission-data', responseData);
      
      console.log('All aircraft cleared');
    } catch (error) {
      console.error('Error clearing aircraft:', error);
      socket.emit('error', { message: 'Failed to clear aircraft' });
    }
  });

  // WebSocket handlers for simulation control
  socket.on('start-simulation', (data) => {
    if (!simulationRunning) {
      simulationRunning = true;
      const requestedSpeed = toFiniteNumber(data && data.speed);
      simulationSpeed = requestedSpeed === null ? 1 : clamp(requestedSpeed, 0.25, 300);
      const requestedOffset = toFiniteNumber(data && data.startTime);
      if (requestedOffset !== null && requestedOffset >= 0) {
        simulationTime = new Date(SIMULATION_BASE_TIME.getTime() + requestedOffset * 1000);
      }
      // Log the simulation time at the moment the client requested start
      console.log('Simulation requested start at server time:', simulationTime.toISOString(), 'speed:', simulationSpeed);
      simulationInterval = setInterval(updateSimulation, 1000);
      console.log('Simulation started');
    }
  });

  socket.on('pause-simulation', () => {
    simulationRunning = false;
    if (simulationInterval) {
      clearInterval(simulationInterval);
      simulationInterval = null;
    }
    console.log('Simulation paused');
  });

  socket.on('reset-simulation', () => {
    simulationRunning = false;
    if (simulationInterval) {
      clearInterval(simulationInterval);
      simulationInterval = null;
    }
    simulationTime = new Date(SIMULATION_BASE_TIME.getTime());
    console.log('Simulation reset');
  });

  socket.on('set-simulation-speed', (data) => {
    const requestedSpeed = toFiniteNumber(data && data.speed);
    simulationSpeed = requestedSpeed === null ? 1 : clamp(requestedSpeed, 0.25, 300);
    console.log('Simulation speed set to:', simulationSpeed);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Get local network IP addresses
function getNetworkAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }
  
  return addresses;
}

// Start server
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n🛩️  Low-Level Aircraft Tracking System');
  console.log('═══════════════════════════════════════════');
  console.log(`\n✅ Server running on port ${PORT}\n`);
  console.log('📍 Access URLs:');
  console.log(`   Local:   http://localhost:${PORT}`);
  console.log(`   Local:   http://127.0.0.1:${PORT}`);
  
  const networkAddresses = getNetworkAddresses();
  if (networkAddresses.length > 0) {
    networkAddresses.forEach(addr => {
      console.log(`   Network: http://${addr}:${PORT}`);
    });
  }
  
  console.log('\n═══════════════════════════════════════════\n');
});
