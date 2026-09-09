import { authorizeTwilioWebhook, appendWebhookSecret } from "./twilio/webhookAuth";
import { isDemoUser, handleDemoRequest, demoEmails } from "./demo";
import { renderJoinConference, renderDialAgentIntoConference, renderListenConference, renderBridgeToCustomer, renderAbandonToVoicemail } from "./twilio/conferenceTwiml";
import { createOutboundCall } from "./twilio/restClient";
import { cleanupLoneConference } from "./twilio/conferenceClient";
import { normalizeCallStatus } from "./twilio/statusCallback";
import { requireStaffUser } from "./access/requireStaffUser";
import { handleLogoAsset } from "./html/logoAsset";
import { handleDesktopUpdateAsset } from "./api/desktopUpdates";
import { renderPrivacyPolicyPage, renderTermsOfServicePage, renderSupportPage } from "./html/pages/legal";
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
  handleGetDivertCallerIdSetting,
  handlePutDivertCallerIdSetting,
} from "./api/settings";
import { handleGetUserSettings, handlePutUserSettings } from "./api/userSettings";
import { handleListAudioAssets, handleUploadAudioAsset } from "./api/audioAssets";
import { handleGetFlow, handlePatchNodePosition, handlePutFlow } from "./api/ivrFlow";
import { handleGetMedia } from "./api/media";
import { handleListCallbackRequests, handleUpdateCallbackRequest } from "./api/callbackRequests";
import {
  handleGetSoftphoneToken,
  handlePutPresence,
  handlePostHeartbeat,
  handlePostHold,
  handlePostTransfer,
  handlePostCompleteTransfer,
} from "./api/softphone";
import {
  handleGetStaffRoster, handleGetStaffAdminList, handlePutStaffSchedule, handlePutStaffPriority,
  handlePutStaffStatus, handleInviteStaff, handleResendInvite, handleSendReset, handleRemoveStaff,
} from "./api/staff";
import { handleListConversations, handleGetThread, handleSendMessage } from "./api/messages";
import { insertMessage, updateMessageStatus } from "./db/messages";
import { syncPendingCallsToServiceM8 } from "./servicem8/syncQueue";
import { handleGetDiagnostics, handleTestPush, handleTestEmail } from "./api/diagnostics";
import { handleCallViaMobile } from "./api/callViaMobile";
import { handleDeleteCall, handleRestoreCall, handleDeleteThread, handleRestoreThread } from "./api/deletions";
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
import { renderCallDetailPage } from "./html/pages/callDetail";
import { renderSettingsPage } from "./html/pages/settings";
import { renderWebhooksPage } from "./html/pages/webhooks";
import { renderLiveCallsPage } from "./html/pages/liveCalls";
import { renderIvrFlowPage } from "./html/pages/ivrFlow";
import { renderCallbackRequestsPage } from "./html/pages/callbackRequests";
import { renderVoicemailPage } from "./html/pages/voicemail";
import { listContacts, normalizePhone } from "./db/contacts";
import { handleReportClientErrors, handleListClientErrors } from "./api/clientErrors";
import { renderClientErrorsPage } from "./html/pages/clientErrors";
import { listClientErrors } from "./db/clientErrors";
import { renderMessagesPage } from "./html/pages/messages";
import {
  getCallDetail,
  listVoicemails,
  appendCallEvent,
  getCallStats,
  blankToNull,
  parseRecordingDuration,
} from "./db/calls";
import { handleGetRecording } from "./api/recordings";
import { renderAnalyticsPage } from "./html/pages/analytics";
import { getBusinessHours, getCallBlocklist, getRecordingEnabled, getDivertCallerId } from "./db/settings";
import { listNodesForFlow } from "./db/ivrNodes";
import { resetAvailabilityForNewDay } from "./db/staff";
import { localDateKey } from "./ivr/businessHours";
import { listAudioAssets } from "./db/audioAssets";
import { getStaffRoster, listStaffAccess } from "./db/staff";
import { listCallbackRequests } from "./db/callbackRequests";
import { recordCallLeg } from "./db/callLegs";
import { transcribeCallRecording, backfillTranscripts } from "./transcribe";
import { intelligenceEnabled, isDualChannelRecording, requestTranscript } from "./twilio/intelligence";
import { collectPendingTranscripts } from "./twilio/intelligenceQueue";
import { getTranscriptStaffChannel } from "./db/settings";
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
  // Conversational Intelligence service (GA...), set as a worker secret. Unset = the
  // speaker-labelled transcript is simply off and Whisper's unlabelled one stands.
  TWILIO_INTELLIGENCE_SERVICE_SID?: string;
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

// The extra cron added purely so the ServiceM8 sweep can fire near its 3-minute mark; the 5-minute
// tick everything else uses would have stretched that to anywhere from 3 to 8 minutes. Must stay in
// step with the "crons" array in wrangler.jsonc.
const MINUTE_CRON = "* * * * *";

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
    // The store listings' Support URL. Public by necessity -- see renderSupportPage.
    if (url.pathname === "/support") {
      return new Response(renderSupportPage(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
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
          // Present only on the FIRST webhook of a call, and only when Twilio POSTs. The ring can
          // happen many gathers later, so the DO stashes it -- see CallSession.handleMainWebhook.
          // It is what lets the divert leg ring showing the customer's number (dialStaff).
          callToken: params.CallToken ?? null,
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
          // ServiceM8 is deliberately NOT called here. Staff often create the client or job during
          // the call or just after hanging up, so looking the caller up the moment it ended
          // searched for a record that did not exist yet and gave up for good. The row is left
          // with servicem8_synced_at NULL and the cron picks it up a few minutes later --
          // see src/servicem8/syncQueue.ts.
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
          // Set by dialStaff only on a divert leg that presented the CUSTOMER's number, so the
          // staff member is told on pickup that an unfamiliar number is work. NOT "this leg is a
          // mobile": a divert that fell back to the business number leaves this off, because the
          // screen already said who it was from.
          whisper: url.searchParams.get("whisper") === "1",
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

    // "Call via my mobile" leg answered. Twilio calls this on the STAFF member's mobile leg; the
    // customer has not been dialled yet, which is what makes refusing to connect possible here.
    if (url.pathname === "/twiml/mobile-bridge" && request.method === "POST") {
      const formData = await request.formData();
      const params: Record<string, string> = {};
      for (const [key, value] of formData.entries()) {
        params[key] = String(value);
      }
      const valid = await authorizeTwilioWebhook(request, params, env);
      if (!valid) return new Response("invalid signature", { status: 401 });

      const to = url.searchParams.get("to");
      const callerId = url.searchParams.get("callerId");
      if (!to || !callerId) return new Response("missing to/callerId", { status: 400 });

      // AnsweredBy comes from the synchronous AMD on this leg. Anything that is not a human means
      // the staff member's voicemail (or a fax) answered, so the customer is never dialled.
      const answeredBy = params.AnsweredBy ?? "";
      if (answeredBy.startsWith("machine") || answeredBy === "fax") {
        console.log("CALL_VIA_MOBILE_VOICEMAIL", JSON.stringify({ callSid: params.CallSid, answeredBy }));
        await env.DB.prepare("UPDATE calls SET status = 'no-answer' WHERE id = ? AND ended_at IS NULL")
          .bind(params.CallSid)
          .run();
        return new Response(renderAbandonToVoicemail(), { headers: { "Content-Type": "text/xml" } });
      }

      const record = await getRecordingEnabled(env.DB);
      return new Response(
        renderBridgeToCustomer({
          to,
          callerId,
          recordingStatusCallbackUrl: appendWebhookSecret(
            `${url.origin}/webhooks/twilio/recording-status?callSid=${encodeURIComponent(params.CallSid)}`,
            env.TWILIO_WEBHOOK_SECRET
          ),
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

      // No `To` at all means this is not a dial -- it is the Voice SDK's PreflightTest (Settings ->
      // Test Connection), which places a real test call through this same TwiML app to measure the
      // device's jitter/MOS/round-trip time. Answer it with <Echo/>: the media loops straight back
      // so the SDK can sample the network, no number is dialled, no staff leg rings, and no `calls`
      // row is written. Returning an error here instead would fail the test with an unhelpful
      // "application error" rather than a report.
      //
      // Reaching this needs a valid signed webhook AND a valid access token, so it is staff-only.
      if (!params.To) {
        return new Response(
          '<?xml version="1.0" encoding="UTF-8"?><Response><Echo/></Response>',
          { headers: { "Content-Type": "text/xml" } }
        );
      }
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

      // COALESCE all three. A later callback without RecordingDuration can never blank a length we
      // already stored -- and the url/sid beside it needed the same guard, because a redelivery or a
      // RecordingStatus of absent/failed carries no RecordingUrl and was writing NULL over a
      // perfectly good recording, after which /api/calls/:id/recording 404s for a call whose audio
      // is fine in Twilio. parseRecordingDuration returns null for absent/garbage values.
      //
      // `blankToNull` rather than `?? null`, because this is a form post: an omitted field and a field
      // sent empty are the same intent, and only the first of them is undefined. COALESCE cannot
      // save us from an empty STRING -- that is a value, and it would overwrite the url just as
      // destructively while looking guarded.
      await env.DB.prepare(
        "UPDATE calls SET recording_url = COALESCE(?, recording_url), recording_sid = COALESCE(?, recording_sid), " +
          "recording_duration = COALESCE(?, recording_duration) WHERE id = ?"
      )
        .bind(
          blankToNull(params.RecordingUrl),
          blankToNull(params.RecordingSid),
          parseRecordingDuration(params.RecordingDuration),
          callSid
        )
        .run();

      // Kick off transcription (Whisper) in the background — never block the webhook ack. A voicemail
      // Record posts here with ?vm=1 so its transcript lands in `transcription` ("Voicemail
      // transcript"); answered-call recordings land in `call_transcript` ("Call transcript").
      if (params.RecordingUrl) {
        const isVoicemail = url.searchParams.get("vm") === "1";
        const column = isVoicemail ? "transcription" : "call_transcript";
        const job = transcribeCallRecording(env, callSid, params.RecordingUrl, column);
        if (ctx) ctx.waitUntil(job);
        else await job;

        // Answered calls ALSO go to Twilio, which returns the transcript split by speaker. Whisper
        // still runs above and lands first: Twilio is asynchronous, so this is what the call shows
        // in the meantime, and what it keeps if the labelled one never arrives.
        //
        // Voicemail is deliberately excluded. Only the caller is speaking, so there is nothing to
        // label and it would be paying per minute for the same text.
        //
        // Only CONFERENCE recordings, which is what `RecordingChannels === "2"` identifies. A
        // call-via-mobile leg is recorded by <Dial record="record-from-answer"> -- mono by
        // construction, unaffected by any Console conference setting -- so every one of those
        // transcripts would come back single-channel, be discarded, and still be billed per minute.
        if (!isVoicemail && params.RecordingSid && intelligenceEnabled(env) && !isDualChannelRecording(params.RecordingChannels)) {
          // Say so rather than going quiet. A mono recording here almost always means the Console's
          // dual-channel conference switch is off, which is the difference between this feature
          // working for every call and not working at all -- and silence is how SERVICEM8_API_KEY
          // sat inert for a day.
          console.log(
            "INTELLIGENCE_SKIPPED_MONO",
            JSON.stringify({ callSid, channels: params.RecordingChannels ?? null })
          );
        }
        if (!isVoicemail && params.RecordingSid && intelligenceEnabled(env) && isDualChannelRecording(params.RecordingChannels)) {
          // The CUSTOMER is whichever end is not us, and that flips with direction: both outbound
          // paths store the business number as caller_number and the customer as called_number, so
          // reading caller_number unconditionally told Twilio the office landline was the customer.
          const row = await env.DB.prepare("SELECT caller_number, called_number, direction FROM calls WHERE id = ?")
            .bind(callSid)
            .first<{ caller_number: string; called_number: string; direction: string }>();
          const customerNumber =
            row === null ? null : row.direction === "outbound" ? row.called_number : row.caller_number;
          // NOT named `request`: the fetch handler's own `request: Request` is in scope here, and
          // shadowing it in a webhook handler is a trap for whoever next reads a header in this block.
          const intelligenceJob = requestTranscript(env, params.RecordingSid, {
            staffChannel: await getTranscriptStaffChannel(env.DB),
            customerNumber,
          })
            .then(async (sid) => {
              if (!sid) return;
              await env.DB.prepare("UPDATE calls SET intelligence_sid = ?, intelligence_status = 'pending' WHERE id = ?")
                .bind(sid, callSid)
                .run();
            })
            // requestTranscript swallows its own failures, but this D1 write does not -- and an
            // unhandled rejection inside waitUntil is recorded as a Worker EXCEPTION, not a log
            // line. Every job on the cron is already `.catch`ed for exactly this reason; this one
            // was the only new one that was not. Losing the sid means the sweep never collects that
            // transcript, which costs a label, not the call.
            .catch((e) => {
              console.log(
                "INTELLIGENCE_PENDING_WRITE_FAILED",
                JSON.stringify({ callSid, error: e instanceof Error ? e.message : String(e) })
              );
            });
          if (ctx) ctx.waitUntil(intelligenceJob);
          else await intelligenceJob;
        }
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
      //
      // Everything under /api/admin/ is admin-only by construction, whatever the method: it is
      // where surfaces that cannot server-render their own admin data (the mobile app) read it.
      const adminOnlyRead =
        url.pathname.startsWith("/api/admin/") ||
        url.pathname.startsWith("/api/ivr/") ||
        (request.method === "GET" &&
          (url.pathname === "/api/settings/business-hours" ||
          url.pathname === "/api/settings/call-blocklist"));
      if (adminOnlyRead && staff.role !== "admin") {
        return new Response("Forbidden", { status: 403 });
      }

      if (url.pathname === "/api/me") {
        return handleMe(env.DB, staff);
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

      // Undo for a deleted call log. Longer than the id-only match below, so it is tested first.
      const callRestoreMatch = url.pathname.match(/^\/api\/calls\/([^/]+)\/restore$/);
      if (callRestoreMatch && request.method === "POST") {
        try {
          return handleRestoreCall(env.DB, decodeURIComponent(callRestoreMatch[1]), staff);
        } catch (e) {
          if (e instanceof URIError) return new Response("not found", { status: 404 });
          throw e;
        }
      }

      const callIdMatch = url.pathname.match(/^\/api\/calls\/([^/]+)$/);
      if (callIdMatch) {
        try {
          const callId = decodeURIComponent(callIdMatch[1]);
          if (request.method === "DELETE") return handleDeleteCall(env.DB, callId, staff);
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
      if (url.pathname === "/api/settings/divert-caller-id") {
        return request.method === "PUT"
          ? handlePutDivertCallerIdSetting(request, env.DB, staff)
          : handleGetDivertCallerIdSetting(env.DB);
      }
      if (url.pathname === "/api/settings/me") {
        return request.method === "PUT"
          ? handlePutUserSettings(request, env.DB, staff)
          : handleGetUserSettings(env.DB, staff);
      }

      // The bare collection path, checked before the /:id regex below. An exact-string match
      // cannot collide with it (the regex requires a further "/<digits>" segment), and neither
      // collides with any other /api/ segment above or below -- so there is no ordering hazard.
      if (url.pathname === "/api/callback-requests") {
        return handleListCallbackRequests(env.DB);
      }

      // Marking a request handled (or reopening it). PUT matches the convention used by
      // /api/calls/:id and /api/settings/* rather than introducing PATCH for one route. The id is
      // \d+ so a non-numeric segment falls through to the 404 below instead of reaching the DB.
      const callbackIdMatch = url.pathname.match(/^\/api\/callback-requests\/(\d+)$/);
      if (callbackIdMatch && request.method === "PUT") {
        return handleUpdateCallbackRequest(request, env.DB, Number(callbackIdMatch[1]), staff);
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

      // Dial without using VoIP at all: Twilio rings this staff member's mobile, then bridges the
      // customer. See src/api/callViaMobile.ts.
      if (url.pathname === "/api/softphone/call-via-mobile" && request.method === "POST") {
        return handleCallViaMobile(request, env, staff, url.origin, appendWebhookSecret);
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
      // Deliberately NOT under /api/admin/: a handset that is crashing needs to be able to say so
      // whoever is holding it, and most staff are not admins. Reading the reports is admin-only.
      if (url.pathname === "/api/client-errors" && request.method === "POST") {
        return handleReportClientErrors(env.DB, request, staff);
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
      // Full staff detail for the mobile Admin screens. Gated above with the rest of /api/admin/.
      if (url.pathname === "/api/admin/staff" && request.method === "GET") {
        return handleGetStaffAdminList(env.DB);
      }
      // Health checks, and the two end-to-end tests that prove a chain rather than describe it.
      if (url.pathname === "/api/admin/client-errors" && request.method === "GET") {
        return handleListClientErrors(env.DB);
      }
      if (url.pathname === "/api/admin/diagnostics" && request.method === "GET") {
        return handleGetDiagnostics(env, staff);
      }
      if (url.pathname === "/api/admin/test-push" && request.method === "POST") {
        return handleTestPush(env, staff);
      }
      if (url.pathname === "/api/admin/test-email" && request.method === "POST") {
        return handleTestEmail(env, staff);
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
      // Undo for a deleted conversation. Checked before the id-only match, which is $-anchored.
      const threadRestoreMatch = url.pathname.match(/^\/api\/messages\/([^/]+)\/restore$/);
      if (threadRestoreMatch && request.method === "POST") {
        try {
          return handleRestoreThread(request, env.DB, decodeURIComponent(threadRestoreMatch[1]), staff);
        } catch (e) {
          if (e instanceof URIError) return new Response("not found", { status: 404 });
          throw e;
        }
      }

      const messageThreadMatch = url.pathname.match(/^\/api\/messages\/([^/]+)$/);
      if (messageThreadMatch) {
        let peerNumber: string;
        try {
          peerNumber = decodeURIComponent(messageThreadMatch[1]);
        } catch (e) {
          if (e instanceof URIError) return new Response("not found", { status: 404 });
          throw e;
        }
        if (request.method === "DELETE") return handleDeleteThread(env.DB, peerNumber, staff);
        if (request.method === "GET") {
          // ?peek=1 fetches the thread WITHOUT marking it read (used by the call detail preview,
          // where merely viewing a call shouldn't clear the SMS unread badge).
          const peek = url.searchParams.get("peek") === "1";
          return handleGetThread(env.DB, peerNumber, peek);
        }
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
        const [schedule, blocklist, staffRoster, staffAccess, divertCallerId] = await Promise.all([
          getBusinessHours(env.DB),
          getCallBlocklist(env.DB),
          getStaffRoster(env.DB),
          listStaffAccess(env.DB),
          getDivertCallerId(env.DB),
        ]);
        const html = renderSettingsPage(schedule, blocklist, staffRoster, staffAccess, staffOrResponse.role, divertCallerId);
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      if (url.pathname === "/admin/errors") {
        if (staffOrResponse.role !== "admin") return new Response("forbidden", { status: 403 });
        const html = renderClientErrorsPage(await listClientErrors(env.DB), staffOrResponse.role);
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      if (url.pathname === "/admin/voicemail") {
        // The contact names are resolved here, in one query, rather than per row: the roster is
        // small and a lookup per voicemail is a D1 round trip each.
        const [voicemails, contacts] = await Promise.all([listVoicemails(env.DB), listContacts(env.DB)]);
        const byNormalized = new Map(contacts.map((c) => [c.phone_normalized, c.name]));
        const names = new Map<string, string>();
        for (const vm of voicemails) {
          const name = byNormalized.get(normalizePhone(vm.caller_number));
          if (name) names.set(vm.caller_number, name);
        }
        const html = renderVoicemailPage(voicemails, names, staffOrResponse.role);
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      if (url.pathname === "/admin/callbacks") {
        const html = renderCallbackRequestsPage(await listCallbackRequests(env.DB), staffOrResponse.role);
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
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // Runs on EVERY tick, the 1-minute one included: this is the only time-sensitive job here
    // (3 minutes after a call ends, near enough), and each call is claimed in D1 before any work,
    // so an overlapping tick cannot post a diary note twice.
    ctx.waitUntil(syncPendingCallsToServiceM8(env).catch(() => {}));

    // Everything below was written for the 5-minute tick and must not run every minute. An
    // unrecognised or absent cron string falls through to here, which is the safe default: the
    // work still happens, just on whatever schedule fired.
    if (event.cron === MINUTE_CRON) return;

    ctx.waitUntil(reconcileStaleCalls(env).catch(() => {}));
    // Catch recordings the recording-status webhook never transcribed (made before Whisper
    // shipped, or a dropped webhook). Bounded per tick; rows are attempt-capped so this drains
    // and then does nothing.
    ctx.waitUntil(backfillTranscripts(env).catch(() => {}));
    // Twilio transcribes asynchronously, so the recording webhook can only ask -- this collects the
    // finished ones and writes the speaker-labelled text over the Whisper transcript. No-ops
    // entirely when TWILIO_INTELLIGENCE_SERVICE_SID is unset.
    ctx.waitUntil(collectPendingTranscripts(env).catch(() => {}));
    // Messenger senders whose name lookup failed on their first message: retry them here, so the
    // inbox fills the name in by itself once the Graph API is answering again. Attempt-capped.
    ctx.waitUntil(backfillFacebookNames(env).catch(() => {}));
    // Watches real Messenger send outcomes for a channel-wide break (e.g. error 63001, the Twilio
    // <-> Facebook Page connection itself) and pages staff once, deduped, instead of per message.
    ctx.waitUntil(checkMessengerChannelHealth(env).catch(() => {}));
    // Availability is a one-day override: anyone still marked away/offline from an earlier day is
    // put back to available, so one sick day cannot quietly remove someone from the ring roster
    // for a week. Cheap single UPDATE; a no-op on most ticks.
    ctx.waitUntil(
      resetAvailabilityForNewDay(env.DB, localDateKey(new Date()))
        .then((n) => {
          if (n > 0) console.log("AVAILABILITY_RESET", { staff: n });
        })
        .catch(() => {})
    );
  },
};
