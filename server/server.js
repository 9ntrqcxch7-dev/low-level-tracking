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

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

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
      
      // Process route to add required fields
      const processedAircraft = {
        id: aircraft.id,
        callsign: aircraft.callsign,
        type: 'Custom',
        color: aircraft.color,
        route: aircraft.route.map((point, index) => ({
          lat: point.lat,
          lon: point.lng || point.lon,
          alt: 300, // Default altitude
          time: index * 30 // 30 seconds between waypoints
        }))
      };
      
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
        name: 'Custom Mission',
        description: 'User-created mission',
        startTime: new Date().toISOString(),
        aircraft: simulation.aircraft.map(ac => ({
          id: ac.id,
          callsign: ac.callsign,
          startTime: new Date().toISOString(),
          speed: 250,
          color: ac.color,
          route: ac.route.map(point => ({
            lat: point.lat,
            lng: point.lon
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
      
      // Process loaded aircraft
      const processedAircraft = loadedMission.aircraft.map(ac => ({
        id: ac.id,
        callsign: ac.callsign,
        type: ac.type || 'Custom',
        color: ac.color,
        route: ac.route.map((point, index) => ({
          lat: point.lat,
          lon: point.lng || point.lon,
          alt: point.alt || 300,
          time: index * 30
        }))
      }));
      
      simulation.aircraft = processedAircraft;
      simulation.aircraftCounter = processedAircraft.length;
      
      // Broadcast updated mission to all clients
      const responseData = {
        mission: loadedMission.name || 'Loaded Mission',
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
