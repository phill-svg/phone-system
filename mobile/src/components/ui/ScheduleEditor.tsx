import React, { useEffect, useRef, useState } from "react";
import { View, Text, Switch, TextInput, StyleSheet } from "react-native";
import { DAY_KEYS, DAY_LABELS, type BusinessHours, type DayKey } from "../../lib/api";
import { DEFAULT_WINDOW, isCompleteTime, normalizeTime, withDay } from "../../lib/schedule";
import { useTheme, type } from "../../theme/theme";

// The seven-day open/close editor shared by Business Hours and a staff member's working hours --
// the same shape on the server, so the same control both places.
//
// Times are free text rather than a native picker: a picker would mean a new native module, and
// this app is pinned to Expo SDK 54 so Phill can keep running it in Expo Go. Text is normalized on
// blur ("930" -> "09:30", "10pm" -> "22:00") and reverts if it isn't a time, because the API
// rejects the whole schedule when one field is malformed.
//
// **A complete time also commits ON CHANGE, and that is load-bearing.** Committing only on blur
// made the screen look broken: the parent's Save button is disabled unless the draft differs from
// what was loaded, and the enclosing ScrollView sets `keyboardShouldPersistTaps="handled"`, so a
// tap on Save is delivered straight to the button WITHOUT blurring the field. Type a new closing
// time, tap Save, and nothing happens at all -- the button still reads "Saved" because the draft
// never changed. Reported as "it won't let me change business hours from 10pm".
//
// **Committing on change means the value LOOPS BACK, so the re-seed has to know its own echo.**
// The field is controlled and re-seeds from `value`, which was harmless while nothing committed
// mid-word. It is not harmless now: type "17:30" and the field commits at "17:3" (a perfectly good
// 17:03), the parent hands 17:03 straight back, the re-seed rewrites the box to "17:03", the last
// keystroke makes "17:030" and blur -- finding that is not a time -- reverts to 17:03. The hours
// are then silently wrong. `pushed` records what this field last sent up so the echo of its own
// commit is ignored and only a value from SOMEWHERE ELSE (a reload, the day switched back on)
// re-seeds the text.
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
  // The last value this field sent up. See the note above: without it the field rewrites itself
  // mid-word with the echo of its own commit.
  const pushed = useRef(value);

  // Re-seed when the parent changes underneath us (a reload, or the day being switched back on) --
  // but never when the parent is just handing our own commit back.
  useEffect(() => {
    if (value === pushed.current) return;
    pushed.current = value;
    setText(value);
  }, [value]);

  const commit = (time: string) => {
    pushed.current = time;
    onCommit(time);
  };

  return (
    <TextInput
      value={text}
      onChangeText={(next) => {
        setText(next);
        // Only once no further digit could still be coming. "103" parses as 01:03 but is on the
        // way to "1030", so committing it would store 01:03 for someone typing 10:30.
        if (isCompleteTime(next)) {
          const time = normalizeTime(next);
          if (time && time !== value) commit(time);
        }
      }}
      editable={!disabled}
      onBlur={() => {
        const time = normalizeTime(text);
        // Not a time: put the last good value back rather than sending something the API rejects.
        if (!time) {
          setText(value);
          return;
        }
        setText(time);
        if (time !== value) commit(time);
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
