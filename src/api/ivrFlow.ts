import { jsonResponse } from "./respond";
import { listNodesForFlow, nodeExistsInOtherFlow, replaceFlowNodes, updateNodePosition } from "../db/ivrNodes";
import type { StaffUser } from "../access/requireStaffUser";

const NODE_TYPES = ["business_hours", "play", "gather", "ring", "wait", "voicemail"] as const;
type NodeType = (typeof NODE_TYPES)[number];

type PutNode = { id: string; type: NodeType; config: Record<string, unknown>; positionX: number | null; positionY: number | null };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// "Next node" fields are deliberately allowed to be blank -- a flow is built up incrementally
// (e.g. via the editor's "+ Add node"), and the node this points at, or even a decision about
// where it should eventually point, may not exist yet. A blank/unresolved reference only
// surfaces as a runtime error in the flow engine if a real call ever actually reaches it.
function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNumberOrNull(value: unknown): value is number | null {
  return value === null || typeof value === "number";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGatherOptions(value: unknown): value is { digit: string; nextNodeId: string }[] {
  if (!Array.isArray(value)) return false;
  return value.every(
    (opt) => isPlainObject(opt) && isNonEmptyString(opt.digit) && isString(opt.nextNodeId)
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

// One small validator per node type, matching the discriminated-validator style already used
// in src/api/settings.ts.
function isBusinessHoursConfig(c: Record<string, unknown>): boolean {
  return isString(c.openNextNodeId) && isString(c.closedNextNodeId);
}

function isPlayConfig(c: Record<string, unknown>): boolean {
  return isStringOrNull(c.audioAssetId) && isStringOrNull(c.ttsText) && isString(c.nextNodeId);
}

function isGatherConfig(c: Record<string, unknown>): boolean {
  return (
    isStringOrNull(c.audioAssetId) &&
    isStringOrNull(c.ttsText) &&
    isGatherOptions(c.options) &&
    isString(c.defaultNextNodeId) &&
    typeof c.retryLimit === "number"
  );
}

function isRingConfig(c: Record<string, unknown>): boolean {
  return (
    (c.target === "all" || isStringArray(c.target)) &&
    (c.strategy === "cascade" || c.strategy === "simultaneous") &&
    typeof c.timeoutSeconds === "number" &&
    isString(c.noAnswerNextNodeId)
  );
}

function isWaitConfig(c: Record<string, unknown>): boolean {
  return (
    isStringOrNull(c.audioAssetId) &&
    isStringOrNull(c.ttsText) &&
    typeof c.allowCallbackStar === "boolean" &&
    isString(c.nextNodeId)
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
  }

  const entryMatches = typedNodes.filter((n) => n.id === entryNodeId);
  if (entryMatches.length !== 1) {
    return new Response(
      `entryNodeId '${entryNodeId}' must match exactly one node in the payload (matched ${entryMatches.length})`,
      { status: 400 }
    );
  }

  const seenIds = new Set<string>();
  for (const node of typedNodes) {
    if (seenIds.has(node.id)) {
      return new Response(`duplicate node id: ${node.id}`, { status: 400 });
    }
    seenIds.add(node.id);
  }

  // `id` is a global PRIMARY KEY (not composite with `flow`), so a payload node whose id already
  // belongs to a DIFFERENT flow would otherwise pass validation and then throw an unhandled
  // constraint-violation 500 out of db.batch() in replaceFlowNodes. Re-saving ids that already
  // belong to THIS flow (the normal edit-and-resave case) is fine, since those rows are about to
  // be replaced, not collided with.
  for (const node of typedNodes) {
    if (await nodeExistsInOtherFlow(db, node.id, flow)) {
      return new Response(`node id '${node.id}' already exists in a different flow`, { status: 400 });
    }
  }

  // Deliberately no dangling-reference check here: a node's config fields (openNextNodeId,
  // noAnswerNextNodeId, etc.) are allowed to point at ids that don't exist yet, so a flow can
  // be built up incrementally in any order rather than strictly back-to-front from a terminal
  // node. A reference that's still dangling when a real call actually reaches it will surface
  // as a runtime error in the flow engine at that point, not here at save time.

  await replaceFlowNodes(db, flow, entryNodeId, typedNodes);
  return jsonResponse({ ok: true });
}

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
