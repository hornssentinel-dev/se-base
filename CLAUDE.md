# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick Start

**Development server:**
```bash
npm install    # Install dependencies
npm start      # Runs on http://localhost:3000
```

The server watches for changes to se-tracker.jsx and serves it via Express. No separate build step is needed — React, Tailwind, and Lucide icons load from CDN in public/index.html.

**Production deployment:**
```bash
sudo cp se-tracker.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable se-tracker && sudo systemctl start se-tracker
```

Change the port via `PORT=8080 npm start` or by editing the systemd service file.

## Architecture

### Overall Design
SE Tracker is a full-stack opportunity tracking app:
- **Frontend**: Single-page React app (se-tracker.jsx) with client-side state management
- **Backend**: Express server providing a simple file-based REST API
- **Storage**: JSON file at data/storage.json (auto-created on first run)

### Key Flows

**Data Persistence (Auto-save Pattern)**
1. User interacts with React UI → state updates via `setState`
2. React effect or event handler calls `saveStorage()` (a fetch POST to `/api/storage/:key`)
3. Backend writes JSON to disk
4. On app load or navigation, `loadStorage()` fetches from `/api/storage/:key` and populates state

**Health Calculation**
`derivePocHealth(opp)` derives a PoC's health status (green/amber/red/none) based on:
- Whether PoC is active
- Criteria statuses (fail/blocked → red, all pass → green)
- Target date overdue → amber

This computation happens client-side during render; no server involvement.

### React Component Architecture
**se-tracker.jsx** is a monolithic component managing:
- `opportunities`: Main data structure (array of opp objects)
- `currentOpp`: Currently selected opportunity
- `view`: Navigation state (list, detail, settings)
- Dozens of event handlers for CRUD operations on opportunities, notes, demos, PoC criteria

Key React patterns used:
- `useState` for component state
- `useEffect` for side effects (load/save storage)
- `useMemo` for computed values (health indicators, filtering)
- Inline event handlers (no separate handler functions)

### Backend Endpoints
```
GET  /api/storage/:key       # Fetch stored data (returns { value: ... })
POST /api/storage/:key       # Save data (body: { value: ... })
GET  /api/health             # Health check (returns { status: 'ok', timestamp: ... })
GET  *                        # SPA fallback (serves index.html)
```

The storage is a flat JSON object with keys like `"se-tracker:opps:v1"`. Values can be any JSON-serializable data.

### Data Model

**Opportunity**
```javascript
{
  id: string,
  account: string,
  segment: string,
  acv: number,
  closeDate: "YYYY-MM-DD",
  seStage: string,        // One of SE_STAGES
  products: string[],     // Subset of PRODUCTS
  champion: string,
  competitor: string,
  nextAction: string,
  createdAt: "YYYY-MM-DD",
  notes: Note[],
  demos: Demo[],
  poc: PoC | null
}
```

**PoC (Proof of Concept)**
```javascript
{
  active: boolean,
  startDate: "YYYY-MM-DD",
  targetDate: "YYYY-MM-DD",
  criteria: Criterion[]
}
```

**Criterion**
```javascript
{
  id: string,
  label: string,
  status: "pending" | "pass" | "fail" | "blocked",
  owner: string,          // "SE" | "Customer" | "Joint"
  note: string
}
```

**Note & Demo**
- Note: `{ id, date, type, body }`
- Demo: `{ id, date, products, audience, outcome, notes }`

### Important Constants
- `SE_STAGES`: ["Discovery", "Technical validation", "PoC", "Technical win", "Handoff / closed"]
- `PRODUCTS`: ["SWG", "CASB", "PA", "ADVDLP", "RBI", "DSPM", "ICAP", "FwaaS"]
- `NOTE_TYPES`: ["Discovery", "Call", "Technical", "Internal", "Risk"]
- `HEALTH`: { none, green, amber, red } — each with label, color, and Icon
- `POC_STATUS`: { pending, pass, fail, blocked } — each with label, color, and Icon

Storage key: `"se-tracker:opps:v1"`

## Common Changes

**Adding a new opportunity field:**
1. Update the `sampleOpp()` function signature (around line 54)
2. Add to the opp object structure in form handlers / detail views

**Changing the data model or storage schema:**
- Update `STORE_KEY` constant if the schema is incompatible
- Ensure `loadStorage()` and `saveStorage()` handle the new structure
- Consider migrations if old data needs to be preserved

**Styling:**
- Tailwind classes are available in public/index.html via CDN
- Colors and typography should use Tailwind utilities (e.g., `text-red-500`, `bg-slate-100`)
- Icons from Lucide React are already imported at the top

**Adding UI elements:**
- Icon imports are at the top; add new icons from lucide-react if needed
- All components are inline in se-tracker.jsx; no separate component files

## File Purposes

- **server.js** – Express server; handles CORS, serves static files, manages storage API and SPA routing
- **se-tracker.jsx** – Entire React UI; state management, rendering, event handling
- **public/index.html** – HTML template; loads React, Tailwind, Lucide from CDN
- **se-tracker.service** – Systemd service definition for production deployment
- **data/storage.json** – Runtime data file (created automatically); do not commit to version control

## Permissions

Pre-configured permissions (in .claude/settings.local.json) allow:
- Starting the server and running npm commands
- Health checks and test requests to localhost:3000
- Killing existing server processes
