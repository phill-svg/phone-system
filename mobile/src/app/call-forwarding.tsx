import React, { useState, useEffect } from "react";
import { ScrollView, View, TextInput } from "react-native";
import { Screen } from "../components/ui/Screen";
import { Group, Row } from "../components/ui/Grouped";
import { useTheme } from "../theme/theme";
import { useUserSettings } from "../lib/userSettings";

export default function CallForwardingScreen() {
  const t = useTheme();
  const { settings, update } = useUserSettings();
  const [number, setNumber] = useState(settings.mobile_number);

  useEffect(() => {
    setNumber(settings.mobile_number);
  }, [settings.mobile_number]);

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <Group title="Ring my mobile"
          footer="When on, incoming business calls ring your mobile as well as the app during your available hours — whoever answers first takes the call.">
          <Row icon="iphone" iconColor="#34C759" label="Ring my mobile"
            toggle={settings.ring_my_mobile} onToggle={(v) => update({ ring_my_mobile: v })} />
        </Group>
        <Group title="Mobile number" footer="Australian mobile, e.g. 0412 345 678.">
          <View style={{ paddingHorizontal: 14, paddingVertical: 10 }}>
            <TextInput
              value={number}
              onChangeText={setNumber}
              onBlur={() => {
                const next = number.trim();
                if (next !== settings.mobile_number) update({ mobile_number: next });
              }}
              placeholder="0412 345 678"
              placeholderTextColor={t.colors.labelTertiary}
              keyboardType="phone-pad"
              style={{ color: t.colors.label, fontSize: 17, paddingVertical: 6 }}
            />
          </View>
        </Group>
      </ScrollView>
    </Screen>
  );
}
