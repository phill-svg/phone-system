import { getToken, clearToken } from "./session";
import { OTA_BUILD, NATIVE_BUILD } from "./build";
import { toPutPayload, type IvrFlow } from "./ivr";

export const BASE_URL = (process.env.EXPO_PUBLIC_API_BASE_URL ?? "https://tcbvoip.app").replace(/\/$/, "");

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

let unauthorizedHandler: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  unauthorizedHandler = fn;
}

export async function apiFetch<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  const token = await getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(opts.headers as Record<string, string> | undefined),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}${path}`, { ...opts, headers });

  if (res.status === 401) {
    await clearToken();
    unauthorizedHandler?.();
    throw new ApiError(401, "unauthorized");
  }
  if (!res.ok) {
    let msg = `request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) msg = body.error;
    } catch { /* non-JSON error body */ }
    throw new ApiError(res.status, msg);
  }
  return (await res.json()) as T;
}

// Twilio Voice access token for the native softphone. Minted server-side with a VoiceGrant
// scoped to this staff member's identity (see /api/softphone/token).
export async function getSoftphoneToken(platform: "android" | "ios" = "android"): Promise<string> {
  const { token } = await apiFetch<{ token: string }>(`/api/softphone/token?platform=${platform}`);
  return token;
}

// Presence + heartbeat. The inbound ring plan only dials a staff member's softphone while they
// are "available" with a heartbeat seen in the last 5 minutes (see src/dial/presence.ts).
export async function setPresence(status: "available" | "away" | "offline"): Promise<void> {
  await apiFetch("/api/softphone/presence", { method: "PUT", body: JSON.stringify({ status }) });
}
export async function sendHeartbeat(): Promise<void> {
  await apiFetch("/api/softphone/heartbeat", { method: "POST" });
}

export type StaffUser = { email: string; role: "admin" | "staff" };

// /api/me additionally reports the caller's own availability, which Settings shows and lets
// them change. Availability is a one-day override: the server resets it to available each
// local morning so one sick day cannot drop someone off the ring roster all week.
export type Me = StaffUser & { status: "available" | "away" | "offline"; awayReason: string | null };

export async function login(email: string, password: string): Promise<{ token: string; user: StaffUser }> {
  return apiFetch("/api/login", { method: "POST", body: JSON.stringify({ email, password }) });
}

// Who the stored session token belongs to. Sign-in returns the user inline, but a relaunch only
// restores the token, so this is how we learn the email and role again.
export async function getMe(): Promise<Me> {
  return apiFetch<Me>("/api/me");
}

export async function logout(): Promise<void> {
  try {
    await apiFetch("/api/logout", { method: "POST" });
  } catch { /* logout is best-effort; the local token is cleared regardless by the caller */ }
}

export type LiveCall = {
  id: string;
  caller_number: string;
  called_number: string;
  started_at: number;
  status: string;
};

export async function getLiveCalls(): Promise<LiveCall[]> {
  return apiFetch<LiveCall[]>("/api/calls/live");
}

// ---- Call history / detail ----

export type Call = {
  id: string;
  caller_number: string;
  called_number: string;
  started_at: number;
  ended_at: number | null;
  status: string;
  direction: "inbound" | "outbound";
  recording_sid: string | null;
  recording_url: string | null;
  recording_duration: number | null;
  // What the event timeline says, which `status` cannot: Twilio calls a rang-out voicemail
  // `completed` exactly like an answered conversation. `event_count` is 0 for rows predating the
  // event log, where "nobody answered" is unknown rather than true.
  answered: number;
  event_count: number;
  // Set only when the caller landed in a mailbox and left a message -- this, not the presence of a
  // transcript, is what makes a call a voicemail. A short message transcribes to nothing at all.
  mailbox_label: string | null;
  // Two separate transcripts, never merged: `transcription` is the voicemail one, written when a
  // caller leaves a message; `call_transcript` is the full recording of an answered call. The API
  // returns both (SELECT * over `calls`) and the web app renders each under its own heading.
  transcription: string | null;
  call_transcript: string | null;
  disposition: string | null;
  notes: string | null;
};

export type CallEvent = {
  id: number;
  call_id: string;
  ts: number;
  event_type: string;
  detail: string | null;
};

export async function getCalls(): Promise<Call[]> {
  return apiFetch<Call[]>("/api/calls");
}

export async function getCallDetail(id: string): Promise<{ call: Call; events: CallEvent[] }> {
  return apiFetch<{ call: Call; events: CallEvent[] }>(`/api/calls/${encodeURIComponent(id)}`);
}

// The outcomes the web softphone offers, in the same order. "" means "no outcome set" — the API
// stores an empty string as NULL, so clearing the outcome works by sending "".
export const CALL_DISPOSITIONS = ["", "New booking", "Existing job", "Emergency", "Callback", "Spam", "Other"] as const;
export type CallDisposition = (typeof CALL_DISPOSITIONS)[number];

// Saves the staff-entered outcome + notes for a call. Both fields are always sent together
// because the API writes both columns on every PUT — sending one alone would blank the other.
export async function updateCallMeta(
  id: string,
  input: { disposition: string; notes: string }
): Promise<void> {
  await apiFetch(`/api/calls/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(input) });
}

// Absolute URL of a call's recording, streamed through the authed proxy. The Bearer token must be
// supplied by the caller (audio source headers) — the raw Twilio URL would demand Twilio creds.
export function recordingUri(callId: string): string {
  return `${BASE_URL}/api/calls/${encodeURIComponent(callId)}/recording`;
}

// ---- Callback requests ----

export type CallbackRequest = {
  id: number;
  call_id: string;
  caller_number: string;
  requested_at: number;
  status: "open" | "done";
  done_at: number | null;
  done_by: string | null;
};

// Open requests plus a bounded tail of handled ones -- the Inbox splits them into the work queue
// and the history below it.
export async function getCallbackRequests(): Promise<CallbackRequest[]> {
  return apiFetch<CallbackRequest[]>("/api/callback-requests");
}

// Mark a request handled, or reopen one that was ticked by mistake.
export async function setCallbackRequestStatus(id: number, status: "open" | "done"): Promise<void> {
  await apiFetch(`/api/callback-requests/${id}`, {
    method: "PUT",
    body: JSON.stringify({ status }),
  });
}

// ---- Contacts ----

export type Contact = {
  id: number;
  name: string;
  company: string | null;
  phone: string;
  phone_normalized: string;
  created_at?: number;
  updated_at?: number;
};

export async function getContacts(): Promise<Contact[]> {
  return apiFetch<Contact[]>("/api/contacts");
}

export type ContactInput = { name: string; phone: string; company?: string | null };

export async function createContact(input: ContactInput): Promise<Contact> {
  return apiFetch<Contact>("/api/contacts", { method: "POST", body: JSON.stringify(input) });
}

export async function updateContact(id: number, input: ContactInput): Promise<Contact> {
  return apiFetch<Contact>(`/api/contacts/${id}`, { method: "PUT", body: JSON.stringify(input) });
}

export async function deleteContact(id: number): Promise<void> {
  await apiFetch(`/api/contacts/${id}`, { method: "DELETE" });
}

// ---- Messaging (SMS) ----
// The backend SMS endpoints + Twilio number are wired later; until then these
// resolve to empty so the UI shows honest empty states rather than erroring.

export type Message = {
  id: string;
  direction: "inbound" | "outbound";
  body: string;
  ts: number;
  status?: string;
  error_code?: string | null;
  error_message?: string | null;
};

export type Conversation = {
  number: string;
  name?: string | null;
  last_body: string;
  last_ts: number;
  unread: number;
};

export async function getConversations(): Promise<Conversation[]> {
  try {
    return await apiFetch<Conversation[]>("/api/messages");
  } catch {
    return [];
  }
}

export async function getThread(number: string): Promise<Message[]> {
  try {
    return await apiFetch<Message[]>(`/api/messages/${encodeURIComponent(number)}`);
  } catch {
    return [];
  }
}

// Returns true if sent, false if messaging isn't linked/available yet. `from` optionally picks the
// sending number (validated server-side against SMS-enabled numbers).
export async function sendMessage(to: string, body: string, from?: string): Promise<boolean> {
  try {
    await apiFetch("/api/messages", { method: "POST", body: JSON.stringify({ to, body, from }) });
    return true;
  } catch {
    return false;
  }
}

// ---- Sending numbers (caller-ID / SMS-from picker) ----
export type PhoneNumber = {
  id: number;
  e164: string;
  label: string;
  voice_enabled: number;
  sms_enabled: number;
  is_default_voice: number;
  is_default_sms: number;
  region: string | null;
};

export async function getNumbers(): Promise<PhoneNumber[]> {
  try {
    return await apiFetch<PhoneNumber[]>("/api/numbers");
  } catch {
    return [];
  }
}

// Register this device's Expo push token so the server can notify it of inbound SMS.
//
// It also reports which build this handset is running, because this is the one call every
// signed-in handset makes on launch. `nativeBuild` is the identity of the installed BINARY and is
// the only thing that says whether a native fix is on this phone -- the CallKit patch above all,
// which an OTA can never deliver. Admin > Health Checks reads it, so "is the fix installed?" stops
// being a question someone has to answer by reading their own Settings screen aloud.
export async function registerPushToken(token: string, platform: string): Promise<boolean> {
  try {
    await apiFetch("/api/push/register", {
      method: "POST",
      body: JSON.stringify({
        token,
        platform,
        otaBuild: OTA_BUILD,
        nativeBuild: NATIVE_BUILD,
      }),
    });
    return true;
  } catch {
    return false;
  }
}

// ---- Per-user settings ----
export type UserSettings = {
  notif_incoming: boolean;
  notif_missed: boolean;
  notif_voicemail: boolean;
  notif_sms: boolean;
  notif_callback: boolean;
  ring_my_mobile: boolean;
  // OUTBOUND, and nothing to do with ring_my_mobile above (that is the inbound divert). When on,
  // dialling rings YOUR mobile and bridges the customer once you answer.
  call_via_mobile: boolean;
  mobile_number: string;
};

export async function getUserSettings(): Promise<UserSettings> {
  return apiFetch<UserSettings>("/api/settings/me");
}

export async function updateUserSettings(partial: Partial<UserSettings>): Promise<UserSettings> {
  return apiFetch<UserSettings>("/api/settings/me", { method: "PUT", body: JSON.stringify(partial) });
}

// ---- Business-wide call recording setting (admin-editable, staff read-only) ----
export async function getRecordingSetting(): Promise<boolean> {
  const r = await apiFetch<{ recording_enabled: boolean }>("/api/settings/recording");
  return r.recording_enabled;
}
export async function setRecordingSetting(enabled: boolean): Promise<void> {
  await apiFetch("/api/settings/recording", { method: "PUT", body: JSON.stringify({ recording_enabled: enabled }) });
}

// ---- Caller ID shown when a call is diverted to a staff mobile (admin-editable) ----
// On: the customer's number, so you know who is calling before you answer. Off: the business
// number, which the phone's own contacts resolve to "TCB Phone".
export async function getDivertCallerIdSetting(): Promise<boolean> {
  const r = await apiFetch<{ divert_caller_id: boolean }>("/api/settings/divert-caller-id");
  return r.divert_caller_id;
}
export async function setDivertCallerIdSetting(enabled: boolean): Promise<void> {
  await apiFetch("/api/settings/divert-caller-id", { method: "PUT", body: JSON.stringify({ divert_caller_id: enabled }) });
}

// ---- Call via my mobile ----
// Asks the server to ring this staff member's mobile and bridge the customer on answer. There is no
// VoIP leg and no in-call screen: the native dialler owns the call once the phone rings.
export async function callViaMobile(to: string, from?: string): Promise<{ callSid: string; ringing: string }> {
  return apiFetch("/api/softphone/call-via-mobile", { method: "POST", body: JSON.stringify({ to, from }) });
}

// ---- Admin: business-wide settings ----
// Everything below is admin-only. The server is the real gate (403 for staff on every one of
// these paths); the app hides the Admin section as well so nobody is offered a button that fails.

export const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type DayKey = (typeof DAY_KEYS)[number];
export const DAY_LABELS: Record<DayKey, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

// null = closed that day. Times are "HH:MM" in Canberra local time, matching the web admin page
// and what src/ivr/businessHours.ts reads.
export type DayWindow = { open: string; close: string } | null;
export type BusinessHours = Record<DayKey, DayWindow>;

export const CLOSED_WEEK: BusinessHours = { mon: null, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null };

export async function getBusinessHours(): Promise<BusinessHours> {
  return apiFetch<BusinessHours>("/api/settings/business-hours");
}

// The API replaces the whole schedule, so always send all seven days.
export async function setBusinessHours(schedule: BusinessHours): Promise<void> {
  await apiFetch("/api/settings/business-hours", { method: "PUT", body: JSON.stringify(schedule) });
}

export async function getCallBlocklist(): Promise<string[]> {
  return apiFetch<string[]>("/api/settings/call-blocklist");
}

export async function setCallBlocklist(numbers: string[]): Promise<void> {
  await apiFetch("/api/settings/call-blocklist", { method: "PUT", body: JSON.stringify(numbers) });
}

// ---- Admin: IVR flow ----

// The whole flow goes out in one PUT (the endpoint is a delete-and-reinsert), so a save must carry
// every node back, positions included -- see the note on IvrNode.
export async function getIvrFlow(flow: string): Promise<IvrFlow> {
  return apiFetch<IvrFlow>(`/api/ivr/flows/${encodeURIComponent(flow)}`);
}

// Serialised through toPutPayload, which names every field the server persists. The endpoint is a
// delete-and-reinsert, so a field dropped on the way out is destroyed -- sending `body` straight
// through would carry whatever the type happened to have, and fail silently the day it had less.
export async function putIvrFlow(flow: string, body: IvrFlow): Promise<void> {
  await apiFetch(`/api/ivr/flows/${encodeURIComponent(flow)}`, {
    method: "PUT",
    body: JSON.stringify(toPutPayload(body)),
  });
}

export type IvrAudioAsset = { id: string; label: string };

export async function getIvrAudio(): Promise<IvrAudioAsset[]> {
  return apiFetch<IvrAudioAsset[]>("/api/ivr/audio");
}

// ---- Admin: after-hours on call ----

// One person per week is rung when nobody is on shift. The weeks come back already resolved by the
// server -- overrides applied, rotation advanced -- so this screen never re-implements the rule and
// cannot disagree with what a real call does.
export type OnCallWeek = {
  weekStart: string;
  email: string | null;
  source: "rotation" | "override" | "nobody";
};

export type OnCallState = {
  rotation: { members: string[]; anchorWeekStart: string };
  thisWeek: string;
  weeks: OnCallWeek[];
  unknownMembers: string[];
  staff: string[];
};

export async function getOnCall(): Promise<OnCallState> {
  return apiFetch<OnCallState>("/api/admin/on-call");
}

// The anchor is REQUIRED, not optional. Omitting it makes the server default to the current week
// (src/api/onCall.ts), which silently re-anchors an existing rotation: whoever was on call tonight
// changes mid-week and every future week shifts. Reordering the list on a handset must not be able
// to do that, so the caller passes back the anchor it loaded.
export async function setOnCallRotation(members: string[], anchorWeekStart: string): Promise<void> {
  await apiFetch("/api/admin/on-call", {
    method: "PUT",
    body: JSON.stringify(anchorWeekStart ? { members, anchorWeekStart } : { members }),
  });
}

// `email: null` clears the week back to whatever the rotation says.
export async function setOnCallOverride(weekStart: string, email: string | null): Promise<void> {
  await apiFetch("/api/admin/on-call/override", { method: "PUT", body: JSON.stringify({ weekStart, email }) });
}

// ---- Admin: staff ----

export type AdminStaff = {
  email: string;
  role: "admin" | "staff";
  status: "available" | "away" | "offline";
  awayReason: string | null;
  schedule: BusinessHours;
  // Cascade ring order: lower rings earlier. Each on-shift person contributes exactly one leg,
  // so this ordering is what decides who hears the phone first.
  ringPriority: number;
  lastHeartbeatAt: number | null;
  // False = invited but has never set a password, so they cannot sign in yet.
  hasPassword: boolean;
};

// One request for the whole Admin > Staff surface. /api/staff (the transfer picker's roster)
// deliberately carries none of this.
export async function getAdminStaff(): Promise<AdminStaff[]> {
  return apiFetch<AdminStaff[]>("/api/admin/staff");
}

export async function setStaffSchedule(email: string, schedule: BusinessHours): Promise<void> {
  await apiFetch(`/api/staff/${encodeURIComponent(email)}/schedule`, { method: "PUT", body: JSON.stringify(schedule) });
}

export async function setStaffRingPriority(email: string, priority: number): Promise<void> {
  await apiFetch(`/api/staff/${encodeURIComponent(email)}/priority`, { method: "PUT", body: JSON.stringify({ priority }) });
}

// Admin override of someone else's availability. "away" benches them from the ring cascade until
// the server's local-morning reset, exactly like they had set it themselves.
export async function setStaffAvailability(email: string, status: "available" | "away"): Promise<void> {
  await apiFetch(`/api/staff/${encodeURIComponent(email)}/status`, { method: "PUT", body: JSON.stringify({ status }) });
}

export async function inviteStaff(email: string, role: "admin" | "staff"): Promise<void> {
  await apiFetch("/api/staff", { method: "POST", body: JSON.stringify({ email, role }) });
}

export async function resendStaffInvite(email: string): Promise<void> {
  await apiFetch(`/api/staff/${encodeURIComponent(email)}/invite`, { method: "POST" });
}

export async function sendStaffPasswordReset(email: string): Promise<void> {
  await apiFetch(`/api/staff/${encodeURIComponent(email)}/reset`, { method: "POST" });
}

export async function removeStaff(email: string): Promise<void> {
  await apiFetch(`/api/staff/${encodeURIComponent(email)}`, { method: "DELETE" });
}

// ---- Admin: phone numbers ----
// Adding a row here configures nothing on Twilio's side -- the number must already exist there.
// `region` records the Twilio Inbound Processing Region that handles the number's inbound calls.

export type PhoneNumberInput = {
  e164: string;
  label: string;
  voice_enabled: boolean;
  sms_enabled: boolean;
  is_default_voice: boolean;
  is_default_sms: boolean;
  region: string | null;
};

export async function createNumber(input: PhoneNumberInput): Promise<PhoneNumber> {
  return apiFetch<PhoneNumber>("/api/numbers", { method: "POST", body: JSON.stringify(input) });
}

export async function updateNumber(id: number, input: PhoneNumberInput): Promise<void> {
  await apiFetch(`/api/numbers/${id}`, { method: "PUT", body: JSON.stringify(input) });
}

export async function deleteNumber(id: number): Promise<void> {
  await apiFetch(`/api/numbers/${id}`, { method: "DELETE" });
}

// ---- Admin: health checks ----
// Each of these exists because it went wrong in production and nothing said so. The two "test"
// calls below are end-to-end on purpose: a status row describes a chain, a buzzing phone proves it.

export type CheckStatus = "ok" | "warn" | "fail";
export type Check = { key: string; label: string; status: CheckStatus; detail: string };

export async function getDiagnostics(): Promise<Check[]> {
  return apiFetch<Check[]>("/api/admin/diagnostics");
}

// Sends a push to YOUR devices only, and prunes any Expo reports as dead.
export async function sendTestPush(): Promise<{ sent: number; devices: number; pruned: number }> {
  return apiFetch("/api/admin/test-push", { method: "POST" });
}

export async function sendTestEmail(): Promise<{ ok: boolean; to: string }> {
  return apiFetch("/api/admin/test-email", { method: "POST" });
}

// ---- Deleting call logs and conversations (admin only) ----
// These HIDE rather than destroy: the row survives and the Twilio recording is untouched, so an
// accidental delete is recoverable. The server 403s anyone who isn't an admin.

export async function deleteCall(id: string): Promise<void> {
  await apiFetch(`/api/calls/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function restoreCall(id: string): Promise<void> {
  await apiFetch(`/api/calls/${encodeURIComponent(id)}/restore`, { method: "POST" });
}

// Returns the stamp this delete used, which the undo needs so it restores exactly these messages
// and not an older deletion of the same conversation.
export async function deleteThread(number: string): Promise<{ messages: number; deletedAt: number }> {
  return apiFetch(`/api/messages/${encodeURIComponent(number)}`, { method: "DELETE" });
}

export async function restoreThread(number: string, deletedAt: number): Promise<void> {
  await apiFetch(`/api/messages/${encodeURIComponent(number)}/restore`, {
    method: "POST",
    body: JSON.stringify({ deletedAt }),
  });
}
