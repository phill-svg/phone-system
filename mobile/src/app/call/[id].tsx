import React from "react";
import { View, Text, ScrollView, ActivityIndicator, Pressable, StyleSheet, TextInput, Platform, KeyboardAvoidingView } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { getCallDetail, updateCallMeta, CALL_DISPOSITIONS, type Call, type CallEvent } from "../../lib/api";
import { RecordingPlayer } from "../../components/recording-player";
import { Icon } from "../../components/ui/Icon";
import { haptics } from "../../theme/haptics";
import { colors } from "../../lib/theme";

// 🎨 COLORS FOR THIS PAGE (Call detail) — click a swatch to recolor just this screen.
// They start from the shared app theme; change one to override only this page.
const page = {
  ...colors,           // shared app theme (fallback for anything not overridden)
  bg: "#0f1013",       // screen background
  surface: "#1b1d24",  // detail cards
  border: "#26282f",   // card borders
  text: "#eceef2",     // values / transcript text
  dim: "#a7adb8",      // labels
  mute: "#6d7280",     // faint "no recording" text
  brand: "#e4002b",    // loading spinner
};

function fmtWhen(ms: number): string {
  return new Date(ms).toLocaleString("en-AU");
}

export default function CallDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["call", id],
    queryFn: () => getCallDetail(String(id)),
    enabled: !!id,
  });

  const peer = data ? (data.call.direction === "outbound" ? data.call.called_number : data.call.caller_number) : "";

  function callBack() {
    haptics.medium();
    router.push({ pathname: "/call-active", params: { number: peer, name: peer } });
  }

  function message() {
    haptics.tap();
    router.push({ pathname: "/thread/[number]", params: { number: peer } });
  }

  return (
    <View style={styles.wrap}>
      {isLoading ? (
        <ActivityIndicator color={page.brand} style={{ marginTop: 40 }} />
      ) : isError || !data ? (
        <Text style={styles.muted}>Couldn&apos;t load this call.</Text>
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
          {peer ? (
            <View style={styles.actionRow}>
              <Pressable onPress={callBack} style={styles.actionBtn}>
                <View style={[styles.actionIcon, { backgroundColor: "#1e3a24" }]}>
                  <Icon name="phone.fill" fallback="call" size={20} color="#34C759" />
                </View>
                <Text style={styles.actionLabel}>Call</Text>
              </Pressable>
              <Pressable onPress={message} style={styles.actionBtn}>
                <View style={[styles.actionIcon, { backgroundColor: "#1e2c3a" }]}>
                  <Icon name="message.fill" fallback="chatbubble" size={20} color="#4FA8FF" />
                </View>
                <Text style={styles.actionLabel}>Message</Text>
              </Pressable>
            </View>
          ) : null}

          <View style={styles.card}>
            <Field label="Direction" value={data.call.direction === "outbound" ? "Outgoing" : "Incoming"} />
            <Field label="From" value={data.call.caller_number} />
            <Field label="To" value={data.call.called_number} />
            <Field label="Status" value={data.call.status} />
            <Field label="Started" value={fmtWhen(data.call.started_at)} />
          </View>

          <View style={styles.card}>
            <Text style={styles.cardLabel}>Recording</Text>
            {data.call.recording_sid ? (
              <RecordingPlayer callId={String(id)} />
            ) : (
              <Text style={styles.muted}>No recording for this call.</Text>
            )}
          </View>

          {data.call.transcription ? (
            <View style={styles.card}>
              <Text style={styles.cardLabel}>Voicemail transcript</Text>
              <Text style={styles.transcript}>{data.call.transcription}</Text>
            </View>
          ) : null}

          {data.call.call_transcript ? (
            <View style={styles.card}>
              <Text style={styles.cardLabel}>Call transcript</Text>
              <Text style={styles.transcript}>{data.call.call_transcript}</Text>
            </View>
          ) : null}

          <OutcomeAndNotes callId={String(id)} call={data.call} />

          <View style={styles.card}>
            <Text style={styles.cardLabel}>Timeline</Text>
            {data.events.length === 0 ? (
              <Text style={styles.muted}>No events.</Text>
            ) : (
              data.events.map((e: CallEvent) => (
                <View key={e.id} style={styles.eventRow}>
                  <Text style={styles.eventTs}>{fmtWhen(e.ts)}</Text>
                  <Text style={styles.eventType}>{e.event_type}</Text>
                </View>
              ))
            )}
          </View>
        </ScrollView>
      )}
    </View>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={styles.fieldValue}>{value}</Text>
    </View>
  );
}

// Staff-entered outcome + notes, matching the web softphone's "Outcome & notes" card. The web
// uses a <select>; there's no such control on native, so the outcomes are pills that toggle —
// tapping the selected one clears it back to "no outcome set", which is the web's blank option.
function OutcomeAndNotes({ callId, call }: { callId: string; call: Call }) {
  const qc = useQueryClient();
  const [disposition, setDisposition] = React.useState(call.disposition ?? "");
  const [notes, setNotes] = React.useState(call.notes ?? "");
  const [saving, setSaving] = React.useState(false);
  const [status, setStatus] = React.useState<string | null>(null);

  // The query can refetch (focus, invalidate) while this card is mounted. Re-seed from the server
  // only when the user has nothing in flight, so a background refetch can't wipe what they typed.
  const saved = React.useRef({ disposition: call.disposition ?? "", notes: call.notes ?? "" });
  React.useEffect(() => {
    const next = { disposition: call.disposition ?? "", notes: call.notes ?? "" };
    const dirty = disposition !== saved.current.disposition || notes !== saved.current.notes;
    if (dirty) return;
    saved.current = next;
    setDisposition(next.disposition);
    setNotes(next.notes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call.disposition, call.notes]);

  const dirty = disposition !== saved.current.disposition || notes !== saved.current.notes;

  async function save() {
    haptics.tap();
    setSaving(true);
    setStatus("Saving…");
    try {
      await updateCallMeta(callId, { disposition, notes });
      saved.current = { disposition, notes };
      setStatus("Saved.");
      // Refresh the detail view and the recents list, which both show this metadata.
      qc.invalidateQueries({ queryKey: ["call", callId] });
      qc.invalidateQueries({ queryKey: ["calls"] });
      haptics.success();
    } catch {
      setStatus("Couldn't save. Try again.");
      haptics.error();
    } finally {
      setSaving(false);
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={styles.card}>
        <Text style={styles.cardLabel}>Outcome &amp; notes</Text>

        <View style={styles.pillRow}>
          {CALL_DISPOSITIONS.filter(Boolean).map((opt) => {
            const active = disposition === opt;
            return (
              <Pressable
                key={opt}
                onPress={() => {
                  haptics.tap();
                  setDisposition(active ? "" : opt);
                  setStatus(null);
                }}
                style={[styles.pill, active && styles.pillActive]}
              >
                <Text style={[styles.pillText, active && styles.pillTextActive]}>{opt}</Text>
              </Pressable>
            );
          })}
        </View>
        {!disposition ? <Text style={styles.noOutcome}>No outcome set</Text> : null}

        <TextInput
          value={notes}
          onChangeText={(v) => {
            setNotes(v);
            setStatus(null);
          }}
          placeholder="Notes about this call…"
          placeholderTextColor={page.mute}
          multiline
          // Same Samsung One UI fix as the message composer: on Android the keyboard's composing
          // text renders white on multiline fields, making typing look invisible until you hit
          // space. "visible-password" forces a no-composing keyboard so every character commits.
          keyboardType={Platform.OS === "android" ? "visible-password" : "default"}
          autoCorrect={false}
          autoComplete="off"
          spellCheck={false}
          style={styles.notesInput}
        />

        <View style={styles.saveRow}>
          <Pressable
            onPress={save}
            disabled={saving || !dirty}
            style={[styles.saveBtn, (saving || !dirty) && styles.saveBtnDisabled]}
          >
            <Text style={styles.saveBtnText}>{saving ? "Saving…" : "Save"}</Text>
          </Pressable>
          {status ? <Text style={styles.saveStatus}>{status}</Text> : null}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: page.bg, padding: 16 },
  muted: { color: page.mute, marginTop: 12, textAlign: "center" },
  actionRow: { flexDirection: "row", justifyContent: "center", gap: 32, marginBottom: 16 },
  actionBtn: { alignItems: "center", gap: 6 },
  actionIcon: { width: 52, height: 52, borderRadius: 26, alignItems: "center", justifyContent: "center" },
  actionLabel: { color: page.text, fontSize: 12, fontWeight: "600" },
  card: { backgroundColor: page.surface, borderColor: page.border, borderWidth: 1, borderRadius: 10, padding: 14, marginBottom: 12 },
  cardLabel: { color: page.dim, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 },
  field: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 },
  fieldLabel: { color: page.dim, fontSize: 13 },
  fieldValue: { color: page.text, fontSize: 14, flexShrink: 1, textAlign: "right", marginLeft: 12 },
  transcript: { color: page.text, fontSize: 14, lineHeight: 20 },
  pillRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  pill: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 16, borderWidth: 1, borderColor: page.border, backgroundColor: page.bg },
  pillActive: { backgroundColor: page.brand, borderColor: page.brand },
  pillText: { color: page.dim, fontSize: 13, fontWeight: "500" },
  pillTextActive: { color: "#FFFFFF" },
  noOutcome: { color: page.mute, fontSize: 12, marginTop: 8 },
  notesInput: {
    color: page.text, fontSize: 14, lineHeight: 20, marginTop: 12, minHeight: 90,
    borderWidth: 1, borderColor: page.border, borderRadius: 8, backgroundColor: page.bg,
    padding: 10, textAlignVertical: "top",
  },
  saveRow: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 12 },
  saveBtn: { backgroundColor: page.brand, paddingHorizontal: 20, paddingVertical: 9, borderRadius: 8 },
  saveBtnDisabled: { opacity: 0.45 },
  saveBtnText: { color: "#FFFFFF", fontSize: 14, fontWeight: "600" },
  saveStatus: { color: page.dim, fontSize: 12, flexShrink: 1 },
  eventRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 },
  eventTs: { color: page.dim, fontSize: 12 },
  eventType: { color: page.text, fontSize: 13, marginLeft: 12 },
});
