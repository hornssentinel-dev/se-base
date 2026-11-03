# Feeding SE Tracker into Ollama

`/api/ingest` is a read-only feed that turns the tracker into small, self-contained
plain-text documents — the shape a retrieval index wants. Ollama itself has no
crawler: you run a sync job that pulls from this API, embeds each document with
Ollama's `/api/embed`, and writes the vectors into whatever store you're using.

## 1. Pull documents

The feed is **open** — no key, no header. It is served to a retrieval job on
another host on the LAN, and threading a credential through that job was judged
not worth it for this deployment.

```bash
curl 'http://192.168.4.49:3000/api/ingest/documents?limit=500'
```

An unauthenticated request has no owner to scope to, so it returns the whole
org's pipeline; `?scope=all` is a no-op. A request that *does* arrive with a
session cookie keeps the ordinary ownership rules (own rows, `?scope=all` for
admins).

### Closing it again

Set `INGEST_REQUIRE_AUTH=true` in the environment and restart. That restores the
read-only API key / session cookie check on every ingest route, with no other
change. Keys are issued from the CLI:

```bash
npm run api-key -- --name ollama --user you@example.com   # prints the token once
npm run api-key -- --list                                 # who has keys
npm run api-key -- --revoke <id>                          # immediate 401
```

Clients then send `Authorization: Bearer set_…` (or `X-API-Key`). The key acts as
the named user: an admin account for the whole org, an SE account for one
person's rows.

Every document looks like this:

```json
{
  "id": "note:opp1:n2",
  "type": "note",
  "title": "Risk — Acme Corp (2026-02-10)",
  "text": "Risk note on Acme Corp — 2026-02-10\nAccount: Acme Corp · Segment: Enterprise · SE stage: PoC · Products: SWG, CASB · SE owner: Sam SE\n\nProcurement freeze until Q2 unless we show quantified DLP savings.",
  "updatedAt": "2026-02-10T09:12:44.101Z",
  "hash": "fb16499271d73e62",
  "metadata": { "oppId": "opp1", "account": "Acme Corp", "noteType": "Risk", "...": "..." }
}
```

`text` is what you embed. `metadata` is what you store alongside the vector for
filtering and for citing the answer back to a human. `hash` is a digest of
`text`: unchanged hash, nothing to re-embed.

One record becomes several documents. An opportunity yields a profile document
plus one document per note, per demo, and one for its PoC — so a hit tells you
*which* conversation matched, not just which account.

| Type | Id form | What it is |
|---|---|---|
| `opportunity` | `opportunity:<oppId>` | Deal profile: stage, ACV, products, champion, competitor, next action, PoC summary |
| `note` | `note:<oppId>:<noteId>` | One note, prefixed with its account/stage context |
| `demo` | `demo:<oppId>:<demoId>` | One demo: products, audience, outcome |
| `poc` | `poc:<oppId>` | PoC dates, health, and the full criteria list |
| `business_case` | `business_case:<id>` | Shared org-wide talking point (not user-scoped) |
| `task` | `task:<id>` | One open or completed task |

### Query parameters

| Param | Default | Notes |
|---|---|---|
| `since` | — | ISO timestamp; return only documents changed since. Pass back the previous run's `nextSince`. |
| `types` | all | Comma-separated subset, e.g. `types=note,demo` |
| `scope` | whole org | No-op while the feed is open; with auth on, `scope=all` is admin-only |
| `limit` / `offset` | 200 / 0 | `limit` caps at 1000; page while `hasMore` is true |
| `chunkChars` | off | Split long documents at paragraph/line/sentence boundaries; ids become `note:opp1:n2#1` |
| `format` | `json` | `ndjson` streams one document per line |

Other endpoints:

- `GET /api/ingest` — self-describing index of the feed
- `GET /api/ingest/stats` — document counts by type, total characters
- `GET /api/ingest/manifest` — `{id, type, hash, updatedAt}` for **every** document, unpaginated. Diff it against your index to find documents deleted upstream.
- `GET /api/ingest/documents/:id` — one document

## 2. Sync into Ollama

Incremental sync in full: `since` gets you what changed, the manifest gets you
what disappeared.

```js
// sync.js — node sync.js
const TRACKER = process.env.TRACKER_URL || 'http://192.168.4.49:3000';
const OLLAMA  = process.env.OLLAMA_URL  || 'http://localhost:11434';
const MODEL   = 'nomic-embed-text';        // ollama pull nomic-embed-text

const tracker = async (path) => {
  // No auth header: the feed is open. Add
  // { headers: { Authorization: `Bearer ${process.env.SE_TRACKER_KEY}` } }
  // if INGEST_REQUIRE_AUTH is ever switched on.
  const res = await fetch(`${TRACKER}/api/ingest${path}`);
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return res.json();
};

const embed = async (input) => {
  const res = await fetch(`${OLLAMA}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, input }),
  });
  return (await res.json()).embeddings;
};

// Replace these three with your vector store (Chroma, Qdrant, pgvector, …).
const store = { upsert: async (rows) => {}, remove: async (ids) => {}, knownHashes: async () => ({}) };

const since = process.argv[2] || '';       // last run's nextSince, '' for a full build
let offset = 0, nextSince = since, fresh = [];

for (;;) {
  const page = await tracker(
    `/documents?limit=200&offset=${offset}` +
    `${since ? `&since=${encodeURIComponent(since)}` : ''}`
  );
  fresh.push(...page.documents);
  if (!page.hasMore) { nextSince = page.nextSince; break; }
  offset += page.documents.length;
}

// Skip anything whose text hasn't actually changed — re-embedding is the slow part.
const known = await store.knownHashes();
const changed = fresh.filter((d) => known[d.id] !== d.hash);

for (let i = 0; i < changed.length; i += 16) {
  const batch = changed.slice(i, i + 16);
  const vectors = await embed(batch.map((d) => d.text));
  await store.upsert(batch.map((d, n) => ({
    id: d.id, vector: vectors[n], text: d.text, metadata: { ...d.metadata, type: d.type, title: d.title },
  })));
}

// Deletions: anything in the index that the manifest no longer lists.
const manifest = await tracker('/manifest');
const live = new Set(manifest.documents.map((d) => d.id));
await store.remove(Object.keys(known).filter((id) => !live.has(id)));

console.log(`embedded ${changed.length} of ${fresh.length}; next run: node sync.js ${nextSince}`);
```

Two things worth getting right:

- **Only advance the watermark after a complete pass.** `nextSince` is `null`
  while `hasMore` is true, precisely so a half-finished run can't skip records.
- **Notes and demos inherit their opportunity's `updatedAt`,** because they live
  in its JSON columns. Editing one note re-emits every document for that
  opportunity; the `hash` check above keeps that from costing you anything.

Chunking is off by default — these documents are small. Turn it on with
`chunkChars=1200` if your embedding model has a tight window.

## The in-app Ask panel

SE Tracker ships its own chat over this same data — the **Ask** button in the
header opens a panel that posts to `POST /api/chat`. That route is *not* part of
the open ingest feed: it is session-authenticated and scoped to the signed-in
user, and it assembles the prompt server-side so the browser cannot widen its own
scope.

It talks to whichever Ollama `OLLAMA_URL` points at (default
`http://localhost:11434`, model `OLLAMA_MODEL`, default `gemma4:e4b`) and needs no
embedding model — it selects records by keyword overlap and sends them as context:

```bash
OLLAMA_URL=http://192.168.4.124:11434 OLLAMA_MODEL=gemma4:e4b npm start
```

With no records in scope the route answers without calling the model at all. That
is deliberate: given an empty context block, a local model will invent an account,
a close date and a person's name rather than admit it has nothing.

## No vector store yet?

A single SE's tracker is usually a few hundred KB of text. Below roughly 100
documents you can skip retrieval entirely and stuff the whole feed into a prompt:

```bash
CTX=$(curl -s 'http://192.168.4.49:3000/api/ingest/documents?limit=1000' |
  python3 -c 'import json,sys; print("\n\n---\n\n".join(d["text"] for d in json.load(sys.stdin)["documents"]))')

curl -s http://localhost:11434/api/generate -d "$(jq -n --arg c "$CTX" '{
  model: "gemma4:e4b", stream: false,
  prompt: ("Here is my SE pipeline:\n\n" + $c + "\n\nWhich deals are at risk and why?")
}')" | jq -r .response
```

Move to embeddings + a vector store once the corpus outgrows the context window.
Note that embedding needs an embedding model — a chat model will answer
`this model does not support embeddings` on `/api/embed`. `ollama pull
nomic-embed-text` (768 dims) or `mxbai-embed-large` (1024) covers it.

## Scope and privacy

As deployed, the feed is unauthenticated and returns every SE's pipeline to
anyone who can reach port 3000 on .49 — deliberately, to keep the LAN ingest job
simple. Two consequences worth being deliberate about:

- Restrict reachability at the network layer, since the app no longer does it:
  `sudo ufw allow from 192.168.4.124 to any port 3000 proto tcp` scopes it to the
  one host that needs it.
- An index built from this feed flattens the per-SE boundary — anyone who can
  query the resulting model can read the whole pipeline.

Set `INGEST_REQUIRE_AUTH=true` to put the key check back; per-SE keys then give
you one index per SE.

Note *images* are never included either way — only a count of the attachments on
a note.
