import type { IvrNode } from "../db/ivrNodes";

// Can an AFTER-HOURS call reach a ring step that targets the on-call rotation?
//
// Three earlier versions of this answered easier questions and got them wrong:
//
// 1. Counting rows (`WHERE type='ring' AND target='on_call'`) counts a step nothing points at.
//    Blank next-fields are legal so a flow can be built incrementally, and replaceFlowNodes
//    persists every node in the payload whether or not it is reachable -- so an admin who drags in
//    a ring step and never repoints the closed branch satisfied the count with a rota ringing
//    nobody.
// 2. Walking every branch follows the OPEN side of business_hours as well. A ring step hung off
//    the daytime path would report the AFTER-HOURS rota as fine, which is the one thing the check
//    exists to deny. flowEngine takes `closedNextNodeId` and only that when isAfterHours, so this
//    follows the closed branch alone there. NOT at date_rule: that branches on the HOLIDAY list,
//    and an ordinary night is not a closed date, so it takes openNextNodeId -- following only the
//    closed side walked the holiday path and got a correctly wired rota wrong. Following both then
//    went green over a rota only holidays reach. The open branch alone is the ordinary night.
// 3. Loading one flow drops any next-id crossing into another. Node ids are a global PRIMARY KEY
//    -- `nodeExistsInOtherFlow` exists precisely because of that, and flowEngine's loadNodeById
//    has no flow predicate -- so a cross-flow reference is a supported shape, and a correctly
//    wired rota would have been reported as unwired.
//
// 4. Walking `main` alone. CallSession sends an after-hours call into the `after_hours` flow
//    whenever that flow has an entry node, falling back to `main` only when it has none -- so that
//    is the flow walked here, chosen the same way.
//
// 5. Walking ONE pair of flow names. Since migration 0041 each number carries its own
//    `after_hours_flow`, so "the after-hours flow" is no longer a single thing: a rota wired into a
//    second line's own menu would have read as unwired, and one wired only into `after_hours` would
//    have read as fine for numbers that never enter it. The caller passes the ordered candidate
//    list for each number in use (`entryFlowCandidates`), each is resolved to the first flow that
//    actually has an entry node -- the same rung-by-rung fallback CallSession walks at call time --
//    and the rota counts as reachable if ANY of them reaches it.
//
// `null` means "could not answer", which the caller reports as a warning rather than a failure.

const CLOSED_ONLY = new Set(["business_hours"]);

const NEXT_FIELDS: Record<string, string[]> = {
  business_hours: ["closedNextNodeId"],
  // Open only: an ordinary night is not a closed date. Following the holiday (closed) branch too
  // reported a rota wired when only holidays reached it.
  date_rule: ["openNextNodeId"],
  play: ["nextNodeId"],
  gather: ["defaultNextNodeId"],
  input: ["nextNodeId"],
  ring: ["noAnswerNextNodeId"],
  wait: ["nextNodeId", "callbackNextNodeId"],
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export async function isRingNodeReachingOnCall(
  db: D1Database,
  // One ordered candidate list per number in use, most-specific first. Required rather than
  // defaulted: a defaulted list would silently answer the pre-0041 question the moment a caller
  // forgot to pass one, which is the "a defaulted exclusion list FAILS OPEN" lesson from the demo
  // account, in a check whose whole job is to notice a rota nothing reaches.
  afterHoursCandidates: string[][]
): Promise<boolean | null> {
  const result = await db.prepare("SELECT * FROM ivr_nodes").all<{
    id: string;
    flow: string;
    is_entry: number;
    type: string;
    config: string;
  }>();

  const nodes = result.results.map((row) => ({
    id: row.id,
    flow: row.flow,
    isEntry: row.is_entry === 1,
    type: row.type,
    config: safeParse(row.config),
  }));

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const entryOf = (flow: string) => nodes.find((n) => n.flow === flow && n.isEntry);

  // Resolve each number's candidate list the way CallSession does: the first flow with an entry
  // node is the one its after-hours callers actually land in.
  const entries = afterHoursCandidates
    .map((candidates) => candidates.map(entryOf).find((n) => n !== undefined))
    .filter((n): n is (typeof nodes)[number] => n !== undefined);

  // No entry node anywhere means every inbound call already fails in loadEntryNode -- the phone
  // system is down, not missing a menu step. Reporting that as "add a ring step" would send someone
  // building a menu while no call of any kind is answered, so it is explicitly unanswerable here.
  if (entries.length === 0) return null;

  // A fresh `seen` per entry: one walk's visited set would let an early flow's dead end mark a node
  // that a later flow reaches by a different route, turning a wired rota into a false negative.
  for (const entry of entries) {
    const seen = new Set<string>();
    const queue = [entry];
    while (queue.length > 0) {
      const node = queue.shift()!;
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      if (node.type === "ring" && node.config.target === "on_call") return true;

      for (const id of outgoing(node.type, node.config)) {
        const next = byId.get(id);
        if (next && !seen.has(next.id)) queue.push(next);
      }
    }
  }
  return false;
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    // One unreadable node must not make the whole walk unanswerable; it simply leads nowhere.
    return {};
  }
}

function outgoing(type: string, config: Record<string, unknown>): string[] {
  const ids = (NEXT_FIELDS[type] ?? []).map((field) => str(config[field]));
  // A menu key is a route like any other, and the "press 1 if this is urgent" split this feature is
  // meant to sit behind is built out of exactly these. Not followed from the two branch types,
  // which have no options anyway -- CLOSED_ONLY is what keeps the daytime side out of the walk.
  if (type === "gather" && !CLOSED_ONLY.has(type) && Array.isArray(config.options)) {
    for (const opt of config.options) ids.push(str((opt as { nextNodeId?: unknown }).nextNodeId));
  }
  return ids.filter((id) => id !== "");
}
