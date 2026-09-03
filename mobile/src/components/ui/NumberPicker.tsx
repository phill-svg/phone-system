import React, { useState } from "react";
import { View, Text, Pressable, Modal, ScrollView, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme, type } from "../../theme/theme";
import { Icon } from "./Icon";
import { formatPhone } from "../../lib/phone";
import { haptics } from "../../theme/haptics";

export type PickableNumber = { id: number; e164: string; label: string };

// The sending-number picker used for both caller ID (dialer) and SMS "From" (message thread).
//
// Replaces the chip rows these screens used to have: chips showed the friendly name ONLY, and ran
// out of width once the business had more than two numbers. This shows the name AND the number --
// the number is the part that actually matters to the person on the other end -- and moves the
// choice into a sheet so the row stays one line no matter how many numbers exist.
export function NumberPicker({
  title,
  options,
  value,
  onChange,
}: {
  title: string;
  options: PickableNumber[];
  value: string | undefined;
  onChange: (e164: string) => void;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);

  if (options.length === 0) return null;
  const selected = options.find((n) => n.e164 === value) ?? options[0];
  // With a single number there is nothing to choose, but the row still renders: seeing which
  // number you're calling/texting from is useful on its own, and the old chip row hid it entirely.
  const choosable = options.length > 1;

  return (
    <>
      <Pressable
        accessibilityRole={choosable ? "button" : "text"}
        accessibilityLabel={`${title}: ${selected.label}, ${formatPhone(selected.e164)}`}
        disabled={!choosable}
        onPress={() => {
          haptics.tap();
          setOpen(true);
        }}
        style={({ pressed }) => [
          styles.row,
          { borderBottomColor: t.colors.separator, backgroundColor: pressed && choosable ? t.colors.fillPressed : "transparent" },
        ]}
      >
        <Text style={[type.caption, { color: t.colors.labelSecondary }]}>{title}</Text>
        <View style={styles.rowValue}>
          <Text style={[type.footnote, { color: t.colors.label, fontWeight: "600" }]} numberOfLines={1}>
            {selected.label}
          </Text>
          <Text style={[type.caption, { color: t.colors.labelSecondary }]} numberOfLines={1}>
            {formatPhone(selected.e164)}
          </Text>
        </View>
        {choosable ? <Icon name="chevron.down" fallback="chevron-down" size={14} color={t.colors.labelTertiary} /> : null}
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          {/* Swallow taps on the sheet itself so they don't dismiss it. */}
          <Pressable
            style={[styles.sheet, { backgroundColor: t.colors.bgElevated, paddingBottom: insets.bottom + 12 }]}
            onPress={() => {}}
          >
            <Text style={[type.caption, styles.sheetTitle, { color: t.colors.labelSecondary }]}>{title}</Text>
            <ScrollView bounces={false}>
              {options.map((n) => {
                const active = n.e164 === selected.e164;
                return (
                  <Pressable
                    key={n.id}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    onPress={() => {
                      haptics.tap();
                      onChange(n.e164);
                      setOpen(false);
                    }}
                    style={({ pressed }) => [
                      styles.option,
                      { borderBottomColor: t.colors.separator, backgroundColor: pressed ? t.colors.cardPressed : "transparent" },
                    ]}
                  >
                    <View style={styles.optionText}>
                      <Text style={[type.body, { color: t.colors.label, fontWeight: active ? "700" : "400" }]} numberOfLines={1}>
                        {n.label}
                      </Text>
                      <Text style={[type.footnote, { color: t.colors.labelSecondary }]} numberOfLines={1}>
                        {formatPhone(n.e164)}
                      </Text>
                    </View>
                    {active ? <Icon name="checkmark" fallback="checkmark" size={18} color={t.colors.accent} /> : null}
                  </Pressable>
                );
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowValue: { flex: 1, alignItems: "flex-end", gap: 1 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  sheet: { borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingTop: 14, maxHeight: "70%" },
  sheetTitle: { paddingHorizontal: 20, paddingBottom: 8, textTransform: "uppercase", letterSpacing: 0.6 },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  optionText: { flex: 1, gap: 2 },
});
