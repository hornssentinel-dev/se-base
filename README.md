# SE Tracker

A web-based application for sales engineers to track opportunities, proof of concepts (PoCs), demos, and technical wins.

## Project Structure

```
se-tracker/
├── server.js              # Express server: auth, per-record REST API
├── db.js                  # SQLite schema + row/object mapping
├── auth.js                # Password hashing, sessions, access middleware
├── se-tracker.jsx         # The entire React UI (served as-is, no build step)
├── package.json           # Node.js dependencies
├── public/
│   └── index.html         # HTML shell (CDN React/Tailwind + import map)
├── scripts/
│   ├── create-user.js     # Create an account from the CLI (--role admin|se)
│   ├── migrate-storage.js # One-time import of the old data/storage.json
│   ├── reassign.js        # Move a pipeline to a different owner
│   ├── backup.js          # Consistent online DB backup
│   ├── check.js           # JSX syntax check (no build step to catch typos)
│   └── deploy.sh          # rsync + restart on the EC2 host
├── se-tracker.service     # Systemd service file
└── data/                  # All runtime state; none of it is in git
    ├── se-tracker.db      # SQLite database (auto-created)
    ├── images/            # Note attachments
    └── backups/           # Output of npm run backup
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

### 3. Create the first admin account

The tracker is multi-user and there is no self-signup. Bootstrap an admin first:

```bash
npm run create-admin      # prompts for email, display name, password
```

After this, the normal way to add someone is an invite link from the Team tab.
`npm run create-user` creates an SE account from the command line instead, which
is handy for an account on a machine you're already logged into:

```bash
npm run create-user
```

It's worth keeping the admin account (the one that manages the app) separate
from the account that actually holds your pipeline — admins can see everyone's
data, so day-to-day work is cleaner from an SE account.

### 4. (Upgrading only) Import your old single-user data

If you're coming from the pre-login version, its data lives in
`data/storage.json`. Import it, assigning every opportunity and task to your
admin account:

```bash
npm run migrate-storage -- --owner you@example.com --dry-run   # preview
npm run migrate-storage -- --owner you@example.com             # do it
```

Business cases are imported as an org-wide shared library rather than being
assigned to anyone. Images embedded in notes are written out to `data/images/`.
The original `storage.json` is left untouched as a backup, and re-running the
import is safe — records are matched on their existing ids.

## Accounts and roles

- **SE** — sees and edits only their own opportunities and tasks.
- **Admin** — the same, plus a **Team** tab to invite teammates, change roles,
  and disable accounts. Admins can view the whole org's pipeline.

The business case library is shared org-wide: every user reads and edits the
same list, and changes are visible to everyone.

To invite someone, open **Team → Invite a teammate**, then copy the generated
link and send it to them. There is no mail server involved. Links expire after
7 days and are single-use.

Disabling a user immediately ends their sessions and blocks sign-in, but keeps
their opportunities intact.

To move a pipeline to a different owner — someone leaves, or data landed on the
wrong account:

```bash
npm run reassign -- --from old@example.com --to new@example.com --dry-run
npm run reassign -- --from old@example.com --to new@example.com
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

### HTTPS

Once the app is served over HTTPS, set `COOKIE_SECURE=true` so session cookies
are only ever sent over TLS:

```ini
Environment="COOKIE_SECURE=true"
```

### Data storage

Everything lives under `data/`: the SQLite database (`se-tracker.db`), note
images, and backups. It is created on first run and is excluded from git.

Set `DB_FILE` to put the database elsewhere.

### Backups

Do not `cp` the database while the server is running — SQLite in WAL mode keeps
part of the state in a side file, so a plain copy can be inconsistent. Use:

```bash
npm run backup                          # -> data/backups/, keeps the last 14
npm run backup -- --out /mnt/x --keep 30
```

This is safe against a live server. A nightly cron entry:

```
0 2 * * * cd /opt/se-tracker && /usr/bin/node scripts/backup.js >> /var/log/se-tracker-backup.log 2>&1
```

Note that `data/images/` is not included in the database backup — back that
directory up alongside it.

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
- Database unwritable (check permissions on `data/`)

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

There is no build step. `se-tracker.jsx` is served straight to the browser,
which transforms the JSX at load time, so editing it and refreshing is the whole
loop.

Because nothing compiles ahead of time, a syntax error shows up as a blank page
with a console message. To catch that first:

```bash
npm run check
```

## API Endpoints

All data endpoints require a session cookie and are scoped to the signed-in
user; unauthenticated requests get a 401.

**Auth**
- `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/me`
- `POST /api/auth/password` — change your own password
- `GET /api/invite/:token` · `POST /api/invite/:token/accept`

**Data** (records are written individually, not as one blob)
- `GET /api/opportunities` — your own; `?all=1` for the whole org (admin only)
- `PUT /api/opportunities/:id` · `DELETE /api/opportunities/:id`
- `GET|PUT|DELETE /api/business-cases[/:id]` — shared org-wide
- `GET|PUT|DELETE /api/tasks[/:id]`
- `POST /api/images` (base64 data URL in, URL out) · `GET /api/images/:id`

**Admin**
- `GET /api/admin/users` · `PATCH /api/admin/users/:id` (role, status)
- `GET|POST /api/admin/invites` · `DELETE /api/admin/invites/:token`

**Other**
- `GET /api/health` — health check, no auth required

## Browser Support

SE Tracker uses modern web APIs and is best experienced in:
- Chrome/Chromium (latest)
- Firefox (latest)
- Safari (latest)
- Edge (latest)
