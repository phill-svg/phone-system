import { jsonResponse } from "./respond";
import { listOpenCallbackRequests } from "../db/callbackRequests";

export async function handleListCallbackRequests(db: D1Database): Promise<Response> {
  return jsonResponse(await listOpenCallbackRequests(db));
}
