import React from "react";
import { Stack } from "expo-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { View, ActivityIndicator, StyleSheet } from "react-native";
import { AuthProvider, useAuth } from "../lib/auth";
import { colors } from "../lib/theme";

// 🎨 COLORS FOR THE APP SHELL (Call detail header + first loading screen).
// They start from the shared app theme; change one to override the shell only.
const page = {
  ...colors,           // shared app theme (fallback for anything not overridden)
  bg: "#0f1013",       // background behind screens + loading screen
  surface: "#1b1d24",  // Call detail header bar
  text: "#eceef2",     // "Call detail" title
  link: "#ff5c78",     // the back button
  brand: "#e4002b",    // loading spinner
};

const queryClient = new QueryClient();

function RootNavigator() {
  const { status } = useAuth();

  if (status === "loading") {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={page.brand} />
      </View>
    );
  }

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: page.bg },
      }}
    >
      <Stack.Protected guard={status === "authed"}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen
          name="call/[id]"
          options={{
            headerShown: true,
            title: "Call detail",
            headerStyle: { backgroundColor: page.surface },
            headerTitleStyle: { color: page.text },
            headerTintColor: page.link,
            headerShadowVisible: false,
            headerBackButtonDisplayMode: "minimal",
          }}
        />
      </Stack.Protected>
      <Stack.Protected guard={status === "anon"}>
        <Stack.Screen name="login" />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RootNavigator />
      </AuthProvider>
    </QueryClientProvider>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, backgroundColor: page.bg, alignItems: "center", justifyContent: "center" },
});
