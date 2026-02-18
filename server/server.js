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
try {
  const missionPath = path.join(__dirname, '../missions/example-mission.json');
  missionData = JSON.parse(fs.readFileSync(missionPath, 'utf8'));
  console.log('Mission data loaded successfully');
} catch (error) {
  console.error('Error loading mission data:', error.message);
}

// API endpoints
app.get('/api/mission', (req, res) => {
  if (missionData) {
    res.json(missionData);
  } else {
    res.status(500).json({ error: 'Mission data not available' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// WebSocket connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Send mission data on connection
  if (missionData) {
    socket.emit('mission-data', missionData);
  }

  // Handle client requests
  socket.on('request-mission', () => {
    if (missionData) {
      socket.emit('mission-data', missionData);
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
