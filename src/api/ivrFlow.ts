import { jsonResponse } from "./respond";
import { listNodesForFlow, nodeExists, replaceFlowNodes } from "../db/ivrNodes";
import type { StaffUser } from "../access/requireStaffUser";

const NODE_TYPES = ["business_hours", "play", "gather", "ring", "wait", "voicemail"] as const;
type NodeType = (typeof NODE_TYPES)[number];

type PutNode = { id: string; type: NodeType; config: Record<string, unknown> };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGatherOptions(value: unknown): value is { digit: string; nextNodeId: string }[] {
  if (!Array.isArray(value)) return false;
  return value.every(
    (opt) => isPlainObject(opt) && isNonEmptyString(opt.digit) && isNonEmptyString(opt.nextNodeId)
  );
}

// One small validator per node type, matching the isStaffRingList/isBusinessHoursSchedule
// discriminated-validator style already used in src/api/settings.ts.
function isBusinessHoursConfig(c: Record<string, unknown>): boolean {
  return isNonEmptyString(c.openNextNodeId) && isNonEmptyString(c.closedNextNodeId);
}

function isPlayConfig(c: Record<string, unknown>): boolean {
  return isStringOrNull(c.audioAssetId) && isStringOrNull(c.ttsText) && isNonEmptyString(c.nextNodeId);
}

function isGatherConfig(c: Record<string, unknown>): boolean {
  return (
    isStringOrNull(c.audioAssetId) &&
    isStringOrNull(c.ttsText) &&
    isGatherOptions(c.options) &&
    isNonEmptyString(c.defaultNextNodeId) &&
    typeof c.retryLimit === "number"
  );
}

function isRingConfig(c: Record<string, unknown>): boolean {
  return (
    (c.target === "all" || c.target === "on_call_only") &&
    (c.strategy === "cascade" || c.strategy === "simultaneous") &&
    typeof c.timeoutSeconds === "number" &&
    isNonEmptyString(c.noAnswerNextNodeId)
  );
}

function isWaitConfig(c: Record<string, unknown>): boolean {
  return (
    isStringOrNull(c.audioAssetId) &&
    isStringOrNull(c.ttsText) &&
    typeof c.allowCallbackStar === "boolean" &&
    isNonEmptyString(c.nextNodeId)
  );
}

function isVoicemailConfig(c: Record<string, unknown>): boolean {
  return isStringOrNull(c.audioAssetId) && isStringOrNull(c.ttsText) && isNonEmptyString(c.mailboxLabel);
}

function isValidConfigForType(type: NodeType, config: unknown): config is Record<string, unknown> {
  if (!isPlainObject(config)) return false;
  switch (type) {
    case "business_hours":
      return isBusinessHoursConfig(config);
    case "play":
      return isPlayConfig(config);
    case "gather":
      return isGatherConfig(config);
    case "ring":
      return isRingConfig(config);
    case "wait":
      return isWaitConfig(config);
    case "voicemail":
      return isVoicemailConfig(config);
  }
}

// Every node-id-shaped field that exists for a given node type, for the dangling-reference check.
function referencesForNode(node: PutNode): string[] {
  const c = node.config;
  switch (node.type) {
    case "business_hours":
      return [c.openNextNodeId as string, c.closedNextNodeId as string];
    case "play":
    case "wait":
      return [c.nextNodeId as string];
    case "gather": {
      const options = (c.options as { digit: string; nextNodeId: string }[]) ?? [];
      return [...options.map((opt) => opt.nextNodeId), c.defaultNextNodeId as string];
    }
    case "ring":
      return [c.noAnswerNextNodeId as string];
    case "voicemail":
      return [];
  }
}

function forbiddenUnlessAdmin(staff: StaffUser): Response | null {
  if (staff.role !== "admin") {
    return new Response("forbidden", { status: 403 });
  }
  return null;
}

const INVALID_BODY_RESPONSE = () => new Response("invalid request body", { status: 400 });

export async function handleGetFlow(db: D1Database, flow: string): Promise<Response> {
  const nodes = await listNodesForFlow(db, flow);
  if (nodes.length === 0) {
    return new Response("not found", { status: 404 });
  }
  const entryNode = nodes.find((n) => n.isEntry);
  return jsonResponse({ entryNodeId: entryNode?.id ?? null, nodes });
}

export async function handlePutFlow(
  request: Request,
  db: D1Database,
  flow: string,
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

  if (!isPlainObject(body)) return INVALID_BODY_RESPONSE();
  const { entryNodeId, nodes } = body;
  if (typeof entryNodeId !== "string" || !Array.isArray(nodes)) {
    return INVALID_BODY_RESPONSE();
  }

  const typedNodes: PutNode[] = [];
  for (const raw of nodes) {
    if (!isPlainObject(raw) || !isNonEmptyString(raw.id)) {
      return INVALID_BODY_RESPONSE();
    }
    if (typeof raw.type !== "string" || !(NODE_TYPES as readonly string[]).includes(raw.type)) {
      return new Response(`node '${raw.id}' has unknown type '${String(raw.type)}'`, { status: 400 });
    }
    const type = raw.type as NodeType;
    if (!isValidConfigForType(type, raw.config)) {
      return new Response(`node '${raw.id}' has an invalid config shape for type '${type}'`, { status: 400 });
    }
    typedNodes.push({ id: raw.id, type, config: raw.config });
  }

  const entryMatches = typedNodes.filter((n) => n.id === entryNodeId);
  if (entryMatches.length !== 1) {
    return new Response(
      `entryNodeId '${entryNodeId}' must match exactly one node in the payload (matched ${entryMatches.length})`,
      { status: 400 }
    );
  }

  const payloadIds = new Set(typedNodes.map((n) => n.id));
  for (const node of typedNodes) {
    for (const ref of referencesForNode(node)) {
      if (payloadIds.has(ref)) continue;
      // Cross-flow shared nodes (e.g. the seeded shared_voicemail, tagged flow='main' but
      // referenced by after_hours) are valid to reference even though we're not editing
      // their flow right now -- so fall back to a global-by-id lookup, not flow-scoped.
      if (await nodeExists(db, ref)) continue;
      return new Response(`node '${node.id}' references unknown node '${ref}'`, { status: 400 });
    }
  }

  await replaceFlowNodes(db, flow, entryNodeId, typedNodes);
  return jsonResponse({ ok: true });
}
