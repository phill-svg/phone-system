import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handleCreateNumber, handleUpdateNumber, handleListNumbers } from "../../src/api/numbers";

function post(body: unknown): Request {
  return new Request("https://x/api/numbers", { method: "POST", body: JSON.stringify(body) });
}
function put(body: unknown): Request {
  return new Request("https://x/api/numbers/1", { method: "PUT", body: JSON.stringify(body) });
}
async function regionOf(e164: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT region FROM phone_numbers WHERE e164 = ?").bind(e164).first<{ region: string | null }>();
  return row?.region ?? null;
}

describe("phone number region", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM phone_numbers").run();
  });

  it("stores a region sent when adding a number", async () => {
    const res = await handleCreateNumber(post({ e164: "+61261059771", label: "TCB Main", voice_enabled: true, region: "au1" }), env.DB);
    expect(res.status).toBe(201);
    expect(await regionOf("+61261059771")).toBe("au1");
  });

  it("normalises case and whitespace", async () => {
    await handleCreateNumber(post({ e164: "+61485034869", label: "SMS line", sms_enabled: true, region: " US1 " }), env.DB);
    expect(await regionOf("+61485034869")).toBe("us1");
  });

  // A region exists to answer "which Twilio region processes this number's inbound calls". A
  // typo'd value would read as an answer, so it is rejected rather than stored.
  it("rejects a region that is not one this account uses", async () => {
    await handleCreateNumber(post({ e164: "+61400000000", label: "Junk", region: "ap2" }), env.DB);
    expect(await regionOf("+61400000000")).toBeNull();
  });

  it("keeps a missing region null rather than inventing one", async () => {
    await handleCreateNumber(post({ e164: "+61400000001", label: "No region" }), env.DB);
    expect(await regionOf("+61400000001")).toBeNull();
  });

  it("an edit can set the region on a number that had none", async () => {
    await handleCreateNumber(post({ e164: "+61400000002", label: "Later" }), env.DB);
    const list = (await (await handleListNumbers(env.DB)).json()) as { id: number; e164: string }[];
    const id = list.find((n) => n.e164 === "+61400000002")!.id;
    const res = await handleUpdateNumber(put({ e164: "+61400000002", label: "Later", voice_enabled: true, region: "au1" }), env.DB, id);
    expect(res.status).toBe(200);
    expect(await regionOf("+61400000002")).toBe("au1");
  });
});
