import React, { useEffect, useState } from "react";
import { ScrollView, View, Text, ActivityIndicator, Alert } from "react-native";
import { Screen } from "../../components/ui/Screen";
import { Group } from "../../components/ui/Grouped";
import { PrimaryButton } from "../../components/ui/PrimaryButton";
import { ScheduleEditor } from "../../components/ui/ScheduleEditor";
import { getBusinessHours, setBusinessHours, CLOSED_WEEK, type BusinessHours } from "../../lib/api";
import { isSameSchedule, normalizeSchedule } from "../../lib/schedule";
import { useTheme, type } from "../../theme/theme";

// When the business is open. The IVR reads this to decide whether a caller is routed to the team
// or straight to the after-hours message, so it is saved explicitly rather than per-keystroke.
export default function BusinessHoursScreen() {
  const t = useTheme();
  const [saved, setSaved] = useState<BusinessHours | null>(null);
  const [draft, setDraft] = useState<BusinessHours>(CLOSED_WEEK);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getBusinessHours()
      .then((s) => {
        const normalized = normalizeSchedule(s);
        setSaved(normalized);
        setDraft(normalized);
      })
      .catch(() => setError("Couldn't load business hours."));
  }, []);

  const dirty = saved !== null && !isSameSchedule(saved, draft);

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      await setBusinessHours(draft);
      setSaved(draft);
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
        <Group
          title="Opening hours"
          footer="Callers who ring outside these hours get the after-hours message instead of ringing the team. Times are 24-hour, Canberra time."
        >
          <ScheduleEditor value={draft} onChange={setDraft} disabled={saving} />
        </Group>

        <View style={{ paddingHorizontal: 16, marginTop: 20 }}>
          <PrimaryButton
            label={saving ? "Saving…" : dirty ? "Save Business Hours" : "Saved"}
            onPress={save}
            disabled={!dirty}
            busy={saving}
          />
        </View>
      </ScrollView>
    </Screen>
  );
}
