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

// True only when the account is actually configured for this. Everything below no-ops otherwise, so
// an unset secret leaves the existing Whisper behaviour exactly as it was.
export function intelligenceEnabled(env: IntelligenceEnv): boolean {
  return !!env.TWILIO_INTELLIGENCE_SERVICE_SID;
}

// Ask Twilio to transcribe a recording. Returns the GT... transcript sid, or null on any failure --
// a transcript is a nicety and must never break the recording webhook that calls this.
//
// `participants` declares which channel is whom. For a CONFERENCE recording Twilio puts the FIRST
// participant to join on channel 1 and everyone else mixed on channel 2; our conference is joined by
// the staff leg first (it renders the conference TwiML on answer) and the caller is REST-redirected
// in after, so channel 1 is staff. That ordering is asserted by a test rather than left implicit,
// and `CALL_TRANSCRIPT_CHANNELS_SWAPPED` in settings flips it without a deploy if it ever changes.
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

export async function fetchSentences(env: IntelligenceEnv, transcriptSid: string): Promise<Sentence[]> {
  try {
    const res = await fetch(
      `${INTELLIGENCE_BASE}/Transcripts/${encodeURIComponent(transcriptSid)}/Sentences?PageSize=1000`,
      { headers: { Authorization: authHeader(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN) } }
    );
    if (!res.ok) return [];
    const json = (await res.json()) as { sentences?: Sentence[] };
    return Array.isArray(json.sentences) ? json.sentences : [];
  } catch {
    return [];
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
