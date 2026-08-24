import { authHeader } from "./twilio/conferenceClient";

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

type TranscribeEnv = {
  DB: D1Database;
  AI: { run: (model: string, input: Record<string, unknown>) => Promise<{ text?: string; transcription_info?: { text?: string } }> };
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
};

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
    const buf = await res.arrayBuffer();
    // Workers AI Whisper takes the audio as base64.
    const bytes = new Uint8Array(buf);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
    }
    const base64 = btoa(binary);

    const result = await env.AI.run("@cf/openai/whisper-large-v3-turbo", {
      audio: base64,
      // Whisper invents text on silence/noise ("Merci.", "Q2. Q2. Q2…"). These curb it:
      language: "en", // AU English — stops it defaulting to French/other hallucination tokens
      vad_filter: true, // skip silent segments entirely (the big one for empty voicemails)
      condition_on_previous_text: false, // break the repetition loops ("Q2. Q2. Q2…")
    });
    let text = (result?.text ?? result?.transcription_info?.text ?? "").trim();
    // Belt-and-braces: drop obvious hallucinations (a single short token repeated, or a bare
    // "thanks/merci"-style artefact on a silent clip) so we store nothing rather than nonsense.
    if (isLikelyHallucination(text)) text = "";
    if (!text) return;

    await env.DB.prepare("UPDATE calls SET " + column + " = ? WHERE id = ?").bind(text, callSid).run();
  } catch (e) {
    console.log("TRANSCRIBE_FAILED", callSid, e instanceof Error ? e.message : String(e));
  }
}
