import { getToken, clearToken } from "./session";

const BASE_URL = (process.env.EXPO_PUBLIC_API_BASE_URL ?? "https://phone.tcbpestcontrolcanberra.com.au").replace(/\/$/, "");

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
