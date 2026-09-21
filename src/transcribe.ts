import { authHeader } from "./twilio/conferenceClient";
import { MAX_SPLIT_BYTES, splitStereoWav } from "./audio/wav";
import { buildLabelledTurns, formatLabelledTurns, type ChannelResult } from "./labelledTranscript";

// Full-call transcription via Cloudflare Workers AI (Whisper). Runs off the recording-status
// webhook in ctx.waitUntil, so it never blocks the webhook ack and a failure is non-fatal (the
// call still has its recording; only the text is missing). Whisper-large-v3-turbo handles the
// multi-minute recordings a real call produces; the base whisper model truncates long audio.

// Whisper on silence tends to emit either a short token repeated ("Q2. Q2. Q2…") or a lone stock
// artefact. We drop the repeated-token case, punctuation-only output, and a few artefacts that are
// never a real standalone voicemail ("you", "so", "merci", YouTube-style outros). We deliberately do
// NOT drop plausible short real messages like "Thanks." / "Bye." — dropping a genuine transcript is
// worse than occasionally storing a stray hallucinated word (vad_filter already suppresses most
// silence). A cleaner long-term signal is Whisper's own no_speech_prob, not this wordlist.
function isLikelyHallucination(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  const tokens = t.replace(/[.,!?]/g, " ").split(/\s+/).filter(Boolean);
  if (tokens.length >= 4 && new Set(tokens.map((w) => w.toLowerCase())).size <= 2) return true;
  const stripped = t.toLowerCase().replace(/[.!?]/g, "").trim();
  if (!stripped) return true; // punctuation-only (".", "...")
  const junk = new Set(["you", "so", "merci", "thanks for watching", "please subscribe"]);
  return junk.has(stripped);
}

type WhisperResult = {
  text?: string;
  transcription_info?: { text?: string };
  // Present on `@cf/openai/whisper-large-v3-turbo` today. Optional and unvalidated here on purpose:
  // the labelling degrades to one block per speaker if it ever stops arriving (see
  // `buildLabelledTurns`), rather than losing the transcript.
  segments?: { start?: unknown; text?: unknown }[];
};

type TranscribeEnv = {
  DB: D1Database;
  AI: { run: (model: string, input: Record<string, unknown>) => Promise<WhisperResult> };
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
};

const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";

// Workers AI takes the audio as base64.
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

async function runWhisper(env: TranscribeEnv, audio: Uint8Array): Promise<WhisperResult> {
  return env.AI.run(WHISPER_MODEL, {
    audio: toBase64(audio),
    // Whisper invents text on silence/noise ("Merci.", "Q2. Q2. Q2..."). These curb it:
    language: "en", // AU English -- stops it defaulting to French/other hallucination tokens
    vad_filter: true, // skip silent segments entirely (the big one for empty voicemails)
    condition_on_previous_text: false, // break the repetition loops ("Q2. Q2. Q2...")
  });
}

function cleanText(result: WhisperResult): string {
  const text = (result?.text ?? result?.transcription_info?.text ?? "").trim();
  return isLikelyHallucination(text) ? "" : text;
}

// The two-channel media file for a recording. Twilio serves it at `.wav?RequestedChannels=2`, and
// answers 400 for a recording that has only one channel -- which is a normal outcome here (a
// voicemail <Record>, an older recording), not an error worth reporting.
function dualChannelUrl(recordingUrl: string): string {
  const base = recordingUrl.replace(/\.(mp3|wav)$/, "");
  return base + ".wav?RequestedChannels=2";
}

// A transcript that says WHO SAID WHAT, without Twilio's Conversational Intelligence -- which
// cannot be used on this account at all, because it is unsupported in AU1 and our landline is au1
// (see `src/audio/wav.ts`). Each channel of the recording is transcribed separately and the two are
// merged back into one conversation.
//
// The OUTCOME is returned, not just the text, because "could not label this" has causes that must
// not be treated alike:
//
//   labelled   the text is here.
//   retry      a transient failure -- the media host answered 5xx, or the fetch threw. Twilio still
//              holds the recording, so this must be tried again. Collapsing it into a terminal
//              marker is precisely the bug the deleted `fetchSentences` existed to avoid: one 502
//              and that call is unlabelled for good.
//   unusable   nothing here can be labelled: a 4xx for the two-channel file, audio that will not
//              parse, or nobody speaking. Terminal, and reported.
//
// A recording refused on SIZE returns `unusable` too, but is not marked: it is working as designed,
// and a marker that is always set is one you learn to ignore. The log line is the record.
export type LabelOutcome = { kind: "labelled"; text: string } | { kind: "retry" } | { kind: "unusable" };

export async function transcribeChannels(
  env: TranscribeEnv,
  callSid: string,
  recordingUrl: string,
  staffChannel: 1 | 2
): Promise<{ outcome: LabelOutcome; mark: boolean }> {
  const auth = authHeader(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
  let bytes: Uint8Array;
  try {
    const res = await fetch(dualChannelUrl(recordingUrl), { headers: { Authorization: auth } });
    if (!res.ok) {
      console.log("TRANSCRIBE_DUAL_FETCH_FAILED", JSON.stringify({ callSid, status: res.status }));
      // 4xx is Twilio saying this recording has no second channel -- asking again cannot change
      // that. 5xx and 429 are the host, and will answer differently on the next tick.
      // 4xx is Twilio saying this recording has no second channel. Not a fault -- a mono
      // recording, an older one -- so it is logged and left unmarked, like the size refusal.
      const retry = res.status >= 500 || res.status === 429;
      return { outcome: retry ? { kind: "retry" } : { kind: "unusable" }, mark: retry };
    }
    // BEFORE buffering: the size cap exists to protect a 128 MB isolate, and reading the body first
    // is the allocation it is meant to prevent. A 40-minute call is ~77 MB on the wire, and the
    // split peaks at roughly three times the audio.
    const declared = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_SPLIT_BYTES) {
      console.log("TRANSCRIBE_DUAL_TOO_LONG", JSON.stringify({ callSid, bytes: declared }));
      return { outcome: { kind: "unusable" }, mark: false };
    }
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    console.log("TRANSCRIBE_DUAL_FETCH_FAILED", JSON.stringify({ callSid, error: e instanceof Error ? e.message : String(e) }));
    return { outcome: { kind: "retry" }, mark: true };
  }
  // A host that sent no `content-length` still has to be caught, and this is free.
  if (bytes.length > MAX_SPLIT_BYTES) {
    console.log("TRANSCRIBE_DUAL_TOO_LONG", JSON.stringify({ callSid, bytes: bytes.length }));
    return { outcome: { kind: "unusable" }, mark: false };
  }
  const split = splitStereoWav(bytes);
  if (!split) {
    console.log("TRANSCRIBE_DUAL_UNSPLITTABLE", JSON.stringify({ callSid, bytes: bytes.length }));
    return { outcome: { kind: "unusable" }, mark: true };
  }

  // Serially, not Promise.all: two Workers AI inferences at once on a multi-minute call is twice
  // the peak memory for no wall-clock gain worth having inside a webhook's waitUntil.
  const first = await runWhisper(env, split.left);
  const second = await runWhisper(env, split.right);

  // Channel 1 is the leg that ran the <Dial>. That is the customer on every flow except
  // call-via-mobile, where the staff member's own mobile ran it -- which is what
  // `calls.transcript_staff_channel` records, written by the leg that chose the recording.
  const staff: WhisperResult = staffChannel === 1 ? first : second;
  const customer: WhisperResult = staffChannel === 1 ? second : first;
  // The hallucination filter has to reach the SEGMENTS, not just the joined text. Whisper invents
  // words on a silent channel ("Thanks for watching", "Q2. Q2. Q2."), and the merge reads segments
  // when both channels have timings -- so filtering only `text` would put an invented sentence in
  // the transcript under a named speaker, which is worse than no label at all.
  const asChannel = (r: WhisperResult): ChannelResult => {
    const text = cleanText(r);
    return { text, segments: text ? r.segments : undefined };
  };
  const text = formatLabelledTurns(buildLabelledTurns(asChannel(customer), asChannel(staff)));
  if (!text) {
    // Nobody spoke. Indistinguishable from a fault only if you mark it as one -- and an alarm that
    // fires on a short real call is an alarm people learn to ignore.
    console.log("TRANSCRIBE_DUAL_EMPTY", JSON.stringify({ callSid }));
    return { outcome: { kind: "unusable" }, mark: false };
  }
  return { outcome: { kind: "labelled", text }, mark: true };
}

// Twilio RecordingUrl (regional, e.g. api.sydney.au1.twilio.com/.../Recordings/RE...) → fetch the
// mp3 with the account's Basic auth, transcribe, store against the call. `column` picks where the
// text lands: "call_transcript" for answered calls, "transcription" for voicemail (so it keeps the
// "Voicemail transcript" label). It's a fixed internal enum, never user input — safe to inline.
export async function transcribeCallRecording(
  env: TranscribeEnv,
  callSid: string,
  recordingUrl: string,
  column: "call_transcript" | "transcription" = "call_transcript"
): Promise<void> {
  try {
    const mp3Url = recordingUrl.endsWith(".mp3") ? recordingUrl : recordingUrl + ".mp3";
    const auth = authHeader(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
    const res = await fetch(mp3Url, { headers: { Authorization: auth } });
    if (!res.ok) {
      console.log("TRANSCRIBE_FETCH_FAILED", callSid, res.status);
      return;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    // Belt-and-braces: drop obvious hallucinations (a single short token repeated, or a bare
    // "thanks/merci"-style artefact on a silent clip) so we store nothing rather than nonsense.
    const text = cleanText(await runWhisper(env, bytes));
    if (!text) return;

    // Never overwrite a speaker-labelled transcript with this unlabelled one.
    //
    // Both writers run in the same cron tick: backfillTranscripts can SELECT a row whose transcript
    // is still NULL, spend 10-30s fetching audio and running Workers AI, and land here AFTER the
    // Twilio sweep has written the labelled text -- destroying it permanently, since the row is by
    // then out of that sweep's query. The guard is on the write rather than the read because the
    // gap between them is exactly where the race lives.
    const guard = column === "call_transcript" ? " AND COALESCE(intelligence_status, '') <> 'completed'" : "";
    await env.DB.prepare("UPDATE calls SET " + column + " = ? WHERE id = ?" + guard).bind(text, callSid).run();
  } catch (e) {
    console.log("TRANSCRIBE_FAILED", callSid, e instanceof Error ? e.message : String(e));
  }
}

// The ONE entry point the recording-status webhook uses, and the reason there is only one: Whisper
// runs at most once per recording. Two writers racing over `call_transcript` in the same tick is
// exactly how a labelled transcript used to be destroyed by an unlabelled one landing late.
//
// Labelled first when the audio has two channels; the plain single-pass transcript is the fallback,
// and covers voicemail, mono recordings, audio that will not split, and a call where the labelling
// produced nothing.
export async function transcribeRecording(
  env: TranscribeEnv,
  callSid: string,
  recordingUrl: string,
  opts: { column: "call_transcript" | "transcription"; dualChannel: boolean; staffChannel: 1 | 2 }
): Promise<void> {
  if (opts.dualChannel && opts.column === "call_transcript") {
    let result: { outcome: LabelOutcome; mark: boolean };
    try {
      result = await transcribeChannels(env, callSid, recordingUrl, opts.staffChannel);
    } catch (e) {
      // Never at the cost of the transcript itself. Retryable, because an exception here says
      // nothing about the recording.
      console.log("TRANSCRIBE_DUAL_FAILED", JSON.stringify({ callSid, error: e instanceof Error ? e.message : String(e) }));
      result = { outcome: { kind: "retry" }, mark: true };
    }
    if (result.outcome.kind === "labelled") {
      await writeLabelled(env, callSid, result.outcome.text);
      return;
    }
    // `label_retry` is NOT terminal: the cron picks it up (see backfillLabels). `mark: false` is
    // the working-as-designed set -- a mono recording, one refused on size, a call where nobody
    // spoke -- which is logged and left alone, because a marker that is always set is one you learn
    // to ignore.
    if (result.mark) {
      await env.DB.prepare(
        "UPDATE calls SET intelligence_status = ? WHERE id = ? AND COALESCE(intelligence_status, '') IN ('', 'label_retry')"
      )
        .bind(result.outcome.kind === "retry" ? "label_retry" : "unlabelled", callSid)
        .run()
        .catch(() => {});
    }
  }
  await transcribeCallRecording(env, callSid, recordingUrl, opts.column);
}

// Guarded on the status, so a redelivered callback does not re-fetch the media and run two more
// inferences to write the same text again.
async function writeLabelled(env: TranscribeEnv, callSid: string, text: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE calls SET call_transcript = ?, intelligence_status = 'completed' WHERE id = ? AND COALESCE(intelligence_status, '') <> 'completed'"
  )
    .bind(text, callSid)
    .run();
  console.log("TRANSCRIBE_LABELLED", JSON.stringify({ callSid }));
}

// Calls whose LABELLING failed for a reason that may not fail again -- the media host 5xx'd, or the
// fetch threw. They already have a plain transcript, which is what makes them invisible to
// `backfillTranscripts` (it only looks at rows with no transcript at all), so without this sweep one
// transient failure would cost the labels permanently. That is the same defect the deleted Twilio
// sweep was built to avoid, and it would have come straight back.
//
// `intelligence_polls` is the attempt counter (the column is free now that nothing polls Twilio),
// and it is counted BEFORE the work: not every failure is transient, and an uncounted retry would
// re-fetch the same recording every five minutes forever.
export const MAX_LABEL_ATTEMPTS = 3;

type LabelRetryRow = { id: string; recording_url: string; transcript_staff_channel: number | null; intelligence_polls: number | null };

export async function backfillLabels(env: TranscribeEnv, limit = 2): Promise<number> {
  const rows = (
    await env.DB.prepare(
      `SELECT id, recording_url, transcript_staff_channel, intelligence_polls
         FROM calls
        WHERE intelligence_status = 'label_retry'
          AND recording_url IS NOT NULL AND recording_url <> ''
          AND deleted_at IS NULL
          AND COALESCE(intelligence_polls, 0) < ?
        ORDER BY started_at DESC
        LIMIT ?`
    )
      .bind(MAX_LABEL_ATTEMPTS, limit)
      .all<LabelRetryRow>()
  ).results;
  if (rows.length === 0) return 0;

  for (const row of rows) {
    const attempt = (row.intelligence_polls ?? 0) + 1;
    await env.DB.prepare("UPDATE calls SET intelligence_polls = ? WHERE id = ?").bind(attempt, row.id).run();
    const staffChannel = row.transcript_staff_channel === 1 ? 1 : 2;
    const result = await transcribeChannels(env, row.id, row.recording_url, staffChannel).catch(() => ({
      outcome: { kind: "retry" } as LabelOutcome,
      mark: true,
    }));
    if (result.outcome.kind === "labelled") {
      await writeLabelled(env, row.id, result.outcome.text);
      continue;
    }
    // The LAST attempt has to be terminal. Leaving the row on `label_retry` once it falls out of
    // this query drops it out of every counter Health Checks has -- the screen would report a call
    // that will never be labelled as "waiting on another attempt", indefinitely. A media-host
    // outage longer than fifteen minutes is exactly how that happens: limit 2, three attempts, one
    // tick every five minutes.
    const givingUp = result.outcome.kind !== "retry" || attempt >= MAX_LABEL_ATTEMPTS;
    if (givingUp && result.mark) {
      await env.DB.prepare("UPDATE calls SET intelligence_status = 'unlabelled' WHERE id = ?").bind(row.id).run();
    } else if (givingUp) {
      await env.DB.prepare("UPDATE calls SET intelligence_status = NULL WHERE id = ?").bind(row.id).run();
    }
  }
  return rows.length;
}

// A recording only gets transcribed if the recording-status webhook fires while the Whisper code
// is live. Recordings made before it shipped, or whose webhook was lost, have nothing that ever
// retries them -- they sit with a playable recording and a blank transcript forever. This sweep
// (run from the cron) picks those up.
//
// Voicemail (`mailbox_label` set) lands in `transcription` so it keeps the "Voicemail transcript"
// label; everything else lands in `call_transcript`, matching the webhook's own choice of column.
export const MAX_TRANSCRIBE_ATTEMPTS = 3;

type BackfillRow = { id: string; recording_url: string; is_voicemail: number; transcript_staff_channel: number | null };

export async function backfillTranscripts(env: TranscribeEnv, limit = 3): Promise<number> {
  const rows = (
    await env.DB.prepare(
      `SELECT id, recording_url, transcript_staff_channel,
              (mailbox_label IS NOT NULL AND mailbox_label <> '') AS is_voicemail
         FROM calls
        WHERE recording_url IS NOT NULL AND recording_url <> ''
          AND deleted_at IS NULL
          AND transcribe_attempts < ?
          AND CASE WHEN mailbox_label IS NOT NULL AND mailbox_label <> ''
                   THEN transcription IS NULL OR transcription = ''
                   ELSE call_transcript IS NULL OR call_transcript = ''
              END
        ORDER BY started_at DESC
        LIMIT ?`
    )
      .bind(MAX_TRANSCRIBE_ATTEMPTS, limit)
      .all<BackfillRow>()
  ).results;
  if (rows.length === 0) return 0;

  // Count the attempt BEFORE transcribing. A silent recording transcribes to "" and writes no
  // transcript, so without this the same rows would be re-fetched and re-transcribed every tick.
  // It also caps the damage from a recording that always fails (deleted at Twilio, bad audio).
  await env.DB.batch(
    rows.map((r) =>
      env.DB.prepare("UPDATE calls SET transcribe_attempts = transcribe_attempts + 1 WHERE id = ?").bind(r.id)
    )
  );

  // Serial, not Promise.all: each row is a Twilio fetch plus a Workers AI inference, and the
  // sweep shares the cron invocation's budget with reconcileStaleCalls. `limit` keeps it small.
  for (const row of rows) {
    // Through the SAME entry point the webhook uses, so a recording whose status callback was lost
    // is still labelled. Calling `transcribeCallRecording` directly here left those calls with a
    // permanently unlabelled transcript AND no status at all, which is invisible to Health Checks
    // -- the reassuring silence this all exists to break. A mono recording answers 4xx for its
    // two-channel file and falls through to the plain transcript, unmarked.
    await transcribeRecording(env, row.id, row.recording_url, {
      column: row.is_voicemail ? "transcription" : "call_transcript",
      dualChannel: !row.is_voicemail,
      staffChannel: row.transcript_staff_channel === 1 ? 1 : 2,
    });
  }
  return rows.length;
}
