import { verifyTwilioSignature } from "./twilio/verifySignature";
import { normalizeCallStatus } from "./twilio/statusCallback";
import { requireStaffUser } from "./access/requireStaffUser";
import { handleMe } from "./api/me";
import { handleCallDetail, handleListCalls, handleLiveCalls } from "./api/calls";
import { handleGetBusinessHours, handleGetStaffRingList, handlePutBusinessHours, handlePutStaffRingList } from "./api/settings";
import { renderCallHistoryPage } from "./html/pages/callHistory";
import { renderCallDetailPage } from "./html/pages/callDetail";
import { getCallDetail, listCalls } from "./db/calls";
export { CallSession } from "./durable-objects/CallSession";

type Env = {
  DB: D1Database;
  CALL_SESSION: DurableObjectNamespace;
  TWILIO_AUTH_TOKEN: string;
  AUTH_MODE?: string;
  DEV_STAFF_EMAIL?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    if (url.pathname === "/webhooks/twilio" && request.method === "POST") {
      const formData = await request.formData();
      const params: Record<string, string> = {};
      for (const [key, value] of formData.entries()) {
        params[key] = String(value);
      }

      const signature = request.headers.get("X-Twilio-Signature") ?? "";
      const valid = await verifyTwilioSignature(request.url, params, signature, env.TWILIO_AUTH_TOKEN);
      if (!valid) {
        return new Response("invalid signature", { status: 401 });
      }

      const id = env.CALL_SESSION.idFromName(params.CallSid);
      const stub = env.CALL_SESSION.get(id);
      const doResponse = await stub.fetch("https://internal/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          callSid: params.CallSid,
          from: params.From,
          to: params.To,
          digits: params.Digits ?? null,
          webhookUrl: request.url,
        }),
      });

      return new Response(await doResponse.text(), {
        status: doResponse.status,
        headers: { "Content-Type": "text/xml" },
      });
    }

    if (url.pathname === "/webhooks/twilio/status" && request.method === "POST") {
      const formData = await request.formData();
      const params: Record<string, string> = {};
      for (const [key, value] of formData.entries()) {
        params[key] = String(value);
      }

      const signature = request.headers.get("X-Twilio-Signature") ?? "";
      const valid = await verifyTwilioSignature(request.url, params, signature, env.TWILIO_AUTH_TOKEN);
      if (!valid) {
        return new Response("invalid signature", { status: 401 });
      }

      const normalized = normalizeCallStatus(params.CallStatus ?? "");
      if (normalized) {
        await env.DB.prepare("UPDATE calls SET status = ?, ended_at = ? WHERE id = ? AND ended_at IS NULL")
          .bind(normalized, Date.now(), params.CallSid)
          .run();
      }

      return new Response("ok", { status: 200 });
    }

    if (url.pathname.startsWith("/api/")) {
      const staffOrResponse = await requireStaffUser(request, env);
      if (staffOrResponse instanceof Response) return staffOrResponse;
      const staff = staffOrResponse;

      if (url.pathname === "/api/me") {
        return handleMe(staff);
      }
      if (url.pathname === "/api/calls/live") {
        return handleLiveCalls(env.DB);
      }
      if (url.pathname === "/api/calls") {
        return handleListCalls(env.DB);
      }
      const callIdMatch = url.pathname.match(/^\/api\/calls\/([^/]+)$/);
      if (callIdMatch) {
        return handleCallDetail(env.DB, decodeURIComponent(callIdMatch[1]));
      }

      if (url.pathname === "/api/settings/business-hours") {
        return request.method === "PUT"
          ? handlePutBusinessHours(request, env.DB, staff)
          : handleGetBusinessHours(env.DB);
      }
      if (url.pathname === "/api/settings/staff-ring-list") {
        return request.method === "PUT"
          ? handlePutStaffRingList(request, env.DB, staff)
          : handleGetStaffRingList(env.DB);
      }

      return new Response("not found", { status: 404 });
    }

    if (url.pathname.startsWith("/admin/")) {
      const staffOrResponse = await requireStaffUser(request, env);
      if (staffOrResponse instanceof Response) return staffOrResponse;

      if (url.pathname === "/admin/calls") {
        const html = renderCallHistoryPage(await listCalls(env.DB));
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      const callIdMatch = url.pathname.match(/^\/admin\/calls\/([^/]+)$/);
      if (callIdMatch) {
        const detail = await getCallDetail(env.DB, decodeURIComponent(callIdMatch[1]));
        if (!detail) return new Response("not found", { status: 404 });
        const html = renderCallDetailPage(detail.call, detail.events);
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      return new Response("not found", { status: 404 });
    }

    return new Response("not found", { status: 404 });
  },
};
