import React, { useRef, useState } from "react";
import { View, Text, TextInput } from "react-native";
import { wholeNumberInput } from "../../lib/draft";
import { useTheme, type } from "../../theme/theme";

// A whole-number field you can actually CLEAR.
//
// The old version was `Number(text.replace(/\D/g, "")) || 0` straight into the draft, so
// backspacing the box snapped it to "0" and it could never be empty. That is not cosmetic:
// `numDigits` is passed to <Gather> verbatim by the flow engine, and `isInputConfig` only checks
// `typeof === "number"` -- so clearing the field intending to retype it, then tapping Save, built
// a live Gather asking for zero digits. The staff ring-priority box had the same fault the other
// way round: `Number("")` saved 0 and moved that person to the front of the ring order.
//
// The box therefore owns its own text and the parent keeps the last valid number. While the text
// is empty nothing is committed, which is exactly "clear it, type the new one". It commits on
// CHANGE, into a draft the parent saves: the enclosing ScrollViews set
// keyboardShouldPersistTaps="handled", so a tap on Save never blurs the field, and a blur-only
// commit never reaches the draft at all.
//
// `min` is 0 or 1 ONLY, and that bound is load-bearing rather than incidental. A higher floor would
// let the committed value diverge from what the box shows -- type "3" into a min-5 field and it
// commits 5 while reading 3 -- and since a tap on Save never blurs the field, nothing reconciles the
// two. That is the same trap recorded for TimeField, and the fix is to make the clamp unreachable
// during ordinary typing: with a floor of 1, every digit string except "0" is already at or above
// it, so Math.max only ever fires on a lone zero -- which is the one value that must not reach a
// live <Gather>. Per-field because zero retries is a legitimate answer and zero digits is not.
//
// `onCommit` must update `value` synchronously (a draft, not a network save): the render-time
// re-seed below treats any `value` that is not what was last pushed as an outside change.
export function NumberField({
  label,
  placeholder,
  min,
  value,
  onCommit,
}: {
  label: string;
  placeholder: string;
  min: number;
  value: number;
  onCommit: (n: number) => void;
}) {
  const t = useTheme();
  const [text, setText] = useState(String(value));
  // Ignore the parent echoing back what we just sent; re-seed only on a genuine outside change
  // (a reload). Same trap as the schedule editor's TimeField: without it a commit rewrites the box
  // mid-word.
  const pushed = useRef(String(value));
  if (String(value) !== pushed.current) {
    pushed.current = String(value);
    setText(String(value));
  }

  return (
    <View style={{ paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 0.5, borderBottomColor: t.colors.separator }}>
      <Text style={[type.footnote, { color: t.colors.labelSecondary }]}>{label}</Text>
      <TextInput
        value={text}
        onChangeText={(v) => {
          const next = wholeNumberInput(v, min);
          setText(next.text);
          if (next.value === null) return;
          pushed.current = String(next.value);
          onCommit(next.value);
        }}
        onBlur={() => setText(pushed.current)}
        placeholder={placeholder}
        placeholderTextColor={t.colors.labelTertiary}
        keyboardType="number-pad"
        style={[type.body, { color: t.colors.label, paddingVertical: 6 }]}
      />
    </View>
  );
}
