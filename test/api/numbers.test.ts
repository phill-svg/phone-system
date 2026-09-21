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

describe("editing a number's default flags", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM phone_numbers").run();
  });

  async function defaults() {
    return (await env.DB.prepare("SELECT e164, is_default_voice, is_default_sms FROM phone_numbers ORDER BY e164").all()).results;
  }

  // The clears used to run unscoped in the same batch, so an edit to a number deleted elsewhere
  // 404'd AFTER wiping every default -- leaving no default voice or SMS number at all.
  it("leaves the existing defaults alone when the edited number no longer exists", async () => {
    await handleCreateNumber(post({ e164: "+61261059771", label: "Main", voice_enabled: true, sms_enabled: true, is_default_voice: true, is_default_sms: true }), env.DB);
    const before = await defaults();
    const res = await handleUpdateNumber(put({ e164: "+61400000009", label: "Gone", voice_enabled: true, sms_enabled: true, is_default_voice: true, is_default_sms: true }), env.DB, 999999);
    expect(res.status).toBe(404);
    expect(await defaults()).toEqual(before);
  });

  it("still moves the default onto the edited number when it exists", async () => {
    await handleCreateNumber(post({ e164: "+61261059771", label: "Main", voice_enabled: true, sms_enabled: true, is_default_voice: true, is_default_sms: true }), env.DB);
    await handleCreateNumber(post({ e164: "+61485034869", label: "Other", voice_enabled: true, sms_enabled: true }), env.DB);
    const list = (await (await handleListNumbers(env.DB)).json()) as { id: number; e164: string }[];
    const id = list.find((n) => n.e164 === "+61485034869")!.id;
    const res = await handleUpdateNumber(put({ e164: "+61485034869", label: "Other", voice_enabled: true, sms_enabled: true, is_default_voice: true, is_default_sms: true }), env.DB, id);
    expect(res.status).toBe(200);
    expect(await defaults()).toEqual([
      { e164: "+61261059771", is_default_voice: 0, is_default_sms: 0 },
      { e164: "+61485034869", is_default_voice: 1, is_default_sms: 1 },
    ]);
  });
});

// ---- Per-number IVR routing (migration 0041) ----

async function seedFlow(flow: string, opts: { withEntry: boolean }): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO ivr_nodes (id, flow, is_entry, type, config, created_at, updated_at) VALUES (?, ?, ?, 'voicemail', ?, 1, 1)"
  )
    .bind(`n_${flow}`, flow, opts.withEntry ? 1 : 0, JSON.stringify({ audioAssetId: null, ttsText: "hi", mailboxLabel: flow }))
    .run();
}

async function flowsOf(e164: string): Promise<{ ivr_flow: string | null; after_hours_flow: string | null }> {
  const row = await env.DB.prepare("SELECT ivr_flow, after_hours_flow FROM phone_numbers WHERE e164 = ?")
    .bind(e164)
    .first<{ ivr_flow: string | null; after_hours_flow: string | null }>();
  return row ?? { ivr_flow: null, after_hours_flow: null };
}

describe("per-number IVR routing", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM phone_numbers").run();
    await env.DB.prepare("DELETE FROM ivr_nodes WHERE flow LIKE 'test_%'").run();
  });

  it("stores the flows a number is pointed at", async () => {
    await seedFlow("test_sales", { withEntry: true });
    await seedFlow("test_sales_ah", { withEntry: true });
    const res = await handleCreateNumber(
      post({
        e164: "+61200000200",
        label: "Sales",
        voice_enabled: true,
        ivr_flow: "test_sales",
        after_hours_flow: "test_sales_ah",
      }),
      env.DB
    );
    expect(res.status).toBe(201);
    // Asserted against the STORED row, not through the handler's own response — a read that
    // normalises the same way would pass against code that never wrote anything.
    expect(await flowsOf("+61200000200")).toEqual({ ivr_flow: "test_sales", after_hours_flow: "test_sales_ah" });
  });

  it("keeps an omitted flow null so the number follows the global default", async () => {
    await handleCreateNumber(post({ e164: "+61200000201", label: "Plain", voice_enabled: true }), env.DB);
    expect(await flowsOf("+61200000201")).toEqual({ ivr_flow: null, after_hours_flow: null });
  });

  // "" is not NULL: stored as-is it would reach loadEntryNode as a flow that cannot exist.
  it("treats a blank flow as no override rather than a flow named ''", async () => {
    await handleCreateNumber(
      post({ e164: "+61200000202", label: "Blank", voice_enabled: true, ivr_flow: "   ", after_hours_flow: "" }),
      env.DB
    );
    expect(await flowsOf("+61200000202")).toEqual({ ivr_flow: null, after_hours_flow: null });
  });

  // Validate on write: a number pointed at a menu with no starting step takes calls that die in
  // loadEntryNode, and the caller-side fallback makes that invisible.
  it("refuses a flow that has no starting step, naming it", async () => {
    await seedFlow("test_orphan", { withEntry: false });
    const res = await handleCreateNumber(
      post({ e164: "+61200000203", label: "Broken", voice_enabled: true, ivr_flow: "test_orphan" }),
      env.DB
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("test_orphan");
    expect(body.error).toContain("ivr_flow");
    // Nothing was written.
    expect(await flowsOf("+61200000203")).toEqual({ ivr_flow: null, after_hours_flow: null });
  });

  it("refuses a flow that does not exist at all", async () => {
    const res = await handleCreateNumber(
      post({ e164: "+61200000204", label: "Ghost", voice_enabled: true, after_hours_flow: "test_nope" }),
      env.DB
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("after_hours_flow");
  });

  it("applies the same validation on update, and saves a good one", async () => {
    await seedFlow("test_sales", { withEntry: true });
    await seedFlow("test_orphan", { withEntry: false });
    await handleCreateNumber(post({ e164: "+61200000205", label: "Edit me", voice_enabled: true }), env.DB);
    const row = await env.DB.prepare("SELECT id FROM phone_numbers WHERE e164 = ?")
      .bind("+61200000205")
      .first<{ id: number }>();

    const bad = await handleUpdateNumber(
      put({ e164: "+61200000205", label: "Edit me", voice_enabled: true, ivr_flow: "test_orphan" }),
      env.DB,
      row!.id
    );
    expect(bad.status).toBe(400);
    expect(await flowsOf("+61200000205")).toEqual({ ivr_flow: null, after_hours_flow: null });

    const good = await handleUpdateNumber(
      put({ e164: "+61200000205", label: "Edit me", voice_enabled: true, ivr_flow: "test_sales" }),
      env.DB,
      row!.id
    );
    expect(good.status).toBe(200);
    expect((await flowsOf("+61200000205")).ivr_flow).toBe("test_sales");
  });

  // Every existing row is null on both columns. A validator that refused those would lock an admin
  // out of re-saving a number they could always save before.
  it("still allows saving a number with no flow set", async () => {
    await handleCreateNumber(post({ e164: "+61200000206", label: "Legacy", voice_enabled: true }), env.DB);
    const row = await env.DB.prepare("SELECT id FROM phone_numbers WHERE e164 = ?")
      .bind("+61200000206")
      .first<{ id: number }>();
    const res = await handleUpdateNumber(
      put({ e164: "+61200000206", label: "Legacy renamed", voice_enabled: true }),
      env.DB,
      row!.id
    );
    expect(res.status).toBe(200);
  });

  it("ships the flows on the list endpoint so the pickers can show them", async () => {
    await seedFlow("test_sales", { withEntry: true });
    await handleCreateNumber(
      post({ e164: "+61200000207", label: "Sales", voice_enabled: true, ivr_flow: "test_sales" }),
      env.DB
    );
    const listed = (await (await handleListNumbers(env.DB)).json()) as { e164: string; ivr_flow: string | null }[];
    expect(listed.find((n) => n.e164 === "+61200000207")?.ivr_flow).toBe("test_sales");
  });
});
