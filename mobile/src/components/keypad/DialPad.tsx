import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { useTheme } from "../../theme/theme";
import { haptics } from "../../theme/haptics";

const KEYS: { digit: string; letters?: string }[] = [
  { digit: "1" },
  { digit: "2", letters: "ABC" },
  { digit: "3", letters: "DEF" },
  { digit: "4", letters: "GHI" },
  { digit: "5", letters: "JKL" },
  { digit: "6", letters: "MNO" },
  { digit: "7", letters: "PQRS" },
  { digit: "8", letters: "TUV" },
  { digit: "9", letters: "WXYZ" },
  { digit: "*" },
  { digit: "0", letters: "+" },
  { digit: "#" },
];

function Key({ digit, letters, onPress, onLongPress }: { digit: string; letters?: string; onPress: () => void; onLongPress?: () => void }) {
  const t = useTheme();
  return (
    <Pressable
      onPress={() => {
        haptics.press();
        onPress();
      }}
      onLongPress={onLongPress}
      style={({ pressed }) => [
        styles.key,
        { backgroundColor: pressed ? t.colors.fillPressed : t.colors.fill },
      ]}
      android_disableSound
    >
      <Text style={[styles.digit, { color: t.colors.keypadDigit }]}>{digit}</Text>
      {letters ? <Text style={[styles.letters, { color: t.colors.labelTertiary }]}>{letters}</Text> : <View style={styles.lettersSpacer} />}
    </Pressable>
  );
}

// Shared 3×4 dial pad. `onKey` receives the character ("0"–"9", "*", "#"); a long
// press on 0 emits "+" for international dialling.
export function DialPad({ onKey }: { onKey: (char: string) => void }) {
  return (
    <View style={styles.grid}>
      {KEYS.map((k) => (
        <Key
          key={k.digit}
          digit={k.digit}
          letters={k.letters}
          onPress={() => onKey(k.digit)}
          onLongPress={k.digit === "0" ? () => onKey("+") : undefined}
        />
      ))}
    </View>
  );
}

const KEY = 74;
const styles = StyleSheet.create({
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    rowGap: 14,
    maxWidth: 320,
    alignSelf: "center",
    width: "100%",
  },
  key: {
    width: KEY,
    height: KEY,
    borderRadius: KEY / 2,
    alignItems: "center",
    justifyContent: "center",
  },
  digit: { fontSize: 32, fontWeight: "400", lineHeight: 38 },
  letters: { fontSize: 10.5, fontWeight: "600", letterSpacing: 1.5, marginTop: -2 },
  lettersSpacer: { height: 12 },
});
