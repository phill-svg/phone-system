import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getMessageMedia, insertMessageMedia, listMediaForPeer, parseInboundMedia } from "../../src/db/messageMedia";

// A customer's photo used to arrive as a message with an empty body and nothing saying an
// attachment had been dropped. These cover the parse -- where a malformed webhook could otherwise
// produce rows pointing nowhere -- and the reads the thread and the proxy depend on.

describe("parseInboundMedia", () => {
  it("reads the attachments Twilio actually sent", () => {
    expect(
      parseInboundMedia({
        NumMedia: "2",
        MediaUrl0: "https://api.twilio.com/media/ME1",
        MediaContentType0: "image/jpeg",
        MediaUrl1: "https://api.twilio.com/media/ME2",
        MediaContentType1: "application/pdf",
      })
    ).toEqual([
      { idx: 0, content_type: "image/jpeg", url: "https://api.twilio.com/media/ME1" },
      { idx: 1, content_type: "application/pdf", url: "https://api.twilio.com/media/ME2" },
    ]);
  });

  it("finds nothing on an ordinary text message", () => {
    expect(parseInboundMedia({ Body: "hello" })).toEqual([]);
    expect(parseInboundMedia({ NumMedia: "0", Body: "hello" })).toEqual([]);
  });

  // The count and the fields have to agree. A message claiming ten attachments while carrying one
  // must not produce nine rows pointing nowhere, each of which renders as a broken image.
  it("trusts the fields over the count", () => {
    expect(parseInboundMedia({ NumMedia: "3", MediaUrl0: "https://x/1", MediaContentType0: "image/png" })).toEqual([
      { idx: 0, content_type: "image/png", url: "https://x/1" },
    ]);
  });

  it("survives a count that is not a number", () => {
    expect(parseInboundMedia({ NumMedia: "lots", MediaUrl0: "https://x/1" })).toEqual([]);
  });

  // Guessing image/jpeg for what might be a PDF would have a client render a broken image instead
  // of offering to open the file.
  it("does not guess a content type it was not given", () => {
    expect(parseInboundMedia({ NumMedia: "1", MediaUrl0: "https://x/1" })).toEqual([
      { idx: 0, content_type: "application/octet-stream", url: "https://x/1" },
    ]);
  });
});

describe("message media storage", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM message_media").run();
    await env.DB.prepare("DELETE FROM messages").run();
    await env.DB.prepare(
      "INSERT INTO messages (id, direction, peer_number, our_number, body, status, read, created_at) VALUES ('SM1', 'inbound', '+61400000000', '+61485034869', '', 'received', 0, 1)"
    ).run();
    await env.DB.prepare(
      "INSERT INTO messages (id, direction, peer_number, our_number, body, status, read, created_at) VALUES ('SM2', 'inbound', '+61400000000', '+61485034869', 'no media', 'received', 0, 2)"
    ).run();
  });

  it("stores and reads back the attachments of a message", async () => {
    await insertMessageMedia(env.DB, "SM1", [
      { idx: 0, content_type: "image/jpeg", url: "https://api.twilio.com/media/ME1" },
    ]);
    expect(await listMediaForPeer(env.DB, "+61400000000")).toEqual([
      { message_id: "SM1", idx: 0, content_type: "image/jpeg", url: "https://api.twilio.com/media/ME1" },
    ]);
  });

  // Twilio redelivers a webhook it did not get a 200 for, and the message insert is already
  // ON CONFLICT DO NOTHING for the same reason.
  it("does not duplicate on a redelivered webhook", async () => {
    const media = [{ idx: 0, content_type: "image/jpeg", url: "https://api.twilio.com/media/ME1" }];
    await insertMessageMedia(env.DB, "SM1", media);
    await insertMessageMedia(env.DB, "SM1", media);
    expect(await listMediaForPeer(env.DB, "+61400000000")).toHaveLength(1);
  });

  it("writes nothing for a message with no attachments", async () => {
    await insertMessageMedia(env.DB, "SM2", []);
    expect(await listMediaForPeer(env.DB, "+61400000000")).toEqual([]);
  });

  // The thread loads a whole conversation; one query per bubble would be a round trip each.
  it("reads a conversation's attachments in one go", async () => {
    await insertMessageMedia(env.DB, "SM1", [{ idx: 0, content_type: "image/jpeg", url: "https://x/1" }]);
    await insertMessageMedia(env.DB, "SM2", [{ idx: 0, content_type: "image/png", url: "https://x/2" }]);
    expect(await listMediaForPeer(env.DB, "+61400000000")).toHaveLength(2);
  });

  it("returns nothing for a conversation with no attachments", async () => {
    expect(await listMediaForPeer(env.DB, "+61499999999")).toEqual([]);
  });

  // The reason this is scoped by PEER rather than by a list of message ids: D1 caps a query at 100
  // bound parameters, and the thread view loads a conversation with no LIMIT. An IN list would
  // throw inside the thread handler once a customer passed ~100 messages, making the conversation
  // unreadable on both surfaces -- and it would pass locally, because miniflare does not enforce
  // the cap. One parameter cannot hit it.
  it("handles a conversation far longer than D1's bound-parameter cap", async () => {
    const inserts = [];
    for (let i = 0; i < 150; i++) {
      inserts.push(
        env.DB.prepare(
          "INSERT INTO messages (id, direction, peer_number, our_number, body, status, read, created_at) VALUES (?, 'inbound', '+61400000000', '+61485034869', 'hi', 'received', 1, ?)"
        ).bind(`BULK${i}`, 100 + i)
      );
    }
    await env.DB.batch(inserts);
    await insertMessageMedia(env.DB, "BULK149", [{ idx: 0, content_type: "image/jpeg", url: "https://x/last" }]);

    const media = await listMediaForPeer(env.DB, "+61400000000");
    expect(media).toHaveLength(1);
    expect(media[0].url).toBe("https://x/last");
  });

  it("finds one attachment for the proxy, and null for one that does not exist", async () => {
    await insertMessageMedia(env.DB, "SM1", [{ idx: 0, content_type: "image/jpeg", url: "https://x/1" }]);
    expect(await getMessageMedia(env.DB, "SM1", 0)).toMatchObject({ url: "https://x/1" });
    expect(await getMessageMedia(env.DB, "SM1", 7)).toBeNull();
    expect(await getMessageMedia(env.DB, "nope", 0)).toBeNull();
  });
});
