import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { db, IMAGE_DIR, rowToOpp, oppToRow, rowToBizCase, rowToTask } from './db.js';
import {
  SESSION_COOKIE, sessionCookieOptions, attachUser, requireAuth, requireAdmin,
  hashPassword, verifyPassword, createSession, destroySession, createInvite,
  findInvite, purgeExpired, publicUser, newId,
} from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

const nowIso = () => new Date().toISOString();

purgeExpired();

app.use(cors({ origin: true, credentials: true }));
// Note images arrive as data URLs on POST /api/images; the default 100kb JSON
// limit would reject them.
app.use(express.json({ limit: '12mb' }));
app.use(cookieParser());
app.use(attachUser);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/se-tracker.jsx', (req, res) => {
  res.type('text/babel').sendFile(path.join(__dirname, 'se-tracker.jsx'));
});

// ---- auth --------------------------------------------------------------------

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).trim());
  // Same message either way so the response can't be used to enumerate accounts.
  if (!user || user.status !== 'active' || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), user.id);
  res.cookie(SESSION_COOKIE, createSession(user.id), sessionCookieOptions);
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  const sid = req.cookies?.[SESSION_COOKIE];
  if (sid) destroySession(sid);
  res.clearCookie(SESSION_COOKIE, { ...sessionCookieOptions, maxAge: undefined });
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  res.json({ user: publicUser(req.user) });
});

app.post('/api/auth/password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!verifyPassword(currentPassword || '', req.user.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(hashPassword(newPassword), req.user.id);
  res.json({ ok: true });
});

// ---- invite acceptance (unauthenticated: the token is the credential) --------

app.get('/api/invite/:token', (req, res) => {
  const invite = findInvite(req.params.token);
  if (!invite) return res.status(404).json({ error: 'This invite is invalid or has expired' });
  res.json({ email: invite.email, name: invite.name, role: invite.role });
});

app.post('/api/invite/:token/accept', (req, res) => {
  const invite = findInvite(req.params.token);
  if (!invite) return res.status(404).json({ error: 'This invite is invalid or has expired' });

  const { password, name } = req.body || {};
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(invite.email)) {
    return res.status(409).json({ error: 'An account with this email already exists' });
  }

  const userId = newId();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO users (id, email, name, password_hash, role, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?)`
    ).run(userId, invite.email, name || invite.name || '', hashPassword(password), invite.role, nowIso());
    db.prepare('UPDATE invites SET accepted_at = ? WHERE token = ?').run(nowIso(), invite.token);
  })();

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  res.cookie(SESSION_COOKIE, createSession(userId), sessionCookieOptions);
  res.status(201).json({ user: publicUser(user) });
});

// ---- opportunities -----------------------------------------------------------

// Admins can opt into the whole org's pipeline with ?all=1; everyone else is
// pinned to their own rows. scopeUser is the single place that decides.
function scopeUser(req) {
  const wantsAll = req.query.all === '1' && req.user.role === 'admin';
  return wantsAll ? null : req.user.id;
}

app.get('/api/opportunities', requireAuth, (req, res) => {
  const userId = scopeUser(req);
  const rows = userId
    ? db.prepare('SELECT * FROM opportunities WHERE user_id = ? ORDER BY created_at DESC').all(userId)
    : db.prepare('SELECT * FROM opportunities ORDER BY created_at DESC').all();
  const owners = Object.fromEntries(
    db.prepare('SELECT id, name, email FROM users').all().map((u) => [u.id, u.name || u.email])
  );
  res.json({ opportunities: rows.map((r) => ({ ...rowToOpp(r), ownerName: owners[r.user_id] || '' })) });
});

// Upsert rather than separate POST/PUT: the client syncs whatever records it
// holds and does not track whether the server has seen them yet.
app.put('/api/opportunities/:id', requireAuth, (req, res) => {
  const existing = db.prepare('SELECT * FROM opportunities WHERE id = ?').get(req.params.id);
  if (existing && existing.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Not your opportunity' });
  }
  const ownerId = existing ? existing.user_id : req.user.id;
  const row = oppToRow({ ...req.body, id: req.params.id }, ownerId, nowIso());

  db.prepare(
    `INSERT INTO opportunities
       (id, user_id, account, segment, se_stage, acct_mgr, acv, close_date, close_status,
        champion, competitor, next_action, sfdc_url, products, notes, demos, poc,
        created_at, updated_at)
     VALUES
       (@id, @user_id, @account, @segment, @se_stage, @acct_mgr, @acv, @close_date, @close_status,
        @champion, @competitor, @next_action, @sfdc_url, @products, @notes, @demos, @poc,
        @created_at, @updated_at)
     ON CONFLICT(id) DO UPDATE SET
       account=@account, segment=@segment, se_stage=@se_stage, acct_mgr=@acct_mgr,
       acv=@acv, close_date=@close_date, close_status=@close_status, champion=@champion,
       competitor=@competitor, next_action=@next_action, sfdc_url=@sfdc_url,
       products=@products, notes=@notes, demos=@demos, poc=@poc, updated_at=@updated_at`
  ).run(row);

  res.json({ opportunity: rowToOpp(db.prepare('SELECT * FROM opportunities WHERE id = ?').get(row.id)) });
});

app.delete('/api/opportunities/:id', requireAuth, (req, res) => {
  const existing = db.prepare('SELECT * FROM opportunities WHERE id = ?').get(req.params.id);
  if (!existing) return res.json({ ok: true });
  if (existing.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Not your opportunity' });
  }
  db.prepare('DELETE FROM opportunities WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---- business cases (org-wide shared library) ---------------------------------

app.get('/api/business-cases', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM business_cases ORDER BY created_at').all();
  res.json({ businessCases: rows.map(rowToBizCase) });
});

app.put('/api/business-cases/:id', requireAuth, (req, res) => {
  const { product = '', title = '', detail = '' } = req.body || {};
  const now = nowIso();
  db.prepare(
    `INSERT INTO business_cases (id, product, title, detail, created_by, created_at, updated_at)
     VALUES (@id, @product, @title, @detail, @created_by, @created_at, @updated_at)
     ON CONFLICT(id) DO UPDATE SET
       product=@product, title=@title, detail=@detail, updated_at=@updated_at`
  ).run({
    id: req.params.id, product, title, detail,
    created_by: req.user.id, created_at: now, updated_at: now,
  });
  res.json({ businessCase: rowToBizCase(db.prepare('SELECT * FROM business_cases WHERE id = ?').get(req.params.id)) });
});

app.delete('/api/business-cases/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM business_cases WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---- tasks -------------------------------------------------------------------

app.get('/api/tasks', requireAuth, (req, res) => {
  const rows = db
    .prepare('SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at DESC')
    .all(req.user.id);
  res.json({ tasks: rows.map(rowToTask) });
});

app.put('/api/tasks/:id', requireAuth, (req, res) => {
  const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (existing && existing.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Not your task' });
  }
  const { text = '', oppId = null, oppAccount = '', done = false, createdAt } = req.body || {};
  db.prepare(
    `INSERT INTO tasks (id, user_id, opp_id, text, opp_account, done, created_at)
     VALUES (@id, @user_id, @opp_id, @text, @opp_account, @done, @created_at)
     ON CONFLICT(id) DO UPDATE SET
       text=@text, opp_id=@opp_id, opp_account=@opp_account, done=@done`
  ).run({
    id: req.params.id, user_id: req.user.id, opp_id: oppId, text,
    opp_account: oppAccount, done: done ? 1 : 0, created_at: createdAt || nowIso(),
  });
  res.json({ task: rowToTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id)) });
});

app.delete('/api/tasks/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// ---- note images -------------------------------------------------------------

const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };

// Images used to be embedded in the opportunity JSON as base64 data URLs, which
// meant one screenshot could make a single opp 70KB+ and every save rewrote it.
// They now land on disk and the note keeps only a URL.
app.post('/api/images', requireAuth, (req, res) => {
  const { dataUrl } = req.body || {};
  const match = /^data:([\w/+-]+);base64,(.+)$/.exec(dataUrl || '');
  if (!match) return res.status(400).json({ error: 'Expected a base64 data URL' });

  const ext = IMAGE_TYPES[match[1]];
  if (!ext) return res.status(415).json({ error: `Unsupported image type ${match[1]}` });

  const id = `${newId()}.${ext}`;
  fs.writeFileSync(path.join(IMAGE_DIR, id), Buffer.from(match[2], 'base64'));
  res.status(201).json({ id, url: `/api/images/${id}` });
});

app.get('/api/images/:id', requireAuth, (req, res) => {
  // Reject anything that isn't a bare generated filename so the id can't walk
  // out of IMAGE_DIR.
  if (!/^[a-f0-9]{32}\.(jpg|png|gif|webp)$/.test(req.params.id)) {
    return res.status(400).json({ error: 'Bad image id' });
  }
  const file = path.join(IMAGE_DIR, req.params.id);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(file);
});

// ---- admin -------------------------------------------------------------------

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = db.prepare('SELECT * FROM users ORDER BY created_at').all().map(publicUser);
  const counts = db
    .prepare('SELECT user_id, COUNT(*) n FROM opportunities GROUP BY user_id')
    .all();
  const byUser = Object.fromEntries(counts.map((c) => [c.user_id, c.n]));
  res.json({ users: users.map((u) => ({ ...u, oppCount: byUser[u.id] || 0 })) });
});

app.patch('/api/admin/users/:id', requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'No such user' });

  const { role, status } = req.body || {};
  // Guard against an admin locking every admin out of the instance.
  if ((role === 'se' || status === 'disabled') && target.role === 'admin') {
    const admins = db
      .prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND status = 'active'")
      .get().n;
    if (admins <= 1) return res.status(400).json({ error: 'Cannot remove the last active admin' });
  }
  if (role) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.id);
  if (status) db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, req.params.id);
  // A disabled user should lose access immediately, not at session expiry.
  if (status === 'disabled') db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.params.id);

  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id)) });
});

app.get('/api/admin/invites', requireAdmin, (req, res) => {
  const invites = db
    .prepare('SELECT * FROM invites WHERE accepted_at IS NULL ORDER BY created_at DESC')
    .all();
  res.json({
    invites: invites.map((i) => ({
      token: i.token, email: i.email, name: i.name, role: i.role,
      expiresAt: i.expires_at, expired: i.expires_at <= nowIso(),
    })),
  });
});

app.post('/api/admin/invites', requireAdmin, (req, res) => {
  const { email, name, role = 'se' } = req.body || {};
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email is required' });
  }
  if (!['admin', 'se'].includes(role)) return res.status(400).json({ error: 'Unknown role' });
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    return res.status(409).json({ error: 'That email already has an account' });
  }

  const token = createInvite({ email: email.trim(), name, role, invitedBy: req.user.id });
  // There is no mail transport here — the admin copies the link and sends it.
  res.status(201).json({ token, url: `/invite/${token}`, email, role });
});

app.delete('/api/admin/invites/:token', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM invites WHERE token = ?').run(req.params.token);
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: nowIso() });
});

// Unmatched /api paths must 404 as JSON; without this they fall through to the
// SPA catch-all and a fetch() would try to parse index.html.
app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown endpoint' }));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`SE Tracker running at http://localhost:${PORT}`);
  const users = db.prepare('SELECT COUNT(*) n FROM users').get().n;
  if (users === 0) console.log('No users yet — create the first admin: npm run create-admin');
});
