import { verifyTwilioSignature } from "./twilio/verifySignature";
import { normalizeCallStatus } from "./twilio/statusCallback";
import { requireStaffUser } from "./access/requireStaffUser";
import { handleMe } from "./api/me";
import { handleCallDetail, handleListCalls, handleLiveCalls } from "./api/calls";
import { handleGetBusinessHours, handleGetStaffRingList, handlePutBusinessHours, handlePutStaffRingList } from "./api/settings";
import { handleCreateOutboundCall } from "./api/outboundCalls";
import { handleListAudioAssets, handleUploadAudioAsset } from "./api/audioAssets";
import { handleGetFlow, handlePutFlow } from "./api/ivrFlow";
import { handleGetMedia } from "./api/media";
import { renderCallHistoryPage } from "./html/pages/callHistory";
import { renderCallDetailPage } from "./html/pages/callDetail";
import { renderSettingsPage } from "./html/pages/settings";
import { renderLiveCallsPage } from "./html/pages/liveCalls";
import { renderIvrFlowPage } from "./html/pages/ivrFlow";
import { getCallDetail, listCalls, listLiveCalls } from "./db/calls";
import { getBusinessHours, getStaffRingList } from "./db/settings";
import { listNodesForFlow } from "./db/ivrNodes";
import { listAudioAssets } from "./db/audioAssets";
export { CallSession } from "./durable-objects/CallSession";

// Local copy of the same 5-entity-replace XML-escape convention used throughout this codebase
// (see src/twilio/flowTwiml.ts, src/twilio/queueTwiml.ts) -- neither of those modules exports
// it, and pulling in a whole renderer module for this one inline TwiML string isn't warranted.
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

type Env = {
  DB: D1Database;
  CALL_SESSION: DurableObjectNamespace;
  AUDIO_ASSETS: R2Bucket;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_FROM_NUMBER: string;
  AUTH_MODE?: string;
  DEV_STAFF_EMAIL?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response(null, { status: 302, headers: { Location: "/admin/live" } });
    }

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
          recordingUrl: params.RecordingUrl ?? null,
          recordingSid: params.RecordingSid ?? null,
          recordingDuration: params.RecordingDuration ?? null,
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

    // Caller-leg hold poll: Twilio fetches the queue waitUrl on a loop. CallSid here is the caller's.
    if (url.pathname === "/webhooks/twilio/hold" && request.method === "POST") {
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

      const callSid = params.CallSid;
      const id = env.CALL_SESSION.idFromName(callSid);
      const stub = env.CALL_SESSION.get(id);
      const doResponse = await stub.fetch("https://internal/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "hold_poll", callSid, webhookUrl: request.url }),
      });

      return new Response(await doResponse.text(), {
        status: doResponse.status,
        headers: { "Content-Type": "text/xml" },
      });
    }

    // Caller-leg hold digit: caller pressed a key while on hold (e.g. star for callback). Caller's CallSid.
    if (url.pathname === "/webhooks/twilio/hold-digit" && request.method === "POST") {
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

      const callSid = params.CallSid;
      const id = env.CALL_SESSION.idFromName(callSid);
      const stub = env.CALL_SESSION.get(id);
      const doResponse = await stub.fetch("https://internal/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "hold_digit",
          callSid,
          digits: params.Digits ?? null,
          webhookUrl: request.url,
        }),
      });

      return new Response(await doResponse.text(), {
        status: doResponse.status,
        headers: { "Content-Type": "text/xml" },
      });
    }

    // Caller-leg queue action: fires when the caller leaves the queue (bridged, hung up, or <Leave/>).
    // CallSid here is the caller's.
    if (url.pathname === "/webhooks/twilio/queue-left" && request.method === "POST") {
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

      const callSid = params.CallSid;
      const id = env.CALL_SESSION.idFromName(callSid);
      const stub = env.CALL_SESSION.get(id);
      const doResponse = await stub.fetch("https://internal/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "queue_left",
          callSid,
          queueResult: params.QueueResult ?? null,
          webhookUrl: request.url,
        }),
      });

      return new Response(await doResponse.text(), {
        status: doResponse.status,
        headers: { "Content-Type": "text/xml" },
      });
    }

    // Staff-leg answer webhook: TwiML for the outbound staff call when it connects. The staff leg's own
    // CallSid is in params.CallSid (useless for DO lookup) — the caller's CallSid comes from the query.
    if (url.pathname === "/webhooks/twilio/agent-answer" && request.method === "POST") {
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

      const callSid = url.searchParams.get("callSid");
      if (!callSid) {
        return new Response("missing callSid", { status: 400 });
      }

      const id = env.CALL_SESSION.idFromName(callSid);
      const stub = env.CALL_SESSION.get(id);
      const doResponse = await stub.fetch("https://internal/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "agent_answer",
          callSid,
          agentCallSid: params.CallSid,
          webhookUrl: request.url,
        }),
      });

      return new Response(await doResponse.text(), {
        status: doResponse.status,
        headers: { "Content-Type": "text/xml" },
      });
    }

    // Staff-leg status callback: lifecycle of the outbound staff call. Caller's CallSid from the query.
    if (url.pathname === "/webhooks/twilio/agent-status" && request.method === "POST") {
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

      const callSid = url.searchParams.get("callSid");
      if (!callSid) {
        return new Response("missing callSid", { status: 400 });
      }

      const id = env.CALL_SESSION.idFromName(callSid);
      const stub = env.CALL_SESSION.get(id);
      const doResponse = await stub.fetch("https://internal/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "agent_status",
          callSid,
          agentCallSid: params.CallSid,
          callStatus: params.CallStatus ?? null,
          webhookUrl: request.url,
        }),
      });

      return new Response(await doResponse.text(), {
        status: doResponse.status,
        headers: { "Content-Type": "text/xml" },
      });
    }

    // Recording status callback: flat, direct D1 write (does NOT go through the DO), matching the style of
    // /webhooks/twilio/status. Caller's CallSid from the query — params.CallSid is the wrong (staff) leg.
    if (url.pathname === "/webhooks/twilio/recording-status" && request.method === "POST") {
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

      const callSid = url.searchParams.get("callSid");
      if (!callSid) {
        return new Response("missing callSid", { status: 400 });
      }

      await env.DB.prepare("UPDATE calls SET recording_url = ?, recording_sid = ? WHERE id = ?")
        .bind(params.RecordingUrl ?? null, params.RecordingSid ?? null, callSid)
        .run();

      return new Response("ok", { status: 200 });
    }

    // Click-to-call answer webhook: fires when the STAFF member's own phone (the leg
    // handleCreateOutboundCall just created via createOutboundCall) picks up. Pure, stateless
    // TwiML render off the query string + env vars only -- no D1/DO lookup needed to dial out.
    if (url.pathname === "/webhooks/twilio/click-to-call" && request.method === "POST") {
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

      const target = url.searchParams.get("target");
      if (!target) {
        return new Response("missing target", { status: 400 });
      }
      const decodedTarget = decodeURIComponent(target);

      const twiml =
        `<?xml version="1.0" encoding="UTF-8"?><Response><Dial action="${url.origin}/webhooks/twilio/status" method="POST" record="record-from-answer-dual" recordingStatusCallback="${url.origin}/webhooks/twilio/recording-status-outbound" recordingStatusCallbackMethod="POST">` +
        `<Number callerId="${env.TWILIO_FROM_NUMBER}">${escapeXml(decodedTarget)}</Number></Dial></Response>`;

      return new Response(twiml, { headers: { "Content-Type": "text/xml" } });
    }

    // Outbound click-to-call recording status: flat, direct D1 write, matched by params.CallSid
    // DIRECTLY. Unlike /webhooks/twilio/recording-status (inbound), which needs the ?callSid=
    // query-string workaround because the <Dial> there is executed by the STAFF leg (a different
    // CallSid than the caller's calls.id row), THIS <Dial> (rendered in click-to-call above) is
    // executed by the very CallSid that createOutboundCall returned and that handleCreateOutboundCall
    // stored as calls.id -- so params.CallSid on this callback already IS the right calls.id.
    // Do not "fix" this into a query-string workaround; it would be redundant here.
    if (url.pathname === "/webhooks/twilio/recording-status-outbound" && request.method === "POST") {
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

      await env.DB.prepare("UPDATE calls SET recording_url = ?, recording_sid = ? WHERE id = ?")
        .bind(params.RecordingUrl ?? null, params.RecordingSid ?? null, params.CallSid)
        .run();

      return new Response("ok", { status: 200 });
    }

    if (url.pathname.startsWith("/media/")) {
      // Public route, intentionally NOT staff-gated: Twilio fetches this URL directly
      // to stream IVR audio into a live call and cannot present an Access credential.
      try {
        const key = decodeURIComponent(url.pathname.slice("/media/".length));
        return await handleGetMedia(env.AUDIO_ASSETS, key);
      } catch (e) {
        if (e instanceof URIError) {
          return new Response("not found", { status: 404 });
        }
        throw e;
      }
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
      // Must be checked BEFORE the /api/calls/:id regex below -- "outbound" would otherwise
      // match ([^/]+) and get misrouted into handleCallDetail(db, "outbound") instead of here,
      // exactly like /api/calls/live is checked before it for the same reason.
      if (url.pathname === "/api/calls/outbound" && request.method === "POST") {
        return handleCreateOutboundCall(request, env, staff);
      }
      const callIdMatch = url.pathname.match(/^\/api\/calls\/([^/]+)$/);
      if (callIdMatch) {
        try {
          return handleCallDetail(env.DB, decodeURIComponent(callIdMatch[1]));
        } catch (e) {
          if (e instanceof URIError) {
            return new Response("not found", { status: 404 });
          }
          throw e;
        }
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

      if (url.pathname === "/api/ivr/audio") {
        return request.method === "POST"
          ? handleUploadAudioAsset(request, env)
          : handleListAudioAssets(env.DB);
      }

      // Matched after the literal /api/ivr/audio check above -- "audio" and "flows" are
      // disjoint path segments so there's no shadowing risk between the two, but keeping
      // literal-before-regex here mirrors the /api/calls/outbound-before-/api/calls/:id
      // ordering fixed in Task 11.
      const ivrFlowMatch = url.pathname.match(/^\/api\/ivr\/flows\/([^/]+)$/);
      if (ivrFlowMatch) {
        try {
          const flow = decodeURIComponent(ivrFlowMatch[1]);
          return request.method === "PUT"
            ? handlePutFlow(request, env.DB, flow, staff)
            : handleGetFlow(env.DB, flow);
        } catch (e) {
          if (e instanceof URIError) {
            return new Response("not found", { status: 404 });
          }
          throw e;
        }
      }

      return new Response("not found", { status: 404 });
    }

    if (url.pathname.startsWith("/admin/")) {
      const staffOrResponse = await requireStaffUser(request, env);
      if (staffOrResponse instanceof Response) return staffOrResponse;

      if (url.pathname === "/admin/live") {
        const html = renderLiveCallsPage(await listLiveCalls(env.DB));
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      if (url.pathname === "/admin/calls") {
        const html = renderCallHistoryPage(await listCalls(env.DB));
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      const callIdMatch = url.pathname.match(/^\/admin\/calls\/([^/]+)$/);
      if (callIdMatch) {
        try {
          const detail = await getCallDetail(env.DB, decodeURIComponent(callIdMatch[1]));
          if (!detail) return new Response("not found", { status: 404 });
          const html = renderCallDetailPage(detail.call, detail.events);
          return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
        } catch (e) {
          if (e instanceof URIError) {
            return new Response("not found", { status: 404 });
          }
          throw e;
        }
      }

      if (url.pathname === "/admin/settings") {
        const schedule = await getBusinessHours(env.DB);
        const ringList = await getStaffRingList(env.DB);
        const html = renderSettingsPage(schedule, ringList);
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      const ivrAdminMatch = url.pathname.match(/^\/admin\/ivr\/([^/]+)$/);
      if (ivrAdminMatch) {
        try {
          const flow = decodeURIComponent(ivrAdminMatch[1]);
          const [nodes, audioAssets] = await Promise.all([listNodesForFlow(env.DB, flow), listAudioAssets(env.DB)]);
          const html = renderIvrFlowPage(
            flow,
            nodes,
            audioAssets.map((a) => ({ id: a.id, label: a.label }))
          );
          return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
        } catch (e) {
          if (e instanceof URIError) {
            return new Response("not found", { status: 404 });
          }
          throw e;
        }
      }

      return new Response("not found", { status: 404 });
    }

    return new Response("not found", { status: 404 });
  },
};
