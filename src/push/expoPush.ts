// Send notifications through Expo's push service (https://docs.expo.dev/push-notifications/sending-notifications/).
// Expo relays to FCM (Android) / APNs (iOS); the FCM V1 credential must be uploaded to the EAS project.
// Returns the set of tokens Expo reports as permanently invalid so the caller can prune them.

type ExpoMessage = { to: string; title: string; body: string; data?: Record<string, unknown>; channelId?: string; sound?: string };

type ExpoTicket = { status: "ok" | "error"; message?: string; details?: { error?: string } };

export async function sendExpoPush(
  tokens: string[],
  msg: { title: string; body: string; data?: Record<string, unknown> }
): Promise<{ sent: number; invalidTokens: string[] }> {
  const valid = tokens.filter((t) => t.startsWith("ExponentPushToken[") || t.startsWith("ExpoPushToken["));
  if (valid.length === 0) return { sent: 0, invalidTokens: [] };

  const messages: ExpoMessage[] = valid.map((to) => ({
    to,
    title: msg.title,
    body: msg.body,
    data: msg.data,
    channelId: "messages",
    sound: "default",
  }));

  const res = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(messages),
  });
  if (!res.ok) throw new Error(`Expo push failed: ${res.status} ${await res.text()}`);

  const json = (await res.json()) as { data?: ExpoTicket[] };
  const tickets = json.data ?? [];
  const invalidTokens: string[] = [];
  tickets.forEach((tk, i) => {
    if (tk.status !== "error") return;
    if (tk.details?.error === "DeviceNotRegistered") {
      invalidTokens.push(valid[i]);
      return;
    }
    // Other ticket errors (InvalidCredentials, MessageRateExceeded, …) aren't prune-worthy but a
    // silent drop here once meant "staff stopped getting pushes" with zero trace — always log.
    console.log("EXPO_PUSH_TICKET_ERROR", JSON.stringify({ error: tk.details?.error ?? null, message: tk.message ?? null }));
  });
  return { sent: tickets.filter((t) => t.status === "ok").length, invalidTokens };
}
