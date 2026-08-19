/// <reference types="jest" />

jest.mock("../src/lib/session");
import * as session from "../src/lib/session";
import { getCalls, getCallDetail, getCallbackRequests, recordingUri } from "../src/lib/api";

const okJson = (body: unknown, status = 200) =>
  Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body), text: () => Promise.resolve("") } as Response);

describe("dashboard api", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (session.getToken as jest.Mock).mockResolvedValue("tok123");
  });

  it("getCalls fetches /api/calls with the Bearer header", async () => {
    const fetchMock = jest.fn().mockReturnValue(okJson([{ id: "CA1", caller_number: "+61400", called_number: "+61866", started_at: 1, status: "completed", direction: "inbound" }]));
    (global as any).fetch = fetchMock;
    const calls = await getCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe("CA1");
    expect(fetchMock.mock.calls[0][0]).toContain("/api/calls");
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer tok123" });
  });

  it("getCallDetail fetches /api/calls/:id (url-encoded) and returns call+events", async () => {
    const fetchMock = jest.fn().mockReturnValue(okJson({ call: { id: "CA 1" }, events: [{ id: 1, call_id: "CA 1", ts: 2, event_type: "answered", detail: null }] }));
    (global as any).fetch = fetchMock;
    const detail = await getCallDetail("CA 1");
    expect(detail.call.id).toBe("CA 1");
    expect(detail.events).toHaveLength(1);
    expect(fetchMock.mock.calls[0][0]).toContain("/api/calls/CA%201");
  });

  it("getCallbackRequests fetches /api/callback-requests", async () => {
    const fetchMock = jest.fn().mockReturnValue(okJson([{ id: 1, call_id: "CA1", caller_number: "+61400", requested_at: 3, status: "open" }]));
    (global as any).fetch = fetchMock;
    const cbs = await getCallbackRequests();
    expect(cbs[0].status).toBe("open");
    expect(fetchMock.mock.calls[0][0]).toContain("/api/callback-requests");
  });

  it("recordingUri builds an absolute proxy URL for the call", () => {
    expect(recordingUri("CA 1")).toMatch(/\/api\/calls\/CA%201\/recording$/);
    expect(recordingUri("CA1")).toMatch(/^https?:\/\//);
  });
});
