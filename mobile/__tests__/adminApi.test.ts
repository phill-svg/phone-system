/// <reference types="jest" />
/// <reference types="node" />

jest.mock("../src/lib/session");
import * as session from "../src/lib/session";
import {
  CLOSED_WEEK,
  getAdminStaff,
  setBusinessHours,
  setCallBlocklist,
  setStaffSchedule,
  setStaffRingPriority,
  setStaffAvailability,
  sendStaffPasswordReset,
  removeStaff,
  inviteStaff,
  updateNumber,
} from "../src/lib/api";
import { toE164 } from "../src/lib/phone";

const okJson = (body: unknown, status = 200) =>
  Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body), text: () => Promise.resolve("") } as Response);

function mockFetch(body: unknown = { ok: true }) {
  const fetchMock = jest.fn().mockReturnValue(okJson(body));
  (global as any).fetch = fetchMock as any;
  return fetchMock;
}

function lastCall(fetchMock: jest.Mock) {
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return { url: url as string, init: (init ?? {}) as RequestInit };
}

describe("admin api client", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (session.getToken as jest.Mock).mockResolvedValue("tok");
  });

  it("reads the full staff list from the admin-only path", async () => {
    const fetchMock = mockFetch([]);
    await getAdminStaff();
    const { url, init } = lastCall(fetchMock);
    // /api/staff is the transfer picker's roster and carries none of this; the admin path is the
    // one the server gates on role.
    expect(url).toContain("/api/admin/staff");
    expect(init.method).toBeUndefined();
  });

  it("PUTs the whole schedule for business hours (the API replaces, it does not merge)", async () => {
    const fetchMock = mockFetch();
    await setBusinessHours({ ...CLOSED_WEEK, mon: { open: "09:00", close: "17:00" } });
    const { url, init } = lastCall(fetchMock);
    expect(url).toContain("/api/settings/business-hours");
    expect(init.method).toBe("PUT");
    expect(Object.keys(JSON.parse(init.body as string))).toHaveLength(7);
  });

  it("PUTs the blocklist as a bare array", async () => {
    const fetchMock = mockFetch();
    await setCallBlocklist(["+61400123456"]);
    const { init } = lastCall(fetchMock);
    expect(JSON.parse(init.body as string)).toEqual(["+61400123456"]);
  });

  it("encodes the email in every per-staff path", async () => {
    const email = "a+b@example.com";
    const encoded = encodeURIComponent(email);

    let fetchMock = mockFetch();
    await setStaffSchedule(email, CLOSED_WEEK);
    expect(lastCall(fetchMock).url).toContain(`/api/staff/${encoded}/schedule`);

    fetchMock = mockFetch();
    await setStaffRingPriority(email, 20);
    expect(lastCall(fetchMock).url).toContain(`/api/staff/${encoded}/priority`);
    expect(JSON.parse(lastCall(fetchMock).init.body as string)).toEqual({ priority: 20 });

    fetchMock = mockFetch();
    await setStaffAvailability(email, "away");
    expect(lastCall(fetchMock).url).toContain(`/api/staff/${encoded}/status`);
    expect(JSON.parse(lastCall(fetchMock).init.body as string)).toEqual({ status: "away" });

    fetchMock = mockFetch();
    await sendStaffPasswordReset(email);
    expect(lastCall(fetchMock).url).toContain(`/api/staff/${encoded}/reset`);
    expect(lastCall(fetchMock).init.method).toBe("POST");

    fetchMock = mockFetch();
    await removeStaff(email);
    expect(lastCall(fetchMock).url).toContain(`/api/staff/${encoded}`);
    expect(lastCall(fetchMock).init.method).toBe("DELETE");
  });

  it("invites with email + role", async () => {
    const fetchMock = mockFetch();
    await inviteStaff("new@example.com", "admin");
    const { url, init } = lastCall(fetchMock);
    expect(url).toContain("/api/staff");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ email: "new@example.com", role: "admin" });
  });

  it("sends every number field on update, since the API replaces the row", async () => {
    const fetchMock = mockFetch();
    await updateNumber(7, {
      e164: "+61261059771",
      label: "Landline",
      voice_enabled: true,
      sms_enabled: false,
      is_default_voice: true,
      is_default_sms: false,
      region: "au1",
    });
    const { url, init } = lastCall(fetchMock);
    expect(url).toContain("/api/numbers/7");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toMatchObject({ label: "Landline", voice_enabled: true, region: "au1" });
  });
});

describe("toE164", () => {
  it("stores what Twilio reports as the caller, so the blocklist can match it literally", () => {
    expect(toE164("0400 123 456")).toBe("+61400123456");
    expect(toE164("+61 400 123 456")).toBe("+61400123456");
    expect(toE164("61400123456")).toBe("+61400123456");
    expect(toE164("")).toBe("");
  });
});
