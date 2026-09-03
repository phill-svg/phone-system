import { authorizeTwilioWebhook, appendWebhookSecret } from "./twilio/webhookAuth";
import { isDemoUser, handleDemoRequest, demoEmails } from "./demo";
import { renderJoinConference, renderDialAgentIntoConference, renderListenConference } from "./twilio/conferenceTwiml";
import { createOutboundCall } from "./twilio/restClient";
import { cleanupLoneConference } from "./twilio/conferenceClient";
import { normalizeCallStatus } from "./twilio/statusCallback";
import { requireStaffUser } from "./access/requireStaffUser";
import { handleLogoAsset } from "./html/logoAsset";
import { handleDesktopUpdateAsset } from "./api/desktopUpdates";
import { renderPrivacyPolicyPage, renderTermsOfServicePage } from "./html/pages/legal";
import { handleMe } from "./api/me";
import {
  handleLoginPage, handleLoginSubmit, handleLogout,
  handleForgotPasswordPage, handleForgotPasswordSubmit,
  handleSetPasswordPage, handleSetPasswordSubmit,
  handleApiLogin, handleApiLogout,
} from "./api/auth";
import { handleCallDetail, handleListCalls, handleLiveCalls, handleUpdateCallMeta, getLiveCalls, reconcileStaleCalls } from "./api/calls";
import {
  handleGetBusinessHours,
  handleGetCallBlocklist,
  handlePutBusinessHours,
  handlePutCallBlocklist,
  handleGetRecordingSetting,
  handlePutRecordingSetting,
} from "./api/settings";
import { handleGetUserSettings, handlePutUserSettings } from "./api/userSettings";
import { handleListAudioAssets, handleUploadAudioAsset } from "./api/audioAssets";
import { handleGetFlow, handlePatchNodePosition, handlePutFlow } from "./api/ivrFlow";
import { handleGetMedia } from "./api/media";
import { handleListCallbackRequests } from "./api/callbackRequests";
import {
  handleGetSoftphoneToken,
  handlePutPresence,
  handlePostHeartbeat,
  handlePostHold,
  handlePostTransfer,
  handlePostCompleteTransfer,
} from "./api/softphone";
import {
  handleGetStaffRoster, handlePutStaffSchedule, handlePutStaffPriority, handlePutStaffStatus,
  handleInviteStaff, handleResendInvite, handleSendReset, handleRemoveStaff,
} from "./api/staff";
import { handleListConversations, handleGetThread, handleSendMessage } from "./api/messages";
import { insertMessage, updateMessageStatus } from "./db/messages";
import { logCallToServiceM8, syncContactFromServiceM8 } from "./servicem8/callLogging";
import { describeChannelError } from "./twilio/channelErrors";
import { handleRegisterPushToken, notifyInboundSms, notifyMessageFailed } from "./api/push";
import { handleResolveFacebookNames, handleSetFacebookName, handleFacebookProbe } from "./api/facebook";
import type { SendEmailBinding } from "./email/sendgrid";
import {
  handleListContacts,
  handleCreateContact,
  handleUpdateContact,
  handleDeleteContact,
  handleImportContacts,
} from "./api/contacts";
import { renderPhonePage } from "./html/pages/phone";
import { renderCallHistoryPage } from "./html/pages/callHistory";
import { renderCallDetailPage } from "./html/pages/callDetail";
import { renderSettingsPage } from "./html/pages/settings";
import { renderWebhooksPage } from "./html/pages/webhooks";
import { renderLiveCallsPage } from "./html/pages/liveCalls";
import { renderIvrFlowPage } from "./html/pages/ivrFlow";
import { renderCallbackRequestsPage } from "./html/pages/callbackRequests";
import { renderMessagesPage } from "./html/pages/messages";
import { getCallDetail, listCalls, appendCallEvent, getCallStats, parseRecordingDuration } from "./db/calls";
import { handleGetRecording } from "./api/recordings";
import { renderAnalyticsPage } from "./html/pages/analytics";
import { getBusinessHours, getCallBlocklist, getRecordingEnabled } from "./db/settings";
import { listNodesForFlow } from "./db/ivrNodes";
import { listAudioAssets } from "./db/audioAssets";
import { getStaffRoster, listStaffAccess } from "./db/staff";
import { listOpenCallbackRequests } from "./db/callbackRequests";
import { recordCallLeg } from "./db/callLegs";
import { transcribeCallRecording, backfillTranscripts } from "./transcribe";
import { handleListNumbers, handleCreateNumber, handleUpdateNumber, handleDeleteNumber } from "./api/numbers";
import { resolveSendingNumber } from "./db/phoneNumbers";
import { getFacebookName, upsertFacebookName, noteTwilioMessengerFields } from "./db/fbContacts";
import { resolveFacebookName } from "./facebook/graph";
import { backfillFacebookNames } from "./facebook/backfill";
import { checkMessengerChannelHealth } from "./facebook/channelHealth";
import { fetchPageInboxNames } from "./facebook/pageInbox";
export { CallSession } from "./durable-objects/CallSession";

type Env = {
  DB: D1Database;
  CALL_SESSION: DurableObjectNamespace;
  AUDIO_ASSETS: R2Bucket;
  AI: { run: (model: string, input: Record<string, unknown>) => Promise<{ text?: string; transcription_info?: { text?: string } }> };
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_AUTH_TOKEN_SECONDARY?: string;
  TWILIO_WEBHOOK_SECRET?: string;
  TWILIO_WEBHOOK_SECRET_SECONDARY?: string;
  TWILIO_FROM_NUMBER: string;
  TWILIO_SMS_NUMBER?: string;
  TWILIO_API_KEY_SID: string;
  TWILIO_API_KEY_SECRET: string;
  // US1-region API key, used for SMS (the Messages API is US1-only; the AU1 key/token 401s there).
  TWILIO_US1_API_KEY_SID?: string;
  TWILIO_US1_API_KEY_SECRET?: string;
  TWILIO_TWIML_APP_SID: string;
  TWILIO_PUSH_CREDENTIAL_SID_IOS?: string;
  TWILIO_PUSH_CREDENTIAL_SID_ANDROID?: string;
  AUTH_MODE?: string;
  DEV_STAFF_EMAIL?: string;
  // Comma-separated logins served invented data instead of the real business inbox (see
  // src/demo/). Empty or unset means every account sees real data, which is the default.
  DEMO_ACCOUNT_EMAILS?: string;
  EMAIL?: SendEmailBinding;
  // Facebook Page access token, used to resolve Messenger senders' display names via the Graph API.
  FB_PAGE_ACCESS_TOKEN?: string;
  // "messenger:<page-id>" -- the Page we send from, and whose inbox we read sender names out of.
  TWILIO_MESSENGER_FROM?: string;
  // Optional: when set, a completed call is auto-logged as a diary note on the matching ServiceM8
  // job (see src/servicem8/). Unset means the feature is simply off -- no error, no missing data.
  SERVICEM8_API_KEY?: string;
};

// Staff dial numbers as they'd say them ("0472 762 158"), but Twilio only accepts E.164.
// Australian local formats get +61; anything already-E.164 or a client: identity passes through.
function normalizeAuNumber(raw: string | undefined): string | undefined {
  if (!raw) return raw;
  const trimmed = raw.trim();
  if (trimmed.startsWith("+") || trimmed.startsWith("client:")) return trimmed;
  const digits = trimmed.replace(/[\s()-]/g, "");
  if (/^0[2-9]\d{8}$/.test(digits)) return "+61" + digits.slice(1);
  if (/^61\d{9}$/.test(digits)) return "+" + digits;
  return trimmed;
}

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response(null, { status: 302, headers: { Location: "/admin/live" } });
    }

    if (url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    if (url.pathname === "/logo.png") {
      return handleLogoAsset();
    }

    // Desktop auto-update feed (electron-updater). Public by necessity -- the updater cannot hold
    // a session -- and read-only over a validated filename under R2's desktop/ prefix.
    const desktopUpdateMatch = url.pathname.match(/^\/desktop\/([^/]+)$/);
    if (desktopUpdateMatch && (request.method === "GET" || request.method === "HEAD")) {
      return handleDesktopUpdateAsset(env.AUDIO_ASSETS, decodeURIComponent(desktopUpdateMatch[1]));
    }

    // Public legal pages (no auth) — linked from the mobile app Settings and the app-store listings.
    if (url.pathname === "/privacy") {
      return new Response(renderPrivacyPolicyPage(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    if (url.pathname === "/terms") {
      return new Response(renderTermsOfServicePage(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    if (url.pathname === "/login") {
      if (request.method === "GET") return handleLoginPage(request, env);
      if (request.method === "POST") return handleLoginSubmit(request, env);
    }

    if (url.pathname === "/logout") {
      return handleLogout(request, env);
    }

    if (url.pathname === "/api/login" && request.method === "POST") {
      return handleApiLogin(request, env);
    }
    if (url.pathname === "/api/logout" && request.method === "POST") {
      return handleApiLogout(request, env);
    }

    if (url.pathname === "/forgot-password") {
      if (request.method === "GET") return handleForgotPasswordPage(request, env);
      if (request.method === "POST") return handleForgotPasswordSubmit(request, env, url.origin);
    }

    if (url.pathname === "/set-password") {
      if (request.method === "GET") return handleSetPasswordPage(request, env);
      if (request.method === "POST") return handleSetPasswordSubmit(request, env);
    }

    if (url.pathname === "/webhooks/twilio" && request.method === "POST") {
      const formData = await request.formData();
      const params: Record<string, string> = {};
      for (const [key, value] of formData.entries()) {
        params[key] = String(value);
      }

      const valid = await authorizeTwilioWebhook(request, params, env);
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

      const valid = await authorizeTwilioWebhook(request, params, env);
      if (!valid) {
        return new Response("invalid signature", { status: 401 });
      }

      const normalized = normalizeCallStatus(params.CallStatus ?? "");
      if (normalized) {
        const update = await env.DB.prepare("UPDATE calls SET status = ?, ended_at = ? WHERE id = ? AND ended_at IS NULL")
          .bind(normalized, Date.now(), params.CallSid)
          .run();
        // Only append the timeline event on the first (real) terminal write -- the `ended_at IS
        // NULL` guard means a redelivered status callback changes 0 rows and must not double-log.
        if ((update.meta.changes ?? 0) > 0) {
          try {
            await appendCallEvent(env.DB, params.CallSid, "call_ended", { status: normalized });
          } catch {
            /* timeline logging is best-effort; never fail the webhook over it */
          }
          if (env.SERVICEM8_API_KEY) {
            const apiKey = env.SERVICEM8_API_KEY;
            const sm8Work = env.DB.prepare(
              "SELECT direction, caller_number, called_number, started_at FROM calls WHERE id = ?"
            )
              .bind(params.CallSid)
              .first<{ direction: "inbound" | "outbound"; caller_number: string; called_number: string; started_at: number }>()
              .then((call) => {
                if (!call) return;
                const loggable = {
                  direction: call.direction,
                  callerNumber: call.caller_number,
                  calledNumber: call.called_number,
                  startedAt: call.started_at,
                  endedAt: Date.now(),
                  status: normalized,
                };
                return Promise.all([
                  logCallToServiceM8(apiKey, loggable),
                  syncContactFromServiceM8(env.DB, apiKey, loggable),
                ]);
              })
              .catch(() => {
                /* ServiceM8 logging is best-effort; never fail the webhook over it */
              });
            if (ctx) ctx.waitUntil(sm8Work);
            else await sm8Work;
          }
        }
        // The caller's leg ending may strand the agent alone in the conference (named by
        // this same CallSid) -- end it if at most one participant remains.
        await cleanupLoneConference(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, params.CallSid);
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

      const valid = await authorizeTwilioWebhook(request, params, env);
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

      const valid = await authorizeTwilioWebhook(request, params, env);
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

      const valid = await authorizeTwilioWebhook(request, params, env);
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

      const valid = await authorizeTwilioWebhook(request, params, env);
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
          // Present only when the leg was dialed with MachineDetection enabled (the pstn mobile
          // leg -- see CallSession.dialStaff). Absent for softphone legs and other AMD-less legs.
          answeredBy: params.AnsweredBy,
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
      const valid = await authorizeTwilioWebhook(request, params, env);
      if (!valid) {
        return new Response("invalid signature", { status: 401 });
      }
      const conferenceName = url.searchParams.get("conf");
      if (!conferenceName) {
        return new Response("missing conf", { status: 400 });
      }
      return new Response(renderJoinConference({ conferenceName }), { headers: { "Content-Type": "text/xml" } });
    }

    // Transfer target's answer webhook (Task 7): TwiML for the outbound call dialed to the transfer
    // target's client identity when it connects. Dials the target into the same conference the
    // original caller/agent legs are already in. `conf` (the query param) is that conference's name.
    if (url.pathname === "/webhooks/twilio/transfer-answer" && request.method === "POST") {
      const formData = await request.formData();
      const params: Record<string, string> = {};
      for (const [key, value] of formData.entries()) {
        params[key] = String(value);
      }
      const valid = await authorizeTwilioWebhook(request, params, env);
      if (!valid) {
        return new Response("invalid signature", { status: 401 });
      }
      const conferenceName = url.searchParams.get("conf");
      if (!conferenceName) {
        return new Response("missing conf", { status: 400 });
      }
      const record = await getRecordingEnabled(env.DB);
      return new Response(
        renderDialAgentIntoConference({
          conferenceName,
          actionUrl: appendWebhookSecret(`${url.origin}/webhooks/twilio/agent-status?callSid=${conferenceName}`, env.TWILIO_WEBHOOK_SECRET),
          recordingStatusCallbackUrl: appendWebhookSecret(`${url.origin}/webhooks/twilio/recording-status?callSid=${conferenceName}`, env.TWILIO_WEBHOOK_SECRET),
          record,
        }),
        { headers: { "Content-Type": "text/xml" } }
      );
    }

    // Outbound softphone dialing (Task 8): TwiML Application route that Twilio calls when a staff
    // member dials out from the browser softphone. Dials the target phone number into a named
    // conference (named after the agent's own CallSid), and returns TwiML for the agent leg to join.
    if (url.pathname === "/twiml/voice-app" && request.method === "POST") {
      const formData = await request.formData();
      const params: Record<string, string> = {};
      for (const [key, value] of formData.entries()) {
        params[key] = String(value);
      }
      const valid = await authorizeTwilioWebhook(request, params, env);
      if (!valid) {
        return new Response("invalid signature", { status: 401 });
      }

      // Live listen-in: an ADMIN's softphone joins an existing call's conference muted. Gated on the
      // caller's own client identity being an admin (a Twilio webhook has no session, so we look the
      // role up by email) — otherwise any staff softphone could silently listen to any call.
      if (params.Listen) {
        const listenerEmail = params.From.startsWith("client:") ? params.From.slice("client:".length) : params.From;
        const row = await env.DB.prepare("SELECT role FROM staff_users WHERE email = ?")
          .bind(listenerEmail)
          .first<{ role: string }>();
        if (row?.role !== "admin") {
          return new Response(
            '<?xml version="1.0" encoding="UTF-8"?><Response><Say>You are not authorised to listen to calls.</Say><Hangup/></Response>',
            { headers: { "Content-Type": "text/xml" } }
          );
        }
        return new Response(renderListenConference({ conferenceName: params.Listen }), {
          headers: { "Content-Type": "text/xml" },
        });
      }

      const conferenceName = params.CallSid; // the agent's own browser-originated leg
      const target = normalizeAuNumber(params.To);
      if (!target) return new Response("missing To", { status: 400 });

      // Caller-ID the staff member picked in the dialer (params.CallerId). Honoured only if it's an
      // enabled voice number (see resolveSendingNumber); otherwise the default voice number.
      const fromNumber = (await resolveSendingNumber(env.DB, "voice", params.CallerId || null)) ?? env.TWILIO_FROM_NUMBER;

      // Outbound calls otherwise create no `calls` row, so they never show up in Call
      // History/Live Calls, and the recording-status callback (which matches on this same
      // conferenceName as `calls.id`) silently discards the recording. Mirrors the inbound
      // insert in CallSession.ts's handleMainWebhook.
      await env.DB.prepare(
        "INSERT INTO calls (id, caller_number, called_number, started_at, is_after_hours, status, direction) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
        .bind(conferenceName, fromNumber, target, Date.now(), 0, "in_progress", "outbound")
        .run();

      // params.From is the agent's own `client:{email}` identity (set by the Voice SDK). Record
      // this leg's ownership so handlePostHold/handlePostTransfer/handlePostCompleteTransfer can
      // later verify a client-submitted CallSid actually belongs to the authenticated staff member.
      const fromEmail = params.From.startsWith("client:") ? params.From.slice("client:".length) : params.From;
      await recordCallLeg(env.DB, conferenceName, fromEmail, conferenceName);

      const { sid: targetSid } = await createOutboundCall(env.TWILIO_ACCOUNT_SID, env.TWILIO_API_KEY_SID, env.TWILIO_API_KEY_SECRET, {
        to: target,
        from: fromNumber,
        url: appendWebhookSecret(`${url.origin}/webhooks/twilio/transfer-answer?conf=${conferenceName}`, env.TWILIO_WEBHOOK_SECRET),
        statusCallback: appendWebhookSecret(`${url.origin}/webhooks/twilio/agent-status?callSid=${conferenceName}`, env.TWILIO_WEBHOOK_SECRET),
        statusCallbackEvent: ["completed"],
      });

      // Remember the dialed-out leg so an agent hang-up (before the callee answers) can cancel it,
      // instead of leaving the callee's phone ringing. Recorded on the call row we just inserted.
      await env.DB.prepare("UPDATE calls SET outbound_target_sid = ? WHERE id = ?").bind(targetSid, conferenceName).run();

      const record = await getRecordingEnabled(env.DB);
      return new Response(
        renderDialAgentIntoConference({
          conferenceName,
          actionUrl: appendWebhookSecret(`${url.origin}/webhooks/twilio/agent-status?callSid=${conferenceName}`, env.TWILIO_WEBHOOK_SECRET),
          recordingStatusCallbackUrl: appendWebhookSecret(`${url.origin}/webhooks/twilio/recording-status?callSid=${conferenceName}`, env.TWILIO_WEBHOOK_SECRET),
          record,
        }),
        { headers: { "Content-Type": "text/xml" } }
      );
    }

    // Staff-leg status callback: lifecycle of the outbound staff call. Caller's CallSid from the query.
    if (url.pathname === "/webhooks/twilio/agent-status" && request.method === "POST") {
      const formData = await request.formData();
      const params: Record<string, string> = {};
      for (const [key, value] of formData.entries()) {
        params[key] = String(value);
      }

      const valid = await authorizeTwilioWebhook(request, params, env);
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
      await doResponse.text();

      // This URL is BOTH a status callback (body ignored) and the agent <Dial>'s action
      // (body parsed as TwiML -- e.g. when the conference ends while the agent leg is still
      // up). Plain-text "ok" here makes Twilio play "an application error has occurred" to
      // the surviving leg; an empty TwiML document ends the call cleanly in both roles.
      return new Response('<?xml version="1.0" encoding="UTF-8"?><Response/>', {
        headers: { "Content-Type": "text/xml" },
      });
    }

    // Async AMD verdict for a pstn (mobile) staff leg. Fires out-of-band, typically a few seconds
    // AFTER the legs bridged, carrying AnsweredBy. Caller's CallSid from the query -- params.CallSid
    // is the staff leg. Body is ignored by Twilio, so a plain 200 is correct here.
    if (url.pathname === "/webhooks/twilio/amd-status" && request.method === "POST") {
      const formData = await request.formData();
      const params: Record<string, string> = {};
      for (const [key, value] of formData.entries()) {
        params[key] = String(value);
      }

      const valid = await authorizeTwilioWebhook(request, params, env);
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
          kind: "amd_status",
          callSid,
          agentCallSid: params.CallSid,
          answeredBy: params.AnsweredBy ?? null,
          webhookUrl: request.url,
        }),
      });
      await doResponse.text();
      return new Response("ok", { status: 200 });
    }

    // The caller leg, REST-redirected here after async AMD caught a staff member's personal
    // voicemail answering. Renders the ring node's no-answer branch (business voicemail).
    if (url.pathname === "/webhooks/twilio/amd-fallthrough" && request.method === "POST") {
      const formData = await request.formData();
      const params: Record<string, string> = {};
      for (const [key, value] of formData.entries()) {
        params[key] = String(value);
      }

      const valid = await authorizeTwilioWebhook(request, params, env);
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
        body: JSON.stringify({ kind: "amd_fallthrough", callSid, webhookUrl: request.url }),
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

      const valid = await authorizeTwilioWebhook(request, params, env);
      if (!valid) {
        return new Response("invalid signature", { status: 401 });
      }

      const callSid = url.searchParams.get("callSid");
      if (!callSid) {
        return new Response("missing callSid", { status: 400 });
      }

      // COALESCE so a later callback without RecordingDuration can never blank a length we already
      // stored. parseRecordingDuration returns null for absent/garbage values.
      await env.DB.prepare(
        "UPDATE calls SET recording_url = ?, recording_sid = ?, recording_duration = COALESCE(?, recording_duration) WHERE id = ?"
      )
        .bind(
          params.RecordingUrl ?? null,
          params.RecordingSid ?? null,
          parseRecordingDuration(params.RecordingDuration),
          callSid
        )
        .run();

      // Kick off transcription (Whisper) in the background — never block the webhook ack. A voicemail
      // Record posts here with ?vm=1 so its transcript lands in `transcription` ("Voicemail
      // transcript"); answered-call recordings land in `call_transcript` ("Call transcript").
      if (params.RecordingUrl) {
        const column = url.searchParams.get("vm") === "1" ? "transcription" : "call_transcript";
        const job = transcribeCallRecording(env, callSid, params.RecordingUrl, column);
        if (ctx) ctx.waitUntil(job);
        else await job;
      }

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

    // Inbound SMS from a customer -> stored as a message. Public webhook, whsec-authed like the
    // voice ones. Point the number's Messaging webhook at this URL (with ?whsec=<secret>).
    if (url.pathname === "/webhooks/twilio/sms" && request.method === "POST") {
      const formData = await request.formData();
      const params: Record<string, string> = {};
      for (const [key, value] of formData.entries()) params[key] = String(value);
      const valid = await authorizeTwilioWebhook(request, params, env);
      if (!valid) return new Response("invalid signature", { status: 401 });
      if (params.From) {
        await insertMessage(env.DB, {
          id: params.MessageSid || crypto.randomUUID(),
          direction: "inbound",
          peer_number: params.From,
          our_number: params.To || null,
          body: params.Body ?? "",
          status: "received",
          read: 0,
          createdAt: Date.now(),
        });

        // Facebook Messenger senders arrive as "messenger:<psid>" with no human-readable name.
        // Resolve it via the Graph API (once per PSID -- cached in fb_contacts after that) so the
        // inbox and push notification show the person's name instead of the raw id.
        let fbName: string | null = null;
        if (params.From.startsWith("messenger:")) {
          const psid = params.From.slice("messenger:".length);
          try {
            fbName = await getFacebookName(env.DB, psid);
          } catch {
            fbName = null;
          }
          // Twilio itself sometimes hands us the sender's profile name (it does on WhatsApp). When
          // it does, that IS the name: no Graph API, no Page token, nothing that can expire. This
          // is the preferred source precisely because the Messenger connection is Twilio's, so the
          // psid is scoped to Twilio's Facebook app rather than to our own Page token.
          const fromTwilio = String(params.ProfileName ?? params.SenderName ?? "").trim().slice(0, 100);
          if (fbName == null && fromTwilio) {
            fbName = fromTwilio;
            const save = upsertFacebookName(env.DB, psid, fromTwilio).catch(() => {});
            if (ctx) ctx.waitUntil(save);
            else await save;
          } else if (fbName == null) {
            // Nothing from Twilio: fall back to the Graph API, and leave a note of what the webhook
            // actually carried so a permanently nameless sender can be explained rather than
            // guessed at.
            const note = noteTwilioMessengerFields(env.DB, psid, Object.keys(params)).catch(() => {});
            if (ctx) ctx.waitUntil(note);
            else await note;
            if (env.FB_PAGE_ACCESS_TOKEN) {
              const token = env.FB_PAGE_ACCESS_TOKEN;
              const pageId = (env.TWILIO_MESSENGER_FROM ?? "").replace(/^messenger:/, "");
              // Fire-and-forget: don't let a slow/failed Graph API call block the webhook ack.
              // The Page inbox is tried first because it is the only route that names an ordinary
              // customer -- the per-psid profile lookup is refused (code 100) for anyone without a
              // role on the Page. The profile call stays as the fallback.
              const resolveName = fetchPageInboxNames(pageId, token)
                .then((inbox) => ("names" in inbox ? inbox.names.get(psid) ?? null : null))
                .then((name) => name ?? resolveFacebookName(psid, token))
                .then((name) => (name ? upsertFacebookName(env.DB, psid, name) : undefined))
                .catch(() => {});
              if (ctx) ctx.waitUntil(resolveName);
              else await resolveName;
            }
          }
        }

        // Notify staff devices (don't let a push failure break the webhook ack).
        const notify = notifyInboundSms(env.DB, params.From, params.Body ?? "", fbName).catch(() => {});
        if (ctx) ctx.waitUntil(notify);
        else await notify;
      }
      return new Response('<?xml version="1.0" encoding="UTF-8"?><Response/>', { headers: { "Content-Type": "text/xml" } });
    }

    // Outbound SMS/Messenger delivery status. Twilio's initial send response only means "accepted" --
    // this is how a later async rejection (e.g. Facebook Messenger sent outside the 24-hour window)
    // ever reaches the stored message row. See handleSendMessage, which sets this as the StatusCallback.
    if (url.pathname === "/webhooks/twilio/sms-status" && request.method === "POST") {
      const formData = await request.formData();
      const params: Record<string, string> = {};
      for (const [key, value] of formData.entries()) params[key] = String(value);
      const valid = await authorizeTwilioWebhook(request, params, env);
      if (!valid) return new Response("invalid signature", { status: 401 });
      if (params.MessageSid && params.MessageStatus) {
        const errorCode = params.ErrorCode || null;
        const errorMessage = params.ErrorMessage || describeChannelError(errorCode) || null;
        await updateMessageStatus(env.DB, params.MessageSid, params.MessageStatus, { code: errorCode, message: errorMessage });
        if (params.MessageStatus === "failed" || params.MessageStatus === "undelivered") {
          const notify = env.DB.prepare("SELECT peer_number FROM messages WHERE id = ?")
            .bind(params.MessageSid)
            .first<{ peer_number: string }>()
            .then((row) => (row ? notifyMessageFailed(env.DB, row.peer_number, errorMessage) : undefined))
            .catch(() => {
              /* push is best-effort; never fail the webhook over it */
            });
          if (ctx) ctx.waitUntil(notify);
          else await notify;
        }
      }
      return new Response("ok");
    }

    if (url.pathname.startsWith("/api/")) {
      const staffOrResponse = await requireStaffUser(request, env, { isApi: true });
      if (staffOrResponse instanceof Response) return staffOrResponse;
      const staff = staffOrResponse;

      // The App Review demo account never touches the real inbox: conversations, calls and
      // contacts are business-wide here, so any login would otherwise show a reviewer real
      // customers by name and number. Reads are substituted and writes are swallowed; outbound
      // calling is left alone so the app's core feature stays testable. See src/demo/.
      if (isDemoUser(staff.email, env)) {
        const demo = handleDemoRequest(url, request);
        if (demo) return demo;
      }

      // Admin-only read endpoints (the settings + IVR surfaces). Mutations under these paths
      // already role-check inside their handlers; this closes the matching GET reads so a staff
      // member can't fetch the data directly. The staff ROSTER (/api/staff GET) is intentionally
      // NOT gated -- the softphone transfer picker needs the colleague list.
      const adminOnlyRead =
        url.pathname.startsWith("/api/ivr/") ||
        (request.method === "GET" &&
          (url.pathname === "/api/settings/business-hours" ||
          url.pathname === "/api/settings/call-blocklist"));
      if (adminOnlyRead && staff.role !== "admin") {
        return new Response("Forbidden", { status: 403 });
      }

      if (url.pathname === "/api/me") {
        return handleMe(staff);
      }
      if (url.pathname === "/api/calls/live") {
        return handleLiveCalls(env);
      }
      if (url.pathname === "/api/calls") {
        return handleListCalls(env.DB);
      }
      // Longer than the /api/calls/:id match below (which is $-anchored right after the id), so the
      // two never shadow each other. Streams the call's Twilio recording through our own auth.
      const recordingMatch = url.pathname.match(/^\/api\/calls\/([^/]+)\/recording$/);
      if (recordingMatch && request.method === "GET") {
        try {
          const callId = decodeURIComponent(recordingMatch[1]);
          return handleGetRecording(env, env.DB, callId, request);
        } catch (e) {
          if (e instanceof URIError) {
            return new Response("not found", { status: 404 });
          }
          throw e;
        }
      }

      const callIdMatch = url.pathname.match(/^\/api\/calls\/([^/]+)$/);
      if (callIdMatch) {
        try {
          const callId = decodeURIComponent(callIdMatch[1]);
          return request.method === "PUT"
            ? handleUpdateCallMeta(request, env.DB, callId)
            : handleCallDetail(env.DB, callId);
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
      if (url.pathname === "/api/settings/recording") {
        return request.method === "PUT" ? handlePutRecordingSetting(request, env.DB, staff) : handleGetRecordingSetting(env.DB);
      }
      if (url.pathname === "/api/settings/me") {
        return request.method === "PUT"
          ? handlePutUserSettings(request, env.DB, staff)
          : handleGetUserSettings(env.DB, staff);
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
        return handleGetSoftphoneToken(env, staff, url.searchParams.get("platform") ?? undefined);
      }
      if (url.pathname === "/api/softphone/presence" && request.method === "PUT") {
        return handlePutPresence(request, env.DB, staff);
      }
      if (url.pathname === "/api/softphone/heartbeat" && request.method === "POST") {
        return handlePostHeartbeat(env.DB, staff);
      }
      if (url.pathname === "/api/softphone/hold" && request.method === "POST") {
        return handlePostHold(request, env, staff, env.DB);
      }
      if (url.pathname === "/api/softphone/transfer" && request.method === "POST") {
        return handlePostTransfer(request, env, staff, url.origin, env.DB);
      }
      if (url.pathname === "/api/softphone/transfer/complete" && request.method === "POST") {
        return handlePostCompleteTransfer(request, env, staff, env.DB);
      }
      if (url.pathname === "/api/staff") {
        if (request.method === "GET") return handleGetStaffRoster(env.DB, demoEmails(env));
        if (request.method === "POST") return handleInviteStaff(request, env, staff, url.origin);
      }
      const staffScheduleMatch = url.pathname.match(/^\/api\/staff\/([^/]+)\/schedule$/);
      if (staffScheduleMatch && request.method === "PUT") {
        return handlePutStaffSchedule(request, env.DB, decodeURIComponent(staffScheduleMatch[1]), staff);
      }
      const staffPriorityMatch = url.pathname.match(/^\/api\/staff\/([^/]+)\/priority$/);
      if (staffPriorityMatch && request.method === "PUT") {
        return handlePutStaffPriority(request, env.DB, decodeURIComponent(staffPriorityMatch[1]), staff);
      }
      const staffStatusMatch = url.pathname.match(/^\/api\/staff\/([^/]+)\/status$/);
      if (staffStatusMatch && request.method === "PUT") {
        return handlePutStaffStatus(request, env.DB, decodeURIComponent(staffStatusMatch[1]), staff);
      }
      const staffInviteMatch = url.pathname.match(/^\/api\/staff\/([^/]+)\/invite$/);
      if (staffInviteMatch && request.method === "POST") {
        return handleResendInvite(env, staff, decodeURIComponent(staffInviteMatch[1]).toLowerCase(), url.origin);
      }
      const staffResetMatch = url.pathname.match(/^\/api\/staff\/([^/]+)\/reset$/);
      if (staffResetMatch && request.method === "POST") {
        return handleSendReset(env, staff, decodeURIComponent(staffResetMatch[1]).toLowerCase(), url.origin);
      }
      // DELETE-only, and the [^/]+$ segment terminates at the email — it can't match the longer
      // /schedule, /priority, /invite, /reset paths above (those are checked first anyway).
      const staffRemoveMatch = url.pathname.match(/^\/api\/staff\/([^/]+)$/);
      if (staffRemoveMatch && request.method === "DELETE") {
        return handleRemoveStaff(env, staff, decodeURIComponent(staffRemoveMatch[1]).toLowerCase());
      }

      // Contact book (softphone). The literal /api/contacts and /api/contacts/import paths are
      // checked before the /api/contacts/:id regex; "import" is non-numeric so it can't collide
      // with the \\d+ id match anyway.
      if (url.pathname === "/api/contacts") {
        if (request.method === "GET") return handleListContacts(env.DB);
        if (request.method === "POST") return handleCreateContact(request, env.DB);
      }
      if (url.pathname === "/api/numbers") {
        if (request.method === "GET") return handleListNumbers(env.DB);
        if (request.method === "POST") {
          if (staff.role !== "admin") return new Response("Forbidden", { status: 403 });
          return handleCreateNumber(request, env.DB);
        }
      }
      const numberIdMatch = url.pathname.match(/^\/api\/numbers\/(\d+)$/);
      if (numberIdMatch) {
        if (staff.role !== "admin") return new Response("Forbidden", { status: 403 });
        const nid = Number(numberIdMatch[1]);
        if (request.method === "PUT") return handleUpdateNumber(request, env.DB, nid);
        if (request.method === "DELETE") return handleDeleteNumber(env.DB, nid);
      }
      if (url.pathname === "/api/contacts/import" && request.method === "POST") {
        return handleImportContacts(request, env.DB);
      }
      const contactIdMatch = url.pathname.match(/^\/api\/contacts\/(\d+)$/);
      if (contactIdMatch) {
        const contactId = Number(contactIdMatch[1]);
        if (request.method === "PUT") return handleUpdateContact(request, env.DB, contactId);
        if (request.method === "DELETE") return handleDeleteContact(env.DB, contactId);
      }

      // A staff device registers its Expo push token so it can be notified of inbound SMS.
      if (url.pathname === "/api/push/register" && request.method === "POST") {
        return handleRegisterPushToken(request, env.DB, staff);
      }

      // Retry the Graph API name lookup for Messenger senders still showing as "Facebook user".
      if (url.pathname === "/api/facebook/resolve-names" && request.method === "POST") {
        return handleResolveFacebookNames(env.DB, env.FB_PAGE_ACCESS_TOKEN);
      }

      // Diagnostic: what this Page token can actually read from Facebook. Admin-only.
      if (url.pathname === "/api/facebook/probe" && request.method === "GET") {
        if (staff.role !== "admin") return new Response("Forbidden", { status: 403 });
        return handleFacebookProbe(env);
      }

      // Name a Messenger sender by hand, for when the Graph API can't tell us who they are.
      if (url.pathname === "/api/facebook/name" && request.method === "PUT") {
        return handleSetFacebookName(request, env.DB);
      }

      // SMS messaging. /api/messages: GET conversations, POST send. /api/messages/:number: thread.
      if (url.pathname === "/api/messages") {
        if (request.method === "GET") return handleListConversations(env.DB);
        if (request.method === "POST") return handleSendMessage(request, env);
      }
      const messageThreadMatch = url.pathname.match(/^\/api\/messages\/([^/]+)$/);
      if (messageThreadMatch && request.method === "GET") {
        // ?peek=1 fetches the thread WITHOUT marking it read (used by the call detail preview,
        // where merely viewing a call shouldn't clear the SMS unread badge).
        const peek = url.searchParams.get("peek") === "1";
        return handleGetThread(env.DB, decodeURIComponent(messageThreadMatch[1]), peek);
      }

      return new Response("not found", { status: 404 });
    }

    if (url.pathname.startsWith("/admin/")) {
      const staffOrResponse = await requireStaffUser(request, env, { isApi: false });
      if (staffOrResponse instanceof Response) return staffOrResponse;

      // Admin-only pages: Settings (schedules/blocklist/staff), Analytics, and the IVR Flow
      // editor. A non-admin who types the URL is sent to their Phone page instead of seeing it.
      const adminOnlyPage =
        url.pathname === "/admin/settings" ||
        url.pathname === "/admin/analytics" ||
        url.pathname === "/admin/webhooks" ||
        url.pathname.startsWith("/admin/ivr/");
      if (adminOnlyPage && staffOrResponse.role !== "admin") {
        return Response.redirect(new URL("/admin/phone", url).toString(), 302);
      }

      if (url.pathname === "/admin/phone") {
        const html = renderPhonePage(staffOrResponse.email, staffOrResponse.role);
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      if (url.pathname === "/admin/messages") {
        const html = renderMessagesPage(staffOrResponse.role);
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      if (url.pathname === "/admin/live") {
        const html = renderLiveCallsPage(await getLiveCalls(env), staffOrResponse.role);
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      if (url.pathname === "/admin/webhooks") {
        const html = renderWebhooksPage(url.origin, env.TWILIO_WEBHOOK_SECRET ?? "", staffOrResponse.role);
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      if (url.pathname === "/admin/calls") {
        const html = renderCallHistoryPage(await listCalls(env.DB), staffOrResponse.role);
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      const callIdMatch = url.pathname.match(/^\/admin\/calls\/([^/]+)$/);
      if (callIdMatch) {
        try {
          const detail = await getCallDetail(env.DB, decodeURIComponent(callIdMatch[1]));
          if (!detail) return new Response("not found", { status: 404 });
          const html = renderCallDetailPage(detail.call, detail.events, staffOrResponse.role);
          return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
        } catch (e) {
          if (e instanceof URIError) {
            return new Response("not found", { status: 404 });
          }
          throw e;
        }
      }

      if (url.pathname === "/admin/settings") {
        const [schedule, blocklist, staffRoster, staffAccess] = await Promise.all([
          getBusinessHours(env.DB),
          getCallBlocklist(env.DB),
          getStaffRoster(env.DB),
          listStaffAccess(env.DB),
        ]);
        const html = renderSettingsPage(schedule, blocklist, staffRoster, staffAccess, staffOrResponse.role);
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      if (url.pathname === "/admin/callbacks") {
        const html = renderCallbackRequestsPage(await listOpenCallbackRequests(env.DB), staffOrResponse.role);
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      if (url.pathname === "/admin/analytics") {
        const days = 14;
        const since = Date.now() - days * 24 * 60 * 60 * 1000;
        const html = renderAnalyticsPage(await getCallStats(env.DB, since), days);
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

  // Cron: reconcile any calls stuck as `in_progress` (a missed Twilio status callback) against
  // Twilio's real state, so Call History / analytics / Live Calls stay accurate without depending
  // on every status webhook landing. See reconcileStaleCalls.
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(reconcileStaleCalls(env).catch(() => {}));
    // Catch recordings the recording-status webhook never transcribed (made before Whisper
    // shipped, or a dropped webhook). Bounded per tick; rows are attempt-capped so this drains
    // and then does nothing.
    ctx.waitUntil(backfillTranscripts(env).catch(() => {}));
    // Messenger senders whose name lookup failed on their first message: retry them here, so the
    // inbox fills the name in by itself once the Graph API is answering again. Attempt-capped.
    ctx.waitUntil(backfillFacebookNames(env).catch(() => {}));
    // Watches real Messenger send outcomes for a channel-wide break (e.g. error 63001, the Twilio
    // <-> Facebook Page connection itself) and pages staff once, deduped, instead of per message.
    ctx.waitUntil(checkMessengerChannelHealth(env).catch(() => {}));
  },
};
