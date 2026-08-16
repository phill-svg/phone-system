import { parseSessionCookie, parseBearerToken, lookupSession } from "./session";

export type StaffUser = { email: string; role: "admin" | "staff" };

type Env = {
  DB: D1Database;
  AUTH_MODE?: string;
  DEV_STAFF_EMAIL?: string;
};

function unauthenticated(isApi: boolean): Response {
  return isApi
    ? new Response("unauthenticated", { status: 401 })
    : new Response(null, { status: 302, headers: { Location: "/login" } });
}

export async function requireStaffUser(
  request: Request,
  env: Env,
  opts: { isApi: boolean }
): Promise<StaffUser | Response> {
  let email: string;

  if (env.AUTH_MODE === "dev") {
    if (!env.DEV_STAFF_EMAIL) {
      return new Response("dev auth misconfigured: DEV_STAFF_EMAIL not set", { status: 500 });
    }
    email = env.DEV_STAFF_EMAIL.toLowerCase();
  } else {
    const token = parseSessionCookie(request) ?? parseBearerToken(request);
    const sessionEmail = token ? await lookupSession(env.DB, token) : null;
    if (!sessionEmail) return unauthenticated(opts.isApi);
    email = sessionEmail.toLowerCase();
  }

  const row = await env.DB.prepare("SELECT email, role FROM staff_users WHERE email = ?")
    .bind(email)
    .first<{ email: string; role: "admin" | "staff" }>();

  if (!row) return new Response("not provisioned", { status: 403 });

  return { email: row.email, role: row.role };
}
