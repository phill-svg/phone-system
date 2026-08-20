import React from "react";
import { Tabs } from "expo-router";
import { Pressable, Text, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../../lib/auth";
import { colors } from "../../lib/theme";

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
        headerStyle: { backgroundColor: colors.surface },
        headerTitleStyle: { color: colors.text },
        headerShadowVisible: false,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
        tabBarActiveTintColor: colors.link,
        tabBarInactiveTintColor: colors.mute,
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
  signout: { color: colors.link, fontSize: 15 },
});
