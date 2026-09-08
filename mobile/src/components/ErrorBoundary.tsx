import React from "react";
import { View, Text, Pressable, ScrollView, StyleSheet } from "react-native";
import { reportError } from "../lib/crashReport";

// Catches a render error instead of letting it take the app down.
//
// A component that throws during render unmounts the whole tree, which is how a live call ended up
// behind a black screen. Showing what broke -- and keeping the app running -- beats the app
// disappearing, and it means the person holding the phone can read the error out loud.
type Props = { children: React.ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Not fatal: the app is still running, on this screen. The component stack says which component
    // threw, which the JS stack alone often doesn't.
    const stack = [error.stack, info.componentStack].filter(Boolean).join("\n\n--- component stack ---\n");
    void reportError(Object.assign(new Error(error.message), { name: error.name, stack }), false);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <View style={styles.root}>
        <ScrollView contentContainerStyle={styles.body}>
          <Text style={styles.title}>Something went wrong</Text>
          <Text style={styles.lead}>
            The app hit an error and stopped this screen rather than closing. It has been reported
            automatically.
          </Text>
          <Text style={styles.message}>{error.message}</Text>
          {error.stack ? <Text style={styles.stack}>{error.stack}</Text> : null}
        </ScrollView>
        <Pressable style={styles.button} onPress={() => this.setState({ error: null })}>
          <Text style={styles.buttonLabel}>Try again</Text>
        </Pressable>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  body: { padding: 24, paddingTop: 80, gap: 12 },
  title: { color: "#fff", fontSize: 22, fontWeight: "700" },
  lead: { color: "#9b9b9f", fontSize: 14, lineHeight: 20 },
  message: { color: "#ff6b6b", fontSize: 14, marginTop: 8 },
  stack: { color: "#6f6f74", fontSize: 11, lineHeight: 16, marginTop: 8 },
  button: { margin: 24, paddingVertical: 14, borderRadius: 12, backgroundColor: "#0a84ff", alignItems: "center" },
  buttonLabel: { color: "#fff", fontSize: 16, fontWeight: "600" },
});
