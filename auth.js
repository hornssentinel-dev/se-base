// Password hashing, session issuing, and the Express middleware that turns a
// session cookie into req.user. Sessions are server-side rows rather than JWTs
// so that disabling a user or logging out takes effect immediately.
import crypto from 'crypto';
import { db } from './db.js';

const SCRYPT_KEYLEN = 64;
const SESSION_DAYS = 30;
const INVITE_DAYS = 7;

export const SESSION_COOKIE = 'se_session';

const nowIso = () => new Date().toISOString();
const isoIn = (days) => new Date(Date.now() + days * 86400_000).toISOString();

export const newId = (bytes = 16) => crypto.randomBytes(bytes).toString('hex');

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password, stored) {
  if (!stored) return false;
  const [scheme, salt, expected] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  const expectedBuf = Buffer.from(expected, 'hex');
  // Lengths must match before timingSafeEqual, which throws on a mismatch.
  if (expectedBuf.length !== actual.length) return false;
  return crypto.timingSafeEqual(actual, expectedBuf);
}

export function createSession(userId) {
  const id = newId(32);
  db.prepare(
    'INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).run(id, userId, nowIso(), isoIn(SESSION_DAYS));
  return id;
}

export const destroySession = (id) =>
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);

export function userForSession(sessionId) {
  if (!sessionId) return null;
  const row = db
    .prepare(
      `SELECT u.* FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.id = ? AND s.expires_at > ? AND u.status = 'active'`
    )
    .get(sessionId, nowIso());
  return row || null;
}

export function createInvite({ email, name, role, invitedBy }) {
  const token = newId(24);
  db.prepare(
    `INSERT INTO invites (token, email, name, role, invited_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(token, email, name || '', role, invitedBy, nowIso(), isoIn(INVITE_DAYS));
  return token;
}

export const findInvite = (token) =>
  db
    .prepare(
      'SELECT * FROM invites WHERE token = ? AND accepted_at IS NULL AND expires_at > ?'
    )
    .get(token, nowIso());

// Expired sessions and invites are only cleaned up opportunistically at boot;
// both are also filtered by expiry at read time, so a stale row is inert.
export function purgeExpired() {
  const now = nowIso();
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  db.prepare('DELETE FROM invites WHERE expires_at <= ? AND accepted_at IS NULL').run(now);
}

export function attachUser(req, res, next) {
  req.user = userForSession(req.cookies?.[SESSION_COOKIE]);
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  maxAge: SESSION_DAYS * 86400_000,
  // Set COOKIE_SECURE=true once the app is behind HTTPS (the Caddy setup in
  // cloudformation/). Left off by default so plain-HTTP localhost still works.
  secure: process.env.COOKIE_SECURE === 'true',
};

export const publicUser = (u) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  status: u.status,
  createdAt: u.created_at,
  lastLoginAt: u.last_login_at,
});

// ---- API keys ----------------------------------------------------------------
// Long-lived bearer tokens for machine clients (the Ollama ingest job). Kept
// separate from sessions: they don't expire on the 30-day session clock, they
// carry a read-only scope, and revoking one doesn't sign a human out anywhere.

const API_KEY_PREFIX = 'set_'; // "SE Tracker" — makes a leaked token greppable.

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function createApiKey({ userId, name, expiresInDays = null }) {
  const token = API_KEY_PREFIX + newId(24);
  const id = newId(8);
  db.prepare(
    `INSERT INTO api_keys (id, user_id, name, token_hash, scope, created_at, expires_at)
     VALUES (?, ?, ?, ?, 'read', ?, ?)`
  ).run(id, userId, name || '', sha256(token), nowIso(), expiresInDays ? isoIn(expiresInDays) : null);
  // The plaintext token is returned exactly once — only its hash is stored.
  return { id, token };
}

export function userForApiKey(token) {
  if (!token || !token.startsWith(API_KEY_PREFIX)) return null;
  const row = db
    .prepare(
      `SELECT u.*, k.id AS api_key_id, k.scope AS api_key_scope FROM api_keys k
         JOIN users u ON u.id = k.user_id
        WHERE k.token_hash = ?
          AND k.revoked_at IS NULL
          AND (k.expires_at IS NULL OR k.expires_at > ?)
          AND u.status = 'active'`
    )
    .get(sha256(token), nowIso());
  if (!row) return null;
  db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(nowIso(), row.api_key_id);
  return row;
}

export const listApiKeys = (userId = null) =>
  db
    .prepare(
      `SELECT k.*, u.email AS user_email FROM api_keys k
         JOIN users u ON u.id = k.user_id
        ${userId ? 'WHERE k.user_id = ?' : ''}
        ORDER BY k.created_at DESC`
    )
    .all(...(userId ? [userId] : []));

export const revokeApiKey = (id) =>
  db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .run(nowIso(), id).changes;

// Read-only routes accept either an ordinary browser session (so an admin can
// eyeball the feed in a tab) or a bearer API key (so a job can poll it).
export function requireReadAccess(req, res, next) {
  if (req.user) return next();

  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : req.get('x-api-key');
  const user = userForApiKey(token);
  if (!user) {
    res.set('WWW-Authenticate', 'Bearer realm="se-tracker"');
    return res.status(401).json({ error: 'A session cookie or API key is required' });
  }
  req.user = user;
  req.apiKeyId = user.api_key_id;
  next();
}
