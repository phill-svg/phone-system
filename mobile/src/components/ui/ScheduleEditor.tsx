import React, { useEffect, useState } from "react";
import { View, Text, Switch, TextInput, StyleSheet } from "react-native";
import { DAY_KEYS, DAY_LABELS, type BusinessHours, type DayKey } from "../../lib/api";
import { DEFAULT_WINDOW, normalizeTime, withDay } from "../../lib/schedule";
import { useTheme, type } from "../../theme/theme";

// The seven-day open/close editor shared by Business Hours and a staff member's working hours --
// the same shape on the server, so the same control both places.
//
// Times are free text rather than a native picker: a picker would mean a new native module, and
// this app is pinned to Expo SDK 54 so Phill can keep running it in Expo Go. Text is normalized on
// blur ("930" -> "09:30") and reverts if it isn't a time, because the API rejects the whole
// schedule when one field is malformed.
export function ScheduleEditor({
  value,
  onChange,
  disabled,
}: {
  value: BusinessHours;
  onChange: (next: BusinessHours) => void;
  disabled?: boolean;
}) {
  return (
    <View>
      {DAY_KEYS.map((day, i) => (
        <DayRow key={day} day={day} value={value} onChange={onChange} disabled={disabled} first={i === 0} />
      ))}
    </View>
  );
}

function DayRow({
  day,
  value,
  onChange,
  disabled,
  first,
}: {
  day: DayKey;
  value: BusinessHours;
  onChange: (next: BusinessHours) => void;
  disabled?: boolean;
  first: boolean;
}) {
  const t = useTheme();
  const window = value[day];
  const open = window !== null;

  return (
    <View style={[styles.row, !first && { borderTopWidth: t.hairline, borderTopColor: t.colors.separator }]}>
      <View style={styles.header}>
        <Text style={[type.body, { color: t.colors.label, flex: 1 }]}>{DAY_LABELS[day]}</Text>
        {!open ? <Text style={[type.footnote, { color: t.colors.labelTertiary }]}>Closed</Text> : null}
        <Switch
          value={open}
          disabled={disabled}
          onValueChange={(next) => onChange(withDay(value, day, next ? (window ?? DEFAULT_WINDOW) : null))}
          trackColor={{ true: t.colors.accent }}
        />
      </View>
      {open ? (
        <View style={styles.times}>
          <TimeField
            value={window.open}
            disabled={disabled}
            onCommit={(time) => onChange(withDay(value, day, { ...window, open: time }))}
          />
          <Text style={[type.body, { color: t.colors.labelTertiary }]}>to</Text>
          <TimeField
            value={window.close}
            disabled={disabled}
            onCommit={(time) => onChange(withDay(value, day, { ...window, close: time }))}
          />
        </View>
      ) : null}
    </View>
  );
}

function TimeField({
  value,
  onCommit,
  disabled,
}: {
  value: string;
  onCommit: (time: string) => void;
  disabled?: boolean;
}) {
  const t = useTheme();
  const [text, setText] = useState(value);
  // Re-seed when the parent changes underneath us (a reload, or the day being switched back on).
  useEffect(() => setText(value), [value]);

  return (
    <TextInput
      value={text}
      onChangeText={setText}
      editable={!disabled}
      onBlur={() => {
        const time = normalizeTime(text);
        // Not a time: put the last good value back rather than sending something the API rejects.
        if (!time) {
          setText(value);
          return;
        }
        setText(time);
        if (time !== value) onCommit(time);
      }}
      keyboardType="numbers-and-punctuation"
      placeholder="09:00"
      placeholderTextColor={t.colors.labelTertiary}
      style={[
        styles.timeInput,
        { color: t.colors.label, backgroundColor: t.colors.fill, opacity: disabled ? 0.5 : 1 },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  row: { paddingHorizontal: 14, paddingVertical: 10 },
  header: { flexDirection: "row", alignItems: "center", gap: 10 },
  times: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 8 },
  timeInput: { flex: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, fontSize: 17, textAlign: "center" },
});
