// Creates an account from the command line. Normally only needed once, to
// bootstrap the first admin from a cold database — after that, accounts are
// created by an admin sending an invite. It stays useful for accounts you'd
// rather not round-trip through a browser (a personal SE account on the box
// you're already logged into, say).
//
//   node scripts/create-user.js                      # prompts, defaults to SE
//   node scripts/create-user.js --role admin
//   ADMIN_EMAIL=x@y.com ADMIN_PASSWORD=... ADMIN_NAME='X Y' node scripts/create-user.js --role admin
import readline from 'readline';
import { db } from '../db.js';
import { hashPassword, newId } from '../auth.js';

const args = process.argv.slice(2);
const roleArg = args.indexOf('--role');
const role = roleArg === -1 ? 'se' : args[roleArg + 1];
if (!['admin', 'se'].includes(role)) {
  console.error("--role must be 'admin' or 'se'");
  process.exit(1);
}

function ask(question, { silent = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    if (silent) {
      // Suppress echo so the typed password doesn't land in the terminal.
      const onData = (char) => {
        if (['\n', '\r', ''].includes(char.toString())) process.stdin.removeListener('data', onData);
        else process.stdout.write('\x1B[2K\x1B[200D' + question + '*'.repeat(rl.line.length));
      };
      process.stdin.on('data', onData);
    }
    rl.question(question, (answer) => {
      rl.close();
      if (silent) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

const label = role === 'admin' ? 'Admin' : 'User';

const email = process.env.ADMIN_EMAIL || (await ask(`${label} email: `));
if (!email) {
  console.error('An email is required.');
  process.exit(1);
}
if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
  console.error(`A user with email ${email} already exists.`);
  process.exit(1);
}

const name = process.env.ADMIN_NAME ?? (await ask('Display name: '));
const password = process.env.ADMIN_PASSWORD || (await ask('Password (min 8 chars): ', { silent: true }));
if (!password || password.length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}

const id = newId();
db.prepare(
  `INSERT INTO users (id, email, name, password_hash, role, status, created_at)
   VALUES (?, ?, ?, ?, ?, 'active', ?)`
).run(id, email, name || '', hashPassword(password), role, new Date().toISOString());

console.log(`\nCreated ${role} ${email} (id ${id}). Sign in at http://localhost:${process.env.PORT || 3000}`);
process.exit(0);
