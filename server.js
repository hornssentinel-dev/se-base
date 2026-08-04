import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const STORAGE_FILE = path.join(DATA_DIR, 'storage.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Serve the app source straight from the project root — the browser transforms
// its JSX with Babel standalone, so this file is read fresh on every request
// and there's no separate build/bundle step.
app.get('/se-tracker.jsx', (req, res) => {
  res.type('text/babel').sendFile(path.join(__dirname, 'se-tracker.jsx'));
});

// Storage API endpoints
app.get('/api/storage/:key', (req, res) => {
  try {
    if (!fs.existsSync(STORAGE_FILE)) {
      return res.json({ value: null });
    }
    const storage = JSON.parse(fs.readFileSync(STORAGE_FILE, 'utf-8'));
    res.json({ value: storage[req.params.key] || null });
  } catch (err) {
    console.error('Storage read error:', err);
    res.status(500).json({ error: 'Failed to read storage' });
  }
});

app.post('/api/storage/:key', (req, res) => {
  try {
    let storage = {};
    if (fs.existsSync(STORAGE_FILE)) {
      storage = JSON.parse(fs.readFileSync(STORAGE_FILE, 'utf-8'));
    }
    storage[req.params.key] = req.body.value;
    fs.writeFileSync(STORAGE_FILE, JSON.stringify(storage, null, 2));
    res.json({ success: true });
  } catch (err) {
    console.error('Storage write error:', err);
    res.status(500).json({ error: 'Failed to write storage' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve index.html for all other routes (SPA)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`SE Tracker running at http://localhost:${PORT}`);
  console.log(`Data stored at ${STORAGE_FILE}`);
});
