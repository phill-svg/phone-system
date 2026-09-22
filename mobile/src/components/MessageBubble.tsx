import React from "react";
import { View, Text, Image, StyleSheet } from "react-native";
import { messageStatusLabel } from "../lib/conversations";
import { INLINE_IMAGE_TYPES, messageMediaPath, useMediaSource } from "../lib/mediaSource";
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
          {(message.media ?? []).map((m) => (
            <Attachment key={m.idx} messageId={message.id} idx={m.idx} contentType={m.content_type} outbound={out} />
          ))}
          {/* A photo arrives with an EMPTY body, so a bubble rendering only text was a blank one. */}
          {message.body ? (
            <Text style={[type.body, { color: out ? "#FFFFFF" : t.colors.label, marginTop: (message.media ?? []).length ? 6 : 0 }]}>
              {message.body}
            </Text>
          ) : null}
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
  media: { width: 200, height: 200, borderRadius: 12, overflow: "hidden" },
  mediaImage: { width: "100%", height: "100%" },
});

// One attachment inside a bubble.
//
// An image is shown inline, because that is what a customer sending a photo of a rat or a meter box
// expects to see. Anything else -- a PDF, an audio note -- gets a line saying what it is: rendering
// it as an image would show a broken frame, and pretending it is not there is what this whole
// feature exists to stop.
//
// `resizeMode="cover"` inside a fixed frame rather than a computed aspect ratio: the dimensions are
// not known until the image loads, and a bubble that resizes mid-scroll jumps the list.
function Attachment({
  messageId,
  idx,
  contentType,
  outbound,
}: {
  messageId: string;
  idx: number;
  contentType: string;
  outbound: boolean;
}) {
  const t = useTheme();
  // Twilio keeps the media, not us, so an attachment CAN age out (the proxy answers 404), and a
  // locked phone can refuse the keychain. Both used to render as a blank square forever with
  // nothing saying an attachment was even there; this flips to the text branch instead.
  const [failed, setFailed] = React.useState(false);
  // The SAME list the server will serve inline (INLINE_IMAGE_TYPES). `image/*` disagreed with it:
  // bmp, tiff, avif and heif took this branch, the server sent them as downloads, and the bubble
  // showed an empty grey square with no label -- the blank-with-no-explanation symptom this whole
  // feature exists to remove. SVG is excluded on both sides: an image to a person, a script host
  // to a browser, and the type is chosen by whoever sent the message.
  const isImage = INLINE_IMAGE_TYPES.includes(contentType) && !failed;
  const source = useMediaSource(isImage ? messageMediaPath(messageId, idx) : null);

  if (!isImage) {
    return (
      <Text style={[type.footnote, { color: outbound ? "#FFFFFF" : t.colors.labelSecondary }]}>
        Attachment ({contentType})
      </Text>
    );
  }
  // Until the session token resolves there is nothing to fetch with, so a placeholder holds the
  // space rather than flashing a broken image.
  return (
    <View style={[styles.media, { backgroundColor: t.colors.fill }]}>
      {source ? (
        <Image
          source={source}
          style={styles.mediaImage}
          resizeMode="cover"
          accessibilityLabel="Attached photo"
          // Twilio keeps the media, not us, so an attachment CAN age out -- and a locked phone
          // can refuse the keychain. Both rendered as a blank square forever with nothing saying
          // an attachment was even there. Falling back to the text branch says it.
          onError={() => setFailed(true)}
        />
      ) : null}
    </View>
  );
}
