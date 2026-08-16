import React, { useState } from "react";
import { View, Text, TextInput, Pressable, ActivityIndicator, StyleSheet } from "react-native";
import { useAuth } from "../lib/auth";
import { colors } from "../lib/theme";

export default function LoginScreen() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit() {
    setError(null);
    setBusy(true);
    try {
      await signIn(email.trim().toLowerCase(), password);
    } catch (e) {
      setError("Invalid email or password.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.card}>
        <Text style={styles.brand}>TCB VoIP</Text>
        <Text style={styles.subtitle}>Sign in</Text>
        {error && <Text style={styles.error}>{error}</Text>}
        <Text style={styles.label}>EMAIL</Text>
        <TextInput style={styles.input} autoCapitalize="none" keyboardType="email-address"
          autoComplete="email" value={email} onChangeText={setEmail} placeholder="you@tcb…" placeholderTextColor={colors.mute} />
        <Text style={styles.label}>PASSWORD</Text>
        <TextInput style={styles.input} secureTextEntry autoComplete="password"
          value={password} onChangeText={setPassword} />
        <Pressable style={styles.button} onPress={onSubmit} disabled={busy}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Sign in</Text>}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center", padding: 24 },
  card: { width: "100%", maxWidth: 360, backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 14, padding: 22 },
  brand: { color: colors.text, fontWeight: "700", fontSize: 16, marginBottom: 14 },
  subtitle: { color: colors.dim, fontSize: 13, marginBottom: 16 },
  error: { color: "#ff9aab", backgroundColor: "rgba(228,0,43,0.14)", borderRadius: 8, padding: 8, marginBottom: 12, fontSize: 13 },
  label: { color: colors.dim, fontSize: 11, marginBottom: 5, letterSpacing: 1 },
  input: { backgroundColor: colors.bg, borderColor: colors.border, borderWidth: 1, borderRadius: 8, color: colors.text, padding: 11, marginBottom: 12 },
  button: { backgroundColor: colors.brand, borderRadius: 9, padding: 13, alignItems: "center", marginTop: 4 },
  buttonText: { color: "#fff", fontWeight: "600" },
});
