# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick Start

**Development server:**
```bash
npm install          # Install dependencies
npm run create-admin # First run only: bootstrap an admin account
npm start            # Runs on http://localhost:3000
npm run check        # Syntax-check se-tracker.jsx (there's no build step)
```

Express serves se-tracker.jsx fresh on every request (no caching/watching layer), and public/index.html loads it as an in-browser Babel-transformed ES module. No separate build step is needed — React, Tailwind, and Lucide icons load from CDN, and an import map in public/index.html resolves the bare `react`/`lucide-react` specifiers to esm.sh builds. Edit se-tracker.jsx, then just refresh the browser.

**Production deployment:**
```bash
sudo cp se-tracker.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable se-tracker && sudo systemctl start se-tracker
```

Change the port via `PORT=8080 npm start` or by editing the systemd service file.

## Architecture

### Overall Design
SE Tracker is a multi-user, full-stack opportunity tracking app:
- **Frontend**: Single-page React app (se-tracker.jsx) with client-side state management
- **Backend**: Express server providing a session-authenticated REST API
- **Storage**: SQLite at data/se-tracker.db (auto-created on first run)

Each SE sees only their own opportunities and tasks. The business case library is
shared org-wide. Admins additionally get a Team tab and can read the whole org's
pipeline via `?all=1`.

### Key Flows

**Auth**
1. `App` (the shell at the bottom of se-tracker.jsx) calls `GET /api/auth/me` on mount
2. No session → `LoginScreen`; a `/invite/:token` URL → `InviteScreen`; otherwise `SETracker`
3. Sessions are rows in the `sessions` table keyed by an httpOnly cookie, so logout
   and account disabling take effect immediately (unlike a stateless JWT)
4. Any API call returning 401 throws `AuthError`, which drops the UI back to sign-in

There is no self-signup. `scripts/create-user.js` bootstraps the first account;
everyone else is invited by an admin, who copies the generated link and sends it
out of band (there is no mail transport).

**Data Persistence (per-record sync)**
1. User interacts with React UI → state updates via `setState`
2. `useSyncedCollection` diffs the collection against the last server-confirmed
   snapshot and issues a `PUT` per changed record and a `DELETE` per removed one
3. Backend writes each record in its own transaction
4. On load, the same hook fetches the collection and seeds the snapshot

Editing one opportunity writes only that opportunity. This replaced an earlier
scheme that reposted the entire array on every keystroke-level change, which both
sent multi-hundred-KB payloads and silently lost one of any two concurrent edits.
Because the snapshot is seeded at load time, a page load issues no writes at all.

**Note images**
Attachments are downscaled in the browser by `fileToImage`, uploaded to
`POST /api/images`, and stored on disk under `data/images/`; the note keeps only
`{ id, url }`. Read them through `imageSrc(img)`, which falls back to the older
inline `dataUrl` form so un-migrated notes still render.

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
POST /api/auth/login            # → sets session cookie
POST /api/auth/logout
GET  /api/auth/me               # 401 when signed out — the shell's auth probe
POST /api/auth/password
GET  /api/invite/:token         # unauthenticated: the token is the credential
POST /api/invite/:token/accept  # creates the user and signs them in

GET  /api/opportunities         # own rows; ?all=1 = whole org (admin only)
PUT  /api/opportunities/:id     # upsert
DELETE /api/opportunities/:id
GET|PUT|DELETE /api/business-cases[/:id]   # org-wide, not user-scoped
GET|PUT|DELETE /api/tasks[/:id]
POST /api/images                # { dataUrl } → { id, url }
GET  /api/images/:id

GET  /api/admin/users           # admin only, below here
PATCH /api/admin/users/:id      # role / status
GET|POST /api/admin/invites
DELETE /api/admin/invites/:token

GET  /api/health                # no auth
GET  *                          # SPA fallback (serves index.html)
```

Ownership is enforced server-side on every data route — a client cannot widen its
own scope. `scopeUser()` in server.js is the single place that decides whose rows
a request sees. Unmatched `/api/*` paths return a JSON 404 rather than falling
through to the SPA shell.

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
- Note: `{ id, date, type, body, images }` — `images` is `{ id, dataUrl }[]`; `dataUrl` is a downscaled, re-encoded JPEG data URL (see `fileToImage` in se-tracker.jsx), embedded inline since there's no separate upload endpoint/blob store
- Demo: `{ id, date, products, audience, outcome, notes }`

**BizCase (Business Case tab)**
```javascript
{
  id: string,
  product: string,   // one of PRODUCTS
  title: string,      // the business-value headline
  detail: string       // supporting proof point / technical capability behind it
}
```
Unlike notes/demos/PoC, business cases are **not** nested inside an opportunity — they're their own table, shared org-wide across every opportunity **and every user**. The Business Case tab filters this shared list by product so the same library of talking points shows up consistently everywhere that product comes up, and edits/deletes apply everywhere at once.

### Important Constants
- `SE_STAGES`: ["Discovery", "Technical validation", "PoC", "Technical win", "Handoff / closed"]
- `PRODUCTS`: ["SWG", "CASB", "PA", "ADVDLP", "RBI", "DSPM", "ICAP", "FwaaS"]
- `NOTE_TYPES`: ["Discovery", "Call", "Technical", "Internal", "Risk"]
- `HEALTH`: { none, green, amber, red } — each with label, color, and Icon
- `POC_STATUS`: { pending, pass, fail, blocked } — each with label, color, and Icon

### Database Tables
`users`, `sessions`, `invites`, `opportunities`, `business_cases`, `tasks` — see db.js
for the schema. `opportunities` and `tasks` carry a `user_id`; `business_cases` does
not, because it is shared.

An opportunity's `products`, `notes`, `demos`, and `poc` are JSON columns rather than
child tables. The UI always loads and saves them together with their parent opp, so
normalising them would buy no query flexibility we use while forcing a rewrite of most
of the component. Note images live on disk, which keeps these blobs small.

`rowToOpp` / `oppToRow` in db.js map between snake_case rows and the camelCase objects
the React app already used, so the UI's opp shape is unchanged from the single-user
version.

## Common Changes

**Adding a new opportunity field:**
1. Add the column in db.js and map it in both `rowToOpp` and `oppToRow`
2. Add it to the `INSERT ... ON CONFLICT` column list in server.js
3. Update the `sampleOpp()` function (around line 60)
4. Add to the opp object structure in form handlers / detail views

**Changing the data model or storage schema:**
- `CREATE TABLE IF NOT EXISTS` runs on every boot, so new *tables* appear automatically;
  new *columns* on an existing table need an explicit `ALTER TABLE` — there is no
  migration framework
- Back up first (`npm run backup`); the database holds every user's data, not just yours

**Styling:**
- Tailwind classes are available in public/index.html via CDN
- Colors and typography should use Tailwind utilities (e.g., `text-red-500`, `bg-slate-100`)
- Icons from Lucide React are already imported at the top

**Adding UI elements:**
- Icon imports are at the top; add new icons from lucide-react if needed
- All components are inline in se-tracker.jsx; no separate component files

## File Purposes

- **server.js** – Express server; auth routes, per-record data API, admin routes, image upload, static files, serves se-tracker.jsx itself (it lives at the project root, outside public/), and SPA routing
- **db.js** – SQLite connection, schema, and row↔object mapping
- **auth.js** – scrypt password hashing, session issue/lookup, invite tokens, and the requireAuth/requireAdmin middleware
- **se-tracker.jsx** – Entire React UI; state management, rendering, event handling. This is the actual source served to the browser — it is not a template or pre-build artifact.
- **public/index.html** – HTML shell; import map + Babel standalone + Tailwind from CDN, and the `<script>` tag that loads and transforms se-tracker.jsx. Has no app logic of its own.
- **se-tracker.service** – Systemd service definition for production deployment
- **scripts/create-user.js** – Creates an account from the CLI (`--role admin|se`); bootstraps the first admin and is the one path that bypasses invites
- **scripts/reassign.js** – Moves opportunities and tasks from one owner to another
- **scripts/migrate-storage.js** – One-time import of a pre-multi-user data/storage.json
- **scripts/backup.js** – Consistent online backup, safe against a running server
- **data/** – All runtime state (SQLite DB, note images, backups); none of it is in version control

## Permissions

Pre-configured permissions (in .claude/settings.local.json) allow:
- Starting the server and running npm commands
- Health checks and test requests to localhost:3000
- Killing existing server processes
