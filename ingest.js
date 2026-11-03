// Retrieval feed for external LLM tooling (a local Ollama instance, in the case
// this was built for). Everything under /api/ingest is read-only.
//
// The regular data API returns the nested objects the React UI needs — one
// opportunity carries its notes, demos and PoC inside it. That shape is wrong
// for embedding: an opportunity with forty notes is one enormous blob, and a
// nearest-neighbour hit on it tells you nothing about *which* note matched. So
// this module fans the same records out into small, self-contained documents,
// each rendered as plain prose with enough surrounding context ("this note is
// from the Acme PoC") to stand on its own in a retrieved chunk.
//
// Auth is a read-only API key (Authorization: Bearer set_…) or an ordinary
// session cookie. Scoping is the same as everywhere else: your own rows, or the
// whole org with ?scope=all if you're an admin.
import express from 'express';
import crypto from 'crypto';
import { db, rowToOpp, rowToBizCase, rowToTask } from './db.js';
import { requireReadAccess } from './auth.js';
import { derivePocHealth, isPocAtRisk } from './health.js';

export const router = express.Router();

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 200;

const hashOf = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
const clean = (v) => String(v ?? '').trim();
const lines = (...parts) => parts.filter(Boolean).join('\n');
// Header block, then a blank line, then the free text — the blank line matters,
// because it is where the chunker prefers to split.
const withBody = (header, body) => `${header}\n\n${body}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const money = (n) =>
  Number(n) ? `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '';

// One line of context prepended to every child document. Without it a note chunk
// retrieved on its own reads as an anonymous paragraph — the embedding has no
// idea which account or deal stage it belongs to.
const oppContext = (opp, owner) =>
  [
    `Account: ${clean(opp.account) || 'Unnamed'}`,
    opp.segment && `Segment: ${opp.segment}`,
    opp.seStage && `SE stage: ${opp.seStage}`,
    opp.products?.length && `Products: ${opp.products.join(', ')}`,
    owner && `SE owner: ${owner}`,
  ]
    .filter(Boolean)
    .join(' · ');

function doc({ id, type, title, text, updatedAt, metadata }) {
  const body = text.trim();
  return { id, type, title, text: body, updatedAt, hash: hashOf(body), metadata };
}

// ---- renderers ---------------------------------------------------------------

function opportunityDoc(opp, owner, updatedAt) {
  const poc = opp.poc;
  const criteria = poc?.criteria || [];
  const passed = criteria.filter((c) => c.status === 'pass').length;

  const text = lines(
    `Opportunity: ${clean(opp.account) || 'Unnamed opportunity'}`,
    owner && `SE owner: ${owner}`,
    opp.segment && `Segment: ${opp.segment}`,
    opp.seStage && `SE stage: ${opp.seStage}`,
    opp.acctMgr && `Account manager: ${opp.acctMgr}`,
    opp.acv && `Annual contract value: ${money(opp.acv)}`,
    opp.products?.length && `Products in play: ${opp.products.join(', ')}`,
    opp.closeDate && `Expected close date: ${opp.closeDate}${opp.closeStatus ? ` (${opp.closeStatus})` : ''}`,
    opp.champion && `Champion: ${opp.champion}`,
    opp.competitor && `Competition: ${opp.competitor}`,
    opp.nextAction && `Next action: ${opp.nextAction}`,
    poc?.active
      ? `Proof of concept: active, ${poc.startDate || 'no start date'} to ${poc.targetDate || 'no target date'}, health ${derivePocHealth({ poc })}, ${passed} of ${criteria.length} success criteria passed`
      : poc
        ? 'Proof of concept: recorded but not currently active'
        : 'Proof of concept: none',
    `Activity logged: ${plural(opp.notes?.length || 0, 'note')}, ${plural(opp.demos?.length || 0, 'demo')}`,
    opp.sfdcUrl && `Salesforce record: ${opp.sfdcUrl}`
  );

  return doc({
    id: `opportunity:${opp.id}`,
    type: 'opportunity',
    title: clean(opp.account) || 'Unnamed opportunity',
    text,
    updatedAt,
    metadata: {
      oppId: opp.id,
      account: opp.account,
      segment: opp.segment,
      seStage: opp.seStage,
      products: opp.products || [],
      acv: opp.acv,
      closeDate: opp.closeDate || null,
      closeStatus: opp.closeStatus || null,
      pocHealth: derivePocHealth({ poc }),
      ownerId: opp.userId,
      ownerName: owner,
    },
  });
}

function noteDoc(note, opp, owner, updatedAt) {
  const images = note.images?.length
    ? `\n[${plural(note.images.length, 'image attachment')} on this note]`
    : '';
  const text = withBody(
    lines(
      `${note.type || 'Note'} note on ${clean(opp.account)}${note.date ? ` — ${note.date}` : ''}`,
      oppContext(opp, owner)
    ),
    (clean(note.body) || '(no text)') + images
  );

  return doc({
    id: `note:${opp.id}:${note.id}`,
    type: 'note',
    title: `${note.type || 'Note'} — ${clean(opp.account)} (${note.date || 'undated'})`,
    text,
    updatedAt,
    metadata: {
      oppId: opp.id, account: opp.account, noteType: note.type || '',
      date: note.date || null, hasImages: !!note.images?.length,
      ownerId: opp.userId, ownerName: owner,
    },
  });
}

function demoDoc(demo, opp, owner, updatedAt) {
  const text = withBody(
    lines(
      `Demo delivered to ${clean(opp.account)}${demo.date ? ` on ${demo.date}` : ''}`,
      oppContext(opp, owner)
    ),
    lines(
      demo.products?.length && `Products demonstrated: ${demo.products.join(', ')}`,
      demo.audience && `Audience: ${demo.audience}`,
      demo.outcome && `Outcome: ${demo.outcome}`,
      clean(demo.notes) && `Notes: ${clean(demo.notes)}`
    )
  );

  return doc({
    id: `demo:${opp.id}:${demo.id}`,
    type: 'demo',
    title: `Demo — ${clean(opp.account)} (${demo.date || 'undated'})`,
    text,
    updatedAt,
    metadata: {
      oppId: opp.id, account: opp.account, date: demo.date || null,
      products: demo.products || [], outcome: demo.outcome || '',
      ownerId: opp.userId, ownerName: owner,
    },
  });
}

function pocDoc(opp, owner, updatedAt) {
  const poc = opp.poc;
  const criteria = poc.criteria || [];
  const rendered = criteria.map(
    (c) =>
      `- [${c.status || 'pending'}] ${clean(c.label) || 'Unnamed criterion'}` +
      `${c.owner ? ` (owner: ${c.owner})` : ''}${clean(c.note) ? ` — ${clean(c.note)}` : ''}`
  );

  const text = withBody(
    lines(`Proof of concept for ${clean(opp.account)}`, oppContext(opp, owner)),
    lines(
    `Status: ${poc.active ? 'active' : 'inactive'}, health ${derivePocHealth({ poc })}`,
    poc.startDate && `Start date: ${poc.startDate}`,
    poc.targetDate && `Target date: ${poc.targetDate}`,
    criteria.length ? `Success criteria (${criteria.length}):` : 'No success criteria recorded.',
    ...rendered
    )
  );

  return doc({
    id: `poc:${opp.id}`,
    type: 'poc',
    title: `PoC — ${clean(opp.account)}`,
    text,
    updatedAt,
    metadata: {
      oppId: opp.id, account: opp.account, active: !!poc.active,
      health: derivePocHealth({ poc }), startDate: poc.startDate || null,
      targetDate: poc.targetDate || null, criteriaCount: criteria.length,
      ownerId: opp.userId, ownerName: owner,
    },
  });
}

function bizCaseDoc(bc, updatedAt) {
  const text = withBody(
    `Business case for ${bc.product || 'the platform'}: ${clean(bc.title)}`,
    clean(bc.detail)
  );
  return doc({
    id: `business_case:${bc.id}`,
    type: 'business_case',
    title: `${bc.product ? `${bc.product} — ` : ''}${clean(bc.title) || 'Untitled business case'}`,
    text,
    updatedAt,
    metadata: { product: bc.product || '', shared: true },
  });
}

function taskDoc(task) {
  const text = lines(
    `Task${task.done ? ' (completed)' : ' (open)'}: ${clean(task.text)}`,
    task.oppAccount && `Related account: ${task.oppAccount}`,
    task.createdAt && `Created: ${task.createdAt.slice(0, 10)}`
  );
  return doc({
    id: `task:${task.id}`,
    type: 'task',
    title: clean(task.text).slice(0, 80) || 'Untitled task',
    text,
    updatedAt: task.createdAt,
    metadata: {
      oppId: task.oppId || null, account: task.oppAccount || '', done: task.done,
    },
  });
}

// ---- collection --------------------------------------------------------------

export const DOC_TYPES = ['opportunity', 'note', 'demo', 'poc', 'business_case', 'task'];

// The whole corpus is built in memory on each request. A team's tracker is
// thousands of documents at the top end, so this stays in the low milliseconds
// and buys a much simpler story for filtering, delta sync and hashing than
// pushing the fan-out into SQL would.
export function buildDocuments({ userId, types }) {
  const want = (t) => types.includes(t);
  const docs = [];

  const owners = Object.fromEntries(
    db.prepare('SELECT id, name, email FROM users').all().map((u) => [u.id, u.name || u.email])
  );

  if (['opportunity', 'note', 'demo', 'poc'].some(want)) {
    const rows = userId
      ? db.prepare('SELECT * FROM opportunities WHERE user_id = ?').all(userId)
      : db.prepare('SELECT * FROM opportunities').all();

    for (const row of rows) {
      const opp = rowToOpp(row);
      const owner = owners[row.user_id] || '';
      // Notes and demos live in the parent's JSON columns, so the parent's
      // updated_at is the only mtime they have — which is also exactly what a
      // client needs for ?since= to be correct: touching a note touches the opp.
      const updatedAt = row.updated_at;

      if (want('opportunity')) docs.push(opportunityDoc(opp, owner, updatedAt));
      if (want('note')) for (const n of opp.notes || []) docs.push(noteDoc(n, opp, owner, updatedAt));
      if (want('demo')) for (const d of opp.demos || []) docs.push(demoDoc(d, opp, owner, updatedAt));
      if (want('poc') && opp.poc) docs.push(pocDoc(opp, owner, updatedAt));
    }
  }

  // Business cases are org-wide by design, so they are not filtered by scope.
  if (want('business_case')) {
    for (const row of db.prepare('SELECT * FROM business_cases').all()) {
      docs.push(bizCaseDoc(rowToBizCase(row), row.updated_at));
    }
  }

  if (want('task')) {
    const rows = userId
      ? db.prepare('SELECT * FROM tasks WHERE user_id = ?').all(userId)
      : db.prepare('SELECT * FROM tasks').all();
    for (const row of rows) docs.push(taskDoc(rowToTask(row)));
  }

  docs.sort((a, b) => (a.updatedAt || '').localeCompare(b.updatedAt || '') || a.id.localeCompare(b.id));
  return docs;
}

// Splits an over-long document at paragraph, then line, then sentence, then
// hard character boundaries — so a PoC's criteria list breaks between bullets
// rather than mid-bullet. Off by default: most documents here are already well
// under any sensible embedding window, and unsplit documents keep stable ids.
function chunk(text, maxChars) {
  if (!maxChars || text.length <= maxChars) return [text];

  // Flatten the text into units, each remembering the separator that preceded
  // it, so re-joining a run of units reproduces the original spacing.
  const units = [];
  for (const para of text.split(/\n{2,}/)) {
    if (para.length <= maxChars) {
      units.push({ text: para, sep: '\n\n' });
      continue;
    }
    const byLine = para.includes('\n');
    const parts = byLine ? para.split('\n') : para.split(/(?<=[.!?])\s+/);
    parts.forEach((part, i) => units.push({ text: part, sep: i === 0 ? '\n\n' : byLine ? '\n' : ' ' }));
  }

  const pieces = [];
  let current = '';
  const flush = () => { if (current.trim()) pieces.push(current.trim()); current = ''; };

  for (const unit of units) {
    let u = unit.text;
    while (u.length > maxChars) {   // an unbroken run longer than the budget
      flush();
      pieces.push(u.slice(0, maxChars));
      u = u.slice(maxChars);
    }
    const sep = current ? unit.sep : '';
    if (current && current.length + sep.length + u.length > maxChars) flush();
    current += (current ? unit.sep : '') + u;
  }
  flush();
  return pieces.length ? pieces : [text];
}

function applyChunking(docs, maxChars) {
  if (!maxChars) return docs;
  return docs.flatMap((d) => {
    const parts = chunk(d.text, maxChars);
    if (parts.length === 1) return [d];
    return parts.map((text, i) => ({
      ...d,
      id: `${d.id}#${i + 1}`,
      text,
      hash: hashOf(text),
      metadata: { ...d.metadata, chunk: i + 1, chunkCount: parts.length, parentId: d.id },
    }));
  });
}

// ---- structured opportunity table --------------------------------------------

// Every opportunity, every scalar column, always — never sampled by relevance.
//
// Retrieval answers "what did we discuss", but it structurally cannot answer
// "which PoCs are at risk": that is a filter over a column, and a relevance
// ranking returns whatever is topically similar, not the complete set where a
// field equals a value. Worse, the word "risk" never appears in a PoC record —
// health is stored as pass/fail/blocked and derived into red/amber — so the
// query terms cannot retrieve the very rows the question is about.
//
// So the table goes in whole and unranked. At ~200 tokens per opportunity this
// is a few thousand tokens for a normal tracker, and it makes stage, owner,
// close date, ACV, competitor and health all answerable at once rather than
// one question shape at a time. Free-text notes still go through selectContext.
export function opportunityTable(userId) {
  const rows = userId
    ? db.prepare('SELECT * FROM opportunities WHERE user_id = ? ORDER BY account').all(userId)
    : db.prepare('SELECT * FROM opportunities ORDER BY account').all();

  const owners = Object.fromEntries(
    db.prepare('SELECT id, name, email FROM users').all().map((u) => [u.id, u.name || u.email])
  );

  const entries = rows.map((row) => {
    const opp = rowToOpp(row);
    const poc = opp.poc;
    const health = derivePocHealth(opp);
    const blocked = (poc?.criteria || [])
      .filter((c) => c.status === 'fail' || c.status === 'blocked')
      .map((c) => `${clean(c.label) || 'unnamed'} (${c.status}${c.owner ? `, owner ${c.owner}` : ''})`);

    // "Field: value" on its own line, so the column name sits adjacent to its
    // value and the model can match on either.
    return lines(
      `Account: ${clean(opp.account) || 'Unnamed'}`,
      `SE owner: ${owners[row.user_id] || 'unknown'}`,
      `Segment: ${opp.segment || '-'}`,
      `SE stage: ${opp.seStage || '-'}`,
      `Account manager: ${opp.acctMgr || '-'}`,
      `ACV: ${opp.acv ? money(opp.acv) : '-'}`,
      `Close date: ${opp.closeDate || '-'}`,
      `Close status: ${opp.closeStatus || 'open'}`,
      `Champion: ${opp.champion || '-'}`,
      `Competitor: ${opp.competitor || '-'}`,
      `Products: ${opp.products?.length ? opp.products.join(', ') : '-'}`,
      `Next action: ${opp.nextAction || '-'}`,
      `PoC active: ${poc?.active ? 'yes' : 'no'}`,
      `PoC health: ${health}`,
      `At risk: ${isPocAtRisk(opp) ? 'YES' : 'no'}`,
      `PoC target date: ${poc?.targetDate || '-'}`,
      `PoC criteria: ${poc?.criteria?.length || 0} total, ${(poc?.criteria || []).filter((c) => c.status === 'pass').length} passed`,
      `PoC blockers: ${blocked.length ? blocked.join('; ') : 'none'}`,
      `Notes on file: ${opp.notes?.length || 0}, demos: ${opp.demos?.length || 0}`
    );
  });

  const atRisk = rows.filter((r) => isPocAtRisk(rowToOpp(r))).map((r) => r.account);

  return {
    text: lines(
      `There are ${entries.length} opportunities in scope. This table is COMPLETE — every`,
      `opportunity is listed. "At risk" means PoC health is amber or red.`,
      `At risk right now (${atRisk.length}): ${atRisk.join(', ') || 'none'}`,
      '',
      entries.join('\n\n')
    ),
    count: entries.length,
    atRisk,
  };
}

// ---- context selection for the in-app chat -----------------------------------

// Keyword scoring rather than embeddings: this corpus is a few thousand tokens,
// so the cost of standing up a vector store buys nothing a term match can't do.
//
// Two things this deliberately does NOT do. It doesn't rank the structured
// opportunity table — that always goes in whole (see opportunityTable), because
// ranking a filter query is how you end up returning two notes and zero PoCs.
// And it doesn't let one long document eat the budget: a single 3,800-char note
// used to consume the entire allowance and starve everything else.
const STOPWORDS = new Set([
  'the', 'and', 'are', 'for', 'was', 'with', 'that', 'this', 'which', 'what',
  'who', 'how', 'why', 'all', 'any', 'our', 'their', 'from', 'have', 'has',
  'been', 'not', 'but', 'can', 'you', 'your', 'get', 'show', 'list', 'tell',
  'give', 'about', 'into', 'over', 'out', 'now', 'see', 'does', 'did', 'will',
  'would', 'should', 'could', 'there', 'they', 'them', 'its', 'was', 'were',
]);

// Crude singularisation, but it is the difference between "which POCs are at
// risk" matching a PoC record and matching nothing at all. Substring matching
// was worse in the other direction: "are" matched "shared" and "software".
const stem = (w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);
const wordsOf = (text) => new Set((text.toLowerCase().match(/[a-z0-9]+/g) || []).map(stem));

const MAX_DOC_CHARS = 1200;

export function selectContext(docs, query, budget, maxDocChars = MAX_DOC_CHARS) {
  const terms = [...wordsOf(String(query || ''))].filter((t) => t.length >= 3 && !STOPWORDS.has(t));

  const scored = docs.map((d) => {
    const words = wordsOf(d.text);
    let score = 0;
    for (const term of terms) if (words.has(term)) score += 1;
    return { doc: d, score };
  });

  scored.sort((a, b) =>
    b.score - a.score || (b.doc.updatedAt || '').localeCompare(a.doc.updatedAt || '')
  );

  const chosen = [];
  let used = 0;
  for (const { doc: d } of scored) {
    // Trim the individual document first, so the budget spreads across many
    // records instead of being spent on the two longest.
    const text = d.text.length > maxDocChars
      ? d.text.slice(0, maxDocChars).replace(/\s+\S*$/, '') + '\n…[truncated]'
      : d.text;
    if (used + text.length > budget && chosen.length) break;
    chosen.push(text === d.text ? d : { ...d, text });
    used += text.length;
  }
  return { documents: chosen, characters: used, truncated: chosen.length < docs.length };
}

// ---- request plumbing --------------------------------------------------------

class BadRequest extends Error {}

function readParams(req) {
    let userId = null;
  if (req.user) {
    const wantsAll = req.query.scope === 'all';
    if (wantsAll && req.user.role !== 'admin') {
      throw new BadRequest('scope=all requires an admin account');
    }
    userId = wantsAll ? null : req.user.id;
  }

  const typesParam = clean(req.query.types);
  const types = typesParam ? typesParam.split(',').map((t) => t.trim()).filter(Boolean) : DOC_TYPES;
  const unknown = types.filter((t) => !DOC_TYPES.includes(t));
  if (unknown.length) throw new BadRequest(`Unknown document type(s): ${unknown.join(', ')}`);

  const limit = Math.min(Number(req.query.limit) || DEFAULT_LIMIT, MAX_LIMIT);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const chunkChars = Math.max(Number(req.query.chunkChars) || 0, 0);
  const since = clean(req.query.since);

  return { userId, types, limit, offset, chunkChars, since };
}

function collect(req) {
  const p = readParams(req);
  let docs = buildDocuments(p);
  // ?since is a resume watermark, not a filter on record age: pass back the
  // generatedAt of your last successful run and you get only what changed.
  if (p.since) docs = docs.filter((d) => (d.updatedAt || '') > p.since);
  docs = applyChunking(docs, p.chunkChars);
  return { params: p, total: docs.length, page: docs.slice(p.offset, p.offset + p.limit) };
}

export const REQUIRE_AUTH = process.env.INGEST_REQUIRE_AUTH === 'true';
if (REQUIRE_AUTH) router.use(requireReadAccess);

router.use((req, res, next) => {
  // A retrieval index must never be served from a stale cache.
  res.set('Cache-Control', 'no-store');
  next();
});

// Self-describing root, so a client can discover the feed without the README.
router.get('/', (req, res) => {
  res.json({
    service: 'se-tracker-ingest',
    version: 1,
    documentTypes: DOC_TYPES,
    scope: !req.user ? 'whole org (unauthenticated)' : req.user.role === 'admin' ? 'own rows by default, ?scope=all for the org' : 'own rows',
    endpoints: {
      'GET /api/ingest/documents': 'embed-ready documents; ?since= ?types= ?scope=all ?limit= ?offset= ?chunkChars= ?format=json|ndjson',
      'GET /api/ingest/documents/:id': 'a single document by its id',
      'GET /api/ingest/manifest': 'id + hash + updatedAt for every document, for delta sync and deletion detection',
      'GET /api/ingest/stats': 'document counts by type',
    },
    maxLimit: MAX_LIMIT,
  });
});

router.get('/documents', (req, res) => {
  const { params, total, page } = collect(req);
  const generatedAt = new Date().toISOString();

  // NDJSON so a client can stream straight into an embedding loop without
  // holding the whole response in memory.
  if (req.query.format === 'ndjson') {
    res.type('application/x-ndjson');
    for (const d of page) res.write(JSON.stringify(d) + '\n');
    return res.end();
  }

  const hasMore = params.offset + page.length < total;
  res.json({
    generatedAt,
    // Feed this back as ?since= on the next run — but only once hasMore is
    // false, i.e. after you have paged through the whole delta. Advancing the
    // watermark mid-pass would skip everything you hadn't fetched yet. It is
    // the request time rather than the newest document's timestamp so a record
    // written *during* this request is picked up next run instead of missed.
    nextSince: hasMore ? params.since || null : generatedAt,
    count: page.length,
    total,
    offset: params.offset,
    limit: params.limit,
    hasMore,
    documents: page,
  });
});

router.get('/manifest', (req, res) => {
  const p = readParams(req);
  const docs = applyChunking(buildDocuments(p), p.chunkChars);
  res.json({
    generatedAt: new Date().toISOString(),
    count: docs.length,
    // Deliberately the full list, unpaginated: the client diffs it against its
    // own index to find documents that were deleted upstream, which only works
    // if it sees every id that still exists.
    documents: docs.map((d) => ({ id: d.id, type: d.type, hash: d.hash, updatedAt: d.updatedAt })),
  });
});

router.get('/stats', (req, res) => {
  const p = readParams(req);
  const docs = buildDocuments(p);
  const byType = Object.fromEntries(
    DOC_TYPES.map((t) => [t, docs.filter((d) => d.type === t).length])
  );
  res.json({
    generatedAt: new Date().toISOString(),
    total: docs.length,
    byType,
    characters: docs.reduce((n, d) => n + d.text.length, 0),
  });
});

router.get('/documents/:id(*)', (req, res) => {
  const p = readParams(req);
  const docs = applyChunking(buildDocuments(p), p.chunkChars);
  const found = docs.find((d) => d.id === req.params.id);
  if (!found) return res.status(404).json({ error: 'No such document' });
  res.json({ document: found });
});

router.use((err, req, res, next) => {
  if (err instanceof BadRequest) return res.status(400).json({ error: err.message });
  console.error('ingest error:', err);
  res.status(500).json({ error: 'Ingest failed' });
});
