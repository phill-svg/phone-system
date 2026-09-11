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

// The exact payload PUT /api/ivr/flows/:flow is sent, built by naming every field the server
// persists. Both screens save through this rather than spreading the node, and that is the point:
// a spread quietly carries whatever happens to be there, so nothing fails when a field is dropped
// from the type -- which is how `positionX`/`positionY` could have been lost with every test still
// green. Here the field list is RUNTIME, so removing one breaks a test.
//
// The endpoint is a delete-and-reinsert: every field omitted here is destroyed on save.
// `positionX`/`positionY` are the WEB editor's canvas coordinates, never read by this app, and
// losing them would flatten every node onto the origin the next time the web editor was opened --
// a mess nobody would connect to an edit made on a phone. `created_at`/`updated_at` are the only
// columns deliberately left out, because the server regenerates them.
export const IVR_NODE_PUT_FIELDS = ["id", "flow", "isEntry", "type", "config", "positionX", "positionY"] as const;

export type IvrPutPayload = { entryNodeId: string | null; nodes: Record<string, unknown>[] };

export function toPutPayload(flow: IvrFlow): IvrPutPayload {
  return {
    entryNodeId: flow.entryNodeId,
    nodes: flow.nodes.map((n) => {
      const out: Record<string, unknown> = {};
      for (const field of IVR_NODE_PUT_FIELDS) out[field] = (n as unknown as Record<string, unknown>)[field];
      return out;
    }),
  };
}

// Whether an edited config still matches the one that was loaded. One level deep is enough and is
// deliberate: every scalar field is compared by value, and the one nested field (a gather's
// `options`) is compared as JSON, which is exact for the plain `{digit, nextNodeId}` objects the
// API stores. Used only to decide whether a refocus may re-seed the draft, so the failure mode of
// being too eager is keeping edits that were already saved -- harmless -- while being too lax
// throws away typing.
export function configsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const x = a[k];
    const y = b[k];
    if (x === y) continue;
    if (typeof x === "object" && x !== null && typeof y === "object" && y !== null) {
      if (JSON.stringify(x) === JSON.stringify(y)) continue;
    }
    return false;
  }
  return true;
}

// What is still missing before a call could survive this step, or null when it is finished.
//
// A step is deliberately allowed to exist half-wired -- blank next-fields are legal, the API
// persists unreachable nodes, and the handset saves a new step the instant its type is picked so
// the editor can load it fresh. The cost of that is a step nothing warns you about: a blank
// nextNodeId and a blank redirect number BOTH throw in the flow engine, and the DO catch-all
// answers "we're experiencing a technical issue" and hangs up on a live customer. So the list
// screen says which steps are unfinished, which is the thing that makes the permissive save safe.
//
// Deliberately NOT a save-blocker. Half-finishing a step and coming back to it is the normal way
// a menu gets built, and refusing to save would make the handset unable to do what it is for.
export function incompleteReason(node: IvrNode): string | null {
  const c = node.config;
  const blank = (v: unknown) => typeof v !== "string" || v.trim() === "";

  if (node.type === "redirect" && blank(c.number)) return "No phone number set";
  if (node.type === "voicemail" && blank(c.mailboxLabel)) return "No mailbox name set";
  if (PROMPT_REQUIRED.has(node.type) && blank(c.audioAssetId) && blank(c.ttsText)) {
    return "Nothing to say -- pick a recording or type the words";
  }
  if (node.type === "gather" && (!Array.isArray(c.options) || c.options.length === 0)) {
    return "No menu keys set";
  }
  const missing = NEXT_FIELDS[node.type].filter((f) => blank(c[f]));
  if (missing.length > 0) {
    return missing.map((f) => `"${NEXT_FIELD_LABELS[f] ?? f}" goes nowhere`).join(", ");
  }
  if (node.type === "gather" && Array.isArray(c.options)) {
    const dead = (c.options as { digit?: unknown; nextNodeId?: unknown }[]).filter((o) => blank(o.nextNodeId));
    if (dead.length > 0) return `${dead.length} menu key(s) go nowhere`;
  }
  return null;
}

// The types where a blank prompt means the caller genuinely hears NOTHING, which is NOT the same
// list as the editor's "which types show a prompt field". Getting that wrong is how a badge becomes
// noise, and a badge you have learned to ignore is worse than no badge -- the alarm-fatigue failure
// this file keeps recording.
//
// Deliberately excluded, because each has a server-side default for an empty prompt:
//   wait     -- renderHold plays the Australian ringback tone (#47) when there is no wait content,
//               which is the INTENDED configuration, not a gap. Flagging it would invite someone to
//               "fix" it by typing text, replacing the ring cadence with a spoken line on every
//               hold poll.
//   callback -- recordCallbackRequest answers renderCallbackAck("Thanks, we'll call you back
//               soon."). The web editor says so in its own hint.
//   voicemail -- a blank prompt is a beep-only mailbox: terse, but a real choice. The mailboxLabel
//               check above is the gap that actually matters there.
const PROMPT_REQUIRED = new Set<string>(["play", "gather", "input"]);

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
