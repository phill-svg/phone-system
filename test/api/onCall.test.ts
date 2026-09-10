import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handleGetOnCall, handlePutOnCall, handlePutOnCallOverride, previewWeeks } from "../../src/api/onCall";
import { getOnCallRotation, getOnCallOverride } from "../../src/db/onCall";

const ADMIN: import("../../src/access/requireStaffUser").StaffUser = {
  email: "phill@example.com",
  role: "admin",
};

const CLOSED = JSON.stringify({ mon: null, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null });
const DEMO = ["reviewer@x.com"];

async function insertStaff(email: string) {
  await env.DB.prepare(
    "INSERT INTO staff_users (email, role, created_at, status, schedule, last_heartbeat_at, ring_priority) VALUES (?, 'staff', ?, 'available', ?, NULL, 100)"
  )
    .bind(email, Date.now(), CLOSED)
    .run();
}

function put(body: unknown, path = "https://x/api/admin/on-call") {
  return new Request(path, { method: "PUT", body: JSON.stringify(body) });
}

describe("handlePutOnCall", () => {
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM staff_users");
    await env.DB.exec("DELETE FROM on_call_overrides");
    await env.DB.prepare("DELETE FROM settings WHERE key = 'on_call_rotation'").run();
    await insertStaff("a@x.com");
    await insertStaff("b@x.com");
  });

  it("saves an ordered rotation", async () => {
    const res = await handlePutOnCall(put({ members: ["a@x.com", "b@x.com"], anchorWeekStart: "2026-09-07" }), env.DB, ADMIN);
    expect(res.status).toBe(200);
    expect(await getOnCallRotation(env.DB)).toEqual({ members: ["a@x.com", "b@x.com"], anchorWeekStart: "2026-09-07" });
  });

  // A typo here fails SILENTLY at 2am: the week comes round, nobody matches, and the caller hears
  // voicemail exactly as though no rota existed. Refused where somebody is looking at it.
  it("refuses an email that is not a staff member", async () => {
    const res = await handlePutOnCall(put({ members: ["a@x.com", "typo@x.com"] }), env.DB, ADMIN);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("typo@x.com");
    expect((await getOnCallRotation(env.DB)).members).toEqual([]);
  });

  // Not an error at ring time -- just two weeks in the cycle for one person, which reads as a
  // mysteriously unfair rota some months later.
  it("refuses a rotation that lists someone twice", async () => {
    const res = await handlePutOnCall(put({ members: ["a@x.com", "A@x.com"] }), env.DB, ADMIN);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("twice");
  });

  it("refuses an anchor that is not a Monday", async () => {
    const res = await handlePutOnCall(put({ members: ["a@x.com"], anchorWeekStart: "2026-09-08" }), env.DB, ADMIN);
    expect(res.status).toBe(400);
  });

  it("defaults the anchor to the current week when none is given", async () => {
    await handlePutOnCall(put({ members: ["a@x.com"] }), env.DB, ADMIN);
    const saved = await getOnCallRotation(env.DB);
    expect(saved.anchorWeekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(`${saved.anchorWeekStart}T00:00:00Z`).getUTCDay()).toBe(1);
  });

  // Clearing the rota is a legitimate thing to do and must not be blocked by the anchor rules.
  it("accepts an empty rotation, meaning nobody is on call", async () => {
    await handlePutOnCall(put({ members: ["a@x.com"], anchorWeekStart: "2026-09-07" }), env.DB, ADMIN);
    const res = await handlePutOnCall(put({ members: [] }), env.DB, ADMIN);
    expect(res.status).toBe(200);
    expect(await getOnCallRotation(env.DB)).toEqual({ members: [], anchorWeekStart: "" });
  });
});

describe("handlePutOnCallOverride", () => {
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM staff_users");
    await env.DB.exec("DELETE FROM on_call_overrides");
    await insertStaff("a@x.com");
  });

  it("sets and then clears a week's override", async () => {
    expect((await handlePutOnCallOverride(put({ weekStart: "2026-09-07", email: "a@x.com" }), env.DB, ADMIN)).status).toBe(200);
    expect(await getOnCallOverride(env.DB, "2026-09-07")).toBe("a@x.com");

    expect((await handlePutOnCallOverride(put({ weekStart: "2026-09-07", email: null }), env.DB, ADMIN)).status).toBe(200);
    expect(await getOnCallOverride(env.DB, "2026-09-07")).toBeNull();
  });

  it("replaces rather than duplicating when the same week is set twice", async () => {
    await insertStaff("b@x.com");
    await handlePutOnCallOverride(put({ weekStart: "2026-09-07", email: "a@x.com" }), env.DB, ADMIN);
    await handlePutOnCallOverride(put({ weekStart: "2026-09-07", email: "b@x.com" }), env.DB, ADMIN);
    expect(await getOnCallOverride(env.DB, "2026-09-07")).toBe("b@x.com");
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM on_call_overrides").first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it("refuses a week that is not a Monday, and an unknown email", async () => {
    expect((await handlePutOnCallOverride(put({ weekStart: "2026-09-09", email: "a@x.com" }), env.DB, ADMIN)).status).toBe(400);
    expect((await handlePutOnCallOverride(put({ weekStart: "2026-09-07", email: "nope@x.com" }), env.DB, ADMIN)).status).toBe(400);
  });
});

describe("handleGetOnCall", () => {
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM staff_users");
    await env.DB.exec("DELETE FROM on_call_overrides");
    await env.DB.prepare("DELETE FROM settings WHERE key = 'on_call_rotation'").run();
  });

  // A rotation outlives the people in it, and it keeps ADVANCING past a departed name -- so one
  // week in the cycle silently has nobody. Nothing else would ever surface that.
  it("reports rotation members who are no longer staff", async () => {
    await insertStaff("a@x.com");
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('on_call_rotation', ?)")
      .bind(JSON.stringify({ members: ["a@x.com", "gone@x.com"], anchorWeekStart: "2026-09-07" }))
      .run();
    const body = await (await handleGetOnCall(env.DB)).json<{ unknownMembers: string[] }>();
    expect(body.unknownMembers).toEqual(["gone@x.com"]);
  });
});

describe("previewWeeks", () => {
  // A rotation is a rule about the future, and the only way to be sure it says what you meant is to
  // see the weeks it produces before a customer does.
  it("shows the rotation advancing, with overrides taking their week", () => {
    const weeks = previewWeeks(
      { members: ["a@x.com", "b@x.com"], anchorWeekStart: "2026-09-07" },
      new Map([["2026-09-14", "c@x.com"]]),
      "2026-09-07",
      4
    );
    expect(weeks).toEqual([
      { weekStart: "2026-09-07", email: "a@x.com", source: "rotation" },
      { weekStart: "2026-09-14", email: "c@x.com", source: "override" },
      { weekStart: "2026-09-21", email: "a@x.com", source: "rotation" },
      { weekStart: "2026-09-28", email: "b@x.com", source: "rotation" },
    ]);
  });

  it("says nobody rather than inventing a name when the rotation is empty", () => {
    const weeks = previewWeeks({ members: [], anchorWeekStart: "" }, new Map(), "2026-09-07", 2);
    expect(weeks.every((w) => w.email === null && w.source === "nobody")).toBe(true);
  });
});

// The demo account is dropped by resolveRingTargets before shift or availability is considered, so
// a rotation naming it resolves to nobody and every after-hours caller hears voicemail -- while
// Health Checks reports it as fine, having read the same unfiltered roster. The exclusion has to
// happen where the name is CHOSEN, not only where it is dialled.
describe("demo accounts are not selectable for on call", () => {
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM staff_users");
    await env.DB.exec("DELETE FROM on_call_overrides");
    await env.DB.prepare("DELETE FROM settings WHERE key = 'on_call_rotation'").run();
    await insertStaff("a@x.com");
    await insertStaff("reviewer@x.com");
  });

  it("is never offered in the pickers", async () => {
    const body = await (await handleGetOnCall(env.DB, DEMO)).json<{ staff: string[] }>();
    expect(body.staff).toEqual(["a@x.com"]);
  });

  it("is refused in a rotation", async () => {
    const res = await handlePutOnCall(put({ members: ["reviewer@x.com"] }), env.DB, ADMIN, DEMO);
    expect(res.status).toBe(400);
    expect((await getOnCallRotation(env.DB)).members).toEqual([]);
  });

  it("is refused as a week override", async () => {
    const res = await handlePutOnCallOverride(put({ weekStart: "2026-09-07", email: "reviewer@x.com" }), env.DB, ADMIN, DEMO);
    expect(res.status).toBe(400);
    expect(await getOnCallOverride(env.DB, "2026-09-07")).toBeNull();
  });
});

// staff_users only ever holds lowercase (invites lowercase on write), and both admin UIs compare
// stored rotation entries against it with strict equality. A stored "Tech@X.com" passed the
// case-insensitive validation and then showed the person as rostered AND not-rostered at once,
// with the duplicate impossible to remove.
describe("addresses are normalised on write", () => {
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM staff_users");
    await env.DB.exec("DELETE FROM on_call_overrides");
    await env.DB.prepare("DELETE FROM settings WHERE key = 'on_call_rotation'").run();
    await insertStaff("tech@x.com");
  });

  it("lowercases a rotation member", async () => {
    const res = await handlePutOnCall(put({ members: ["  Tech@X.com "] }), env.DB, ADMIN);
    expect(res.status).toBe(200);
    expect((await getOnCallRotation(env.DB)).members).toEqual(["tech@x.com"]);
  });

  it("lowercases an override", async () => {
    await handlePutOnCallOverride(put({ weekStart: "2026-09-07", email: "Tech@X.com" }), env.DB, ADMIN);
    expect(await getOnCallOverride(env.DB, "2026-09-07")).toBe("tech@x.com");
  });

  it("still catches a duplicate that differs only by case", async () => {
    const res = await handlePutOnCall(put({ members: ["tech@x.com", "TECH@x.com"] }), env.DB, ADMIN);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("twice");
  });
});
