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
