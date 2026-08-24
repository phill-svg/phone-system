import { verifyTwilioSignature } from "./verifySignature";

type WebhookAuthEnv = {
  TWILIO_AUTH_TOKEN: string;
  TWILIO_AUTH_TOKEN_SECONDARY?: string;
  TWILIO_WEBHOOK_SECRET?: string;
  // A transitional SECOND accepted secret, used only during a whsec rotation: set primary=NEW,
  // secondary=OLD so both the freshly-generated URLs and the not-yet-updated Twilio console URLs
  // authenticate. Unset it once every Twilio URL has been repointed to the new secret.
  TWILIO_WEBHOOK_SECRET_SECONDARY?: string;
};

// Appends the shared webhook secret to a URL this app hands to Twilio (voice/status/action/
// callback URLs). Twilio echoes the URL back verbatim when it calls us, so possession of the
// secret proves the request came via a URL only we configured.
export function appendWebhookSecret(url: string, secret: string | undefined): string {
  if (!secret) return url;
  return url + (url.includes("?") ? "&" : "?") + `whsec=${secret}`;
}

// This account's X-Twilio-Signature values have repeatedly failed to match its own (verified
// current, REST-valid) primary Auth Token -- the signing key appears wedged out of sync after
// auth-token rotations. So webhook auth accepts EITHER proof: the shared URL secret (primary,
// fully under our control), or a valid Twilio signature (kept as a secondary acceptor in case
// the account's signing recovers).
export async function authorizeTwilioWebhook(
  request: Request,
  params: Record<string, string>,
  env: WebhookAuthEnv
): Promise<boolean> {
  const provided = new URL(request.url).searchParams.get("whsec");
  if (
    provided &&
    ((env.TWILIO_WEBHOOK_SECRET && provided === env.TWILIO_WEBHOOK_SECRET) ||
      (env.TWILIO_WEBHOOK_SECRET_SECONDARY && provided === env.TWILIO_WEBHOOK_SECRET_SECONDARY))
  ) {
    return true;
  }
  return verifyTwilioSignature(request.url, params, request.headers.get("X-Twilio-Signature") ?? "", [
    env.TWILIO_AUTH_TOKEN,
    env.TWILIO_AUTH_TOKEN_SECONDARY,
  ]);
}
