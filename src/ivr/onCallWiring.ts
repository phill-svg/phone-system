import { listNodesForFlow } from "../db/ivrNodes";

// Can a call actually REACH a ring step that targets the on-call rotation?
//
// The first version of this counted rows: `SELECT COUNT(*) ... WHERE type='ring' AND
// json_extract(config,'$.target')='on_call'`. That answers a different question, and answers it
// wrongly in two ordinary cases. `replaceFlowNodes` persists every node in the payload whether or
// not anything points at it, and blank "next" fields are explicitly legal so a flow can be built up
// incrementally -- so an admin who drags in a ring step, sets it to "Whoever is on call", saves, and
// never repoints the closed branch away from the voicemail node has a row that satisfies the count
// and a rota that still rings nobody. A leftover ring node in some other flow satisfied it too.
//
// So this walks the flow the way the flow engine does, from the entry node, and only reports true
// if a reachable node is a ring node targeting `on_call`.
const NEXT_FIELDS: Record<string, string[]> = {
  business_hours: ["openNextNodeId", "closedNextNodeId"],
  date_rule: ["openNextNodeId", "closedNextNodeId"],
  play: ["nextNodeId"],
  gather: ["defaultNextNodeId"],
  input: ["nextNodeId"],
  ring: ["noAnswerNextNodeId"],
  wait: ["nextNodeId"],
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export async function isRingNodeReachingOnCall(db: D1Database, flow = "main"): Promise<boolean> {
  const nodes = await listNodesForFlow(db, flow);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const entry = nodes.find((n) => n.isEntry);
  if (!entry) return false;

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
  return false;
}

function outgoing(type: string, config: Record<string, unknown>): string[] {
  const ids = (NEXT_FIELDS[type] ?? []).map((field) => str(config[field]));
  // A menu key is a route like any other, and the urgent-vs-voicemail split this feature is meant
  // to sit behind is built out of exactly these.
  if (type === "gather" && Array.isArray(config.options)) {
    for (const opt of config.options) ids.push(str((opt as { nextNodeId?: unknown }).nextNodeId));
  }
  return ids.filter((id) => id !== "");
}
