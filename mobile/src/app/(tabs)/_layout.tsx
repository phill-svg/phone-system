import React from "react";
import { Tabs } from "expo-router";
import { type SymbolViewProps } from "expo-symbols";
import { Icon } from "../../components/ui/Icon";
import { useTheme } from "../../theme/theme";

function TabIcon(name: SymbolViewProps["name"], fallback: string) {
  const Cmp = ({ color, focused }: { color: string; focused: boolean }) => (
    <Icon name={name} fallback={fallback as never} size={26} color={color} weight={focused ? "semibold" : "regular"} />
  );
  Cmp.displayName = `TabIcon(${name})`;
  return Cmp;
}

export default function TabsLayout() {
  const t = useTheme();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: t.colors.accent,
        tabBarInactiveTintColor: t.colors.labelTertiary,
        tabBarStyle: {
          backgroundColor: t.colors.bgElevated,
          borderTopColor: t.colors.separator,
          borderTopWidth: t.hairline,
        },
        tabBarLabelStyle: { fontSize: 10.5, fontWeight: "600" },
        sceneStyle: { backgroundColor: t.colors.bg },
      }}
    >
      <Tabs.Screen name="index" options={{ title: "Keypad", tabBarIcon: TabIcon("circle.grid.3x3.fill", "keypad") }} />
      <Tabs.Screen name="recents" options={{ title: "Recents", tabBarIcon: TabIcon("clock.fill", "time") }} />
      <Tabs.Screen name="messages" options={{ title: "Messages", tabBarIcon: TabIcon("message.fill", "chatbubble") }} />
      <Tabs.Screen name="contacts" options={{ title: "Contacts", tabBarIcon: TabIcon("person.crop.circle.fill", "people") }} />
      <Tabs.Screen name="voicemail" options={{ title: "Voicemail", tabBarIcon: TabIcon("waveform", "recording-outline") }} />
      <Tabs.Screen name="settings" options={{ title: "Settings", tabBarIcon: TabIcon("gearshape.fill", "settings") }} />
    </Tabs>
  );
}
