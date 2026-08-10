# IVR Flow Canvas Editor — Design

## Context

`src/html/pages/ivrFlow.ts` renders the IVR flow editor as a flat list of per-node form "cards." Cross-references between nodes (`nextNodeId`, `noAnswerNextNodeId`, gather digit→node options) are plain text inputs — staff must know and hand-type another node's id. Phill: "i want the ivr to be more like aircall it flows a lot better and easier to make it work our one looks more like a mess." Asked to choose between (a) an auto-generated read-only diagram + dropdown pickers, or (b) a full drag-and-drop visual builder like Aircall's actual editor — Phill chose (b).

This codebase has zero frontend build tooling today (confirmed: `package.json` devDependencies are only `@cloudflare/vitest-pool-workers`, `@cloudflare/workers-types`, `typescript`, `vitest`, `wrangler` — no Vite, no bundler, no framework). `wrangler.jsonc` has no `assets` binding. Every existing admin page is server-rendered HTML + inline vanilla JS.

The `GET/PUT /api/ivr/flows/:flow` API (whole-flow read/replace, full validation) is already built, tested, and reviewed as part of the calling-system plan — this design does not change it.

## Decision: no bundler, CDN-loaded Drawflow

Rejected: Vite + React + `@xyflow/react`. This would be the first bundler and first frontend framework in the repo, requiring a new build-before-deploy step and a `wrangler.jsonc` `assets` binding — a large new subsystem for what's an internal single-business admin tool.

Rejected: hand-rolled SVG/canvas drag-and-drop with zero dependencies. Reimplements pan/zoom, edge routing, drag/snap — solved problems — and risks feeling worse than "Aircall's actual editor," which is the explicit ask.

**Chosen: [Drawflow](https://github.com/jerosoler/Drawflow)** (MIT), loaded via a plain `<script>`/`<link>` CDN tag, same "buildless" pattern as every other page in this app. Gives real node dragging, connection rendering, pan/zoom, and JSON import/export out of the box, with no new devDependency or build step.

## Phasing

Automated tests can verify the API layer; nothing can verify "does this look and feel better" except Phill looking at it. So this ships in two visible phases rather than one big-bang build:

**Phase 1 — canvas view + position persistence (this design's scope):**
- Flow renders as a Drawflow canvas: node boxes positioned and connected per the existing node graph.
- Nodes with no stored position get one from a simple auto-layout (see below).
- Dragging a node persists its new position.
- Clicking a node opens its existing type-specific edit form (unchanged) in a slide-over panel; saving still PUTs the whole flow via the existing endpoint.
- No connection-drawing, no node add/delete from the canvas yet.

**Phase 2 — full canvas editing (separate future design/plan, not built now):**
- Draw/rewire connections by dragging between nodes (writes back to the source node's `nextNodeId`/`noAnswerNextNodeId`/gather-option config).
- Add/delete nodes and set the entry node from the canvas, replacing the old "Add node" button and entry radio buttons.

Phill reviews Phase 1 live in the desktop app before Phase 2 is designed or built.

## Data model change

`ivr_nodes` gains two nullable columns: `position_x INTEGER`, `position_y INTEGER`. Null means "never positioned" — every existing seeded node starts out null and gets an auto-layout position on first render (see below), not a backfilled real position.

## Auto-layout (for nodes with null position)

Layered/rank layout: BFS from the flow's entry node, ranking each node by hop distance from the entry (nodes unreachable from the entry — should not normally exist, given the API's cross-reference validation — get appended as an extra trailing rank so nothing silently disappears from view). Each rank becomes a column (or row); nodes within a rank are spread evenly. This is a one-time, client-side computation used only to seed the initial view — it is not stored back to the DB unless the node is subsequently dragged (at which point its real position is persisted, same as any other drag).

## API additions

`PATCH /api/ivr/flows/:flow/nodes/:id/position` — body `{ positionX: number, positionY: number }`. Staff-gated, same as the existing flow endpoints. Updates only those two columns on the one row; does not re-run the full-flow validation (position has no bearing on flow correctness). 404 if the node id doesn't exist in that flow.

No changes to `GET`/`PUT /api/ivr/flows/:flow` — both now additionally read/accept `positionX`/`positionY` per node (nullable), passed through unchanged by validation.

## Frontend

`src/html/pages/ivrFlow.ts` is replaced (not extended). Structure:
- CDN `<link>`/`<script>` tags for Drawflow's CSS/JS.
- A `<div id="canvas">` Drawflow mounts into, sized to fill the available viewport.
- Init JS: maps each `IvrNode` (+ its existing outgoing references) into Drawflow's node/connection input format; nodes without `position_x`/`position_y` get the auto-layout coordinates computed as above.
- Node click handler opens a slide-over `<div>` containing that node's existing type-specific edit form (the current `buildCardHtml`-style rendering, relocated rather than rewritten) with Save/Cancel; Save PUTs the whole flow (existing behavior), Cancel just closes the panel.
- Drawflow's `nodeMoved` event fires once per completed drag (not continuously); the handler calls the new position PATCH endpoint directly on that event, no debounce needed.
- If the CDN script fails to load, the page shows a plain visible error message instead of a blank canvas.
- The "Add node" button and entry-node radio buttons are temporarily removed from this page for Phase 1 (no canvas equivalent yet) — noted here as an explicit, deliberate, temporary regression restored in Phase 2, not an oversight. Node type/config edits, and the audio-upload form, are unaffected and stay as they are.

## Testing

- Migration: existing migration-applies-cleanly test pattern, extended for the two new columns.
- New position PATCH endpoint: Vitest coverage — updates the right row, 404 for unknown node, staff-gated (matches existing endpoint test conventions).
- `GET`/`PUT` flow endpoints: extend existing tests to round-trip `positionX`/`positionY` (including null).
- Canvas rendering, drag feel, auto-layout visual quality: **no automated test** — verified by Phill in the desktop app (Task 18), by design, before Phase 2 is scoped.

## Explicitly out of scope for this design

- Connection drawing/rewiring from the canvas (Phase 2).
- Node add/delete/entry-designation from the canvas (Phase 2).
- Any change to `src/api/ivrFlow.ts`'s existing validation rules.
- Any new build tooling, bundler, or frontend framework.
