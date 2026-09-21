import { jsonResponse } from "./respond";
import { flowHasEntryNode } from "../db/ivrNodes";
import {
  listPhoneNumbers,
  createPhoneNumber,
  updatePhoneNumber,
  deletePhoneNumber,
  type PhoneNumberInput,
} from "../db/phoneNumbers";

// The business's sending numbers, for the caller-ID / SMS-from pickers in the dialer and composer.
export async function handleListNumbers(db: D1Database): Promise<Response> {
  return jsonResponse(await listPhoneNumbers(db));
}

// The only two Twilio regions this account uses. A region is stored to answer one question --
// "which region processes this number's inbound calls" -- so a typo'd value is worse than a blank
// one: it would read as an answer. Anything unrecognised becomes null.
const REGIONS = new Set(["au1", "us1"]);

function normalizeRegion(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const region = raw.trim().toLowerCase();
  return REGIONS.has(region) ? region : null;
}

// A flow name is stored only when it is a real, non-blank string. `""` is NOT null, and letting it
// through would reach `loadEntryNode` as a flow that cannot exist -- so blank means "use the
// default", which is what NULL already means everywhere else here.
function normalizeFlow(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const flow = raw.trim();
  return flow === "" ? null : flow;
}

function parseInput(body: Record<string, unknown> | null): PhoneNumberInput | null {
  if (!body) return null;
  const e164 = String(body.e164 ?? "").trim();
  const label = String(body.label ?? "").trim();
  if (!e164 || !label) return null;
  return {
    e164,
    label,
    voice_enabled: !!body.voice_enabled,
    sms_enabled: !!body.sms_enabled,
    is_default_voice: !!body.is_default_voice,
    is_default_sms: !!body.is_default_sms,
    region: normalizeRegion(body.region),
    ivr_flow: normalizeFlow(body.ivr_flow),
    after_hours_flow: normalizeFlow(body.after_hours_flow),
  };
}

// Validate on write, the same rule as business hours and closed dates: a number pointed at a flow
// with no entry node takes calls that hang up on the caller, and nothing anywhere would say so
// until someone rang it. Refused here, naming the offending field and flow, because `apiFetch` only
// lifts a message out of a JSON `{error}` body -- a plain-text 400 reaches nobody on the handset.
//
// Only a NON-NULL value is checked: null means "use the default", which is always the pre-existing
// behaviour and must stay saveable. Existing rows are all null, so this cannot lock an admin out of
// re-saving a number they could save before.
async function invalidFlow(db: D1Database, input: PhoneNumberInput): Promise<string | null> {
  for (const [field, flow] of [
    ["ivr_flow", input.ivr_flow],
    ["after_hours_flow", input.after_hours_flow],
  ] as const) {
    if (flow === null) continue;
    if (!(await flowHasEntryNode(db, flow))) {
      return `${field}: the phone menu "${flow}" has no starting step, so calls routed to it would fail. Pick a different menu, or set a starting step on it first.`;
    }
  }
  return null;
}

export async function handleCreateNumber(request: Request, db: D1Database): Promise<Response> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const input = parseInput(body);
  if (!input) return jsonResponse({ error: "e164 and label are required" }, 400);
  const flowError = await invalidFlow(db, input);
  if (flowError) return jsonResponse({ error: flowError }, 400);
  try {
    return jsonResponse(await createPhoneNumber(db, input), 201);
  } catch {
    return jsonResponse({ error: "That number already exists." }, 409);
  }
}

export async function handleUpdateNumber(request: Request, db: D1Database, id: number): Promise<Response> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const input = parseInput(body);
  if (!input) return jsonResponse({ error: "e164 and label are required" }, 400);
  const flowError = await invalidFlow(db, input);
  if (flowError) return jsonResponse({ error: flowError }, 400);
  const ok = await updatePhoneNumber(db, id, input);
  return ok ? jsonResponse({ ok: true }) : jsonResponse({ error: "not found" }, 404);
}

export async function handleDeleteNumber(db: D1Database, id: number): Promise<Response> {
  await deletePhoneNumber(db, id);
  return jsonResponse({ ok: true });
}
