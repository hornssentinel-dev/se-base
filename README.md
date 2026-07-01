# SE Tracker

A web-based application for sales engineers to track opportunities, proof of concepts (PoCs), demos, and technical wins.

## Project Structure

```
se-tracker/
├── server.js              # Express server (handles storage API)
├── package.json           # Node.js dependencies
├── public/
│   ├── index.html         # HTML template
│   └── bundle.js          # Built React app (generated)
├── src/
│   ├── App.jsx            # Main React component
│   ├── index.jsx          # React entry point
│   └── index.css          # Tailwind styles
├── se-tracker.service     # Systemd service file
└── data/
    └── storage.json       # Persistent storage (auto-created)
```

## Installation

### 1. Install Node.js (if not already installed)

```bash
# Check if Node.js is installed
node --version

# If not installed, install it
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 2. Install dependencies

```bash
cd /home/rphalen/se_base
npm install
```

### 3. Build the React bundle

```bash
npm run build
```

## Running SE Tracker

### Option A: Run as a service (recommended for production)

```bash
# Copy service file to systemd
sudo cp /home/rphalen/se_base/se-tracker.service /etc/systemd/system/

# Reload systemd and enable the service
sudo systemctl daemon-reload
sudo systemctl enable se-tracker
sudo systemctl start se-tracker

# Check status
sudo systemctl status se-tracker

# View logs
sudo journalctl -u se-tracker -f
```

### Option B: Run manually (for development)

```bash
cd /home/rphalen/se_base
npm start
```

The app will be available at `http://localhost:3000`

## Configuration

### Change the port

Set the `PORT` environment variable:

```bash
PORT=8080 npm start
```

Or edit `se-tracker.service` to change the port:

```ini
Environment="PORT=8080"
```

### Data storage

All opportunity data is stored in `/home/rphalen/se_base/data/storage.json`. This file is automatically created on first run.

To backup your data:

```bash
cp /home/rphalen/se_base/data/storage.json ~/backup-$(date +%Y%m%d).json
```

## Features

- **Opportunity Tracking**: Track sales opportunities through SE stages
- **PoC Management**: Define and track proof of concept criteria
- **Demo Logging**: Record demo outcomes and audience feedback
- **Note Taking**: Capture discovery notes, technical requirements, and objections
- **Health Status**: Real-time PoC health indicators (green/amber/red)
- **Data Export/Import**: Export opportunities as JSON or import from backup
- **Auto-save**: Changes are saved automatically to persistent storage

## Troubleshooting

### Port 3000 already in use

```bash
# Find the process using port 3000
lsof -i :3000

# Kill the process
kill -9 <PID>

# Or use a different port
PORT=3001 npm start
```

### Service fails to start

Check the logs:

```bash
sudo journalctl -u se-tracker -n 50
```

Common issues:
- Node.js not installed
- Port already in use
- Missing dependencies (`npm install`)
- React bundle not built (`npm run build`)

### Data not persisting

Ensure the `data/` directory has write permissions:

```bash
chmod 755 /home/rphalen/se_base/data
```

## Stopping the service

```bash
sudo systemctl stop se-tracker
```

## Restarting the service

```bash
sudo systemctl restart se-tracker
```

## Disabling the service

```bash
sudo systemctl disable se-tracker
```

## Development

To rebuild the React bundle after making changes:

```bash
npm run build
```

To run both the server and watch for changes:

```bash
npm run dev
```

## API Endpoints

The server provides a simple storage API:

- `GET /api/storage/:key` - Get stored data
- `POST /api/storage/:key` - Save data
- `GET /api/health` - Health check

## Browser Support

SE Tracker uses modern web APIs and is best experienced in:
- Chrome/Chromium (latest)
- Firefox (latest)
- Safari (latest)
- Edge (latest)
