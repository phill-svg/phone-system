import { jsonResponse } from "./respond";
import { getBusinessHours, getStaffRingList, setBusinessHours, setStaffRingList } from "../db/settings";
import type { BusinessHoursSchedule } from "../ivr/businessHours";
import type { StaffUser } from "../access/requireStaffUser";

function forbiddenUnlessAdmin(staff: StaffUser): Response | null {
  if (staff.role !== "admin") {
    return new Response("forbidden", { status: 403 });
  }
  return null;
}

export async function handleGetBusinessHours(db: D1Database): Promise<Response> {
  return jsonResponse(await getBusinessHours(db));
}

export async function handlePutBusinessHours(request: Request, db: D1Database, staff: StaffUser): Promise<Response> {
  const forbidden = forbiddenUnlessAdmin(staff);
  if (forbidden) return forbidden;
  const schedule = (await request.json()) as BusinessHoursSchedule;
  await setBusinessHours(db, schedule);
  return jsonResponse({ ok: true });
}

export async function handleGetStaffRingList(db: D1Database): Promise<Response> {
  return jsonResponse(await getStaffRingList(db));
}

export async function handlePutStaffRingList(request: Request, db: D1Database, staff: StaffUser): Promise<Response> {
  const forbidden = forbiddenUnlessAdmin(staff);
  if (forbidden) return forbidden;
  const list = (await request.json()) as { label: string; number: string }[];
  await setStaffRingList(db, list);
  return jsonResponse({ ok: true });
}
