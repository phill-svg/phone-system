import { verifyTwilioSignature } from "./twilio/verifySignature";
import { renderJoinConference } from "./twilio/conferenceTwiml";
import { normalizeCallStatus } from "./twilio/statusCallback";
import { requireStaffUser } from "./access/requireStaffUser";
import { handleMe } from "./api/me";
import { handleCallDetail, handleListCalls, handleLiveCalls } from "./api/calls";
import { handleGetBusinessHours, handleGetCallBlocklist, handlePutBusinessHours, handlePutCallBlocklist } from "./api/settings";
import { handleListAudioAssets, handleUploadAudioAsset } from "./api/audioAssets";
import { handleGetFlow, handlePatchNodePosition, handlePutFlow } from "./api/ivrFlow";
import { handleGetMedia } from "./api/media";
import { handleListCallbackRequests } from "./api/callbackRequests";
import { handleGetSoftphoneToken, handlePutPresence, handlePostHeartbeat } from "./api/softphone";
import { handleGetStaffRoster, handlePutStaffSchedule } from "./api/staff";
import { renderCallHistoryPage } from "./html/pages/callHistory";
import { renderCallDetailPage } from "./html/pages/callDetail";
import { renderSettingsPage } from "./html/pages/settings";
import { renderLiveCallsPage } from "./html/pages/liveCalls";
import { renderIvrFlowPage } from "./html/pages/ivrFlow";
import { renderCallbackRequestsPage } from "./html/pages/callbackRequests";
import { getCallDetail, listCalls, listLiveCalls } from "./db/calls";
import { getBusinessHours, getCallBlocklist } from "./db/settings";
import { listNodesForFlow } from "./db/ivrNodes";
import { listAudioAssets } from "./db/audioAssets";
import { getStaffRoster } from "./db/staff";
import { listOpenCallbackRequests } from "./db/callbackRequests";
export { CallSession } from "./durable-objects/CallSession";

type Env = {
  DB: D1Database;
  CALL_SESSION: DurableObjectNamespace;
  AUDIO_ASSETS: R2Bucket;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_FROM_NUMBER: string;
  TWILIO_API_KEY_SID: string;
  TWILIO_API_KEY_SECRET: string;
  TWILIO_TWIML_APP_SID: string;
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

      const blocklist = await getCallBlocklist(env.DB);
      if (blocklist.includes(params.From)) {
        return new Response('<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>', {
          headers: { "Content-Type": "text/xml" },
        });
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

    // Caller-leg redirect target (Task 4's answer-time bridge): the caller's already-enqueued leg is
    // REST-redirected here (by handleAgentAnswer, via redirectCall) the moment an agent answers, so it
    // joins the same Conference the agent's own answer-webhook response also joins. `conf` (the query
    // param) is the caller's own CallSid, used as the Conference's friendly name.
    if (url.pathname === "/webhooks/twilio/join-conference" && request.method === "POST") {
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
      const conferenceName = url.searchParams.get("conf");
      if (!conferenceName) {
        return new Response("missing conf", { status: 400 });
      }
      return new Response(renderJoinConference({ conferenceName }), { headers: { "Content-Type": "text/xml" } });
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
      if (url.pathname === "/api/settings/call-blocklist") {
        if (request.method === "GET") return handleGetCallBlocklist(env.DB);
        if (request.method === "PUT") return handlePutCallBlocklist(request, env.DB, staff);
      }

      // Literal path, disjoint from every other /api/ segment above and below (no regex here to
      // shadow or be shadowed by) -- so there's no ordering hazard to worry about.
      if (url.pathname === "/api/callback-requests") {
        return handleListCallbackRequests(env.DB);
      }

      if (url.pathname === "/api/ivr/audio") {
        return request.method === "POST"
          ? handleUploadAudioAsset(request, env)
          : handleListAudioAssets(env.DB);
      }

      // Matched after the literal /api/ivr/audio check above -- "audio" and "flows" are
      // disjoint path segments so there's no shadowing risk between the two.
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

      // PATCH-only endpoint (drag-to-reposition on the flow canvas). Disjoint from ivrFlowMatch
      // above -- that regex terminates right after the flow segment ($), so it never matches
      // this longer /nodes/:id/position path; same non-shadowing reasoning as the
      // /api/ivr/audio-vs-/api/ivr/flows comment above it.
      const ivrNodePositionMatch = url.pathname.match(/^\/api\/ivr\/flows\/([^/]+)\/nodes\/([^/]+)\/position$/);
      if (ivrNodePositionMatch) {
        try {
          const flow = decodeURIComponent(ivrNodePositionMatch[1]);
          const nodeId = decodeURIComponent(ivrNodePositionMatch[2]);
          return handlePatchNodePosition(request, env.DB, flow, nodeId, staff);
        } catch (e) {
          if (e instanceof URIError) {
            return new Response("not found", { status: 404 });
          }
          throw e;
        }
      }

      if (url.pathname === "/api/softphone/token" && request.method === "GET") {
        return handleGetSoftphoneToken(env, staff);
      }
      if (url.pathname === "/api/softphone/presence" && request.method === "PUT") {
        return handlePutPresence(request, env.DB, staff);
      }
      if (url.pathname === "/api/softphone/heartbeat" && request.method === "POST") {
        return handlePostHeartbeat(env.DB, staff);
      }
      if (url.pathname === "/api/staff" && request.method === "GET") {
        return handleGetStaffRoster(env.DB);
      }
      const staffScheduleMatch = url.pathname.match(/^\/api\/staff\/([^/]+)\/schedule$/);
      if (staffScheduleMatch && request.method === "PUT") {
        return handlePutStaffSchedule(request, env.DB, decodeURIComponent(staffScheduleMatch[1]), staff);
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
        const blocklist = await getCallBlocklist(env.DB);
        const html = renderSettingsPage(schedule, blocklist);
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      if (url.pathname === "/admin/callbacks") {
        const html = renderCallbackRequestsPage(await listOpenCallbackRequests(env.DB));
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      const ivrAdminMatch = url.pathname.match(/^\/admin\/ivr\/([^/]+)$/);
      if (ivrAdminMatch) {
        try {
          const flow = decodeURIComponent(ivrAdminMatch[1]);
          const [nodes, audioAssets, staffRoster] = await Promise.all([
            listNodesForFlow(env.DB, flow),
            listAudioAssets(env.DB),
            getStaffRoster(env.DB),
          ]);
          const html = renderIvrFlowPage(
            flow,
            nodes,
            audioAssets.map((a) => ({ id: a.id, label: a.label })),
            staffRoster.map((s) => s.email)
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
