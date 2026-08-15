type Env = { SENDGRID_API_KEY?: string; AUTH_FROM_EMAIL?: string };

export async function sendEmail(env: Env, msg: { to: string; subject: string; html: string }): Promise<void> {
  if (!env.SENDGRID_API_KEY || !env.AUTH_FROM_EMAIL) {
    throw new Error("email not configured: SENDGRID_API_KEY / AUTH_FROM_EMAIL missing");
  }
  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.SENDGRID_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: msg.to }] }],
      from: { email: env.AUTH_FROM_EMAIL, name: "TCB VoIP" },
      subject: msg.subject,
      content: [{ type: "text/html", value: msg.html }],
    }),
  });
  if (!res.ok) throw new Error(`sendgrid ${res.status}: ${await res.text()}`);
}

function wrap(heading: string, intro: string, link: string, cta: string): string {
  return `<div style="font-family:system-ui,sans-serif;background:#0f1013;color:#eceef2;padding:28px;">
    <div style="max-width:420px;margin:0 auto;background:#1b1d24;border:1px solid #26282f;border-radius:12px;padding:24px;">
      <div style="font-weight:700;margin-bottom:14px;">TCB VoIP</div>
      <h2 style="font-size:16px;margin:0 0 8px;">${heading}</h2>
      <p style="color:#a7adb8;font-size:13px;line-height:1.5;margin:0 0 18px;">${intro}</p>
      <a href="${link}" style="display:inline-block;background:#e4002b;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600;font-size:13px;">${cta}</a>
      <p style="color:#6d7280;font-size:11px;margin-top:18px;">If the button doesn't work, paste this link into your browser:<br>${link}</p>
    </div>
  </div>`;
}

export function inviteEmail(link: string): { subject: string; html: string } {
  return {
    subject: "You've been added to TCB VoIP — set your password",
    html: wrap("Set your password", "You've been added to the TCB VoIP dashboard. Choose a password to sign in. This link expires in 7 days.", link, "Set password"),
  };
}

export function resetEmail(link: string): { subject: string; html: string } {
  return {
    subject: "Reset your TCB VoIP password",
    html: wrap("Reset your password", "We received a request to reset your TCB VoIP password. This link expires in 1 hour. If you didn't ask for this, you can ignore this email.", link, "Reset password"),
  };
}
