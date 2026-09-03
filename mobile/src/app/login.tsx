import React, { useState } from "react";
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useAuth } from "../lib/auth";
import { colors } from "../lib/theme";

// 🎨 COLORS FOR THIS PAGE (Login) — click a swatch to recolor just this screen.
// They start from the shared app theme; change one to override only this page.
const page = {
  ...colors,           // shared app theme (fallback for anything not overridden)
  bg: "#0f1013",       // screen background
  surface: "#1b1d24",  // the sign-in card
  border: "#26282f",   // card + input borders
  text: "#eceef2",     // title + typed text
  dim: "#a7adb8",      // "Sign in" + field labels
  mute: "#6d7280",     // placeholder text
  brand: "#e4002b",    // the Sign in button
};

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
    } catch {
      setError("Invalid email or password.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.card}>
        <View style={styles.logoBadge}>
          <Image source={require("../../assets/images/tabIcons/tcb-logo.png")} style={styles.logo} resizeMode="contain" />
        </View>
        <Text style={styles.brand}>TCB Phone System</Text>
        <Text style={styles.subtitle}>Sign in</Text>
        {error && <Text style={styles.error}>{error}</Text>}
        <Text style={styles.label}>EMAIL</Text>
        <TextInput style={styles.input} autoCapitalize="none" keyboardType="email-address"
          autoComplete="email" value={email} onChangeText={setEmail} placeholder="you@tcbpestcontrolcanberra.com.au" placeholderTextColor={page.mute} />
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
  wrap: { flex: 1, backgroundColor: page.bg, alignItems: "center", justifyContent: "center", padding: 24 },
  card: { width: "100%", maxWidth: 360, backgroundColor: page.surface, borderColor: page.border, borderWidth: 1, borderRadius: 14, padding: 22 },
  logoBadge: { alignSelf: "center", backgroundColor: "#ffffff", borderRadius: 22, padding: 14, marginBottom: 18 },
  logo: { width: 88, height: 88 },
  brand: { color: page.text, fontWeight: "700", fontSize: 16, marginBottom: 14, textAlign: "center" },
  subtitle: { color: page.dim, fontSize: 13, marginBottom: 16, textAlign: "center" },
  error: { color: "#ff9aab", backgroundColor: "rgba(228,0,43,0.14)", borderRadius: 8, padding: 8, marginBottom: 12, fontSize: 13 },
  label: { color: page.dim, fontSize: 11, marginBottom: 5, letterSpacing: 1 },
  input: { backgroundColor: page.bg, borderColor: page.border, borderWidth: 1, borderRadius: 8, color: page.text, padding: 11, marginBottom: 12 },
  button: { backgroundColor: page.brand, borderRadius: 9, padding: 13, alignItems: "center", marginTop: 4 },
  buttonText: { color: "#fff", fontWeight: "600" },
});
