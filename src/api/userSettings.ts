import { jsonResponse } from "./respond";
import { getUserSettings, setUserSettings, type UserSettings } from "../db/userSettings";
import type { StaffUser } from "../access/requireStaffUser";

export async function handleGetUserSettings(db: D1Database, staff: StaffUser): Promise<Response> {
  return jsonResponse(await getUserSettings(db, staff.email));
}

export async function handlePutUserSettings(
  request: Request,
  db: D1Database,
  staff: StaffUser
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("invalid request body", { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return new Response("invalid request body", { status: 400 });
  }
  // setUserSettings ignores unknown/wrong-typed keys, so passing the raw object is safe.
  const merged = await setUserSettings(db, staff.email, body as Partial<UserSettings>);
  return jsonResponse(merged);
}
