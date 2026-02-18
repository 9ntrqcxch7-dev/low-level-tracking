# 🛩️ Low-Level Aircraft Tracking System

**Real-time Aircraft Low-Level Navigation Tracking**

A web-based system for tracking multiple aircraft in real-time, visualizing their routes, and monitoring potential intersections. Built with Node.js, Express, Socket.io, and Leaflet.

## ✨ Features

- ✈️ **Real-time aircraft position tracking** - Monitor multiple aircraft simultaneously
- 🗺️ **Interactive map visualization** - Using Leaflet for smooth map interactions
- 🔴 **Multi-aircraft support** - Track multiple aircraft with color-coded routes
- ⚡ **WebSocket-based live updates** - Real-time data streaming via Socket.io
- ⏱️ **Time acceleration** - Control playback speed from 1x to 300x
- 🎮 **Playback controls** - Play, pause, and reset animations
- 🌐 **Network accessible** - View from anywhere on your local network
- 📍 **Route visualization** - Color-coded flight paths for each aircraft

## 📋 Prerequisites

- **Node.js** 18+ (LTS recommended)
- **npm** (comes with Node.js)
- **Docker** (optional, for containerized deployment)

## 🚀 Installation

### Standard Installation

```bash
# Clone the repository
git clone https://github.com/9ntrqcxch7-dev/low-level-tracking.git
cd low-level-tracking

# Install dependencies
cd server
npm install

# Start the server
npm start
```

### Docker Installation

```bash
# Clone the repository
git clone https://github.com/9ntrqcxch7-dev/low-level-tracking.git
cd low-level-tracking

# Build and run with Docker Compose
docker-compose up -d

# View logs
docker-compose logs -f
```

## 📖 Usage

### Accessing the Application

Once the server is running, you can access the tracking system:

- **Locally**: 
  - http://localhost:3000
  - http://127.0.0.1:3000

- **On your network**: 
  - The server will display network URLs on startup
  - Example: http://192.168.1.100:3000
  - Share this URL with other devices on your network

### Using the Interface

1. **Play/Pause**: Control the simulation with the play and pause buttons
2. **Reset**: Return all aircraft to their starting positions
3. **Speed Control**: Adjust the playback speed from 1x to 300x using the slider
4. **Aircraft Info**: View real-time data for each aircraft in the info panel
5. **Map Interaction**: Click on aircraft markers to see detailed information

## 🛠️ Configuration

### Adding Custom Missions

Create a new mission file in the `missions/` directory:

```json
{
  "mission": "Your Mission Name",
  "aircraft": [
    {
      "id": "AC001",
      "callsign": "HAWK-1",
      "type": "F-16",
      "route": [
        { "lat": 51.505, "lon": -0.09, "alt": 500, "time": 0 },
        { "lat": 51.510, "lon": -0.08, "alt": 450, "time": 30 }
      ],
      "color": "#FF4444"
    }
  ]
}
```

Update `server/server.js` to load your custom mission file.

## 📁 Project Structure

```
low-level-tracking/
├── .gitignore              # Git ignore rules
├── README.md               # This file
├── Dockerfile              # Docker container configuration
├── docker-compose.yml      # Docker Compose orchestration
├── server/
│   ├── package.json        # Server dependencies
│   └── server.js           # Express + Socket.io server
├── public/
│   ├── index.html          # Main HTML page
│   ├── app.js              # Client-side JavaScript
│   └── style.css           # Styling
└── missions/
    └── example-mission.json # Sample mission data
```

## 🔧 Development

### Running in Development Mode

```bash
cd server
npm run dev
```

### Testing

The server includes health check endpoint:
- `GET /api/health` - Server health status
- `GET /api/mission` - Current mission data

## 🐳 Docker Commands

```bash
# Build the image
docker-compose build

# Start the container
docker-compose up -d

# Stop the container
docker-compose down

# View logs
docker-compose logs -f

# Rebuild and restart
docker-compose up -d --build
```

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

This project is open source and available under the ISC License.

## 🙏 Acknowledgments

- [Leaflet](https://leafletjs.com/) - Interactive map library
- [Socket.io](https://socket.io/) - Real-time WebSocket communication
- [Express](https://expressjs.com/) - Web framework for Node.js
- [OpenStreetMap](https://www.openstreetmap.org/) - Map tiles

## 📧 Support

For issues, questions, or contributions, please open an issue on GitHub.

---

Made with ❤️ for aviation enthusiasts and developers
