import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_AFTER_HOURS_FLOW,
  DEFAULT_FLOW,
  entryFlowCandidates,
  resolveNumberRouting,
  routesInUse,
} from "../../src/ivr/numberRouting";

const NUM = "+61200000100";

async function seedNumber(opts: {
  e164?: string;
  voice?: boolean;
  ivrFlow?: string | null;
  afterHoursFlow?: string | null;
  label?: string;
}): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO phone_numbers (e164, label, voice_enabled, sms_enabled, ivr_flow, after_hours_flow, created_at) VALUES (?, ?, ?, 0, ?, ?, 1)"
  )
    .bind(
      opts.e164 ?? NUM,
      opts.label ?? "Test line",
      opts.voice === false ? 0 : 1,
      opts.ivrFlow ?? null,
      opts.afterHoursFlow ?? null
    )
    .run();
}

describe("resolveNumberRouting", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM phone_numbers").run();
  });

  it("falls back to the global defaults for a number with no row at all", async () => {
    const routing = await resolveNumberRouting(env.DB, "+61499999999");
    expect(routing).toEqual({
      voiceDisabled: false,
      inHoursFlow: DEFAULT_FLOW,
      afterHoursFlow: DEFAULT_AFTER_HOURS_FLOW,
    });
  });

  it("falls back to the global defaults for a row that has no override", async () => {
    await seedNumber({});
    const routing = await resolveNumberRouting(env.DB, NUM);
    expect(routing.inHoursFlow).toBe(DEFAULT_FLOW);
    expect(routing.afterHoursFlow).toBe(DEFAULT_AFTER_HOURS_FLOW);
  });

  it("returns the per-number flows when they are set", async () => {
    await seedNumber({ ivrFlow: "sales", afterHoursFlow: "sales_ah" });
    const routing = await resolveNumberRouting(env.DB, NUM);
    expect(routing.inHoursFlow).toBe("sales");
    expect(routing.afterHoursFlow).toBe("sales_ah");
  });

  // "" is not NULL and would reach loadEntryNode as a flow that cannot exist. Same blank-vs-null
  // trap as `audioAssetId` in flowEngine.
  it("treats a blank stored flow as no override, not as a flow named ''", async () => {
    await seedNumber({ ivrFlow: "   ", afterHoursFlow: "" });
    const routing = await resolveNumberRouting(env.DB, NUM);
    expect(routing.inHoursFlow).toBe(DEFAULT_FLOW);
    expect(routing.afterHoursFlow).toBe(DEFAULT_AFTER_HOURS_FLOW);
  });

  it("reports a number whose voice is switched off", async () => {
    await seedNumber({ voice: false });
    expect((await resolveNumberRouting(env.DB, NUM)).voiceDisabled).toBe(true);
  });

  // The whole point of the module: a throw here escapes handleMainWebhook to the DO's catch-all,
  // which hangs up on a live customer. Asserted by making the read genuinely fail, not by mocking.
  it("never throws when the read fails — it falls back to the defaults", async () => {
    await env.DB.prepare("ALTER TABLE phone_numbers RENAME TO phone_numbers_hidden").run();
    try {
      const routing = await resolveNumberRouting(env.DB, NUM);
      expect(routing).toEqual({
        voiceDisabled: false,
        inHoursFlow: DEFAULT_FLOW,
        afterHoursFlow: DEFAULT_AFTER_HOURS_FLOW,
      });
    } finally {
      await env.DB.prepare("ALTER TABLE phone_numbers_hidden RENAME TO phone_numbers").run();
    }
  });
});

describe("entryFlowCandidates", () => {
  // Pinning the pre-0041 behaviour: a number with no override must produce exactly the old
  // single-try (in hours) and single-fallback (after hours) lists, or this feature changed routing
  // for every existing call.
  it("with no overrides, reproduces the old hardcoded behaviour", () => {
    const routing = { voiceDisabled: false, inHoursFlow: DEFAULT_FLOW, afterHoursFlow: DEFAULT_AFTER_HOURS_FLOW };
    expect(entryFlowCandidates(routing, false)).toEqual(["main"]);
    expect(entryFlowCandidates(routing, true)).toEqual(["after_hours", "main"]);
  });

  it("puts the number's own flow first, with the default as the last resort", () => {
    const routing = { voiceDisabled: false, inHoursFlow: "sales", afterHoursFlow: "sales_ah" };
    expect(entryFlowCandidates(routing, false)).toEqual(["sales", "main"]);
    expect(entryFlowCandidates(routing, true)).toEqual(["sales_ah", "after_hours", "main"]);
  });

  // Each rung must be MORE GENERIC for the same situation. Falling back to the line's own DAYTIME
  // menu would play a 2am caller the sales menu where pre-0041 code used main's closed branch.
  it("never falls back to the daytime menu after hours", () => {
    const routing = { voiceDisabled: false, inHoursFlow: "sales", afterHoursFlow: "sales_ah" };
    expect(entryFlowCandidates(routing, true)).not.toContain("sales");
  });

  it("de-duplicates when a number points both slots at the same flow", () => {
    const routing = { voiceDisabled: false, inHoursFlow: "sales", afterHoursFlow: "sales" };
    expect(entryFlowCandidates(routing, true)).toEqual(["sales", "after_hours", "main"]);
  });
});

describe("routesInUse", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM phone_numbers").run();
  });

  // No rows still means calls are answered — resolveNumberRouting falls open for an unknown number
  // — so the checks built on this must have something to check rather than reading "all clear".
  it("stands in a default route when no voice number is configured", async () => {
    const routes = await routesInUse(env.DB);
    expect(routes).toHaveLength(1);
    expect(routes[0].e164).toBeNull();
    expect(routes[0].routing.inHoursFlow).toBe(DEFAULT_FLOW);
  });

  it("returns one route per voice-enabled number and skips SMS-only ones", async () => {
    await seedNumber({ e164: "+61200000101", label: "Main", ivrFlow: "main" });
    await seedNumber({ e164: "+61200000102", label: "Sales", ivrFlow: "sales", afterHoursFlow: "sales_ah" });
    await seedNumber({ e164: "+61200000103", label: "SMS only", voice: false });

    const routes = await routesInUse(env.DB);
    expect(routes.map((r) => r.e164)).toEqual(["+61200000101", "+61200000102"]);
    expect(routes[1].routing).toEqual({
      voiceDisabled: false,
      inHoursFlow: "sales",
      afterHoursFlow: "sales_ah",
    });
  });

  // A check must be able to tell "the admin set this and it is broken" from "the shared default
  // happens to be unusable, which the fallback chain covers". Without the distinction an unusable
  // default pins Health Checks red over a system working exactly as designed.
  it("reports what was EXPLICITLY configured separately from the resolved flow", async () => {
    await seedNumber({ e164: "+61200000110", label: "Explicit main", ivrFlow: "main" });
    await seedNumber({ e164: "+61200000111", label: "Nothing set" });
    await seedNumber({ e164: "+61200000112", label: "Blank", ivrFlow: "  " });

    const routes = await routesInUse(env.DB);
    const by = (e164: string) => routes.find((r) => r.e164 === e164)!;

    // Set to "main" ON PURPOSE — resolves the same as the default, but it IS a choice.
    expect(by("+61200000110").configured.inHours).toBe("main");
    expect(by("+61200000111").configured.inHours).toBeNull();
    // Blank is no override, so it is not a choice either.
    expect(by("+61200000112").configured.inHours).toBeNull();
    // The resolved flow is the same for all three.
    expect(routes.every((r) => r.routing.inHoursFlow === "main")).toBe(true);
  });
});
