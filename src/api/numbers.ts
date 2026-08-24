import { jsonResponse } from "./respond";
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
    region: typeof body.region === "string" && body.region.trim() ? body.region.trim() : null,
  };
}

export async function handleCreateNumber(request: Request, db: D1Database): Promise<Response> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const input = parseInput(body);
  if (!input) return jsonResponse({ error: "e164 and label are required" }, 400);
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
  const ok = await updatePhoneNumber(db, id, input);
  return ok ? jsonResponse({ ok: true }) : jsonResponse({ error: "not found" }, 404);
}

export async function handleDeleteNumber(db: D1Database, id: number): Promise<Response> {
  await deletePhoneNumber(db, id);
  return jsonResponse({ ok: true });
}
