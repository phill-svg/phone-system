import { jsonResponse } from "./respond";
import type { StaffUser } from "../access/requireStaffUser";

export function handleMe(staff: StaffUser): Response {
  return jsonResponse(staff);
}
