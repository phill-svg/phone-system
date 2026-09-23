import { authorizeTwilioWebhook, appendWebhookSecret } from "./twilio/webhookAuth";
import { isDemoUser, handleDemoRequest, demoEmails } from "./demo";
import { renderJoinConference, renderDialAgentIntoConference, renderListenConference, renderBridgeToCustomer, renderAbandonToVoicemail } from "./twilio/conferenceTwiml";
import { createOutboundCall, cancelCall, TwilioApiError } from "./twilio/restClient";
import { wrapResponse } from "./twilio/flowTwiml";
import { cleanupLoneConference } from "./twilio/conferenceClient";
import { normalizeCallStatus } from "./twilio/statusCallback";
import { requireStaffUser } from "./access/requireStaffUser";
import { handleLogoAsset } from "./html/logoAsset";
import { handleDesktopUpdateAsset } from "./api/desktopUpdates";
import { safeDecode } from "./api/respond";
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
  handleGetMissedCallSmsSetting,
  handlePutMissedCallSmsSetting,
} from "./api/settings";
import { sendMissedCallSmsIfDue } from "./api/missedCallSms";
import { handleGetOnCall, handlePutOnCall, handlePutOnCallOverride } from "./api/onCall";
import { handleGetUserSettings, handlePutUserSettings } from "./api/userSettings";
import { handleListAudioAssets, handleUploadAudioAsset } from "./api/audioAssets";
import { handleGetFlow, handleListFlows, handlePatchNodePosition, handlePutFlow } from "./api/ivrFlow";
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
import { handleListConversations, handleGetThread, handleSendMessage, threadPeer } from "./api/messages";
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
import { renderPhoneFrameStub, renderPhonePage } from "./html/pages/phone";
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
import { handleGetRecording, handleRecoverRecording } from "./api/recordings";
import { insertMessageMedia, parseInboundMedia } from "./db/messageMedia";
import { handleGetMessageMedia } from "./api/messageMediaProxy";
import { renderAnalyticsPage } from "./html/pages/analytics";
import { getBusinessHours, getCallBlocklist, getRecordingEnabled, getDivertCallerId, getMissedCallSms } from "./db/settings";
import { listNodesForFlow } from "./db/ivrNodes";
import { resetAvailabilityForNewDay } from "./db/staff";
import { localDateKey } from "./ivr/businessHours";
import { listAudioAssets } from "./db/audioAssets";
import { getStaffRoster, listStaffAccess } from "./db/staff";
import { listCallbackRequests } from "./db/callbackRequests";
import { recordCallLeg } from "./db/callLegs";
import { transcribeRecording, backfillTranscripts, backfillLabels } from "./transcribe";
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
  // 13/1300/1800 numbers carry no trunk prefix, so unlike an "02..." landline there is no leading 0
  // to strip -- "1300 123 456" is +611300123456. Falling through to the bare-digits return below
  // sent Twilio "1300123456" with no "+", which it rejects outright: 1300/1800/13xx numbers could
  // not be dialled from the softphone at all. See the identical fix and comment in
  // callViaMobile.ts's normalizeDialTarget -- keep the two in lock-step.
  if (/^1[38]00\d{6}$/.test(digits) || /^13\d{4}$/.test(digits)) return "+61" + digits;
  if (/^61\d{9}$/.test(digits)) return "+" + digits;
  return trimmed;
}

// Twilio's own parameters on a voice webhook. Anything outside this set on the agent-answer leg is
// a custom Client parameter that Twilio carried through from the dialled `To`.
const TWILIO_STANDARD_CALL_PARAMS = new Set([
  "AccountSid",
  "ApiVersion",
  "ApplicationSid",
  "CallSid",
  "CallStatus",
  "CallToken",
  "Called",
  "CalledCity",
  "CalledCountry",
  "CalledState",
  "CalledZip",
  "Caller",
  "CallerCity",
  "CallerCountry",
  "CallerState",
  "CallerZip",
  "Direction",
  "ForwardedFrom",
  "From",
  "FromCity",
  "FromCountry",
  "FromState",
  "FromZip",
  "StirVerstat",
  "To",
  "ToCity",
  "ToCountry",
  "ToState",
  "ToZip",
  "AnsweredBy",
  "MachineDetectionDuration",
]);

// The dashboard sections the Phone page's shell opens in its frame -- every /admin/ HTML page
// except Phone itself. A top-level load of one of these gets the shell (see the /admin/ routes).
const SHELL_SECTIONS = new Set([
  "/admin/messages",
  "/admin/live",
  "/admin/webhooks",
  "/admin/settings",
  "/admin/errors",
  "/admin/voicemail",
  "/admin/callbacks",
  "/admin/analytics",
]);
export function isShellSection(pathname: string): boolean {
  return SHELL_SECTIONS.has(pathname) || /^\/admin\/(calls|ivr)\/[^/]+$/.test(pathname);
}

// Whether a recording-status callback describes a TWO-CHANNEL recording, which is the only kind
// that can be labelled by speaker: the split in `src/audio/wav.ts` needs one channel per party.
// Both spellings are accepted deliberately -- Twilio documents `RecordingChannels` as mono/dual
// when CREATING a recording and as 1/2 on the status callback, and gating the whole feature on
// guessing which one arrives is not a bet worth taking.
function isDualChannelRecording(recordingChannels: string | undefined | null): boolean {
  const v = (recordingChannels ?? "").trim().toLowerCase();
  return v === "2" || v === "dual";
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
      const name = safeDecode(desktopUpdateMatch[1]);
      if (name === null) return new Response("not found", { status: 404 });
      return handleDesktopUpdateAsset(env.AUDIO_ASSETS, name);
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

        // OUTSIDE the `changes > 0` block on purpose. This is the only moment the call is
        // genuinely over -- Twilio has reported a terminal status for the caller's own leg -- and
        // it is the ONLY place the missed-call text is sent. A caller who leaves a voicemail or
        // asks for a callback has `ended_at` stamped mid-call by CallSession, on the `<Record>`
        // action, while they are still connected; gating on `changes > 0` meant either texting
        // them from there (their phone buzzing during the call, the reported bug) or not at all.
        // Re-running on a redelivered status is harmless: the `missed_sms_sent_at IS NULL` claim
        // inside is what makes it once-per-call. Best-effort and never throws.
        await sendMissedCallSmsIfDue(env, params.CallSid);
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

      // Every incoming call shows the BUSINESS number on the handset instead of the customer, on
      // every iOS surface. dialStaff attaches the real caller as a `CallerNumber` custom Client
      // parameter on the `To` (`client:{email}?CallerNumber=...`), which is Twilio's own documented
      // mechanism, and all three readers -- the mobile ringing screen, the CallKit handle template,
      // and the web banner -- read it correctly. So the open question is whether Twilio carries it
      // at all, and nothing anywhere records what actually arrives on this leg. This names the
      // non-standard keys Twilio posts here, which is the one observation that settles it: a
      // `CallerNumber` in this list proves Twilio carries it, so the fault is client-side. Absence is
      // evidence, not proof: Twilio may deliver custom parameters to the SDK endpoint without also
      // posting them to this leg's own Url. Read it that way round.
      console.log(
        "AGENT_ANSWER_PARAMS",
        JSON.stringify({ callSid, keys: Object.keys(params).filter((k) => !TWILIO_STANDARD_CALL_PARAMS.has(k)) })
      );

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
      // THE recording for an inbound call lives on this leg -- the caller's. One caller, one leg,
      // lasting the whole call across any transfer, and its parent call is always the customer, so
      // channel 1 is always the customer. See renderJoinConference for why not the staff leg.
      const joinRecord = await getRecordingEnabled(env.DB);
      return new Response(
        renderJoinConference({
          conferenceName,
          record: joinRecord,
          recordingStatusCallbackUrl: appendWebhookSecret(
            `${url.origin}/webhooks/twilio/recording-status?callSid=${conferenceName}&conference=1&rec=dual&staffch=2`,
            env.TWILIO_WEBHOOK_SECRET
          ),
        }),
        { headers: { "Content-Type": "text/xml" } }
      );
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
      // RECORDS ONLY WHEN THE URL SAYS SO, because this route serves two different legs and only
      // one of them should record:
      //
      //   /twiml/voice-app  -> the dialled CUSTOMER on an outbound softphone call. No caller-owned
      //                        <Dial> exists there, so this conference recording is the ONLY one.
      //   handleTransfer    -> the transfer TARGET on an inbound call, which is ALREADY being
      //                        recorded by the caller's own leg (renderJoinConference).
      //
      // Recording unconditionally meant a warm-transferred inbound call produced TWO recordings --
      // the caller's dual-channel DialVerb one plus a mono conference one -- both POSTing to the
      // same recording-status callback, where recording_url is COALESCE/last-write-wins. The row
      // could end up pointing at the mono one with the dual one orphaned in Twilio, and the two
      // callbacks race the intelligence_status write. That is the exact defect the caller-leg move
      // was supposed to make impossible, surviving in the one place it wasn't looked for; found by
      // /code-review before it shipped.
      //
      // The flag is on the URL WE BUILD rather than inferred from Twilio's parameters -- the same
      // reasoning as `conference=1`, and for the same reason: whose leg this is, is something only
      // the code that dialled it knows.
      const record = url.searchParams.get("rec") === "conf" && (await getRecordingEnabled(env.DB));
      return new Response(
        renderDialAgentIntoConference({
          conferenceName,
          actionUrl: appendWebhookSecret(`${url.origin}/webhooks/twilio/agent-status?callSid=${conferenceName}`, env.TWILIO_WEBHOOK_SECRET),
          // `rec=dual` and no `conference=1`: this is a <Dial> recording on the CUSTOMER's own leg,
          // not a <Conference> one, so mono coming back is a real fault rather than the Console's
          // dual-channel switch being off. Same reasoning, and same flags, as the inbound caller leg.
          recordingStatusCallbackUrl: appendWebhookSecret(`${url.origin}/webhooks/twilio/recording-status?callSid=${conferenceName}&rec=dual&staffch=2`, env.TWILIO_WEBHOOK_SECRET),
          record,
          // The leg reaching here with `rec=conf` IS the dialled customer, so its <Dial> is the
          // customer's: channel 1 is the customer, channel 2 is whoever they are speaking to. The
          // agent's own leg passes `record: false` for this, so there is still exactly one recording.
          dual: true,
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
          // `staffch=1`, and this is the ONE flow where it is 1. The <Dial> below is executed by
          // the STAFF member's own mobile leg, and a <Dial> recording puts channel 1 on the call
          // that executed it -- so here channel 1 is staff and channel 2 is the customer, the
          // inverse of every other recorded flow. `rec=dual` for the same reason it is set on the
          // caller leg: this recording is two-channel by request, so mono coming back is a fault.
          recordingStatusCallbackUrl: appendWebhookSecret(
            `${url.origin}/webhooks/twilio/recording-status?callSid=${encodeURIComponent(params.CallSid)}&rec=dual&staffch=1`,
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
      // `OR IGNORE`: Twilio retries an unanswered/erroring webhook once with the SAME CallSid, so
      // a failure below that gets retried must not turn a plain "couldn't dial" into a second crash
      // from a duplicate primary key on this INSERT.
      await env.DB.prepare(
        "INSERT OR IGNORE INTO calls (id, caller_number, called_number, started_at, is_after_hours, status, direction) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
        .bind(conferenceName, fromNumber, target, Date.now(), 0, "in_progress", "outbound")
        .run();

      // params.From is the agent's own `client:{email}` identity (set by the Voice SDK). Record
      // this leg's ownership so handlePostHold/handlePostTransfer/handlePostCompleteTransfer can
      // later verify a client-submitted CallSid actually belongs to the authenticated staff member.
      const fromEmail = params.From.startsWith("client:") ? params.From.slice("client:".length) : params.From;
      await recordCallLeg(env.DB, conferenceName, fromEmail, conferenceName);

      // Twilio can refuse this for reasons entirely outside our control -- a geo-permission block
      // (error 13227, e.g. AU "High Risk: Special" numbers like 1300/1800 not enabled on the
      // account), a rotated key, a 429. Left uncaught, that throw escapes to the Workers runtime's
      // own error page (a bare 500, "error code: 1101" in the Twilio debugger) instead of valid
      // TwiML -- so the agent's own leg gets no response at all and the app shows a raw failure with
      // no explanation. Worse, Twilio then retries this same webhook once, which without `OR IGNORE`
      // above would ALSO throw (duplicate id), guaranteeing two crashes for one failed dial.
      let targetSid: string;
      try {
        ({ sid: targetSid } = await createOutboundCall(env.TWILIO_ACCOUNT_SID, env.TWILIO_API_KEY_SID, env.TWILIO_API_KEY_SECRET, {
          to: target,
          from: fromNumber,
          // `rec=conf` because THIS is the leg that must record on an outbound softphone call: the
          // customer is dialled, so there is no caller-owned <Dial> to hang a dual recording on and
          // the conference recording is the only one. handleTransfer deliberately omits it -- see
          // the transfer-answer route.
          url: appendWebhookSecret(
            `${url.origin}/webhooks/twilio/transfer-answer?conf=${conferenceName}&rec=conf`,
            env.TWILIO_WEBHOOK_SECRET
          ),
          statusCallback: appendWebhookSecret(`${url.origin}/webhooks/twilio/agent-status?callSid=${conferenceName}`, env.TWILIO_WEBHOOK_SECRET),
          statusCallbackEvent: ["completed"],
        }));
      } catch (e) {
        const detail = e instanceof TwilioApiError ? `${e.status} ${e.body}` : e instanceof Error ? e.message : String(e);
        console.log("VOICE_APP_DIAL_FAILED", JSON.stringify({ conferenceName, target, detail }));
        await env.DB.prepare("UPDATE calls SET status = 'failed', ended_at = ? WHERE id = ?").bind(Date.now(), conferenceName).run();
        return new Response(
          wrapResponse("<Say>Sorry, that call could not be placed.</Say><Hangup/>"),
          { headers: { "Content-Type": "text/xml" } }
        );
      }

      try {
        // Remember the dialed-out leg so an agent hang-up (before the callee answers) can cancel
        // it, instead of leaving the callee's phone ringing. Recorded on the call row we just
        // inserted.
        await env.DB.prepare("UPDATE calls SET outbound_target_sid = ? WHERE id = ?").bind(targetSid, conferenceName).run();

        return new Response(
          renderDialAgentIntoConference({
            conferenceName,
            actionUrl: appendWebhookSecret(`${url.origin}/webhooks/twilio/agent-status?callSid=${conferenceName}`, env.TWILIO_WEBHOOK_SECRET),
            recordingStatusCallbackUrl: appendWebhookSecret(`${url.origin}/webhooks/twilio/recording-status?callSid=${conferenceName}&conference=1`, env.TWILIO_WEBHOOK_SECRET),
            // `record: false` is load-bearing, not tidy-up. The dialled CUSTOMER's leg records this
            // call on its own <Dial> (two channels, `rec=conf` -> `dual: true` in the transfer-answer
            // route above). If this leg asked for a conference recording as well there would be TWO
            // recordings for one call, both POSTing to the same callback where `recording_url` is
            // last-write-wins -- half the conversation orphaned in Twilio and the labelled half the
            // one likely to lose. Mirrors the inbound staff leg, which passes `record: false` for
            // exactly the same reason.
            record: false,
          }),
          { headers: { "Content-Type": "text/xml" } }
        );
      } catch (e) {
        // The target leg was already created and is ringing/connecting -- left alone it would
        // strand the callee on a live call nobody joins, since the agent's own leg is about to
        // fail below too. Best-effort: a call that already answered can't be cancelled (Twilio
        // 400s), which is fine -- it hangs up with the agent leg gone from the conference anyway.
        await cancelCall(env.TWILIO_ACCOUNT_SID, env.TWILIO_API_KEY_SID, env.TWILIO_API_KEY_SECRET, targetSid).catch(() => {});
        console.log("VOICE_APP_SETUP_FAILED", JSON.stringify({ conferenceName, targetSid, error: e instanceof Error ? e.message : String(e) }));
        return new Response(
          wrapResponse("<Say>Sorry, that call could not be placed.</Say><Hangup/>"),
          { headers: { "Content-Type": "text/xml" } }
        );
      }
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
        // WHICH KIND of recording this is, because "came back mono" means two completely different
        // things and only one of them is benign. Both flags are set on URLs we build ourselves --
        // never inferred from Twilio's parameters, which is the whole reason they exist.
        //
        //   rec=dual      the CALLER's leg, <Dial record="record-from-answer-dual">. Dual channel is
        //                 the entire point, so mono here is a REAL FAULT: Twilio not honouring
        //                 record-from-answer-dual, or RecordingChannels simply absent from the
        //                 callback (isDualChannelRecording(undefined) is false). It must alarm.
        //   conference=1  a <Conference record="record-from-start"> recording -- outbound softphone,
        //                 where mono is the expected outcome of the Console's dual-channel switch
        //                 not working, and is not worth waking anyone over.
        //
        // Collapsing the two would have re-created the exact gap fixed a day earlier: an inbound
        // recording silently un-transcribed while Health Checks called it expected.
        const isCallerDual = url.searchParams.get("rec") === "dual";
        const isConference = url.searchParams.get("conference") === "1";
        // WHICH CHANNEL IS STAFF, declared by the leg that chose the recording -- the only place
        // that knows. It is 2 wherever the recording sits on the customer's own <Dial> (inbound
        // caller leg, outbound softphone customer leg) and 1 on call-via-mobile, where the staff
        // mobile leg executes the <Dial>. Read back by the Intelligence sweep at collection time.
        //
        // Anything else is ignored rather than stored: the value ends up choosing who gets quoted
        // saying what, and a junk one would do that silently. NULL then falls back to the
        // account-wide setting, which is what every pre-existing row uses.
        //
        // Caught, and not allowed to fail the callback: `recording_url` is already written by this
        // point, so a throw here would 500 a callback whose work is half done -- and neither Whisper
        // nor Twilio would ever be asked for this call. Losing the channel costs only the label
        // direction (the sweep falls back to the setting); losing the transcript costs the call.
        const declaredStaffChannel = url.searchParams.get("staffch");
        if (declaredStaffChannel === "1" || declaredStaffChannel === "2") {
          await env.DB.prepare("UPDATE calls SET transcript_staff_channel = ? WHERE id = ?")
            .bind(Number(declaredStaffChannel), callSid)
            .run()
            .catch((e) => {
              console.log(
                "TRANSCRIPT_STAFF_CHANNEL_WRITE_FAILED",
                JSON.stringify({ callSid, error: e instanceof Error ? e.message : String(e) })
              );
            });
        }
        const column = isVoicemail ? "transcription" : "call_transcript";
        // A two-channel recording is transcribed one channel at a time and merged back into a
        // labelled conversation; anything else gets the ordinary single-pass transcript. Both live
        // behind one call because Whisper must run at most once per recording -- two writers racing
        // over `call_transcript` in a single tick is how a labelled transcript used to be destroyed
        // by an unlabelled one landing late.
        //
        // Voicemail is excluded from labelling: one person is speaking, so there is nothing to
        // label.
        const dualChannel = !isVoicemail && isDualChannelRecording(params.RecordingChannels);
        // The leg that chose the recording declared this on the callback URL (`staffch`), and it is
        // already persisted above. The account-wide setting covers a recording made before that
        // existed -- read ONLY when it is actually needed, and never allowed to throw: this runs
        // after `recording_url` is written, so an escaping error would 500 a callback whose work is
        // half done and lose the transcript entirely to save a label direction that has a default.
        let staffChannel: 1 | 2 = 2;
        if (declaredStaffChannel === "1" || declaredStaffChannel === "2") {
          staffChannel = Number(declaredStaffChannel) as 1 | 2;
        } else if (dualChannel) {
          staffChannel = await getTranscriptStaffChannel(env.DB).catch((e) => {
            console.log(
              "TRANSCRIPT_STAFF_CHANNEL_READ_FAILED",
              JSON.stringify({ callSid, error: e instanceof Error ? e.message : String(e) })
            );
            return 2 as const;
          });
        }
        const job = transcribeRecording(env, callSid, params.RecordingUrl, {
          column,
          dualChannel,
          staffChannel,
        }).catch((e) => {
          console.log("TRANSCRIBE_JOB_FAILED", JSON.stringify({ callSid, error: e instanceof Error ? e.message : String(e) }));
        });
        if (ctx) ctx.waitUntil(job);
        else await job;

        // A recording that came back MONO when the leg that made it asked for two channels. Every
        // recorded flow asks for two now -- inbound on the caller's leg, outbound softphone on the
        // dialled customer's leg, call-via-mobile on the staff mobile leg -- so this is a real
        // fault, not a shape to skip quietly, and it is the difference between labelled transcripts
        // working for every call and not working at all. A log line is not an alarm, so it is
        // persisted for Health Checks to find.
        //
        // `single_channel` stays for a conference recording, which is mono by construction and
        // keeps its unlabelled transcript. Anything else is left UNMARKED rather than filed under a
        // marker that is always set, which is one you learn to ignore.
        //
        // Guarded on a NULL status so a redelivered callback can never relabel a completed one.
        if (!isVoicemail && !dualChannel) {
          console.log(
            "TRANSCRIBE_SKIPPED_MONO",
            JSON.stringify({ callSid, channels: params.RecordingChannels ?? null, conference: isConference, callerDual: isCallerDual })
          );
          const monoStatus = isCallerDual ? "dual_failed" : isConference ? "single_channel" : null;
          if (monoStatus) {
            const monoJob = env.DB.prepare(
              "UPDATE calls SET intelligence_status = ? WHERE id = ? AND intelligence_status IS NULL"
            )
              .bind(monoStatus, callSid)
              .run()
              .catch((e) => {
                console.log(
                  "TRANSCRIBE_MONO_MARK_FAILED",
                  JSON.stringify({ callSid, error: e instanceof Error ? e.message : String(e) })
                );
              });
            if (ctx) ctx.waitUntil(monoJob);
            else await monoJob;
          }
        }
      }

      return new Response("ok", { status: 200 });
    }

    if (url.pathname.startsWith("/media/")) {
      // Public route, intentionally NOT staff-gated: Twilio fetches this URL directly
      // to stream IVR audio into a live call and cannot present an Access credential.
      const key = safeDecode(url.pathname.slice("/media/".length));
      if (key === null) return new Response("not found", { status: 404 });
      return handleGetMedia(env.AUDIO_ASSETS, key);
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
        const messageId = params.MessageSid || crypto.randomUUID();
        await insertMessage(env.DB, {
          id: messageId,
          direction: "inbound",
          peer_number: params.From,
          our_number: params.To || null,
          body: params.Body ?? "",
          status: "received",
          read: 0,
          createdAt: Date.now(),
        });
        const mediaOnMessage = parseInboundMedia(params);
        // A photo the customer sent. Twilio carries these as NumMedia/MediaUrlN on the same
        // webhook, and nothing read them -- so an attachment arrived as a message with an empty
        // body and no sign anything was missing. In its own try: the message is already stored,
        // and losing the attachment must never turn a delivered text into a failed webhook that
        // Twilio then redelivers.
        try {
          await insertMessageMedia(env.DB, messageId, mediaOnMessage);
        } catch (e) {
          console.log("MESSAGE_MEDIA_INSERT_FAILED", JSON.stringify({ messageId, error: e instanceof Error ? e.message : String(e) }));
        }

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
        // A photo arrives with an empty body, and an empty push says a message came in while showing
        // nothing about it -- the half of this bug that is not in the thread view.
        const preview = (params.Body ?? "").trim() || (mediaOnMessage.length ? "Photo" : "");
        const notify = notifyInboundSms(env.DB, params.From, preview, fbName).catch(() => {});
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

      // One attachment on a message -- a customer's photo -- streamed through our own auth.
      // Twilio's media URL needs the account credentials, which no client can present.
      const mediaMatch = /^\/api\/messages\/([^/]+)\/media\/(\d+)$/.exec(url.pathname);
      if (mediaMatch) {
        return handleGetMessageMedia(env, env.DB, safeDecode(mediaMatch[1]) ?? "", Number(mediaMatch[2]));
      }
      if (url.pathname === "/api/me") {
        return handleMe(env.DB, staff);
      }
      if (url.pathname === "/api/calls/live") {
        return handleLiveCalls(env);
      }
      if (url.pathname === "/api/calls") {
        return handleListCalls(env.DB, url.searchParams.get("number"));
      }
      // Longer than the /api/calls/:id match below (which is $-anchored right after the id), so the
      // two never shadow each other. Streams the call's Twilio recording through our own auth.
      const recordingMatch = url.pathname.match(/^\/api\/calls\/([^/]+)\/recording$/);
      if (recordingMatch && request.method === "GET") {
        const callId = safeDecode(recordingMatch[1]);
        if (callId === null) return new Response("not found", { status: 404 });
        return handleGetRecording(env, env.DB, callId, request);
      }

      // Admin recovery for a call whose recording never got linked (the recording-status callback
      // was dropped, redelivered wrong, or failed) -- asks Twilio directly by CallSid rather than
      // trusting anything already in D1. See handleRecoverRecording.
      const recoverMatch = url.pathname.match(/^\/api\/calls\/([^/]+)\/recover-recording$/);
      if (recoverMatch && request.method === "POST") {
        if (staff.role !== "admin") return new Response("Forbidden", { status: 403 });
        const callId = safeDecode(recoverMatch[1]);
        if (callId === null) return new Response("not found", { status: 404 });
        return handleRecoverRecording(env, env.DB, callId);
      }

      // Undo for a deleted call log. Longer than the id-only match below, so it is tested first.
      const callRestoreMatch = url.pathname.match(/^\/api\/calls\/([^/]+)\/restore$/);
      if (callRestoreMatch && request.method === "POST") {
        const callId = safeDecode(callRestoreMatch[1]);
        if (callId === null) return new Response("not found", { status: 404 });
        return handleRestoreCall(env.DB, callId, staff);
      }

      const callIdMatch = url.pathname.match(/^\/api\/calls\/([^/]+)$/);
      if (callIdMatch) {
        const callId = safeDecode(callIdMatch[1]);
        if (callId === null) return new Response("not found", { status: 404 });
        if (request.method === "DELETE") return handleDeleteCall(env.DB, callId, staff);
        return request.method === "PUT"
          ? handleUpdateCallMeta(request, env.DB, callId)
          : handleCallDetail(env.DB, callId);
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
      if (url.pathname === "/api/settings/missed-call-sms") {
        return request.method === "PUT"
          ? handlePutMissedCallSmsSetting(request, env.DB, staff)
          : handleGetMissedCallSmsSetting(env.DB);
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

      // The flow LIST, matched before the per-flow regex below. That regex requires a segment after
      // "flows/", so it never matches this bare path -- the order is for readability, not shadowing.
      if (url.pathname === "/api/ivr/flows" && request.method === "GET") {
        return handleListFlows(env.DB);
      }

      // Matched after the literal /api/ivr/audio check above -- "audio" and "flows" are
      // disjoint path segments so there's no shadowing risk between the two.
      const ivrFlowMatch = url.pathname.match(/^\/api\/ivr\/flows\/([^/]+)$/);
      if (ivrFlowMatch) {
        const flow = safeDecode(ivrFlowMatch[1]);
        if (flow === null) return new Response("not found", { status: 404 });
        return request.method === "PUT"
          ? handlePutFlow(request, env.DB, flow, staff)
          : handleGetFlow(env.DB, flow);
      }

      // PATCH-only endpoint (drag-to-reposition on the flow canvas). Disjoint from ivrFlowMatch
      // above -- that regex terminates right after the flow segment ($), so it never matches
      // this longer /nodes/:id/position path; same non-shadowing reasoning as the
      // /api/ivr/audio-vs-/api/ivr/flows comment above it.
      const ivrNodePositionMatch = url.pathname.match(/^\/api\/ivr\/flows\/([^/]+)\/nodes\/([^/]+)\/position$/);
      if (ivrNodePositionMatch) {
        const flow = safeDecode(ivrNodePositionMatch[1]);
        const nodeId = safeDecode(ivrNodePositionMatch[2]);
        if (flow === null || nodeId === null) return new Response("not found", { status: 404 });
        return handlePatchNodePosition(request, env.DB, flow, nodeId, staff);
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
      // The after-hours on-call rotation. Under /api/admin/ and therefore admin-only by construction.
      if (url.pathname === "/api/admin/on-call") {
        if (request.method === "GET") return handleGetOnCall(env.DB, env);
        if (request.method === "PUT") return handlePutOnCall(request, env.DB, staff, env);
      }
      if (url.pathname === "/api/admin/on-call/override" && request.method === "PUT") {
        return handlePutOnCallOverride(request, env.DB, staff, env);
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
      // /api/staff/:email and its sub-actions. The email is decoded once, and a malformed escape is a
      // 404 whatever the action.
      const staffMemberMatch = url.pathname.match(/^\/api\/staff\/([^/]+)(?:\/(schedule|priority|status|invite|reset))?$/);
      if (staffMemberMatch) {
        const email = safeDecode(staffMemberMatch[1]);
        if (email === null) return new Response("not found", { status: 404 });
        const action = staffMemberMatch[2];
        if (request.method === "PUT") {
          if (action === "schedule") return handlePutStaffSchedule(request, env.DB, email, staff);
          if (action === "priority") return handlePutStaffPriority(request, env.DB, email, staff);
          if (action === "status") return handlePutStaffStatus(request, env.DB, email, staff);
        }
        if (request.method === "POST") {
          if (action === "invite") return handleResendInvite(env, staff, email.toLowerCase(), url.origin);
          if (action === "reset") return handleSendReset(env, staff, email.toLowerCase(), url.origin);
        }
        if (request.method === "DELETE" && action === undefined) return handleRemoveStaff(env, staff, email.toLowerCase());
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
        const peer = safeDecode(threadRestoreMatch[1]);
        if (peer === null) return new Response("not found", { status: 404 });
        return handleRestoreThread(request, env.DB, threadPeer(peer), staff);
      }

      const messageThreadMatch = url.pathname.match(/^\/api\/messages\/([^/]+)$/);
      if (messageThreadMatch) {
        const decodedPeer = safeDecode(messageThreadMatch[1]);
        if (decodedPeer === null) return new Response("not found", { status: 404 });
        const peerNumber = threadPeer(decodedPeer);
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

      // The demo swap lives under /api/, and most of these pages read real D1 on the server. Deny
      // by default: only the two pages that render from the substituted API are allowed, so a
      // future page cannot quietly reopen this.
      if (
        isDemoUser(staffOrResponse.email, env) &&
        url.pathname !== "/admin/phone" &&
        url.pathname !== "/admin/messages"
      ) {
        return Response.redirect(new URL("/admin/phone", url).toString(), 302);
      }

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

      // The Phone page is the dashboard's shell: every other section opens in a frame inside it,
      // because the softphone lives on that page and a navigation away destroys it (a call then
      // rings nowhere). See renderPhonePage. A top-level load of a section gets the shell with that
      // section open; the frame's own request gets the plain section. A missing header (an old
      // browser) gets the plain page too -- never the shell, which inside a frame would nest a
      // second softphone.
      const dest = request.headers.get("Sec-Fetch-Dest");
      if (url.pathname === "/admin/phone" && dest === "iframe") {
        return new Response(renderPhoneFrameStub(), {
          headers: { "Content-Type": "text/html; charset=utf-8", Vary: "Sec-Fetch-Dest" },
        });
      }
      if (url.pathname === "/admin/phone" || (dest === "document" && isShellSection(url.pathname))) {
        const section = url.pathname === "/admin/phone" ? null : url.pathname + url.search;
        const html = renderPhonePage(staffOrResponse.email, staffOrResponse.role, { section });
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8", Vary: "Sec-Fetch-Dest" },
        });
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
        const callId = safeDecode(callIdMatch[1]);
        if (callId === null) return new Response("not found", { status: 404 });
        const detail = await getCallDetail(env.DB, callId);
        if (!detail) return new Response("not found", { status: 404 });
        const html = renderCallDetailPage(detail.call, detail.events, staffOrResponse.role);
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      if (url.pathname === "/admin/settings") {
        const [schedule, blocklist, staffRoster, staffAccess, divertCallerId, missedCallSms] = await Promise.all([
          getBusinessHours(env.DB),
          getCallBlocklist(env.DB),
          getStaffRoster(env.DB),
          listStaffAccess(env.DB),
          getDivertCallerId(env.DB),
          getMissedCallSms(env.DB),
        ]);
        const html = renderSettingsPage(schedule, blocklist, staffRoster, staffAccess, staffOrResponse.role, divertCallerId, missedCallSms);
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
        const flow = safeDecode(ivrAdminMatch[1]);
        if (flow === null) return new Response("not found", { status: 404 });
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
    // (SERVICEM8_SYNC_DELAY_MS after a call ends, near enough), and each call is claimed in D1
    // before any work, so an overlapping tick cannot post a diary note twice.
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
    // Calls whose speaker labelling hit a transient failure. They already have a plain transcript,
    // so backfillTranscripts above will never look at them again -- without this, one 502 from
    // Twilio's media host costs those labels permanently. Attempt-capped, so it drains.
    ctx.waitUntil(backfillLabels(env).catch(() => {}));
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
