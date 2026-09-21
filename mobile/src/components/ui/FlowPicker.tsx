import React, { useState } from "react";
import { View, Text, Pressable } from "react-native";
import { Icon } from "./Icon";
import { useTheme, type } from "../../theme/theme";
import type { IvrFlowSummary } from "../../lib/api";

// Picks the phone menu a number routes into. A disclosure row that expands into the list, matching
// the "go to" picker in the IVR step editor rather than inventing a second shape for the same job.
//
// Three rules, each of which would be a silent misroute if dropped:
//
// 1. `null` is "Default", NOT the literal flow name. A number that was never given a route of its
//    own follows whatever the shared default is; storing "main" would pin it.
// 2. A menu with NO starting step cannot take a call -- it throws in the flow engine, and the
//    server refuses to point a number at one. Those are shown greyed with the reason rather than
//    hidden, because "my menu isn't in the list" is a worse puzzle than being told why.
// 3. A value ALREADY stored on this number is always offered, even if that menu has since been
//    deleted. Dropping it would make the row read "Default" for a number that is not on the
//    default, and saving would then quietly repoint it.
export function FlowPicker({
  label,
  value,
  defaultName,
  flows,
  onChange,
}: {
  label: string;
  value: string | null;
  defaultName: string;
  flows: IvrFlowSummary[];
  onChange: (flow: string | null) => void;
}) {
  const t = useTheme();
  const [open, setOpen] = useState(false);

  const known = flows.some((f) => f.flow === value);
  const options: IvrFlowSummary[] = [...flows];
  if (value && !known) options.push({ flow: value, nodeCount: 0, hasEntry: false });

  const summary = value ? (known ? value : `${value} (missing)`) : `Default (${defaultName})`;

  return (
    <View style={{ borderBottomWidth: 0.5, borderBottomColor: t.colors.separator }}>
      <Pressable
        onPress={() => setOpen((o) => !o)}
        style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14, paddingVertical: 12 }}
      >
        <Text style={[type.body, { color: t.colors.label }]}>{label}</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1 }}>
          <Text style={[type.body, { color: t.colors.labelSecondary }]} numberOfLines={1}>
            {summary}
          </Text>
          <Icon name={open ? "chevron.up" : "chevron.down"} fallback={open ? "chevron-up" : "chevron-down"} size={12} color={t.colors.labelTertiary} />
        </View>
      </Pressable>
      {open ? (
        <View style={{ backgroundColor: t.colors.bg }}>
          <Pressable
            onPress={() => {
              onChange(null);
              setOpen(false);
            }}
            style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 24, paddingVertical: 10 }}
          >
            {value === null ? <Icon name="checkmark" fallback="checkmark" size={14} color={t.colors.accent} /> : null}
            <Text style={[type.body, { color: t.colors.label, marginLeft: value === null ? 8 : 22 }]}>
              Default ({defaultName})
            </Text>
          </Pressable>
          {options.map((f) => {
            const selected = f.flow === value;
            // Only an unusable menu that is NOT already stored here is refused: the stored one has
            // to stay selectable or the row could never be left as it is.
            const disabled = !f.hasEntry && !selected;
            return (
              <Pressable
                key={f.flow}
                disabled={disabled}
                onPress={() => {
                  onChange(f.flow);
                  setOpen(false);
                }}
                style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 24, paddingVertical: 10, opacity: disabled ? 0.4 : 1 }}
              >
                {selected ? <Icon name="checkmark" fallback="checkmark" size={14} color={t.colors.accent} /> : null}
                <Text style={[type.body, { color: t.colors.label, marginLeft: selected ? 8 : 22 }]}>
                  {f.hasEntry ? f.flow : `${f.flow} — no starting step`}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}
