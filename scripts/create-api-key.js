// Issues, lists and revokes the read-only API keys that machine clients use
// against /api/ingest. There is no UI for this: keys are handed to a background
// job by whoever runs the box, not requested self-service from the browser.
//
//   node scripts/create-api-key.js --name ollama --user sam@example.com
//   node scripts/create-api-key.js --name ollama --user sam@example.com --expires 365
//   node scripts/create-api-key.js --list
//   node scripts/create-api-key.js --revoke <key-id>
//
// The key inherits the named user's scope: give it an admin account if the
// ingest job should see the whole org's pipeline (?scope=all), an SE account if
// it should only see that SE's own opportunities.
import { db } from '../db.js';
import { createApiKey, listApiKeys, revokeApiKey } from '../auth.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const has = (name) => args.includes(`--${name}`);

const fmtDate = (iso) => (iso ? iso.slice(0, 10) : '—');

if (has('list')) {
  const keys = listApiKeys();
  if (!keys.length) {
    console.log('No API keys yet. Create one:\n  node scripts/create-api-key.js --name ollama --user you@example.com');
    process.exit(0);
  }
  console.log('id               name                 user                      created     expires     last used   state');
  for (const k of keys) {
    const state = k.revoked_at ? 'revoked'
      : k.expires_at && k.expires_at <= new Date().toISOString() ? 'expired'
      : 'active';
    console.log(
      [k.id.padEnd(16), (k.name || '—').padEnd(20), k.user_email.padEnd(25),
       fmtDate(k.created_at).padEnd(11), fmtDate(k.expires_at).padEnd(11),
       fmtDate(k.last_used_at).padEnd(11), state].join(' ')
    );
  }
  process.exit(0);
}

if (has('revoke')) {
  const id = flag('revoke');
  if (!id) { console.error('--revoke needs a key id (see --list)'); process.exit(1); }
  if (!revokeApiKey(id)) {
    console.error(`No active key with id ${id}.`);
    process.exit(1);
  }
  console.log(`Revoked key ${id}. Any client using it now gets a 401.`);
  process.exit(0);
}

const email = flag('user') || process.env.API_KEY_USER;
if (!email) {
  console.error('Which account should the key act as? Pass --user <email> (see --list for existing keys).');
  process.exit(1);
}

const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim());
if (!user) { console.error(`No user with email ${email}.`); process.exit(1); }
if (user.status !== 'active') { console.error(`${email} is disabled; a key for it would never authenticate.`); process.exit(1); }

const expiresRaw = flag('expires');
const expiresInDays = expiresRaw === undefined ? null : Number(expiresRaw);
if (expiresInDays !== null && (!Number.isFinite(expiresInDays) || expiresInDays <= 0)) {
  console.error('--expires takes a number of days.');
  process.exit(1);
}

const { id, token } = createApiKey({
  userId: user.id,
  name: flag('name') || 'api key',
  expiresInDays,
});

const port = process.env.PORT || 3000;
console.log(`
Created read-only API key ${id} for ${user.email} (${user.role}).
${expiresInDays ? `Expires in ${expiresInDays} days.` : 'No expiry — revoke it with --revoke ' + id + ' when done.'}

  ${token}

This is the only time the token is shown; only its hash is stored. Try it:

  curl -H "Authorization: Bearer ${token}" http://localhost:${port}/api/ingest/stats
`);
process.exit(0);
