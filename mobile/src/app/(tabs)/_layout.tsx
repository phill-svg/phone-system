import React, { useEffect } from "react";
import { Tabs, router } from "expo-router";
import { type SymbolViewProps } from "expo-symbols";
import { Icon } from "../../components/ui/Icon";
import { registerForIncoming } from "../../lib/voice";
import { registerForPushNotifications } from "../../lib/push";
import { setPresence, sendHeartbeat } from "../../lib/api";
import { useTheme } from "../../theme/theme";

// Register this device for incoming calls once the user is signed in (the tab group only
// mounts when authed). On an incoming call, jump to the full-screen ringing UI. Also mark the
// softphone "available" and heartbeat, so the inbound ring plan will actually dial it.
function useIncomingCalls() {
  useEffect(() => {
    let unsub: (() => void) | undefined;
    registerForIncoming((from) => {
      router.push({ pathname: "/call-incoming", params: { number: from, name: "" } });
    })
      .then((u) => {
        unsub = u;
      })
      .catch(() => {});

    registerForPushNotifications().catch(() => {});

    setPresence("available").catch(() => {});
    sendHeartbeat().catch(() => {});
    const hb = setInterval(() => sendHeartbeat().catch(() => {}), 60_000);

    return () => {
      unsub?.();
      clearInterval(hb);
      setPresence("offline").catch(() => {});
    };
  }, []);
}

function TabIcon(name: SymbolViewProps["name"], fallback: string) {
  const Cmp = ({ color, focused }: { color: string; focused: boolean }) => (
    <Icon name={name} fallback={fallback as never} size={26} color={color} weight={focused ? "semibold" : "regular"} />
  );
  Cmp.displayName = `TabIcon(${name})`;
  return Cmp;
}

export default function TabsLayout() {
  const t = useTheme();
  useIncomingCalls();
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
