// Self-hosted ringback tone. Twilio's SDK-CDN copy (sdk.twilio.com/.../outgoing.mp3) started
// returning HTTP 403 to Twilio's OWN media servers when fetched server-side as a Conference waitUrl
// / hold <Play>, producing error 11200 → "an application error has occurred" the moment a caller
// sat alone (ringing out / on hold). We serve an identical copy from our own /media route, which
// Twilio fetches reliably. Do NOT revert to an sdk.twilio.com URL. Both the conference ringback and
// the queue-hold ringback import this single constant.
export const RINGBACK_URL = "https://tcbvoip.app/media/system/ringback.mp3";
