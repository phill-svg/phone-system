import React, { useEffect, useState } from "react";
import { ScrollView, View, Text, TextInput, Pressable, ActivityIndicator, Alert } from "react-native";
import { Screen } from "../../components/ui/Screen";
import { Group } from "../../components/ui/Grouped";
import { PrimaryButton } from "../../components/ui/PrimaryButton";
import { Icon } from "../../components/ui/Icon";
import { getCallBlocklist, setCallBlocklist } from "../../lib/api";
import { blocklistNumber, blocklistState } from "../../lib/phone";
import { useTheme, type } from "../../theme/theme";

// Numbers the IVR drops before they ever ring anyone. Stored as a plain list and matched against
// the caller ID Twilio reports, so entries are kept in the same E.164 form Twilio sends.
export default function BlocklistScreen() {
  const t = useTheme();
  const [saved, setSaved] = useState<string[] | null>(null);
  const [numbers, setNumbers] = useState<string[]>([]);
  const [entry, setEntry] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getCallBlocklist()
      .then((list) => {
        setSaved(list);
        setNumbers(list);
      })
      .catch(() => setError("Couldn't load the blocklist."));
  }, []);

  // What Save would write: the list, PLUS whatever is still sitting in the entry box.
  //
  // Typing a number and tapping Save without first tapping + used to discard it silently -- and
  // because `dirty` ignored the box too, the button sat disabled reading "Saved" while the caller
  // the admin had just typed was not blocked at all. The enclosing ScrollView sets
  // keyboardShouldPersistTaps="handled", so tapping Save never blurs the field either. Same defect
  // as the schedule editor's TimeField, which committed only on blur.
  const { pending, dirty } = blocklistState(saved, numbers, entry);

  function add() {
    const raw = entry.trim();
    if (!raw) return;
    // The SAME rule Save applies, and a mirror of the one the SERVER enforces. Without it the two
    // paths disagreed about identical text: + committed "02 6105 977" as "+6126105977" while Save
    // quietly refused it, and that disagreement is what produced the original bug.
    const number = blocklistNumber(raw);
    if (!number) {
      Alert.alert(
        "That number looks incomplete",
        "Enter a full Australian number, or an international one starting with +."
      );
      return;
    }
    if (numbers.includes(number)) {
      Alert.alert("Already blocked", `${number} is already on the list.`);
      setEntry("");
      return;
    }
    setNumbers([...numbers, number]);
    setEntry("");
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      await setCallBlocklist(pending);
      setSaved(pending);
      // Adopt it, so the list on screen matches what was saved rather than leaving the number
      // in the box looking unsaved.
      setNumbers(pending);
      setEntry("");
    } catch (e) {
      Alert.alert("Couldn't save", e instanceof Error ? e.message : "Try again in a moment.");
    } finally {
      setSaving(false);
    }
  }

  if (error) {
    return (
      <Screen>
        <Text style={[type.body, { color: t.colors.labelSecondary, padding: 16 }]}>{error}</Text>
      </Screen>
    );
  }
  if (saved === null) {
    return (
      <Screen>
        <ActivityIndicator color={t.colors.accent} style={{ marginTop: 32 }} />
      </Screen>
    );
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        <Group title="Add a number" footer="Australian numbers are converted to +61 form. Blocked callers are hung up on before anyone's phone rings.">
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 10 }}>
            <TextInput
              value={entry}
              onChangeText={setEntry}
              onSubmitEditing={add}
              placeholder="0400 123 456"
              placeholderTextColor={t.colors.labelTertiary}
              keyboardType="phone-pad"
              returnKeyType="done"
              style={{ flex: 1, color: t.colors.label, fontSize: 17, paddingVertical: 6 }}
            />
            <Pressable onPress={add} hitSlop={8} accessibilityRole="button" accessibilityLabel="Add number">
              <Icon name="plus.circle.fill" fallback="add-circle" size={26} color={t.colors.accent} />
            </Pressable>
          </View>
        </Group>

        <Group title={`Blocked (${numbers.length})`}>
          {numbers.length === 0 ? (
            <View style={{ paddingHorizontal: 14, paddingVertical: 14 }}>
              <Text style={[type.body, { color: t.colors.labelTertiary }]}>No numbers are blocked.</Text>
            </View>
          ) : (
            numbers.map((n) => (
              <View key={n} style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12 }}>
                <Text style={[type.body, { color: t.colors.label, flex: 1 }]}>{n}</Text>
                <Pressable
                  onPress={() => setNumbers(numbers.filter((x) => x !== n))}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={`Unblock ${n}`}
                >
                  <Icon name="minus.circle.fill" fallback="remove-circle" size={22} color={t.colors.danger} />
                </Pressable>
              </View>
            ))
          )}
        </Group>

        <View style={{ paddingHorizontal: 16, marginTop: 20 }}>
          <PrimaryButton
            label={saving ? "Saving…" : dirty ? "Save Blocklist" : "Saved"}
            onPress={save}
            disabled={!dirty}
            busy={saving}
          />
        </View>
      </ScrollView>
    </Screen>
  );
}
