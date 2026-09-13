import React, { useState, useEffect, useRef, useCallback } from "react";
import { ScrollView, View, TextInput } from "react-native";
import { useFocusEffect } from "expo-router";
import { Screen } from "../components/ui/Screen";
import { Group, Row } from "../components/ui/Grouped";
import { useTheme } from "../theme/theme";
import { useUserSettings } from "../lib/userSettings";

export default function CallForwardingScreen() {
  const t = useTheme();
  const { settings, update } = useUserSettings();
  const [number, setNumber] = useState(settings.mobile_number);

  // Refs, so the commit below sees the latest typing from a cleanup, and so a blur followed at once
  // by the cleanup cannot save the same value twice before a re-render catches up.
  const numberRef = useRef(number);
  const savedRef = useRef(settings.mobile_number);
  const updateRef = useRef(update);
  updateRef.current = update;

  useEffect(() => {
    setNumber(settings.mobile_number);
    numberRef.current = settings.mobile_number;
    savedRef.current = settings.mobile_number;
  }, [settings.mobile_number]);

  const commit = useCallback(() => {
    const next = numberRef.current.trim();
    if (next === savedRef.current) return;
    savedRef.current = next;
    updateRef.current({ mobile_number: next });
  }, []);

  // onBlur alone lost the number: leaving by the header back button while the field is focused
  // unmounts it, and onBlur never runs. The focus-effect cleanup runs on leaving and on unmount.
  useFocusEffect(useCallback(() => commit, [commit]));

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <Group title="Ring my mobile"
          footer="When on, incoming business calls go to your mobile during your available hours and this app will NOT ring. Turn it off to take calls in the app again.">
          <Row icon="iphone" iconColor="#34C759" label="Ring my mobile"
            toggle={settings.ring_my_mobile} onToggle={(v) => update({ ring_my_mobile: v })} />
        </Group>
        <Group title="Mobile number"
          footer="Australian mobile, e.g. 0412 345 678. If this isn't a valid mobile number, calls fall back to ringing the app.">
          <View style={{ paddingHorizontal: 14, paddingVertical: 10 }}>
            <TextInput
              value={number}
              onChangeText={(v) => {
                numberRef.current = v;
                setNumber(v);
              }}
              onBlur={commit}
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
