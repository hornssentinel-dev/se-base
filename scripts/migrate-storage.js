// One-time import of the pre-multi-user data/storage.json into SQLite.
//
//   node scripts/migrate-storage.js --owner you@example.com [--file data/storage.json]
//
// The owner must already exist (see scripts/create-admin.js); every migrated
// opportunity and task is assigned to them. Business cases are org-wide and get
// no owner. Base64 images embedded in notes are written out to data/images/ and
// the note keeps only a URL. Re-running is safe: rows are upserted by id.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { db, IMAGE_DIR, oppToRow } from '../db.js';
import { newId } from '../auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const args = process.argv.slice(2);
const argOf = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
};

const ownerEmail = argOf('--owner');
const file = path.resolve(root, argOf('--file') || 'data/storage.json');
const dryRun = args.includes('--dry-run');

if (!ownerEmail) {
  console.error('Usage: node scripts/migrate-storage.js --owner <email> [--file <path>] [--dry-run]');
  process.exit(1);
}
const owner = db.prepare('SELECT * FROM users WHERE email = ?').get(ownerEmail);
if (!owner) {
  console.error(`No user with email ${ownerEmail}. Create one first: npm run create-admin`);
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.error(`No such file: ${file}`);
  process.exit(1);
}

const store = JSON.parse(fs.readFileSync(file, 'utf-8'));
const decode = (key) => {
  const raw = store[key];
  if (!raw) return [];
  // Values were written by the old API as JSON-encoded strings.
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return Array.isArray(parsed) ? parsed : [];
};

const opps = decode('se-tracker:opps:v1');
const bizCases = decode('se-tracker:bizcases:v1');
const tasks = decode('se-tracker:tasks:v1');

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };
let imagesWritten = 0;
let bytesFreed = 0;

function externalizeImages(notes) {
  if (!Array.isArray(notes)) return [];
  return notes.map((note) => {
    if (!Array.isArray(note?.images) || note.images.length === 0) return note;
    const images = note.images.map((img) => {
      // Already migrated, or never had inline data.
      if (!img?.dataUrl) return img;
      const match = /^data:([\w/+-]+);base64,(.+)$/.exec(img.dataUrl);
      if (!match) return img;
      const ext = EXT[match[1]] || 'jpg';
      const id = `${newId()}.${ext}`;
      const buf = Buffer.from(match[2], 'base64');
      if (!dryRun) fs.writeFileSync(path.join(IMAGE_DIR, id), buf);
      imagesWritten++;
      bytesFreed += img.dataUrl.length;
      return { id, url: `/api/images/${id}` };
    });
    return { ...note, images };
  });
}

const now = new Date().toISOString();

const upsertOpp = db.prepare(
  `INSERT INTO opportunities
     (id, user_id, account, segment, se_stage, acct_mgr, acv, close_date, close_status,
      champion, competitor, next_action, sfdc_url, products, notes, demos, poc,
      created_at, updated_at)
   VALUES
     (@id, @user_id, @account, @segment, @se_stage, @acct_mgr, @acv, @close_date, @close_status,
      @champion, @competitor, @next_action, @sfdc_url, @products, @notes, @demos, @poc,
      @created_at, @updated_at)
   ON CONFLICT(id) DO UPDATE SET
     account=@account, segment=@segment, se_stage=@se_stage, acct_mgr=@acct_mgr, acv=@acv,
     close_date=@close_date, close_status=@close_status, champion=@champion,
     competitor=@competitor, next_action=@next_action, sfdc_url=@sfdc_url,
     products=@products, notes=@notes, demos=@demos, poc=@poc, updated_at=@updated_at`
);

const upsertBiz = db.prepare(
  `INSERT INTO business_cases (id, product, title, detail, created_by, created_at, updated_at)
   VALUES (@id, @product, @title, @detail, @created_by, @created_at, @updated_at)
   ON CONFLICT(id) DO UPDATE SET product=@product, title=@title, detail=@detail, updated_at=@updated_at`
);

const upsertTask = db.prepare(
  `INSERT INTO tasks (id, user_id, opp_id, text, opp_account, done, created_at)
   VALUES (@id, @user_id, @opp_id, @text, @opp_account, @done, @created_at)
   ON CONFLICT(id) DO UPDATE SET text=@text, opp_id=@opp_id, opp_account=@opp_account, done=@done`
);

// Transform up front rather than inside the transaction so --dry-run reports
// the same image counts a real run would produce.
const oppRows = opps.map((opp) =>
  oppToRow({ ...opp, notes: externalizeImages(opp.notes) }, owner.id, now)
);

const run = db.transaction(() => {
  for (const row of oppRows) {
    upsertOpp.run(row);
  }
  for (const bc of bizCases) {
    upsertBiz.run({
      id: bc.id, product: bc.product ?? '', title: bc.title ?? '', detail: bc.detail ?? '',
      created_by: owner.id, created_at: now, updated_at: now,
    });
  }
  for (const t of tasks) {
    upsertTask.run({
      id: t.id, user_id: owner.id, opp_id: t.oppId ?? null, text: t.text ?? '',
      opp_account: t.oppAccount ?? '', done: t.done ? 1 : 0, created_at: t.createdAt || now,
    });
  }
});

if (dryRun) {
  console.log('DRY RUN — nothing written.');
} else {
  run();
}

console.log(`Owner:           ${owner.email} (${owner.role})`);
console.log(`Opportunities:   ${opps.length}`);
console.log(`Business cases:  ${bizCases.length} (org-wide)`);
console.log(`Tasks:           ${tasks.length}`);
console.log(`Images extracted:${imagesWritten} (${Math.round(bytesFreed / 1024)}KB moved out of note JSON)`);
if (!dryRun) console.log(`\nOriginal ${path.relative(root, file)} left untouched as a backup.`);
process.exit(0);
