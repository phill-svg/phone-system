import { authHeader } from "./conferenceClient";

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
const INTELLIGENCE_BASE = "https://intelligence.twilio.com/v2";

export type IntelligenceEnv = {
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
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
// `participants` only LABELS the channels for Twilio's own viewer -- it does not choose them. Which
// channel is staff is a SETTING (getTranscriptStaffChannel), read at collection time and defaulting
// to 2.
//
// For an INBOUND call that 2 is structural, not a guess: the recording is `record-from-answer-dual`
// on the CALLER's own <Dial> (renderJoinConference), and a <Dial> recording puts channel 1 on the
// parent call -- the customer. Channel 2 is whoever they are speaking to, across a transfer
// included, because the caller's leg never changes.
//
// It stays a setting because an OUTBOUND softphone call is recorded conference-level instead, where
// channel 1 goes to whoever joined first and that genuinely is a race. Those come back mono in
// practice and are discarded unlabelled rather than guessed at.
//
// Do not hardcode this. It was briefly 1 on 2026-09-12, when the recording sat on the STAFF leg's
// <Dial>; /code-review found that placement recorded a transferred call twice and labelled every
// outbound transcript backwards, and both went back.
export async function requestTranscript(
  env: IntelligenceEnv,
  recordingSid: string,
  opts: { staffChannel: 1 | 2; customerNumber?: string | null }
): Promise<string | null> {
  const serviceSid = env.TWILIO_INTELLIGENCE_SERVICE_SID;
  if (!serviceSid) return null;
  const customerChannel = opts.staffChannel === 1 ? 2 : 1;
  const body = new URLSearchParams({
    ServiceSid: serviceSid,
    Channel: JSON.stringify({
      media_properties: { source_sid: recordingSid },
      participants: [
        { channel_participant: opts.staffChannel, role: "Agent" },
        {
          channel_participant: customerChannel,
          role: "Customer",
          ...(opts.customerNumber ? { media_participant_id: opts.customerNumber } : {}),
        },
      ],
    }),
  });
  try {
    const res = await fetch(`${INTELLIGENCE_BASE}/Transcripts`, {
      method: "POST",
      headers: {
        Authorization: authHeader(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    if (!res.ok) {
      console.log("INTELLIGENCE_CREATE_FAILED", JSON.stringify({ recordingSid, status: res.status }));
      return null;
    }
    const json = (await res.json()) as { sid?: string };
    return json.sid ?? null;
  } catch (e) {
    console.log("INTELLIGENCE_CREATE_FAILED", JSON.stringify({ recordingSid, error: e instanceof Error ? e.message : String(e) }));
    return null;
  }
}

export type TranscriptStatus = "queued" | "in-progress" | "completed" | "failed" | "unknown";

export async function fetchTranscriptStatus(env: IntelligenceEnv, transcriptSid: string): Promise<TranscriptStatus> {
  try {
    const res = await fetch(`${INTELLIGENCE_BASE}/Transcripts/${encodeURIComponent(transcriptSid)}`, {
      headers: { Authorization: authHeader(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN) },
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
        headers: { Authorization: authHeader(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN) },
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
