import { getToken, clearToken } from "./session";

const BASE_URL = (process.env.EXPO_PUBLIC_API_BASE_URL ?? "https://tcbvoip.app").replace(/\/$/, "");

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

export async function login(email: string, password: string): Promise<{ token: string; user: StaffUser }> {
  return apiFetch("/api/login", { method: "POST", body: JSON.stringify({ email, password }) });
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
  transcription: string | null;
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
};

export async function getCallbackRequests(): Promise<CallbackRequest[]> {
  return apiFetch<CallbackRequest[]>("/api/callback-requests");
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
export async function registerPushToken(token: string, platform: string): Promise<boolean> {
  try {
    await apiFetch("/api/push/register", { method: "POST", body: JSON.stringify({ token, platform }) });
    return true;
  } catch {
    return false;
  }
}
