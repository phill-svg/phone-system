# IVR Flow Canvas Editor — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat form-card IVR flow editor (`src/html/pages/ivrFlow.ts`) with a real drag-and-drop canvas (Drawflow, CDN-loaded, no bundler) that renders the existing node graph, persists dragged positions, and opens the existing per-node edit form in a slide-over panel on click.

**Architecture:** Two nullable `position_x`/`position_y` columns are added to `ivr_nodes`. A new admin-gated `PATCH /api/ivr/flows/:flow/nodes/:id/position` endpoint updates just those two columns per drag. The existing `GET`/`PUT /api/ivr/flows/:flow` contract is extended to round-trip `positionX`/`positionY` but is otherwise unchanged. The page itself is rewritten to mount a Drawflow canvas, auto-laying-out any node with no stored position (client-side, BFS rank from the entry node), and reusing the existing per-type form-field-building code (relocated, not rewritten) inside a slide-over panel instead of a list of cards.

**Tech Stack:** TypeScript, Cloudflare Workers/D1, Vitest (`@cloudflare/vitest-pool-workers`), Drawflow (MIT, loaded via CDN `<script>`/`<link>` tags — no new devDependency, no bundler).

## Global Constraints

- **No new devDependency, no bundler.** Drawflow is loaded via a CDN `<script>`/`<link>` tag exactly like every other page in this codebase loads nothing at all (i.e. stays consistent with the zero-build-step pattern) — do not add Vite, React, npm-install Drawflow, or any `wrangler.jsonc` `assets` binding.
- **`positionX`/`positionY` default to `null`** whenever omitted from a `PUT /api/ivr/flows/:flow` payload — this keeps every existing call site (all of `test/api/ivrFlow.test.ts`'s existing assertions, unmodified) compiling and passing without changes.
- **The position PATCH endpoint is admin-gated**, same as `PUT /api/ivr/flows/:flow` (`forbiddenUnlessAdmin`) — it mutates protected flow data, not a public read.
- **Existing validation behavior in `src/api/ivrFlow.ts` (`handleGetFlow`/`handlePutFlow`) must not change** for anything other than round-tripping the two new position fields. Every existing test in `test/api/ivrFlow.test.ts` must continue to pass unmodified.
- **Phase 1 explicitly does NOT add**: connection-drawing/rewiring from the canvas, node add/delete from the canvas, or entry-node reassignment from the canvas. The old "Add node" button and entry-radio-buttons are removed from this page in this phase — deliberately, not a silent regression — and restored in a future Phase 2 plan (not covered here).
- **`src/html/pages/ivrFlow.ts` has no automated test today and has none after this change.** Canvas rendering and drag feel are verified manually per `docs/superpowers/specs/2026-08-10-ivr-flow-canvas-editor-design.md`, matching the exact same "manual verification for the page itself" precedent already used for this same file in the original flow-builder plan's Task 12.
- Reference design doc: `docs/superpowers/specs/2026-08-10-ivr-flow-canvas-editor-design.md` — read it for the full rationale (why Drawflow/CDN, why phased, why the auto-layout algorithm works the way it does) before starting.

---

### Task 1: Migration + DB layer for node positions

**Files:**
- Create: `migrations/0007_ivr_node_positions.sql`
- Modify: `src/db/ivrNodes.ts`
- Test: `test/db/ivrNodes.test.ts`

**Interfaces:**
- Produces: `IvrNode.positionX: number | null`, `IvrNode.positionY: number | null` (added to the existing type). `replaceFlowNodes`'s node array parameter gains optional `positionX?: number | null` / `positionY?: number | null` (default `null` when omitted — existing callers that omit them are unaffected). New function `updateNodePosition(db, flow, id, positionX, positionY): Promise<boolean>` — returns `false` (no write) if no row with that `id` exists in that `flow`, `true` and writes both columns otherwise.

- [ ] **Step 1: Write the migration**

```sql
-- migrations/0007_ivr_node_positions.sql
-- Canvas layout persistence for the IVR flow editor. NULL means "never positioned" --
-- every existing node starts NULL and is client-side auto-laid-out on first render; a
-- position is only written once a node is actually dragged.
ALTER TABLE ivr_nodes ADD COLUMN position_x INTEGER;
ALTER TABLE ivr_nodes ADD COLUMN position_y INTEGER;
```

- [ ] **Step 2: Run the migration locally and confirm it applies cleanly**

Run: `npx wrangler d1 migrations apply tcb-voip-db --local`
Expected: output lists `0007_ivr_node_positions.sql` as applied, no errors.

- [ ] **Step 3: Write the failing tests** — add to `test/db/ivrNodes.test.ts` (existing file; keep all existing `it(...)` blocks unchanged, add these inside the existing `describe("ivrNodes db", ...)` block):

```ts
  it("replaceFlowNodes persists positionX/positionY, and they round-trip through listNodesForFlow", async () => {
    await replaceFlowNodes(env.DB, "test_flow", "node-a", [
      { id: "node-a", type: "voicemail", config: { audioAssetId: null, ttsText: null, mailboxLabel: "a" }, positionX: 120, positionY: 340 },
    ]);

    const nodes = await listNodesForFlow(env.DB, "test_flow");
    expect(nodes[0].positionX).toBe(120);
    expect(nodes[0].positionY).toBe(340);
  });

  it("replaceFlowNodes defaults positionX/positionY to null when omitted", async () => {
    await replaceFlowNodes(env.DB, "test_flow", "node-a", [
      { id: "node-a", type: "voicemail", config: { audioAssetId: null, ttsText: null, mailboxLabel: "a" } },
    ]);

    const nodes = await listNodesForFlow(env.DB, "test_flow");
    expect(nodes[0].positionX).toBeNull();
    expect(nodes[0].positionY).toBeNull();
  });

  it("updateNodePosition updates position_x/position_y for a node in the given flow and returns true", async () => {
    await replaceFlowNodes(env.DB, "test_flow", "node-a", [
      { id: "node-a", type: "voicemail", config: { audioAssetId: null, ttsText: null, mailboxLabel: "a" } },
    ]);

    const result = await updateNodePosition(env.DB, "test_flow", "node-a", 55, 66);
    expect(result).toBe(true);

    const nodes = await listNodesForFlow(env.DB, "test_flow");
    expect(nodes[0].positionX).toBe(55);
    expect(nodes[0].positionY).toBe(66);
  });

  it("updateNodePosition returns false and writes nothing for a node id that doesn't exist in that flow", async () => {
    const result = await updateNodePosition(env.DB, "test_flow", "does-not-exist", 1, 2);
    expect(result).toBe(false);
  });

  it("updateNodePosition returns false for a node that exists but belongs to a DIFFERENT flow", async () => {
    await replaceFlowNodes(env.DB, "other_flow", "node-a", [
      { id: "node-a", type: "voicemail", config: { audioAssetId: null, ttsText: null, mailboxLabel: "a" } },
    ]);

    const result = await updateNodePosition(env.DB, "test_flow", "node-a", 1, 2);
    expect(result).toBe(false);
  });
```

Also add the two new imports to the top of the test file:

```ts
import { listNodesForFlow, nodeExists, replaceFlowNodes, updateNodePosition } from "../../src/db/ivrNodes";
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run test/db/ivrNodes.test.ts`
Expected: FAIL — `updateNodePosition` is not exported, `positionX`/`positionY` are `undefined` (not yet columns/fields).

- [ ] **Step 5: Implement — modify `src/db/ivrNodes.ts`**

Replace the whole file with:

```ts
export type IvrNode = {
  id: string;
  flow: string;
  isEntry: boolean;
  type: string;
  config: Record<string, unknown>;
  positionX: number | null;
  positionY: number | null;
};

type IvrNodeRow = {
  id: string;
  flow: string;
  is_entry: number;
  type: string;
  config: string;
  position_x: number | null;
  position_y: number | null;
};

export async function listNodesForFlow(db: D1Database, flow: string): Promise<IvrNode[]> {
  const result = await db.prepare("SELECT * FROM ivr_nodes WHERE flow = ?").bind(flow).all<IvrNodeRow>();
  return result.results.map((row) => ({
    id: row.id,
    flow: row.flow,
    isEntry: row.is_entry === 1,
    type: row.type,
    config: JSON.parse(row.config) as Record<string, unknown>,
    positionX: row.position_x,
    positionY: row.position_y,
  }));
}

export async function nodeExists(db: D1Database, id: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 FROM ivr_nodes WHERE id = ? LIMIT 1").bind(id).first();
  return row !== null;
}

// Like nodeExists, but excludes rows belonging to `excludeFlow`. Used by handlePutFlow so
// cross-reference/duplicate-id validation reflects what the DB will look like AFTER this save
// (the flow currently being replaced is about to be wiped and re-inserted from the payload, so
// its current rows shouldn't count as "still existing" for validation purposes).
export async function nodeExistsInOtherFlow(db: D1Database, id: string, excludeFlow: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 FROM ivr_nodes WHERE id = ? AND flow != ? LIMIT 1").bind(id, excludeFlow).first();
  return row !== null;
}

export async function replaceFlowNodes(
  db: D1Database,
  flow: string,
  entryNodeId: string,
  nodes: {
    id: string;
    type: string;
    config: Record<string, unknown>;
    positionX?: number | null;
    positionY?: number | null;
  }[]
): Promise<void> {
  const now = Date.now();
  // Full delete-then-reinsert, run atomically via D1's batch(). This is an internal admin
  // tool for a handful of nodes per flow, so it's not worth the complexity of an
  // upsert-preserving-created_at approach -- every save just re-creates created_at/updated_at.
  const statements = [
    db.prepare("DELETE FROM ivr_nodes WHERE flow = ?").bind(flow),
    ...nodes.map((node) =>
      db
        .prepare(
          "INSERT INTO ivr_nodes (id, flow, is_entry, type, config, position_x, position_y, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(
          node.id,
          flow,
          node.id === entryNodeId ? 1 : 0,
          node.type,
          JSON.stringify(node.config),
          node.positionX ?? null,
          node.positionY ?? null,
          now,
          now
        )
    ),
  ];
  await db.batch(statements);
}

// Used by the canvas editor's drag-to-reposition endpoint. Scoped to (id, flow) rather than
// just id -- id is a global PRIMARY KEY, but a position PATCH always targets one specific
// flow's view of that node, and should 404 rather than silently write if the id/flow pairing
// is wrong (e.g. a stale client still viewing a flow that no longer contains that id).
export async function updateNodePosition(
  db: D1Database,
  flow: string,
  id: string,
  positionX: number,
  positionY: number
): Promise<boolean> {
  const existing = await db.prepare("SELECT 1 FROM ivr_nodes WHERE id = ? AND flow = ? LIMIT 1").bind(id, flow).first();
  if (existing === null) return false;
  await db
    .prepare("UPDATE ivr_nodes SET position_x = ?, position_y = ?, updated_at = ? WHERE id = ? AND flow = ?")
    .bind(positionX, positionY, Date.now(), id, flow)
    .run();
  return true;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/db/ivrNodes.test.ts`
Expected: PASS, all tests including the 5 new ones.

- [ ] **Step 7: Commit**

```bash
git add migrations/0007_ivr_node_positions.sql src/db/ivrNodes.ts test/db/ivrNodes.test.ts
git commit -m "Add ivr_nodes position_x/position_y columns + updateNodePosition"
```

No dependencies.

---

### Task 2: API layer — position PATCH endpoint + position round-trip on GET/PUT

**Files:**
- Modify: `src/api/ivrFlow.ts`
- Modify: `src/worker.ts`
- Test: `test/api/ivrFlow.test.ts`

**Interfaces:**
- Consumes: `updateNodePosition(db, flow, id, positionX, positionY): Promise<boolean>` from Task 1.
- Produces: `handlePatchNodePosition(request, db, flow, nodeId, staff): Promise<Response>` — 403 non-admin, 400 invalid body, 404 unknown node-in-flow, 200 `{ok:true}` on success. New worker route `PATCH /api/ivr/flows/:flow/nodes/:id/position`.

- [ ] **Step 1: Write the failing tests** — add to `test/api/ivrFlow.test.ts` (existing file; keep every existing `it(...)` unchanged). Add this helper near the existing `putRequest` helper:

```ts
function patchPositionRequest(flow: string, nodeId: string, body: unknown): Request {
  return new Request(
    `https://example.com/api/ivr/flows/${encodeURIComponent(flow)}/nodes/${encodeURIComponent(nodeId)}/position`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }
  );
}
```

Add this new `describe` block (new import of `handlePatchNodePosition` goes alongside the existing `handleGetFlow, handlePutFlow` import at the top):

```ts
describe("handlePatchNodePosition", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM ivr_nodes").run();
  });

  it("returns 403 for a non-admin staff user", async () => {
    const response = await handlePatchNodePosition(
      patchPositionRequest("test_flow", "n1", { positionX: 1, positionY: 2 }),
      env.DB,
      "test_flow",
      "n1",
      STAFF
    );
    expect(response.status).toBe(403);
  });

  it("returns 400 for a non-JSON body", async () => {
    const response = await handlePatchNodePosition(
      patchPositionRequest("test_flow", "n1", "not json"),
      env.DB,
      "test_flow",
      "n1",
      ADMIN
    );
    expect(response.status).toBe(400);
  });

  it("returns 400 when positionX/positionY are not numbers", async () => {
    const response = await handlePatchNodePosition(
      patchPositionRequest("test_flow", "n1", { positionX: "1", positionY: 2 }),
      env.DB,
      "test_flow",
      "n1",
      ADMIN
    );
    expect(response.status).toBe(400);
  });

  it("returns 404 for a node id that doesn't exist in that flow", async () => {
    const response = await handlePatchNodePosition(
      patchPositionRequest("test_flow", "ghost", { positionX: 1, positionY: 2 }),
      env.DB,
      "test_flow",
      "ghost",
      ADMIN
    );
    expect(response.status).toBe(404);
  });

  it("updates position and returns {ok:true} for a real node", async () => {
    await replaceFlowNodes(env.DB, "test_flow", "vm-1", [validVoicemail]);

    const response = await handlePatchNodePosition(
      patchPositionRequest("test_flow", "vm-1", { positionX: 42, positionY: 99 }),
      env.DB,
      "test_flow",
      "vm-1",
      ADMIN
    );
    expect(response.status).toBe(200);

    const row = await env.DB.prepare("SELECT position_x, position_y FROM ivr_nodes WHERE id = ?")
      .bind("vm-1")
      .first<{ position_x: number; position_y: number }>();
    expect(row?.position_x).toBe(42);
    expect(row?.position_y).toBe(99);
  });
});
```

Also add these two `it` blocks inside the existing `describe("handlePutFlow", ...)` block (anywhere among the other `it`s):

```ts
  it("round-trips positionX/positionY when provided in the payload", async () => {
    const response = await handlePutFlow(
      putRequest({
        entryNodeId: "vm-1",
        nodes: [{ ...validVoicemail, positionX: 10, positionY: 20 }],
      }),
      env.DB,
      "test_flow",
      ADMIN
    );
    expect(response.status).toBe(200);

    const getResponse = await handleGetFlow(env.DB, "test_flow");
    const body = (await getResponse.json()) as { nodes: { positionX: number; positionY: number }[] };
    expect(body.nodes[0].positionX).toBe(10);
    expect(body.nodes[0].positionY).toBe(20);
  });

  it("defaults positionX/positionY to null when omitted from the payload", async () => {
    const response = await handlePutFlow(
      putRequest({ entryNodeId: "vm-1", nodes: [validVoicemail] }),
      env.DB,
      "test_flow",
      ADMIN
    );
    expect(response.status).toBe(200);

    const getResponse = await handleGetFlow(env.DB, "test_flow");
    const body = (await getResponse.json()) as { nodes: { positionX: number | null; positionY: number | null }[] };
    expect(body.nodes[0].positionX).toBeNull();
    expect(body.nodes[0].positionY).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/api/ivrFlow.test.ts`
Expected: FAIL — `handlePatchNodePosition` not exported; position round-trip assertions fail (`positionX`/`positionY` undefined on the returned nodes until Task 1's DB layer is wired through, which it already is from Task 1 — the failure here is specifically the missing handler and any missing plumbing in `handlePutFlow`'s node-parsing loop).

- [ ] **Step 3: Implement — modify `src/api/ivrFlow.ts`**

Add this import (extend the existing import line):

```ts
import { listNodesForFlow, nodeExistsInOtherFlow, replaceFlowNodes, updateNodePosition } from "../db/ivrNodes";
```

Add this helper near the other `isXOrNull`-style helpers:

```ts
function isNumberOrNull(value: unknown): value is number | null {
  return value === null || typeof value === "number";
}
```

Update the `PutNode` type:

```ts
type PutNode = { id: string; type: NodeType; config: Record<string, unknown>; positionX: number | null; positionY: number | null };
```

In `handlePutFlow`'s per-node loop, replace this block:

```ts
    const type = raw.type as NodeType;
    if (!isValidConfigForType(type, raw.config)) {
      return new Response(`node '${raw.id}' has an invalid config shape for type '${type}'`, { status: 400 });
    }
    typedNodes.push({ id: raw.id, type, config: raw.config });
```

with:

```ts
    const type = raw.type as NodeType;
    if (!isValidConfigForType(type, raw.config)) {
      return new Response(`node '${raw.id}' has an invalid config shape for type '${type}'`, { status: 400 });
    }
    if (raw.positionX !== undefined && !isNumberOrNull(raw.positionX)) {
      return new Response(`node '${raw.id}' has an invalid positionX`, { status: 400 });
    }
    if (raw.positionY !== undefined && !isNumberOrNull(raw.positionY)) {
      return new Response(`node '${raw.id}' has an invalid positionY`, { status: 400 });
    }
    typedNodes.push({
      id: raw.id,
      type,
      config: raw.config,
      positionX: (raw.positionX as number | null | undefined) ?? null,
      positionY: (raw.positionY as number | null | undefined) ?? null,
    });
```

Add this new exported function at the end of the file:

```ts
export async function handlePatchNodePosition(
  request: Request,
  db: D1Database,
  flow: string,
  nodeId: string,
  staff: StaffUser
): Promise<Response> {
  const forbidden = forbiddenUnlessAdmin(staff);
  if (forbidden) return forbidden;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return INVALID_BODY_RESPONSE();
  }

  if (!isPlainObject(body) || typeof body.positionX !== "number" || typeof body.positionY !== "number") {
    return INVALID_BODY_RESPONSE();
  }

  const updated = await updateNodePosition(db, flow, nodeId, body.positionX, body.positionY);
  if (!updated) {
    return new Response("not found", { status: 404 });
  }
  return jsonResponse({ ok: true });
}
```

- [ ] **Step 4: Wire the new route into `src/worker.ts`**

Change the import on line 9 from:

```ts
import { handleGetFlow, handlePutFlow } from "./api/ivrFlow";
```

to:

```ts
import { handleGetFlow, handlePatchNodePosition, handlePutFlow } from "./api/ivrFlow";
```

Immediately after the existing `ivrFlowMatch` block (the one ending `}` before the final `return new Response("not found", { status: 404 });` at the bottom of the `/api/` branch), insert:

```ts
      // PATCH-only endpoint (drag-to-reposition on the flow canvas). Disjoint from ivrFlowMatch
      // above -- that regex terminates right after the flow segment ($), so it never matches
      // this longer /nodes/:id/position path; same non-shadowing reasoning as the
      // /api/ivr/audio-vs-/api/ivr/flows comment above it.
      const ivrNodePositionMatch = url.pathname.match(/^\/api\/ivr\/flows\/([^/]+)\/nodes\/([^/]+)\/position$/);
      if (ivrNodePositionMatch) {
        try {
          const flow = decodeURIComponent(ivrNodePositionMatch[1]);
          const nodeId = decodeURIComponent(ivrNodePositionMatch[2]);
          return handlePatchNodePosition(request, env.DB, flow, nodeId, staff);
        } catch (e) {
          if (e instanceof URIError) {
            return new Response("not found", { status: 404 });
          }
          throw e;
        }
      }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/api/ivrFlow.test.ts`
Expected: PASS, all tests including the new ones. Then run the full suite to confirm nothing else broke: `npx vitest run` (allow up to 240s).
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/api/ivrFlow.ts src/worker.ts test/api/ivrFlow.test.ts
git commit -m "Add PATCH /api/ivr/flows/:flow/nodes/:id/position + positionX/Y round-trip"
```

Depends on Task 1.

---

### Task 3: Drawflow canvas page

**Files:**
- Modify: `src/html/layout.ts`
- Modify: `src/html/pages/ivrFlow.ts` (full rewrite)

**Interfaces:**
- Consumes: `IvrNode` (from Task 1, now carrying `positionX`/`positionY`), `GET`/`PUT /api/ivr/flows/:flow`, `PATCH /api/ivr/flows/:flow/nodes/:id/position` (from Task 2).
- Produces: nothing new consumed by other tasks — this is the top of the stack for Phase 1.

- [ ] **Step 1: Determine the current Drawflow CDN URLs**

Drawflow (https://github.com/jerosoler/Drawflow) is the chosen library — MIT-licensed node/connection canvas editor, no framework dependency. Run:

```bash
curl -s https://registry.npmjs.org/drawflow/latest | node -e "process.stdin.resume();process.stdin.setEncoding('utf8');let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).version))"
```

Expected: prints a version string, e.g. `0.0.59`. Use that exact string everywhere `{{DRAWFLOW_VERSION}}` appears below (both the JS and CSS URL). Before writing any code, fetch `https://raw.githubusercontent.com/jerosoler/Drawflow/master/README.md` and confirm these API names still match what's used below: `new Drawflow(container)`, `editor.start()`, `editor.reroute`, `editor.addNode(name, num_in, num_out, pos_x, pos_y, class, data, html)`, `editor.addConnection(id_output, id_input, output_class, input_class)`, `editor.on('nodeMoved', fn)`, `editor.on('nodeSelected', fn)`, `editor.drawflow.drawflow[editor.module].data[id]` (shape: `{ pos_x, pos_y, data, ... }`), `editor.module` (defaults to `'Home'`). If any name has changed in the version you resolved, use the current name instead — the approach (map our nodes/edges into these calls, read position back out of the same data structure on `nodeMoved`) stays the same either way.

- [ ] **Step 2: Add optional head/width overrides to `renderLayout`**

The current `renderLayout(title, activeNav, body)` has no hook for extra `<head>` content and forces every page into a 960px centered column — wrong for a full-canvas page. Modify `src/html/layout.ts`:

Change the function signature and body from:

```ts
export function renderLayout(title: string, activeNav: string, body: string): string {
  const nav = NAV_ITEMS.map(
    (item) =>
      `<a href="${item.href}" class="nav-link${item.key === activeNav ? " active" : ""}">${escapeHtml(item.label)}</a>`
  ).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)} — TCB VoIP Admin</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; color: #1a1a1a; }
  header { background: #1a3d2e; color: white; padding: 1rem 1.5rem; display: flex; gap: 1.5rem; align-items: center; }
  header h1 { font-size: 1.1rem; margin: 0; }
  .nav-link { color: #cfe8db; text-decoration: none; }
  .nav-link.active { color: white; font-weight: 600; }
  main { padding: 1.5rem; max-width: 960px; margin: 0 auto; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 0.5rem; border-bottom: 1px solid #ddd; }
  .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 0.25rem; font-size: 0.75rem; }
  .badge-after-hours { background: #fde8e8; color: #9b1c1c; }
  .placeholder { background: #f3f4f6; border: 1px dashed #9ca3af; border-radius: 0.5rem; padding: 1rem; color: #6b7280; margin-top: 1rem; }
  .placeholder button { cursor: not-allowed; opacity: 0.6; }
  form.settings-form label { display: block; margin-bottom: 0.75rem; }
  form.settings-form input { margin-left: 0.5rem; }
  .ring-entry { display: flex; gap: 0.5rem; margin-bottom: 0.5rem; }
</style>
</head>
<body>
<header><h1>TCB VoIP Admin</h1>${nav}</header>
<main>${body}</main>
</body>
</html>`;
}
```

to:

```ts
export function renderLayout(
  title: string,
  activeNav: string,
  body: string,
  opts?: { extraHead?: string; fullWidth?: boolean }
): string {
  const nav = NAV_ITEMS.map(
    (item) =>
      `<a href="${item.href}" class="nav-link${item.key === activeNav ? " active" : ""}">${escapeHtml(item.label)}</a>`
  ).join("");
  const mainClass = opts?.fullWidth ? ' class="full-width"' : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)} — TCB VoIP Admin</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; color: #1a1a1a; }
  header { background: #1a3d2e; color: white; padding: 1rem 1.5rem; display: flex; gap: 1.5rem; align-items: center; }
  header h1 { font-size: 1.1rem; margin: 0; }
  .nav-link { color: #cfe8db; text-decoration: none; }
  .nav-link.active { color: white; font-weight: 600; }
  main { padding: 1.5rem; max-width: 960px; margin: 0 auto; }
  main.full-width { max-width: none; padding: 0; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 0.5rem; border-bottom: 1px solid #ddd; }
  .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 0.25rem; font-size: 0.75rem; }
  .badge-after-hours { background: #fde8e8; color: #9b1c1c; }
  .placeholder { background: #f3f4f6; border: 1px dashed #9ca3af; border-radius: 0.5rem; padding: 1rem; color: #6b7280; margin-top: 1rem; }
  .placeholder button { cursor: not-allowed; opacity: 0.6; }
  form.settings-form label { display: block; margin-bottom: 0.75rem; }
  form.settings-form input { margin-left: 0.5rem; }
  .ring-entry { display: flex; gap: 0.5rem; margin-bottom: 0.5rem; }
</style>
${opts?.extraHead ?? ""}
</head>
<body>
<header><h1>TCB VoIP Admin</h1>${nav}</header>
<main${mainClass}>${body}</main>
</body>
</html>`;
}
```

Every other existing caller of `renderLayout` passes exactly 3 arguments today and is unaffected (the 4th parameter is optional).

- [ ] **Step 3: Rewrite `src/html/pages/ivrFlow.ts`**

Replace the entire file with (substitute the real version string for `{{DRAWFLOW_VERSION}}` from Step 1, in both URLs):

```ts
import { renderLayout } from "../layout";
import type { IvrNode } from "../../db/ivrNodes";

// Embeds a value as a JSON literal inside a <script> block. Guards against a stray
// "</script>" inside e.g. an uploaded audio-asset label or a node's ttsText breaking out
// of the script tag early.
function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

const DRAWFLOW_CSS_URL = "https://cdn.jsdelivr.net/npm/drawflow@{{DRAWFLOW_VERSION}}/dist/drawflow.min.css";
const DRAWFLOW_JS_URL = "https://cdn.jsdelivr.net/npm/drawflow@{{DRAWFLOW_VERSION}}/dist/drawflow.min.js";

export function renderIvrFlowPage(
  flow: string,
  nodes: IvrNode[],
  audioAssets: { id: string; label: string }[]
): string {
  const extraHead = `<link rel="stylesheet" href="${DRAWFLOW_CSS_URL}">
    <style>
      #canvas-wrap { position: relative; height: calc(100vh - 64px); }
      #drawflow { width: 100%; height: 100%; background: #f8f9fa; }
      #cdn-error { display: none; padding: 1rem; background: #fde8e8; color: #9b1c1c; }
      .ivr-node { border: 2px solid #1a3d2e; border-radius: 6px; background: white; padding: 0.5rem 0.75rem; min-width: 140px; cursor: pointer; }
      .ivr-node-id { font-weight: 600; font-size: 0.85rem; }
      .ivr-node-type { font-size: 0.75rem; color: #6b7280; }
      #edit-panel { display: none; position: fixed; top: 0; right: 0; width: 380px; height: 100vh; background: white; border-left: 1px solid #ccc; padding: 1rem; overflow-y: auto; box-shadow: -2px 0 8px rgba(0,0,0,0.1); z-index: 10; }
      #edit-panel.open { display: block; }
    </style>`;

  const body = `<div id="cdn-error">Could not load the flow editor library. Check your connection and reload the page.</div>
    <div id="canvas-wrap">
      <div id="drawflow"></div>
    </div>
    <div id="edit-panel">
      <button type="button" id="close-panel-btn">Close</button>
      <div id="edit-panel-fields"></div>
      <p><button type="button" id="save-node-btn">Save node</button> <span id="save-status"></span></p>
    </div>

    <h3>Upload audio</h3>
    <form id="audio-upload-form">
      <input type="file" id="audio-file-input" name="file" required>
      <input type="text" id="audio-label-input" name="label" placeholder="Label">
      <button type="submit">Upload</button>
      <span id="audio-upload-status"></span>
    </form>
    <div id="audio-asset-list"></div>

    <script src="${DRAWFLOW_JS_URL}" onerror="document.getElementById('cdn-error').style.display='block'"></script>
    <script>
      var FLOW = ${safeJsonForScript(flow)};
      var currentNodes = ${safeJsonForScript(nodes)};
      var audioAssets = ${safeJsonForScript(audioAssets)};
      var entryNodeId = (currentNodes.filter(function (n) { return n.isEntry; })[0] || {}).id || null;
      var editor = null;
      var drawflowIdToIvrId = {};
      var ivrIdToDrawflowId = {};
      var editingIvrId = null;

      function escAttr(s) {
        return String(s == null ? '' : s)
          .replace(/&/g, '&amp;')
          .replace(/"/g, '&quot;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
      }
      function escText(s) {
        return escAttr(s);
      }

      function audioOptionsHtml(selectedId) {
        var html = '<option value="">(none)</option>';
        audioAssets.forEach(function (a) {
          var sel = a.id === selectedId ? ' selected' : '';
          html += '<option value="' + escAttr(a.id) + '"' + sel + '>' + escText(a.label) + '</option>';
        });
        return html;
      }

      function typeOptionsHtml(selectedType) {
        var types = ['business_hours', 'play', 'gather', 'ring', 'wait', 'voicemail'];
        var html = '';
        types.forEach(function (t) {
          html += '<option value="' + t + '"' + (t === selectedType ? ' selected' : '') + '>' + t + '</option>';
        });
        return html;
      }

      function gatherOptionRowHtml(opt) {
        var digit = opt && opt.digit ? opt.digit : '';
        var next = opt && opt.nextNodeId ? opt.nextNodeId : '';
        return '<div class="gather-option-row">' +
          '<input type="text" class="opt-digit" placeholder="digit" value="' + escAttr(digit) + '">' +
          '<input type="text" class="opt-next" placeholder="nextNodeId" value="' + escAttr(next) + '">' +
          '<button type="button" class="remove-option-btn">Remove option</button>' +
          '</div>';
      }

      // Same field-group markup as the old flat-card editor, minus the entry-radio/remove-node
      // controls (Phase 1 has no canvas equivalent for those yet -- deferred to Phase 2).
      function buildFieldsHtml(node) {
        var config = node.config || {};
        var html = '';
        html += '<label>ID <input type="text" id="panel-id-input" value="' + escAttr(node.id) + '" readonly></label> ';
        html += '<label>Type <select id="panel-type-select" onchange="toggleFields(this)">' + typeOptionsHtml(node.type) + '</select></label>';

        html += '<div class="field-group" data-type="business_hours" style="display:' + (node.type === 'business_hours' ? 'block' : 'none') + '">' +
          '<label>Open next node <input type="text" class="f-openNextNodeId" value="' + escAttr(config.openNextNodeId) + '"></label> ' +
          '<label>Closed next node <input type="text" class="f-closedNextNodeId" value="' + escAttr(config.closedNextNodeId) + '"></label>' +
          '</div>';

        html += '<div class="field-group" data-type="play" style="display:' + (node.type === 'play' ? 'block' : 'none') + '">' +
          '<label>Audio asset <select class="f-audioAssetId">' + audioOptionsHtml(config.audioAssetId) + '</select></label> ' +
          '<label>TTS text <input type="text" class="f-ttsText" value="' + escAttr(config.ttsText) + '"></label> ' +
          '<label>Next node <input type="text" class="f-nextNodeId" value="' + escAttr(config.nextNodeId) + '"></label>' +
          '</div>';

        var options = Array.isArray(config.options) ? config.options : [];
        var optionRows = options.map(gatherOptionRowHtml).join('');
        html += '<div class="field-group" data-type="gather" style="display:' + (node.type === 'gather' ? 'block' : 'none') + '">' +
          '<label>Audio asset <select class="f-audioAssetId">' + audioOptionsHtml(config.audioAssetId) + '</select></label> ' +
          '<label>TTS text <input type="text" class="f-ttsText" value="' + escAttr(config.ttsText) + '"></label>' +
          '<div class="gather-options-list">' + optionRows + '</div>' +
          '<button type="button" class="add-option-btn">Add option</button> ' +
          '<label>Default next node <input type="text" class="f-defaultNextNodeId" value="' + escAttr(config.defaultNextNodeId) + '"></label> ' +
          '<label>Retry limit <input type="number" class="f-retryLimit" value="' + escAttr(config.retryLimit != null ? config.retryLimit : 3) + '"></label>' +
          '</div>';

        html += '<div class="field-group" data-type="ring" style="display:' + (node.type === 'ring' ? 'block' : 'none') + '">' +
          '<label>Target <select class="f-target">' +
          '<option value="all"' + (config.target === 'all' ? ' selected' : '') + '>all</option>' +
          '<option value="on_call_only"' + (config.target === 'on_call_only' ? ' selected' : '') + '>on_call_only</option>' +
          '</select></label> ' +
          '<label>Strategy <select class="f-strategy">' +
          '<option value="cascade"' + (config.strategy === 'cascade' ? ' selected' : '') + '>cascade</option>' +
          '<option value="simultaneous"' + (config.strategy === 'simultaneous' ? ' selected' : '') + '>simultaneous</option>' +
          '</select></label> ' +
          '<label>Timeout seconds <input type="number" class="f-timeoutSeconds" value="' + escAttr(config.timeoutSeconds != null ? config.timeoutSeconds : 20) + '"></label> ' +
          '<label>No-answer next node <input type="text" class="f-noAnswerNextNodeId" value="' + escAttr(config.noAnswerNextNodeId) + '"></label>' +
          '</div>';

        html += '<div class="field-group" data-type="wait" style="display:' + (node.type === 'wait' ? 'block' : 'none') + '">' +
          '<label>Audio asset <select class="f-audioAssetId">' + audioOptionsHtml(config.audioAssetId) + '</select></label> ' +
          '<label>TTS text <input type="text" class="f-ttsText" value="' + escAttr(config.ttsText) + '"></label> ' +
          '<label>Allow callback (*) <input type="checkbox" class="f-allowCallbackStar"' + (config.allowCallbackStar ? ' checked' : '') + '></label> ' +
          '<label>Next node <input type="text" class="f-nextNodeId" value="' + escAttr(config.nextNodeId) + '"></label>' +
          '</div>';

        html += '<div class="field-group" data-type="voicemail" style="display:' + (node.type === 'voicemail' ? 'block' : 'none') + '">' +
          '<label>Audio asset <select class="f-audioAssetId">' + audioOptionsHtml(config.audioAssetId) + '</select></label> ' +
          '<label>TTS text <input type="text" class="f-ttsText" value="' + escAttr(config.ttsText) + '"></label> ' +
          '<label>Mailbox label <input type="text" class="f-mailboxLabel" value="' + escAttr(config.mailboxLabel) + '"></label>' +
          '</div>';

        return html;
      }

      function toggleFields(selectEl) {
        var panel = document.getElementById('edit-panel-fields');
        var groups = panel.querySelectorAll('.field-group');
        groups.forEach(function (g) {
          g.style.display = g.getAttribute('data-type') === selectEl.value ? 'block' : 'none';
        });
      }

      function audioOrTtsConfig(group) {
        var audioId = group.querySelector('.f-audioAssetId').value;
        var tts = group.querySelector('.f-ttsText').value.trim();
        return {
          audioAssetId: audioId ? audioId : null,
          ttsText: !audioId && tts ? tts : null,
        };
      }

      // Reads the currently-open panel's form fields for whatever type is selected and
      // returns { type, config } for the node being edited (editingIvrId).
      function collectNodeFromPanel() {
        var panel = document.getElementById('edit-panel-fields');
        var type = document.getElementById('panel-type-select').value;
        var group = panel.querySelector('.field-group[data-type="' + type + '"]');
        var config = {};
        if (type === 'business_hours') {
          config.openNextNodeId = group.querySelector('.f-openNextNodeId').value.trim();
          config.closedNextNodeId = group.querySelector('.f-closedNextNodeId').value.trim();
        } else if (type === 'play') {
          var pc = audioOrTtsConfig(group);
          config.audioAssetId = pc.audioAssetId;
          config.ttsText = pc.ttsText;
          config.nextNodeId = group.querySelector('.f-nextNodeId').value.trim();
        } else if (type === 'wait') {
          var wc = audioOrTtsConfig(group);
          config.audioAssetId = wc.audioAssetId;
          config.ttsText = wc.ttsText;
          config.allowCallbackStar = group.querySelector('.f-allowCallbackStar').checked;
          config.nextNodeId = group.querySelector('.f-nextNodeId').value.trim();
        } else if (type === 'voicemail') {
          var vc = audioOrTtsConfig(group);
          config.audioAssetId = vc.audioAssetId;
          config.ttsText = vc.ttsText;
          config.mailboxLabel = group.querySelector('.f-mailboxLabel').value.trim();
        } else if (type === 'gather') {
          var gc = audioOrTtsConfig(group);
          config.audioAssetId = gc.audioAssetId;
          config.ttsText = gc.ttsText;
          var options = [];
          group.querySelectorAll('.gather-option-row').forEach(function (row) {
            var digit = row.querySelector('.opt-digit').value.trim();
            var next = row.querySelector('.opt-next').value.trim();
            if (digit !== '') options.push({ digit: digit, nextNodeId: next });
          });
          config.options = options;
          config.defaultNextNodeId = group.querySelector('.f-defaultNextNodeId').value.trim();
          config.retryLimit = Number(group.querySelector('.f-retryLimit').value) || 0;
        } else if (type === 'ring') {
          config.target = group.querySelector('.f-target').value;
          config.strategy = group.querySelector('.f-strategy').value;
          config.timeoutSeconds = Number(group.querySelector('.f-timeoutSeconds').value) || 0;
          config.noAnswerNextNodeId = group.querySelector('.f-noAnswerNextNodeId').value.trim();
        }
        return { type: type, config: config };
      }

      // Every node-id-shaped outgoing reference for a node, by type -- used for both drawing
      // canvas connections and for the auto-layout BFS. Mirrors referencesForNode() in
      // src/api/ivrFlow.ts (kept in sync by hand since this runs as inline browser JS with no
      // shared module to import from).
      function outgoingRefs(node) {
        var c = node.config || {};
        if (node.type === 'business_hours') return [c.openNextNodeId, c.closedNextNodeId].filter(Boolean);
        if (node.type === 'play' || node.type === 'wait') return [c.nextNodeId].filter(Boolean);
        if (node.type === 'ring') return [c.noAnswerNextNodeId].filter(Boolean);
        if (node.type === 'gather') {
          var opts = Array.isArray(c.options) ? c.options : [];
          return opts.map(function (o) { return o.nextNodeId; }).concat([c.defaultNextNodeId]).filter(Boolean);
        }
        return [];
      }

      // Ordered list of { target } per output slot, in the SAME order used when the node's
      // Drawflow output count was decided in outputsCountForType -- addConnection uses
      // 1-based "output_N" slot names that must line up with this order.
      function outputHandlesForType(node) {
        var c = node.config || {};
        if (node.type === 'business_hours') return [{ target: c.openNextNodeId }, { target: c.closedNextNodeId }];
        if (node.type === 'play' || node.type === 'wait') return [{ target: c.nextNodeId }];
        if (node.type === 'ring') return [{ target: c.noAnswerNextNodeId }];
        if (node.type === 'gather') {
          var opts = Array.isArray(c.options) ? c.options : [];
          return opts.map(function (o) { return { target: o.nextNodeId }; }).concat([{ target: c.defaultNextNodeId }]);
        }
        return [];
      }

      function outputsCountForType(node) {
        if (node.type === 'voicemail') return 0;
        if (node.type === 'business_hours') return 2;
        if (node.type === 'gather') {
          var opts = Array.isArray(node.config.options) ? node.config.options : [];
          return opts.length + 1;
        }
        return 1;
      }

      // Layered/rank auto-layout: BFS from the entry node, ranking each node by hop distance.
      // Each rank becomes a column; nodes within a rank are stacked in rows. Nodes unreachable
      // from the entry (shouldn't normally exist, given the save API's cross-reference
      // validation, but a node could still be legitimately un-pointed-to) get appended as
      // trailing ranks so nothing silently disappears from the canvas. This only computes an
      // INITIAL position for nodes with no stored positionX/positionY -- it is never itself
      // persisted; a node only gets a real stored position once it's actually dragged.
      function computeAutoLayout(nodes) {
        var byId = {};
        nodes.forEach(function (n) { byId[n.id] = n; });

        var rank = {};
        var queue = entryNodeId ? [entryNodeId] : [];
        if (entryNodeId) rank[entryNodeId] = 0;
        while (queue.length > 0) {
          var currentId = queue.shift();
          var current = byId[currentId];
          if (!current) continue;
          outgoingRefs(current).forEach(function (nextId) {
            if (!(nextId in rank) && byId[nextId]) {
              rank[nextId] = rank[currentId] + 1;
              queue.push(nextId);
            }
          });
        }

        var maxRank = 0;
        Object.keys(rank).forEach(function (id) { if (rank[id] > maxRank) maxRank = rank[id]; });
        nodes.forEach(function (n) {
          if (!(n.id in rank)) {
            maxRank += 1;
            rank[n.id] = maxRank;
          }
        });

        var countPerRank = {};
        var positions = {};
        var RANK_WIDTH = 280;
        var ROW_HEIGHT = 160;
        nodes.forEach(function (n) {
          var r = rank[n.id];
          var row = countPerRank[r] || 0;
          countPerRank[r] = row + 1;
          positions[n.id] = { x: r * RANK_WIDTH + 40, y: row * ROW_HEIGHT + 40 };
        });
        return positions;
      }

      function nodeHtml(node) {
        return '<div class="ivr-node"><div class="ivr-node-id">' + escText(node.id) + '</div><div class="ivr-node-type">' + escText(node.type) + '</div></div>';
      }

      function renderAudioAssetList() {
        var el = document.getElementById('audio-asset-list');
        el.innerHTML = audioAssets
          .map(function (a) {
            return '<div>' + escText(a.label) + ' (' + escText(a.id) + ')</div>';
          })
          .join('');
      }

      async function refreshAudioAssets() {
        var res = await fetch('/api/ivr/audio');
        if (!res.ok) return;
        audioAssets = await res.json();
        document.querySelectorAll('.f-audioAssetId').forEach(function (sel) {
          var current = sel.value;
          sel.innerHTML = audioOptionsHtml(current);
          sel.value = current;
        });
        renderAudioAssetList();
      }

      function buildCanvas() {
        var container = document.getElementById('drawflow');
        editor = new Drawflow(container);
        editor.reroute = true;
        editor.start();

        var autoPositions = computeAutoLayout(currentNodes);

        currentNodes.forEach(function (node) {
          var pos = (node.positionX != null && node.positionY != null)
            ? { x: node.positionX, y: node.positionY }
            : autoPositions[node.id];
          var numOutputs = outputsCountForType(node);
          var drawflowId = editor.addNode(node.type, 1, numOutputs, pos.x, pos.y, 'ivr-node', { ivrNodeId: node.id }, nodeHtml(node));
          drawflowIdToIvrId[drawflowId] = node.id;
          ivrIdToDrawflowId[node.id] = drawflowId;
        });

        currentNodes.forEach(function (node) {
          var fromDrawflowId = ivrIdToDrawflowId[node.id];
          var handles = outputHandlesForType(node);
          handles.forEach(function (h, idx) {
            if (!h.target) return;
            var toDrawflowId = ivrIdToDrawflowId[h.target];
            if (toDrawflowId == null) return;
            editor.addConnection(fromDrawflowId, toDrawflowId, 'output_' + (idx + 1), 'input_1');
          });
        });

        editor.on('nodeMoved', function (drawflowId) {
          var ivrId = drawflowIdToIvrId[drawflowId];
          var data = editor.drawflow.drawflow[editor.module].data[drawflowId];
          var posX = Math.round(data.pos_x);
          var posY = Math.round(data.pos_y);
          var node = currentNodes.filter(function (n) { return n.id === ivrId; })[0];
          if (node) {
            node.positionX = posX;
            node.positionY = posY;
          }
          fetch('/api/ivr/flows/' + encodeURIComponent(FLOW) + '/nodes/' + encodeURIComponent(ivrId) + '/position', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ positionX: posX, positionY: posY }),
          });
        });

        editor.on('nodeSelected', function (drawflowId) {
          var ivrId = drawflowIdToIvrId[drawflowId];
          openEditPanel(ivrId);
        });
      }

      function openEditPanel(ivrId) {
        var node = currentNodes.filter(function (n) { return n.id === ivrId; })[0];
        if (!node) return;
        editingIvrId = ivrId;
        document.getElementById('save-status').textContent = '';
        document.getElementById('edit-panel-fields').innerHTML = buildFieldsHtml(node);
        document.getElementById('edit-panel').classList.add('open');
      }

      document.getElementById('close-panel-btn').addEventListener('click', function () {
        document.getElementById('edit-panel').classList.remove('open');
        editingIvrId = null;
      });

      document.getElementById('save-node-btn').addEventListener('click', async function () {
        if (!editingIvrId) return;
        var updated = collectNodeFromPanel();
        var node = currentNodes.filter(function (n) { return n.id === editingIvrId; })[0];
        node.type = updated.type;
        node.config = updated.config;

        var status = document.getElementById('save-status');
        var payload = {
          entryNodeId: entryNodeId,
          nodes: currentNodes.map(function (n) {
            return { id: n.id, type: n.type, config: n.config, positionX: n.positionX, positionY: n.positionY };
          }),
        };
        var res = await fetch('/api/ivr/flows/' + encodeURIComponent(FLOW), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          status.textContent = 'Saved.';
          document.getElementById('edit-panel').classList.remove('open');
          editingIvrId = null;
        } else {
          var text = await res.text();
          status.textContent = 'Failed to save: ' + text;
        }
      });

      document.getElementById('edit-panel-fields').addEventListener('click', function (e) {
        var t = e.target;
        if (t.classList.contains('add-option-btn')) {
          var group = t.closest('.field-group');
          var list = group.querySelector('.gather-options-list');
          var div = document.createElement('div');
          div.innerHTML = gatherOptionRowHtml(null);
          list.appendChild(div.firstChild);
        } else if (t.classList.contains('remove-option-btn')) {
          t.closest('.gather-option-row').remove();
        }
      });

      document.getElementById('audio-upload-form').addEventListener('submit', async function (e) {
        e.preventDefault();
        var status = document.getElementById('audio-upload-status');
        var fileInput = document.getElementById('audio-file-input');
        var labelInput = document.getElementById('audio-label-input');
        var formData = new FormData();
        if (fileInput.files.length > 0) formData.append('file', fileInput.files[0]);
        if (labelInput.value) formData.append('label', labelInput.value);
        var res = await fetch('/api/ivr/audio', { method: 'POST', body: formData });
        if (res.ok) {
          status.textContent = 'Uploaded.';
          fileInput.value = '';
          labelInput.value = '';
          await refreshAudioAssets();
        } else {
          status.textContent = 'Upload failed.';
        }
      });

      if (window.Drawflow) {
        buildCanvas();
      } else {
        document.getElementById('cdn-error').style.display = 'block';
      }
      renderAudioAssetList();
    </script>`;

  return renderLayout(`IVR Flow: ${flow}`, "ivr", body, { extraHead: extraHead, fullWidth: true });
}
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. (`escapeHtml` is no longer imported/used in this file since node ids/labels go through the local `escText`, matching the original file's own local-escaping convention for everything rendered inside the `<script>` block — confirm this doesn't leave an unused import; if `escapeHtml` is unused, it must not be imported.)

- [ ] **Step 5: Run the full test suite to confirm nothing else broke**

Run: `npx vitest run` (allow up to 240s)
Expected: PASS. This file and `layout.ts` have no automated tests of their own (matching existing convention), so this step exists to confirm the `renderLayout` signature change didn't break any other page's tests.

- [ ] **Step 6: Manual verification** (no automated test exists for canvas rendering/drag feel — this is the documented, deliberate exception per `docs/superpowers/specs/2026-08-10-ivr-flow-canvas-editor-design.md`)

Run `npx wrangler dev` locally and, in a browser:
1. Visit `/admin/ivr/main` (log in as staff first if the dev environment enforces Access). Confirm 6 node boxes render (`main_entry_gather`, `main_ring_new_booking`, `main_ring_existing_job`, `main_ring_emergency`, `main_ring_operator`, `shared_voicemail`) with visible connection lines: the entry gather node has 5 outgoing lines (4 digit options + default), each ring node has exactly 1 outgoing line to `shared_voicemail`.
2. Drag a node to a new position, reload the page. Confirm it stays where it was dropped (not reset to the auto-layout position).
3. Click a node. Confirm the slide-over panel opens showing that node's current type and fields. Change a text field (e.g. `ttsText`), click "Save node". Confirm the status shows "Saved.", the panel closes, and reloading the page shows the new value if you re-open that node's panel.
4. Temporarily edit `DRAWFLOW_JS_URL` to an invalid URL, reload the page, confirm the red "Could not load the flow editor library" banner shows instead of a blank canvas. Revert the URL.
5. Visit `/admin/ivr/after_hours`. Confirm its 2 nodes render, including the connection from `after_hours_ring_emergency` to `shared_voicemail` (a node that belongs to the `main` flow) — the cross-flow-shared-node case.

Record the outcome (pass/fail per item) in the task report — if any item fails, fix before marking this task complete.

- [ ] **Step 7: Commit**

```bash
git add src/html/layout.ts src/html/pages/ivrFlow.ts
git commit -m "Replace flat-card IVR flow editor with a Drawflow drag-and-drop canvas (Phase 1)"
```

Depends on Task 2.

---

## Verification (whole-plan)

1. `npx vitest run` (full suite) green.
2. `npx tsc --noEmit` clean.
3. Task 3 Step 6's manual checklist, all 5 items pass.
4. Deploy (`npx wrangler d1 migrations apply tcb-voip-db --remote`, `npm run deploy`) and have Phill look at `/admin/ivr/main` and `/admin/ivr/after_hours` in the actual desktop app — this is the real test this whole phase exists to pass. **Not dispatchable to a subagent.** Phase 2 (connection-drawing, node add/delete, entry-node reassignment from the canvas) is a separate future design + plan, scoped only after this feedback comes back.
