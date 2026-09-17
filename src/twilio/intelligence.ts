import { globalAuthHeader } from "./conferenceClient";

// Twilio Conversational Intelligence: a transcript that says WHO SAID WHAT.
//
// Whisper (src/transcribe.ts) returns one undifferentiated block of text, because it has no speaker
// diarization and because a Conference recording is mixed to a single mono track by default. Both
// halves of a sales call therefore ran together in `call_transcript` with no way to tell the caller
// from whoever answered.
//
// Twilio splits it by AUDIO CHANNEL rather than by voice, which is why this only works properly with
// "Dual-channel Recording for Conference" turned on in the Console (Voice > Settings). Without it
// every sentence comes back on channel 1 and the labelling is meaningless -- so the caller checks
// for that and leaves the Whisper transcript alone rather than writing a confidently mislabelled one.
//
// Deliberately NOT on the au1 host in restClient.ts: Intelligence is a global service on its own
// domain, and pointing it at api.sydney.au1.twilio.com 404s.
//
// Being off the au1 host also means TWILIO_AUTH_TOKEN (the AU1 token) is not a credential here
// either -- it 401s, the same way it 401s against notify.twilio.com and api.twilio.com/Messages.
// Every request below goes through globalAuthHeader, which prefers TWILIO_US1_API_KEY_SID/SECRET.
// This bug predates #106 -- it just had no marker before then, so the same 401 read as the row
// silently staying unmarked (Health Checks: "no answered call has been transcribed yet") instead
// of the `request_failed` status #106 introduced. Every inbound transcript since this feature
// shipped used the AU1 token here and was refused, every single time.
const INTELLIGENCE_BASE = "https://intelligence.twilio.com/v2";

export type IntelligenceEnv = {
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_US1_API_KEY_SID?: string;
  TWILIO_US1_API_KEY_SECRET?: string;
  TWILIO_INTELLIGENCE_SERVICE_SID?: string;
};

export type Sentence = { media_channel: number; transcript: string; sentence_index: number };

// Whether a recording-status callback describes a DUAL-channel recording, which is the only kind
// worth transcribing here -- a mono one comes back entirely on channel 1 and gets discarded, having
// been billed per minute anyway.
//
// Both spellings are accepted deliberately: Twilio documents `RecordingChannels` as mono/dual when
// CREATING a recording and as 1/2 on the status callback, and gating a paid feature on guessing
// which one arrives is not a bet worth taking.
export function isDualChannelRecording(recordingChannels: string | undefined | null): boolean {
  const v = (recordingChannels ?? "").trim().toLowerCase();
  return v === "2" || v === "dual";
}

// True only when the account is actually configured for this. Everything below no-ops otherwise, so
// an unset secret leaves the existing Whisper behaviour exactly as it was.
export function intelligenceEnabled(env: IntelligenceEnv): boolean {
  return !!env.TWILIO_INTELLIGENCE_SERVICE_SID;
}

// Ask Twilio to transcribe a recording. Returns the GT... transcript sid, or null on any failure --
// a transcript is a nicety and must never break the recording webhook that calls this.
//
// NO `participants` array is sent, and that is deliberate. It only ever LABELLED the channels for
// Twilio's own viewer -- the stored transcript is labelled by formatLabelledTranscript from
// `transcript_staff_channel`, read at COLLECTION time (intelligenceQueue), so nothing here reads
// Twilio's roles back. It is also the field that broke this feature: a `media_participant_id` on a
// participant is refused outright for a transcript created from a recording sid --
//   400: The media_participant_id can only be set for transcript with media url
// -- which is a whole-request rejection, so every inbound call from the day this shipped came back
// `request_failed` with no transcript at all. Twilio documents that field, and the participant
// overrides around it, only with `media_url`; we always send `source_sid`. Sending nothing we do
// not read removes the rejection and cannot resurrect it.
// A create failure that a caller can persist alongside `intelligence_status = 'request_failed'`.
// Kept as one short line (truncated) rather than the raw response, because this rides in a TEXT
// column read back on a Health Checks screen, not a log viewer.
export type TranscriptRequestResult = { sid: string | null; error: string | null };

const MAX_ERROR_LEN = 300;

export async function requestTranscript(
  env: IntelligenceEnv,
  recordingSid: string
): Promise<TranscriptRequestResult> {
  const serviceSid = env.TWILIO_INTELLIGENCE_SERVICE_SID;
  if (!serviceSid) return { sid: null, error: null };
  const body = new URLSearchParams({
    ServiceSid: serviceSid,
    Channel: JSON.stringify({ media_properties: { source_sid: recordingSid } }),
  });
  try {
    const res = await fetch(`${INTELLIGENCE_BASE}/Transcripts`, {
      method: "POST",
      headers: {
        Authorization: globalAuthHeader(env),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    if (!res.ok) {
      // us1:false means the AU1 token went out and got refused -- the exact bug this file's top
      // comment documents. Carrying it here is what makes that diagnosable from a log line rather
      // than requiring a re-read of the source to notice the fallback fired.
      const us1 = !!(env.TWILIO_US1_API_KEY_SID && env.TWILIO_US1_API_KEY_SECRET);
      // Twilio's error body (a 401/403/404 all say WHY in JSON) is the difference between "check
      // the logs" and knowing immediately what's wrong -- #115 fixed the AU1-vs-US1 host mismatch,
      // but real calls right after that deploy still came back request_failed with nothing saying
      // what Twilio actually answered THIS time. Best-effort: a body read that itself fails must
      // never turn a reportable failure into an unhandled one.
      const responseBody = await res.text().catch(() => "");
      console.log("INTELLIGENCE_CREATE_FAILED", JSON.stringify({ recordingSid, status: res.status, us1, body: responseBody }));
      const detail = `${res.status}${us1 ? " (US1 key)" : " (AU1 token -- no US1 key set)"}: ${responseBody || "(no body)"}`;
      return { sid: null, error: detail.slice(0, MAX_ERROR_LEN) };
    }
    const json = (await res.json()) as { sid?: string };
    return { sid: json.sid ?? null, error: null };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.log("INTELLIGENCE_CREATE_FAILED", JSON.stringify({ recordingSid, error: message }));
    return { sid: null, error: message.slice(0, MAX_ERROR_LEN) };
  }
}

export type TranscriptStatus = "queued" | "in-progress" | "completed" | "failed" | "unknown";

export async function fetchTranscriptStatus(env: IntelligenceEnv, transcriptSid: string): Promise<TranscriptStatus> {
  try {
    const res = await fetch(`${INTELLIGENCE_BASE}/Transcripts/${encodeURIComponent(transcriptSid)}`, {
      headers: { Authorization: globalAuthHeader(env) },
    });
    if (!res.ok) return res.status === 404 ? "failed" : "unknown";
    const json = (await res.json()) as { status?: string };
    const s = (json.status ?? "").toLowerCase();
    if (s === "completed" || s === "failed" || s === "queued" || s === "in-progress") return s;
    return "unknown";
  } catch {
    return "unknown";
  }
}

// Every sentence, following pagination.
//
// 1000 is Twilio's maximum page size, not a guarantee of completeness: a long site consultation runs
// past it, and stopping at one page would store a transcript that ends mid-conversation -- no error,
// marked completed, overwriting a COMPLETE Whisper transcript. Truncated-but-labelled is strictly
// worse than whole-but-unlabelled, so the pages are followed and any doubt returns null instead
// (see fetchSentences below -- null is "could not read", NOT "read and found nothing").
const MAX_SENTENCE_PAGES = 20;

// A next-page URL, but only if it is still Twilio's Intelligence host. Anything else -- another
// origin, a downgrade to http, an unparseable string -- ends the walk rather than being followed
// with the account token in the Authorization header.
function sameOrigin(next: string | null | undefined): string | null {
  if (!next) return null;
  try {
    return new URL(next).origin === new URL(INTELLIGENCE_BASE).origin ? next : null;
  } catch {
    return null;
  }
}

// Returns NULL for "could not read the transcript", and an array for a read that succeeded --
// including the legitimately empty one.
//
// The distinction is the whole point. These used to collapse into `[]`, and the sweep turns an empty
// result into the TERMINAL status `single_channel`: the row leaves the pending query, so a transcript
// Twilio actually holds is abandoned for good, and Admin > Health Checks counts it as mono and tells
// you to switch on a Console setting that was never off. A transient 502 must be retried, not
// diagnosed as a recording problem.
export async function fetchSentences(env: IntelligenceEnv, transcriptSid: string): Promise<Sentence[] | null> {
  const out: Sentence[] = [];
  let url: string | null =
    `${INTELLIGENCE_BASE}/Transcripts/${encodeURIComponent(transcriptSid)}/Sentences?PageSize=1000`;
  try {
    for (let page = 0; url && page < MAX_SENTENCE_PAGES; page++) {
      const res: Response = await fetch(url, {
        headers: { Authorization: globalAuthHeader(env) },
      });
      if (!res.ok) {
        console.log("INTELLIGENCE_SENTENCES_FAILED", JSON.stringify({ transcriptSid, status: res.status }));
        return null;
      }
      const json = (await res.json()) as { sentences?: Sentence[]; meta?: { next_page_url?: string | null } };
      if (Array.isArray(json.sentences)) out.push(...json.sentences);
      // The next page is a URL the SERVER hands us, and we re-send the account token with it. Only
      // Twilio can set it today, over a TLS-verified connection -- but "follow a URL from a response
      // body, with credentials attached" is the shape of a credential-leak bug, and the check that
      // it stays on Twilio's own origin costs nothing.
      url = sameOrigin(json.meta?.next_page_url);
    }
    if (url) {
      // More pages than the cap allows: we cannot claim to have the whole call, and a partial
      // transcript stored as complete is worse than none.
      console.log("INTELLIGENCE_TOO_MANY_PAGES", JSON.stringify({ transcriptSid }));
      return null;
    }
    return out;
  } catch (err) {
    console.log(
      "INTELLIGENCE_SENTENCES_FAILED",
      JSON.stringify({ transcriptSid, error: err instanceof Error ? err.message : String(err) })
    );
    return null;
  }
}

// Sentences -> the text stored in `call_transcript`, e.g.
//
//   Customer: Would that be Phil?
//   Staff: Yes, how are you?
//
// Consecutive sentences from the same speaker are joined into one turn, because one line per
// sentence turns a two-minute call into forty labelled fragments and is harder to read than the
// unlabelled blob it replaced.
//
// Returns "" when every sentence is on one channel: that means the recording was NOT dual-channel,
// and labelling it would be a guess presented as fact. The caller keeps the Whisper transcript.
export function formatLabelledTranscript(sentences: Sentence[], staffChannel: 1 | 2): string {
  const usable = sentences
    .filter((s) => typeof s.transcript === "string" && s.transcript.trim() !== "")
    .sort((a, b) => (a.sentence_index ?? 0) - (b.sentence_index ?? 0));
  if (usable.length === 0) return "";
  if (new Set(usable.map((s) => s.media_channel)).size < 2) return "";

  const turns: { who: string; text: string }[] = [];
  for (const s of usable) {
    const who = s.media_channel === staffChannel ? "Staff" : "Customer";
    const last = turns[turns.length - 1];
    if (last && last.who === who) last.text += " " + s.transcript.trim();
    else turns.push({ who, text: s.transcript.trim() });
  }
  return turns.map((t) => `${t.who}: ${t.text}`).join("\n\n");
}
