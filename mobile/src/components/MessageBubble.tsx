import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { messageStatusLabel } from "../lib/conversations";
import { useTheme, type } from "../theme/theme";
import type { Message } from "../lib/api";

// One message row: the bubble, plus the delivery caption underneath when there is one to show.
//
// This lives in its own component for a testing reason rather than a styling one. The rule itself
// (messageStatusLabel) was already pure and unit-tested, but nothing pinned that the SCREEN called
// it -- delete the caption block from the thread screen and every mobile test stayed green while
// the handset silently lost both the "Not delivered" warning and the new caption. That is the
// "testing a helper is not testing the call site" failure this repo has now hit four times
// (putIvrFlow, the Admin hub's headerLeft, the canvas positions, the crash-write). As a component
// it can be rendered in a test, so deleting the caption breaks one.
//
// `useTheme()` falls back to the system scheme outside a provider, which is what lets that test
// render this with no wrapper.
export function MessageBubble({
  message,
  isLastOutbound,
  isMessenger,
}: {
  message: Message;
  isLastOutbound: boolean;
  isMessenger: boolean;
}) {
  const t = useTheme();
  const out = message.direction === "outbound";
  // A Twilio status callback can flip an outbound message to failed/undelivered well after it
  // looked "sent" -- most commonly a Messenger reply Facebook rejected (a broken Page connection,
  // or outside the 24-hour window). What the caption says, and whether it appears at all, is
  // messageStatusLabel's call; the web dashboard renders the same rules from its own copy.
  const label = messageStatusLabel({
    direction: message.direction,
    status: message.status,
    isLastOutbound,
    isMessenger,
  });
  // Only a failure carries a reason worth printing. A successful "Delivered" has nothing to add,
  // and error_code/error_message can be left over on a row that later succeeded.
  const failDetail = message.error_message || (message.error_code ? `Error ${message.error_code}` : null);

  return (
    <View>
      <View style={[styles.bubbleRow, { justifyContent: out ? "flex-end" : "flex-start" }]}>
        <View style={[styles.bubble, out ? { backgroundColor: t.colors.accent } : { backgroundColor: t.colors.fill }]}>
          <Text style={[type.body, { color: out ? "#FFFFFF" : t.colors.label }]}>{message.body}</Text>
        </View>
      </View>
      {label ? (
        <View style={[styles.bubbleRow, { justifyContent: "flex-end" }]}>
          <Text
            style={[
              type.caption,
              {
                color: label.failed ? "#FF3B30" : t.colors.labelSecondary,
                paddingHorizontal: 4,
                maxWidth: "78%",
                textAlign: "right",
              },
            ]}
          >
            {label.text}
            {label.failed && failDetail ? ` -- ${failDetail}` : ""}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bubbleRow: { flexDirection: "row" },
  bubble: { maxWidth: "78%", paddingHorizontal: 14, paddingVertical: 9, borderRadius: 20 },
});
