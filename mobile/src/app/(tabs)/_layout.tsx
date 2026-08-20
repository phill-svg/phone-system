import { Ionicons } from "@expo/vector-icons";
import { Tabs } from "expo-router";
import React from "react";
import { Pressable, StyleSheet, Text } from "react-native";
import { useAuth } from "../../lib/auth";
import { colors } from "../../lib/theme";

// 🎨 COLORS FOR THE NAV CHROME (top header + bottom tab bar). Click a swatch to recolor.
// They start from the shared app theme; change one to override the nav bars only.
const page = {
  ...colors,           // shared app theme (fallback for anything not overridden)
  surface: "#1b1d24",  // header + tab bar background
  border: "#26282f",   // line above the tab bar
  text: "#eceef2",     // header title
  link: "#ff5c78",     // active tab + Sign out
  mute: "#6d7280",     // inactive tabs
};

function SignOutButton() {
  const { signOut } = useAuth();
  return (
    <Pressable onPress={() => signOut()} hitSlop={12} style={styles.signoutBtn}>
      <Text style={styles.signout}>Sign out</Text>
    </Pressable>
  );
}

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: page.surface },
        headerTitleStyle: { color: page.text },
        headerShadowVisible: false,
        tabBarStyle: { backgroundColor: page.surface, borderTopColor: page.border },
        tabBarActiveTintColor: page.link,
        tabBarInactiveTintColor: page.mute,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "In progress",
          tabBarLabel: "Live",
          headerRight: () => <SignOutButton />,
          tabBarIcon: ({ color, size }) => <Ionicons name="pulse-outline" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="calls"
        options={{
          title: "Call history",
          tabBarLabel: "History",
          tabBarIcon: ({ color, size }) => <Ionicons name="time-outline" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="callbacks"
        options={{
          title: "Callbacks",
          tabBarLabel: "Callbacks",
          tabBarIcon: ({ color, size }) => <Ionicons name="call-outline" size={size} color={color} />,
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  signoutBtn: { marginRight: 16 },
  signout: { color: page.link, fontSize: 20 },
});
