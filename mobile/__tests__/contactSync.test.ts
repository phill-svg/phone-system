/// <reference types="jest" />
/// <reference types="node" />

jest.mock("../src/lib/session");
import * as session from "../src/lib/session";
import { lookupServiceM8Contacts, saveServiceM8Contacts, type ServiceM8LookupPage } from "../src/lib/api";
import { lookupAllInServiceM8 } from "../src/lib/contactSync";

// Admin > Sync Contacts on the handset: the same paging rule as the web page, against the same
// admin-only routes.

const okJson = (body: unknown, status = 200) =>
  Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body), text: () => Promise.resolve("") } as Response);

const page = (p: Partial<ServiceM8LookupPage>): ServiceM8LookupPage => ({
  matches: [],
  checked: 0,
  failed: 0,
  total: 0,
  remaining: 0,
  next: null,
  ...p,
});

describe("lookupAllInServiceM8", () => {
  it("asks for the next batch until there is none, collecting every match", async () => {
    const sue = { phone: "+61400000001", name: "Sue", lastSeen: 1 };
    const jo = { phone: "+61400000020", name: "Jo", lastSeen: 2 };
    const pages = [
      page({ matches: [sue], checked: 15, total: 20, remaining: 5, next: "+61400000015" }),
      page({ matches: [jo], checked: 5, total: 20, remaining: 0, next: null, failed: 1 }),
    ];
    const asked: (string | null)[] = [];
    const progress: [number, number][] = [];

    const result = await lookupAllInServiceM8(
      async (after) => {
        asked.push(after);
        return pages.shift()!;
      },
      (done, total) => progress.push([done, total])
    );

    expect(result).toEqual({ matches: [sue, jo], failed: 1, checked: 20 });
    expect(asked).toEqual([null, "+61400000015"]);
    expect(progress[progress.length - 1]).toEqual([20, 20]);
  });

  // A cursor that does not move would search ServiceM8 forever.
  it("stops rather than loop when the cursor does not advance", async () => {
    let calls = 0;
    await expect(
      lookupAllInServiceM8(async () => {
        calls++;
        return page({ checked: 15, remaining: 25, next: "+61400000015" });
      }, () => {})
    ).rejects.toThrow();
    expect(calls).toBe(2);
  });
});

describe("Sync Contacts api client", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (session.getToken as jest.Mock).mockResolvedValue("tok");
  });

  it("looks up through the admin-only route, sending the cursor only when there is one", async () => {
    const fetchMock = jest.fn().mockReturnValue(okJson(page({})));
    (global as any).fetch = fetchMock;

    await lookupServiceM8Contacts(null);
    await lookupServiceM8Contacts("+61400000015");

    const [url1, init1] = fetchMock.mock.calls[0];
    const [, init2] = fetchMock.mock.calls[1];
    expect(url1).toMatch(/\/api\/admin\/servicem8\/contact-lookup$/);
    expect(init1.method).toBe("POST");
    expect(JSON.parse(init1.body)).toEqual({});
    expect(JSON.parse(init2.body)).toEqual({ after: "+61400000015" });
  });

  it("saves only the ticked contacts, as phone and name", async () => {
    const fetchMock = jest.fn().mockReturnValue(okJson({ saved: 1, skipped: 0 }));
    (global as any).fetch = fetchMock;

    const result = await saveServiceM8Contacts([{ phone: "+61400000001", name: "Sue" }]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/admin\/servicem8\/contact-save$/);
    expect(JSON.parse(init.body)).toEqual({ contacts: [{ phone: "+61400000001", name: "Sue" }] });
    expect(result).toEqual({ saved: 1, skipped: 0 });
  });
});
