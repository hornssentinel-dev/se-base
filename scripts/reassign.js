// Moves ownership of opportunities and tasks from one user to another. Useful
// when someone leaves and their pipeline needs a new owner, or when data landed
// on the wrong account.
//
//   node scripts/reassign.js --from old@example.com --to new@example.com [--dry-run]
//
// Business cases are org-wide and have no owner, so they are not touched beyond
// their created_by provenance, which is left alone.
import { db } from '../db.js';

const args = process.argv.slice(2);
const argOf = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
};

const fromEmail = argOf('--from');
const toEmail = argOf('--to');
const dryRun = args.includes('--dry-run');

if (!fromEmail || !toEmail) {
  console.error('Usage: node scripts/reassign.js --from <email> --to <email> [--dry-run]');
  process.exit(1);
}

const from = db.prepare('SELECT * FROM users WHERE email = ?').get(fromEmail);
const to = db.prepare('SELECT * FROM users WHERE email = ?').get(toEmail);
for (const [label, user, email] of [['--from', from, fromEmail], ['--to', to, toEmail]]) {
  if (!user) {
    console.error(`No user with email ${email} (${label})`);
    process.exit(1);
  }
}
if (from.id === to.id) {
  console.error('Source and destination are the same user.');
  process.exit(1);
}

const opps = db.prepare('SELECT COUNT(*) n FROM opportunities WHERE user_id = ?').get(from.id).n;
const tasks = db.prepare('SELECT COUNT(*) n FROM tasks WHERE user_id = ?').get(from.id).n;

console.log(`From: ${from.email} (${from.role})`);
console.log(`To:   ${to.email} (${to.role})`);
console.log(`Opportunities to move: ${opps}`);
console.log(`Tasks to move:         ${tasks}`);

if (dryRun) {
  console.log('\nDRY RUN — nothing written.');
  process.exit(0);
}

db.transaction(() => {
  db.prepare('UPDATE opportunities SET user_id = ? WHERE user_id = ?').run(to.id, from.id);
  db.prepare('UPDATE tasks SET user_id = ? WHERE user_id = ?').run(to.id, from.id);
})();

console.log(`\nMoved. ${to.email} now owns ${db.prepare('SELECT COUNT(*) n FROM opportunities WHERE user_id = ?').get(to.id).n} opportunities.`);
process.exit(0);
