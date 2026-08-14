// Flow-walking engine for the data-driven IVR (replaces the old hardcoded src/ivr/stateMachine.ts reducer).
//
// Node/option data lives in the `ivr_nodes` table (see migrations/0004_ivr_flow.sql). This module's D1
// access is limited to node lookups by id/flow — the business-hours schedule check itself stays in
// CallSession (reusing getBusinessHours/isWithinBusinessHours), which passes the result in as
// `isAfterHours` rather than this module re-fetching or re-evaluating it.

import { isClosedDate } from "./dateRules";

export type FlowCommand =
  | { type: "PLAY"; audioAssetId: string | null; ttsText: string | null }
  | { type: "GATHER"; numDigits: number; timeoutSeconds: number; validDigits: string; action: string }
  | { type: "INPUT"; numDigits: number; finishOnKey: string; timeoutSeconds: number; action: string }
  | { type: "REDIRECT"; number: string }
  | { type: "ENQUEUE" /* wait node */ }
  | { type: "DIAL_HANDOFF" /* ring node: hand off to Part B */ }
  | { type: "VOICEMAIL_HANDOFF" /* voicemail node: hand off to Part B */ }
  | { type: "HANGUP" };

export type FlowEvent = { type: "ENTER" } | { type: "DIGIT"; digit: string } | { type: "TIMEOUT_OR_INVALID" };

// The maximum digits an "input" node collects when its config doesn't specify one.
const DEFAULT_INPUT_MAX_DIGITS = 12;

type NodeRow = {
  id: string;
  flow: string;
  is_entry: number;
  type: string;
  config: string;
};

type GatherOption = { digit: string; nextNodeId: string };

// Default DTMF gather timeout when a gather node's config doesn't specify one. The existing
// <Gather> convention elsewhere in this repo (src/twilio/twiml.ts) hardcodes timeout="8".
const DEFAULT_GATHER_TIMEOUT_SECONDS = 8;

async function loadNodeById(db: D1Database, nodeId: string): Promise<NodeRow> {
  const row = await db
    .prepare("SELECT id, flow, is_entry, type, config FROM ivr_nodes WHERE id = ?")
    .bind(nodeId)
    .first<NodeRow>();
  if (!row) {
    throw new Error(`IVR flow engine: no ivr_nodes row found with id "${nodeId}"`);
  }
  return row;
}

async function loadEntryNode(db: D1Database, flow: string): Promise<NodeRow> {
  const row = await db
    .prepare("SELECT id, flow, is_entry, type, config FROM ivr_nodes WHERE flow = ? AND is_entry = 1")
    .bind(flow)
    .first<NodeRow>();
  if (!row) {
    throw new Error(`IVR flow engine: no entry node found for flow "${flow}" (expected a row with is_entry = 1)`);
  }
  return row;
}

function parseConfig(node: NodeRow): Record<string, any> {
  try {
    const parsed = JSON.parse(node.config);
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("config JSON is not an object");
    }
    return parsed;
  } catch (err) {
    throw new Error(
      `IVR flow engine: node "${node.id}" has malformed config JSON: ${(err as Error).message}`
    );
  }
}

function playCommandFor(config: Record<string, any>): FlowCommand | null {
  const audioAssetId = config.audioAssetId ?? null;
  const ttsText = config.ttsText ?? null;
  if (audioAssetId === null && ttsText === null) return null;
  return { type: "PLAY", audioAssetId, ttsText };
}

function gatherCommandFor(config: Record<string, any>): FlowCommand {
  const options: GatherOption[] = Array.isArray(config.options) ? config.options : [];
  const validDigits = options.map((o) => o.digit).join("");
  return {
    type: "GATHER",
    numDigits: 1,
    timeoutSeconds: typeof config.timeoutSeconds === "number" ? config.timeoutSeconds : DEFAULT_GATHER_TIMEOUT_SECONDS,
    validDigits,
    // The real webhook URL is wired up by a later task (TwiML rendering owns the actual action URL).
    action: "PLACEHOLDER",
  };
}

function inputCommandFor(config: Record<string, any>): FlowCommand {
  return {
    type: "INPUT",
    numDigits: typeof config.numDigits === "number" ? config.numDigits : DEFAULT_INPUT_MAX_DIGITS,
    finishOnKey: typeof config.finishOnKey === "string" ? config.finishOnKey : "#",
    timeoutSeconds: typeof config.timeoutSeconds === "number" ? config.timeoutSeconds : DEFAULT_GATHER_TIMEOUT_SECONDS,
    action: "PLACEHOLDER",
  };
}

// Commands emitted once the walk stops at a given node (gather/input/ring/wait/voicemail/redirect).
function stopCommandsFor(node: NodeRow, config: Record<string, any>): FlowCommand[] {
  switch (node.type) {
    case "gather": {
      const play = playCommandFor(config);
      return [...(play ? [play] : []), gatherCommandFor(config)];
    }
    case "input": {
      const play = playCommandFor(config);
      return [...(play ? [play] : []), inputCommandFor(config)];
    }
    case "ring":
      return [{ type: "DIAL_HANDOFF" }];
    case "voicemail": {
      const play = playCommandFor(config);
      return [...(play ? [play] : []), { type: "VOICEMAIL_HANDOFF" }];
    }
    case "wait": {
      const play = playCommandFor(config);
      return [...(play ? [play] : []), { type: "ENQUEUE" }];
    }
    case "redirect": {
      const number = typeof config.number === "string" ? config.number : "";
      if (!number) throw new Error(`IVR flow engine: redirect node "${node.id}" is missing a number`);
      return [{ type: "REDIRECT", number }];
    }
    default:
      throw new Error(`IVR flow engine: node "${node.id}" has unknown type "${node.type}"`);
  }
}

type WalkResult = { node: NodeRow; config: Record<string, any>; commands: FlowCommand[] };

// Walks forward from `startNodeId`, passing straight through non-interactive node types
// (`business_hours`, `play`) and accumulating their commands, until it reaches a node type
// that genuinely needs to stop: `gather`, `ring`, `wait`, or `voicemail`.
async function walkFrom(db: D1Database, startNodeId: string, isAfterHours: boolean, now: Date): Promise<WalkResult> {
  const commands: FlowCommand[] = [];
  let nodeId = startNodeId;
  const visited = new Set<string>();

  while (true) {
    if (visited.has(nodeId)) {
      throw new Error(`IVR flow engine: cycle detected walking through node "${nodeId}"`);
    }
    visited.add(nodeId);

    const node = await loadNodeById(db, nodeId);
    const config = parseConfig(node);

    if (node.type === "business_hours") {
      const next = isAfterHours ? config.closedNextNodeId : config.openNextNodeId;
      if (typeof next !== "string" || next.length === 0) {
        throw new Error(
          `IVR flow engine: business_hours node "${node.id}" is missing ${
            isAfterHours ? "closedNextNodeId" : "openNextNodeId"
          }`
        );
      }
      nodeId = next;
      continue;
    }

    if (node.type === "date_rule") {
      const closed = isClosedDate(config.closedDates, now);
      const next = closed ? config.closedNextNodeId : config.openNextNodeId;
      if (typeof next !== "string" || next.length === 0) {
        throw new Error(
          `IVR flow engine: date_rule node "${node.id}" is missing ${closed ? "closedNextNodeId" : "openNextNodeId"}`
        );
      }
      nodeId = next;
      continue;
    }

    if (node.type === "play") {
      const play = playCommandFor(config);
      if (play) commands.push(play);
      if (typeof config.nextNodeId !== "string" || config.nextNodeId.length === 0) {
        throw new Error(`IVR flow engine: play node "${node.id}" is missing nextNodeId`);
      }
      nodeId = config.nextNodeId;
      continue;
    }

    if (
      node.type === "gather" ||
      node.type === "input" ||
      node.type === "ring" ||
      node.type === "wait" ||
      node.type === "voicemail" ||
      node.type === "redirect"
    ) {
      return { node, config, commands };
    }

    throw new Error(`IVR flow engine: node "${node.id}" has unknown type "${node.type}"`);
  }
}

function finalizeWalk(result: WalkResult): { nextNodeId: string; attempt: number; commands: FlowCommand[] } {
  return {
    nextNodeId: result.node.id,
    attempt: 0,
    commands: [...result.commands, ...stopCommandsFor(result.node, result.config)],
  };
}

// Resume walking the flow graph from an ARBITRARY node id (not a flow entry and not a gather
// continuation). Used by CallSession when a `ring` node's dial-out resolves to "no answer" and the
// flow must continue from that ring node's `config.noAnswerNextNodeId`. `advanceFlow`'s public API
// only supports starting fresh at a flow's entry node or continuing from a gather node; this exposes
// the internal walking logic without changing `advanceFlow`'s contract.
export type AdvanceResult = {
  nextNodeId: string;
  attempt: number;
  commands: FlowCommand[];
  // Set when the caller just completed an "input" node -- the digits they entered, so the caller
  // can store/log them before the flow continues.
  capturedInput?: { nodeId: string; value: string };
};

export async function walkFromNode(
  db: D1Database,
  startNodeId: string,
  isAfterHours: boolean,
  now: Date = new Date()
): Promise<AdvanceResult> {
  return finalizeWalk(await walkFrom(db, startNodeId, isAfterHours, now));
}

export async function advanceFlow(
  db: D1Database,
  flow: string,
  currentNodeId: string | null,
  event: FlowEvent,
  isAfterHours: boolean,
  attempt: number,
  now: Date = new Date()
): Promise<AdvanceResult> {
  if (event.type === "ENTER") {
    if (currentNodeId !== null) {
      throw new Error(`IVR flow engine: ENTER event requires currentNodeId to be null, got "${currentNodeId}"`);
    }
    const entry = await loadEntryNode(db, flow);
    return finalizeWalk(await walkFrom(db, entry.id, isAfterHours, now));
  }

  // DIGIT / TIMEOUT_OR_INVALID: the caller was previously paused at a gather or input node.
  if (currentNodeId === null) {
    throw new Error(`IVR flow engine: "${event.type}" event requires a non-null currentNodeId`);
  }

  const currentNode = await loadNodeById(db, currentNodeId);
  const currentConfig = parseConfig(currentNode);

  // Input node: capture whatever digits the caller entered and continue unconditionally to
  // nextNodeId. An empty entry (timeout / no digits) falls through the same way.
  if (currentNode.type === "input") {
    if (typeof currentConfig.nextNodeId !== "string" || currentConfig.nextNodeId.length === 0) {
      throw new Error(`IVR flow engine: input node "${currentNode.id}" is missing nextNodeId`);
    }
    const value = event.type === "DIGIT" ? event.digit : "";
    const walked = finalizeWalk(await walkFrom(db, currentConfig.nextNodeId, isAfterHours, now));
    return { ...walked, capturedInput: { nodeId: currentNode.id, value } };
  }

  if (currentNode.type !== "gather") {
    throw new Error(
      `IVR flow engine: "${event.type}" event received but current node "${currentNodeId}" is type "${currentNode.type}", not "gather" or "input"`
    );
  }

  let matchedNextNodeId: string | null = null;
  if (event.type === "DIGIT") {
    const options: GatherOption[] = Array.isArray(currentConfig.options) ? currentConfig.options : [];
    const match = options.find((o) => o.digit === event.digit);
    if (match) {
      if (typeof match.nextNodeId !== "string" || match.nextNodeId.length === 0) {
        throw new Error(`IVR flow engine: gather node "${currentNode.id}" option "${event.digit}" is missing nextNodeId`);
      }
      matchedNextNodeId = match.nextNodeId;
    }
  }

  if (matchedNextNodeId) {
    return finalizeWalk(await walkFrom(db, matchedNextNodeId, isAfterHours, now));
  }

  // No matching option (or a timeout): retry the same gather, or fall back to its default.
  const retryLimit = typeof currentConfig.retryLimit === "number" ? currentConfig.retryLimit : 0;
  if (attempt < retryLimit) {
    return {
      nextNodeId: currentNode.id,
      attempt: attempt + 1,
      commands: stopCommandsFor(currentNode, currentConfig),
    };
  }

  if (typeof currentConfig.defaultNextNodeId !== "string" || currentConfig.defaultNextNodeId.length === 0) {
    throw new Error(`IVR flow engine: gather node "${currentNode.id}" has no defaultNextNodeId to fall back to`);
  }
  return finalizeWalk(await walkFrom(db, currentConfig.defaultNextNodeId, isAfterHours, now));
}
