// Consistent online backup of the SQLite database. Safe to run against a live
// server — SQLite's backup API copies pages under a read lock rather than
// snapshotting a file mid-write, which a plain `cp` of a WAL database can't do.
//
//   node scripts/backup.js [--out data/backups] [--keep 14]
//
// A nightly cron entry is enough for a team this size:
//   0 2 * * * cd /opt/se-tracker && /usr/bin/node scripts/backup.js >> /var/log/se-tracker-backup.log 2>&1
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { db, DATA_DIR } from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i === -1 ? fallback : args[i + 1];
};

const outDir = path.resolve(path.join(__dirname, '..'), argOf('--out', path.join(DATA_DIR, 'backups')));
const keep = Number(argOf('--keep', '14'));

fs.mkdirSync(outDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const target = path.join(outDir, `se-tracker-${stamp}.db`);

await db.backup(target);
console.log(`Wrote ${target} (${Math.round(fs.statSync(target).size / 1024)}KB)`);

// Prune oldest first; filenames sort chronologically because the stamp is ISO.
const existing = fs
  .readdirSync(outDir)
  .filter((f) => f.startsWith('se-tracker-') && f.endsWith('.db'))
  .sort();
for (const stale of existing.slice(0, Math.max(0, existing.length - keep))) {
  fs.unlinkSync(path.join(outDir, stale));
  console.log(`Pruned ${stale}`);
}
process.exit(0);
