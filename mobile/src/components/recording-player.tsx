import React, { useEffect, useState } from "react";
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from "react-native";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { getToken } from "../lib/session";
import { recordingUri } from "../lib/api";
import { colors } from "../lib/theme";

function fmtTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Streams the recording from the authenticated proxy (/api/calls/:id/recording) by attaching the
// session Bearer token to the audio source's HTTP headers — expo-audio supports header-bearing
// remote sources, so no token ever lands in a URL.
function Player({ uri, token }: { uri: string; token: string }) {
  const player = useAudioPlayer({ uri, headers: { Authorization: `Bearer ${token}` } });
  const status = useAudioPlayerStatus(player);

  if (!status.isLoaded) {
    return (
      <View style={styles.rowCenter}>
        <ActivityIndicator color={colors.brand} />
        <Text style={styles.muted}>Loading recording…</Text>
      </View>
    );
  }

  const playing = status.playing;
  return (
    <View style={styles.row}>
      <Pressable
        style={styles.btn}
        onPress={() => {
          if (status.didJustFinish) player.seekTo(0);
          playing ? player.pause() : player.play();
        }}
      >
        <Text style={styles.btnText}>{playing ? "❚❚ Pause" : "▶ Play"}</Text>
      </Pressable>
      <Text style={styles.time}>
        {fmtTime(status.currentTime)} / {fmtTime(status.duration)}
      </Text>
    </View>
  );
}

export function RecordingPlayer({ callId }: { callId: string }) {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    getToken().then((t) => { if (alive) setToken(t); });
    return () => { alive = false; };
  }, []);

  if (token === undefined) return <ActivityIndicator color={colors.brand} />;
  if (!token) return <Text style={styles.muted}>Sign in again to play.</Text>;
  return <Player uri={recordingUri(callId)} token={token} />;
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  rowCenter: { flexDirection: "row", alignItems: "center", gap: 8 },
  btn: { backgroundColor: colors.brand, borderRadius: 9, paddingVertical: 8, paddingHorizontal: 18 },
  btnText: { color: "#fff", fontSize: 14, fontWeight: "700" },
  time: { color: colors.dim, fontSize: 13 },
  muted: { color: colors.mute, fontSize: 13 },
});
