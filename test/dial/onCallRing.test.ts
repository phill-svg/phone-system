import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { resolveRingTargets } from "../../src/dial/ringQueue";
import { setUserSettings } from "../../src/db/userSettings";
import { setOnCallRotation, setOnCallOverride } from "../../src/db/onCall";

// Friday 11 September 2026, 21:00 in Canberra -- long after every schedule below has closed. This
// is the hour the whole feature exists for.
const AFTER_HOURS = new Date("2026-09-11T11:00:00.000Z");
const WEEK = "2026-09-07"; // the Monday of that week

// Deliberately CLOSED every day: nobody here is on shift at any hour, which is exactly the state
// the daytime roster is in after 6pm and the reason it returns nobody.
const CLOSED_SCHEDULE = JSON.stringify({
  mon: null, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null,
});

async function insertStaff(email: string, status = "available") {
  await env.DB.prepare(
    "INSERT INTO staff_users (email, role, created_at, status, schedule, last_heartbeat_at, ring_priority) VALUES (?, 'staff', ?, ?, ?, NULL, 100)"
  )
    .bind(email, Date.now(), status, CLOSED_SCHEDULE)
    .run();
}

describe("resolveRingTargets: on_call", () => {
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM staff_users");
    await env.DB.exec("DELETE FROM on_call_overrides");
    await env.DB.prepare("DELETE FROM settings WHERE key = 'on_call_rotation'").run();
    await env.DB.exec("DELETE FROM user_settings");
  });

  // The point of the whole feature. Before it, this returned [] and the caller heard voicemail.
  it("rings the rotation's person even though nobody is on shift", async () => {
    await insertStaff("tech@x.com");
    await setUserSettings(env.DB, "tech@x.com", { mobile_number: "0412 345 678" });
    await setOnCallRotation(env.DB, { members: ["tech@x.com"], anchorWeekStart: WEEK });

    // Same instant, same roster: the daytime target still finds nobody. That contrast IS the test.
    expect(await resolveRingTargets(env.DB, "all", AFTER_HOURS)).toEqual([]);
    expect(await resolveRingTargets(env.DB, "on_call", AFTER_HOURS)).toEqual(["pstn:tech@x.com|+61412345678"]);
  });

  // Ring-my-mobile is a daytime preference. On call, the mobile is used regardless: the softphone
  // leg depends on a backgrounded app being woken by a VoIP push, which is the weakest link in the
  // chain at 2am and the one iOS was killing outright on 2026-09-10.
  it("uses the mobile even when that person has ring-my-mobile switched off", async () => {
    await insertStaff("tech@x.com");
    await setUserSettings(env.DB, "tech@x.com", { mobile_number: "0412 345 678", ring_my_mobile: false });
    await setOnCallRotation(env.DB, { members: ["tech@x.com"], anchorWeekStart: WEEK });

    expect(await resolveRingTargets(env.DB, "on_call", AFTER_HOURS)).toEqual(["pstn:tech@x.com|+61412345678"]);
  });

  // `away` is sticky and meant for the working day. Honouring it here would let one forgotten
  // toggle at 4pm silently disable the entire after-hours rota, with the caller hearing voicemail
  // and nothing anywhere saying why.
  it("rings the on-call person even when their status is away or offline", async () => {
    await insertStaff("tech@x.com", "away");
    await setUserSettings(env.DB, "tech@x.com", { mobile_number: "0412345678" });
    await setOnCallRotation(env.DB, { members: ["tech@x.com"], anchorWeekStart: WEEK });
    expect(await resolveRingTargets(env.DB, "on_call", AFTER_HOURS)).toEqual(["pstn:tech@x.com|+61412345678"]);

    await env.DB.prepare("UPDATE staff_users SET status = 'offline' WHERE email = ?").bind("tech@x.com").run();
    expect(await resolveRingTargets(env.DB, "on_call", AFTER_HOURS)).toEqual(["pstn:tech@x.com|+61412345678"]);
  });

  it("gives the week to the override instead of the rotation when one is set", async () => {
    await insertStaff("rostered@x.com");
    await insertStaff("swapped@x.com");
    await setUserSettings(env.DB, "rostered@x.com", { mobile_number: "0412345678" });
    await setUserSettings(env.DB, "swapped@x.com", { mobile_number: "0499999999" });
    await setOnCallRotation(env.DB, { members: ["rostered@x.com"], anchorWeekStart: WEEK });

    expect(await resolveRingTargets(env.DB, "on_call", AFTER_HOURS)).toEqual(["pstn:rostered@x.com|+61412345678"]);
    await setOnCallOverride(env.DB, WEEK, "swapped@x.com", "admin@x.com");
    expect(await resolveRingTargets(env.DB, "on_call", AFTER_HOURS)).toEqual(["pstn:swapped@x.com|+61499999999"]);
  });

  // A rotation outlives the people in it. Dialling a number that is no longer ours would be worse
  // than voicemail, so this falls through -- loudly enough for Health Checks to report it.
  it("rings nobody when the rotation names someone who has left", async () => {
    await setOnCallRotation(env.DB, { members: ["departed@x.com"], anchorWeekStart: WEEK });
    expect(await resolveRingTargets(env.DB, "on_call", AFTER_HOURS)).toEqual([]);
  });

  it("rings nobody when no rotation has been set at all", async () => {
    await insertStaff("tech@x.com");
    expect(await resolveRingTargets(env.DB, "on_call", AFTER_HOURS)).toEqual([]);
  });

  // Better a handset that might be asleep than a caller sent to voicemail.
  it("falls back to the softphone when the on-call person has no mobile saved", async () => {
    await insertStaff("tech@x.com");
    await setOnCallRotation(env.DB, { members: ["tech@x.com"], anchorWeekStart: WEEK });
    expect(await resolveRingTargets(env.DB, "on_call", AFTER_HOURS)).toEqual(["client:tech@x.com"]);
  });

  // An unusable number is the same case: never drop the person over a typo.
  it("falls back to the softphone when the saved mobile is not dialable", async () => {
    await insertStaff("tech@x.com");
    await setUserSettings(env.DB, "tech@x.com", { mobile_number: "12" });
    await setOnCallRotation(env.DB, { members: ["tech@x.com"], anchorWeekStart: WEEK });
    expect(await resolveRingTargets(env.DB, "on_call", AFTER_HOURS)).toEqual(["client:tech@x.com"]);
  });

  // The demo account is excluded from the roster before anything else is considered, and being
  // named by a rotation must not be a way back in -- an Apple reviewer answering a real after-hours
  // customer is the exact scenario the exclusion exists to prevent.
  it("never rings an excluded demo account, even if the rotation names it", async () => {
    await insertStaff("reviewer@x.com");
    await setUserSettings(env.DB, "reviewer@x.com", { mobile_number: "0412345678" });
    await setOnCallRotation(env.DB, { members: ["reviewer@x.com"], anchorWeekStart: WEEK });
    expect(await resolveRingTargets(env.DB, "on_call", AFTER_HOURS, ["REVIEWER@x.com"])).toEqual([]);
  });

  // The rota advances on its own; that is the feature. This pins that the advance is real rather
  // than the first member being returned forever.
  it("hands over to the next person the following week", async () => {
    await insertStaff("a@x.com");
    await insertStaff("b@x.com");
    await setUserSettings(env.DB, "a@x.com", { mobile_number: "0411111111" });
    await setUserSettings(env.DB, "b@x.com", { mobile_number: "0422222222" });
    await setOnCallRotation(env.DB, { members: ["a@x.com", "b@x.com"], anchorWeekStart: WEEK });

    expect(await resolveRingTargets(env.DB, "on_call", AFTER_HOURS)).toEqual(["pstn:a@x.com|+61411111111"]);
    const nextWeek = new Date(AFTER_HOURS.getTime() + 7 * 86_400_000);
    expect(await resolveRingTargets(env.DB, "on_call", nextWeek)).toEqual(["pstn:b@x.com|+61422222222"]);
  });

  // resolveRingTargets is called from startRing, where a throw does not lose a feature -- it
  // escapes to the DO's catch-all, says "we're experiencing a technical issue" and HANGS UP on a
  // live customer. The fourth member of that family, joining callerId(), getStaffRoster and
  // getUserSettings.
  it("never throws when the overrides table is unreadable", async () => {
    await insertStaff("tech@x.com");
    await setUserSettings(env.DB, "tech@x.com", { mobile_number: "0412345678" });
    await setOnCallRotation(env.DB, { members: ["tech@x.com"], anchorWeekStart: WEEK });
    await env.DB.exec("ALTER TABLE on_call_overrides RENAME TO on_call_overrides_hidden");
    try {
      // And it must still RING. Overrides are empty 51 weeks a year, so one unreadable override
      // read used to throw away a perfectly good rotation and drop the whole rota -- the 2am caller
      // reaching voicemail while settings.on_call_rotation sat intact in D1 naming a reachable
      // tech. The two reads are guarded separately now: a failed override read degrades to "no swap
      // this week", which is the state it normally holds anyway.
      expect(await resolveRingTargets(env.DB, "on_call", AFTER_HOURS)).toEqual(["pstn:tech@x.com|+61412345678"]);
    } finally {
      await env.DB.exec("ALTER TABLE on_call_overrides_hidden RENAME TO on_call_overrides");
    }
  });

  // The rotation is the half that cannot be degraded around: unreadable means nobody is on call,
  // which falls through to the after-hours voicemail that was there before this feature existed.
  it("rings nobody, without throwing, when the rotation itself is unreadable", async () => {
    await insertStaff("tech@x.com");
    await setOnCallRotation(env.DB, { members: ["tech@x.com"], anchorWeekStart: WEEK });
    await env.DB.exec("ALTER TABLE settings RENAME TO settings_hidden");
    try {
      expect(await resolveRingTargets(env.DB, "on_call", AFTER_HOURS)).toEqual([]);
    } finally {
      await env.DB.exec("ALTER TABLE settings_hidden RENAME TO settings");
    }
  });
});
