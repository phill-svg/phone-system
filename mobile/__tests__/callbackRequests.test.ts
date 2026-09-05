/// <reference types="jest" />
/// <reference types="node" />

/**
 * The callback list is the only place staff can clear a request, so the two things worth pinning
 * are the wire call the tick makes and the split into "open work queue" vs "handled history".
 * A request that silently stayed open after a tick would be indistinguishable from one nobody
 * actioned -- which is the exact failure the Inbox screen exists to end.
 */
jest.mock("../src/lib/session");
import * as session from "../src/lib/session";
import { getCallbackRequests, setCallbackRequestStatus, type CallbackRequest } from "../src/lib/api";

const okJson = (body: unknown, status = 200) =>
  Promise.resolve({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(""),
  } as Response);

function request(over: Partial<CallbackRequest> = {}): CallbackRequest {
  return {
    id: 1,
    call_id: "CA-1",
    caller_number: "+61400000001",
    requested_at: 1_700_000_000_000,
    status: "open",
    done_at: null,
    done_by: null,
    ...over,
  };
}

describe("callback requests api", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (session.getToken as jest.Mock).mockResolvedValue("tok");
  });

  it("marking a request done PUTs the new status to that request's id", async () => {
    const fetchMock = jest.fn().mockReturnValue(okJson({ ok: true }));
    (global as any).fetch = fetchMock as any;

    await setCallbackRequestStatus(7, "done");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/callback-requests/7");
    expect((init as RequestInit).method).toBe("PUT");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ status: "done" });
  });

  it("reopening sends status open, so an accidental tick is recoverable", async () => {
    const fetchMock = jest.fn().mockReturnValue(okJson({ ok: true }));
    (global as any).fetch = fetchMock as any;

    await setCallbackRequestStatus(7, "open");

    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({ status: "open" });
  });

  it("returns open and handled requests together for the caller to split", async () => {
    const rows = [
      request({ id: 1, status: "open" }),
      request({ id: 2, status: "done", done_at: 1_700_000_100_000, done_by: "phill@tcbpestcontrolcanberra.com.au" }),
    ];
    (global as any).fetch = jest.fn().mockReturnValue(okJson(rows)) as any;

    const result = await getCallbackRequests();

    expect(result.filter((r) => r.status === "open").map((r) => r.id)).toEqual([1]);
    const done = result.filter((r) => r.status === "done");
    expect(done.map((r) => r.id)).toEqual([2]);
    // The history line needs both of these; without them a completed row cannot say who or when.
    expect(done[0].done_by).toBe("phill@tcbpestcontrolcanberra.com.au");
    expect(done[0].done_at).toBe(1_700_000_100_000);
  });
});
