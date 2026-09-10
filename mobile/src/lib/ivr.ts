// The IVR flow, shaped for a phone.
//
// The web editor is a drag-and-drop node graph, which is the right tool on a desktop and the wrong
// one on a handset. The same data reads perfectly well as a LIST of steps, provided the list is in
// the order a call actually walks them rather than the order D1 returns rows — see orderNodes.
// Nothing here edits a graph layout; positions are carried through untouched (see IvrNode).

export type IvrNode = {
  id: string;
  flow: string;
  isEntry: boolean;
  type: IvrNodeType;
  config: Record<string, unknown>;
  // Never read or written by this app -- they are the WEB editor's canvas coordinates. They are
  // carried on the type, and back out in a save, because PUT /api/ivr/flows/:flow is a full
  // delete-and-reinsert: dropping them here would silently flatten the web canvas to the origin
  // the next time anyone opened it.
  positionX: number | null;
  positionY: number | null;
};

export type IvrFlow = { entryNodeId: string | null; nodes: IvrNode[] };

export const IVR_NODE_TYPES = [
  "business_hours",
  "date_rule",
  "play",
  "gather",
  "input",
  "ring",
  "wait",
  "voicemail",
  "callback",
  "redirect",
] as const;

export type IvrNodeType = (typeof IVR_NODE_TYPES)[number];

export const NODE_TYPE_LABELS: Record<IvrNodeType, string> = {
  business_hours: "Business hours",
  date_rule: "Closed dates",
  play: "Play a message",
  gather: "Menu",
  input: "Collect digits",
  ring: "Ring staff",
  wait: "Hold",
  voicemail: "Voicemail",
  callback: "Log a callback",
  redirect: "Forward to a number",
};

// Which config fields on each type point at another step. Everything that walks or rewrites the
// graph reads this ONE list, so adding a node type means adding it here and nowhere else.
export const NEXT_FIELDS: Record<IvrNodeType, string[]> = {
  business_hours: ["openNextNodeId", "closedNextNodeId"],
  date_rule: ["openNextNodeId", "closedNextNodeId"],
  play: ["nextNodeId"],
  gather: ["defaultNextNodeId"],
  input: ["nextNodeId"],
  ring: ["noAnswerNextNodeId"],
  wait: ["nextNodeId"],
  voicemail: [],
  callback: [],
  redirect: [],
};

// Human labels for those fields, so an edit screen never shows a raw config key.
export const NEXT_FIELD_LABELS: Record<string, string> = {
  openNextNodeId: "When open, go to",
  closedNextNodeId: "When closed, go to",
  nextNodeId: "Then go to",
  defaultNextNodeId: "No key pressed, go to",
  noAnswerNextNodeId: "Nobody answers, go to",
};

export function nodeTitle(node: IvrNode): string {
  return NODE_TYPE_LABELS[node.type] ?? node.type;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

// The one line under a step's title in the list. It has to answer "what does this step do" without
// opening it, because scanning a flow is most of what this screen is for.
export function nodeSummary(node: IvrNode): string {
  const c = node.config;
  switch (node.type) {
    case "ring": {
      const target = c.target;
      const who =
        target === "on_call" ? "whoever is on call" : target === "all" ? "everyone available" : `${(target as string[])?.length ?? 0} chosen`;
      const secs = typeof c.timeoutSeconds === "number" ? c.timeoutSeconds : 0;
      return `Rings ${who} for ${secs}s`;
    }
    case "voicemail":
      return str(c.mailboxLabel) ? `Mailbox: ${str(c.mailboxLabel)}` : "Takes a message";
    case "gather": {
      const options = Array.isArray(c.options) ? c.options : [];
      return options.length === 0 ? "No keys set" : `Keys: ${options.map((o) => str((o as { digit?: unknown }).digit)).join(", ")}`;
    }
    case "redirect":
      return str(c.number) ? `To ${str(c.number)}` : "No number set";
    case "date_rule": {
      const dates = Array.isArray(c.closedDates) ? c.closedDates : [];
      return dates.length === 0 ? "No closed dates" : `${dates.length} closed date${dates.length === 1 ? "" : "s"}`;
    }
    case "input":
      return `Collects ${typeof c.numDigits === "number" ? c.numDigits : 0} digit(s)`;
    case "business_hours":
      return "Splits open vs closed";
    case "wait":
      return c.allowCallbackStar ? "Hold, ★ requests a callback" : "Hold";
    case "play":
    case "callback":
      return promptSummary(node);
  }
}

// What the caller HEARS. TTS text is shown; a stored audio asset is named as such, because the
// asset id is a uuid and means nothing to a human.
export function promptSummary(node: IvrNode): string {
  const tts = str(node.config.ttsText).trim();
  if (tts) return tts.length > 60 ? `${tts.slice(0, 57)}…` : tts;
  if (str(node.config.audioAssetId)) return "Plays a recording";
  return "Says nothing";
}

// Steps in the order a CALL walks them: breadth-first from the entry node, following every
// next-field and every menu key.
//
// The raw order is whatever `SELECT *` returns, which is neither the call order nor stable, and a
// list in that order is unreadable: the greeting can sit below the voicemail it falls through to.
// Anything unreachable is appended at the end rather than hidden -- an orphaned step is usually a
// half-finished edit, and it is exactly what someone opening this screen needs to see.
export function orderNodes(flow: IvrFlow): { ordered: IvrNode[]; unreachable: IvrNode[] } {
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  const entry = flow.entryNodeId ? byId.get(flow.entryNodeId) : undefined;
  const seen = new Set<string>();
  const ordered: IvrNode[] = [];
  const queue: IvrNode[] = entry ? [entry] : [];

  while (queue.length > 0) {
    const node = queue.shift()!;
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    ordered.push(node);
    for (const id of outgoingIds(node)) {
      const next = byId.get(id);
      if (next && !seen.has(next.id)) queue.push(next);
    }
  }

  return { ordered, unreachable: flow.nodes.filter((n) => !seen.has(n.id)) };
}

// Every step this one can lead to. A blank reference is legal and common -- a flow is built up
// incrementally -- so empties are dropped rather than treated as a dangling link.
export function outgoingIds(node: IvrNode): string[] {
  const ids = NEXT_FIELDS[node.type].map((field) => str(node.config[field]));
  if (node.type === "gather" && Array.isArray(node.config.options)) {
    for (const opt of node.config.options) ids.push(str((opt as { nextNodeId?: unknown }).nextNodeId));
  }
  return ids.filter((id) => id !== "");
}

// A step's name in a "go to" picker. The type alone is ambiguous once a flow has two voicemail
// boxes or three ring steps, so the summary disambiguates them.
export function nodePickerLabel(node: IvrNode): string {
  const summary = nodeSummary(node);
  return summary ? `${nodeTitle(node)} — ${summary}` : nodeTitle(node);
}

// A new step, with a config the server's validator will accept. Every "next" field starts blank,
// which the API explicitly allows: you wire it up after adding it.
export function blankConfigFor(type: IvrNodeType): Record<string, unknown> {
  switch (type) {
    case "business_hours":
    case "date_rule":
      return type === "date_rule"
        ? { closedDates: [], openNextNodeId: "", closedNextNodeId: "" }
        : { openNextNodeId: "", closedNextNodeId: "" };
    case "play":
      return { audioAssetId: null, ttsText: "", nextNodeId: "" };
    case "gather":
      return { audioAssetId: null, ttsText: "", options: [], defaultNextNodeId: "", retryLimit: 1 };
    case "input":
      return { audioAssetId: null, ttsText: "", numDigits: 1, nextNodeId: "" };
    case "ring":
      return { target: "all", strategy: "simultaneous", timeoutSeconds: 20, noAnswerNextNodeId: "" };
    case "wait":
      return { audioAssetId: null, ttsText: "", allowCallbackStar: false, nextNodeId: "" };
    case "voicemail":
      return { audioAssetId: null, ttsText: "", mailboxLabel: "Voicemail" };
    case "callback":
      return { audioAssetId: null, ttsText: "" };
    case "redirect":
      return { number: "" };
  }
}

// Ids are generated client-side because the API takes the whole flow at once; matches the web
// editor's `n_` prefix so the two are indistinguishable afterwards.
export function newNodeId(): string {
  return `n_${Math.random().toString(36).slice(2, 9)}`;
}

// Deleting a step must also unlink it, or every reference becomes a dangling id that the flow
// engine only fails on when a real call reaches it -- silently, mid-call. Cleared references
// become blank, which is the same "not wired up yet" state a newly added step is in.
export function removeNode(flow: IvrFlow, id: string): IvrFlow {
  const nodes = flow.nodes
    .filter((n) => n.id !== id)
    .map((n) => ({ ...n, config: clearReferences(n, id) }));
  return { entryNodeId: flow.entryNodeId === id ? null : flow.entryNodeId, nodes };
}

function clearReferences(node: IvrNode, removedId: string): Record<string, unknown> {
  const config = { ...node.config };
  for (const field of NEXT_FIELDS[node.type]) {
    if (config[field] === removedId) config[field] = "";
  }
  if (node.type === "gather" && Array.isArray(config.options)) {
    config.options = config.options.map((opt) => {
      const o = opt as { digit?: unknown; nextNodeId?: unknown };
      return o.nextNodeId === removedId ? { ...o, nextNodeId: "" } : o;
    });
  }
  return config;
}
