import React from "react";
import { View, Text, ScrollView, Pressable, ActivityIndicator, StyleSheet } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { getCallDetail, type CallEvent } from "../../lib/api";
import { RecordingPlayer } from "../../components/recording-player";
import { colors } from "../../lib/theme";

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

  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={styles.back}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title}>Call detail</Text>
        <View style={{ width: 44 }} />
      </View>

      {isLoading ? (
        <ActivityIndicator color={colors.brand} style={{ marginTop: 40 }} />
      ) : isError || !data ? (
        <Text style={styles.muted}>Couldn&apos;t load this call.</Text>
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
          <View style={styles.card}>
            <Field label="Direction" value={data.call.direction === "outbound" ? "Outgoing" : "Incoming"} />
            <Field label="From" value={data.call.caller_number} />
            <Field label="To" value={data.call.called_number} />
            <Field label="Status" value={data.call.status} />
            <Field label="Started" value={fmtWhen(data.call.started_at)} />
            {data.call.disposition ? <Field label="Disposition" value={data.call.disposition} /> : null}
            {data.call.notes ? <Field label="Notes" value={data.call.notes} /> : null}
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

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.bg, padding: 16 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  back: { color: colors.link, fontSize: 15, width: 44 },
  title: { color: colors.text, fontSize: 18, fontWeight: "700" },
  muted: { color: colors.mute, marginTop: 12, textAlign: "center" },
  card: { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 10, padding: 14, marginBottom: 12 },
  cardLabel: { color: colors.dim, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 },
  field: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 },
  fieldLabel: { color: colors.dim, fontSize: 13 },
  fieldValue: { color: colors.text, fontSize: 14, flexShrink: 1, textAlign: "right", marginLeft: 12 },
  transcript: { color: colors.text, fontSize: 14, lineHeight: 20 },
  eventRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 },
  eventTs: { color: colors.dim, fontSize: 12 },
  eventType: { color: colors.text, fontSize: 13, marginLeft: 12 },
});
