import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOutboundCall, cancelCall } from "../../src/twilio/restClient";

const ACCOUNT_SID = "ACabcd1234efgh5678ijkl9012";
const AUTH_TOKEN = "auth-token-secret";
const CALL_SID = "CAcall1234sid5678";

describe("Twilio REST client", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  describe("createOutboundCall", () => {
    it("sends POST request to correct Twilio API endpoint", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ sid: CALL_SID }), { status: 201 })
      );

      await createOutboundCall(ACCOUNT_SID, AUTH_TOKEN, {
        to: "+61412345678",
        from: "+61234567890",
        url: "https://example.com/twiml",
      });

      expect(fetchMock).toHaveBeenCalledOnce();
      const call = fetchMock.mock.calls[0]!;
      expect(call[0]).toBe(
        `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Calls.json`
      );
    });

    it("uses POST method", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ sid: CALL_SID }), { status: 201 })
      );

      await createOutboundCall(ACCOUNT_SID, AUTH_TOKEN, {
        to: "+61412345678",
        from: "+61234567890",
        url: "https://example.com/twiml",
      });

      const call = fetchMock.mock.calls[0]!;
      const options = call[1] as RequestInit;
      expect(options.method).toBe("POST");
    });

    it("sends Basic Auth header with correct base64-encoded credentials", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ sid: CALL_SID }), { status: 201 })
      );

      await createOutboundCall(ACCOUNT_SID, AUTH_TOKEN, {
        to: "+61412345678",
        from: "+61234567890",
        url: "https://example.com/twiml",
      });

      const call = fetchMock.mock.calls[0]!;
      const options = call[1] as RequestInit;
      const authHeader = options.headers as Record<string, string>;
      const expectedAuth = `Basic ${btoa(`${ACCOUNT_SID}:${AUTH_TOKEN}`)}`;
      expect(authHeader.Authorization).toBe(expectedAuth);

      // Verify base64 decoding
      const decodedAuth = atob(expectedAuth.replace("Basic ", ""));
      expect(decodedAuth).toBe(`${ACCOUNT_SID}:${AUTH_TOKEN}`);
    });

    it("sets Content-Type to application/x-www-form-urlencoded", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ sid: CALL_SID }), { status: 201 })
      );

      await createOutboundCall(ACCOUNT_SID, AUTH_TOKEN, {
        to: "+61412345678",
        from: "+61234567890",
        url: "https://example.com/twiml",
      });

      const call = fetchMock.mock.calls[0]!;
      const options = call[1] as RequestInit;
      const headers = options.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    });

    it("sends required form body fields: To, From, Url", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ sid: CALL_SID }), { status: 201 })
      );

      const to = "+61412345678";
      const from = "+61234567890";
      const url = "https://example.com/twiml";

      await createOutboundCall(ACCOUNT_SID, AUTH_TOKEN, {
        to,
        from,
        url,
      });

      const call = fetchMock.mock.calls[0]!;
      const options = call[1] as RequestInit;
      const bodyStr = options.body as string;
      const params = new URLSearchParams(bodyStr);

      expect(params.get("To")).toBe(to);
      expect(params.get("From")).toBe(from);
      expect(params.get("Url")).toBe(url);
    });

    it("includes StatusCallback when provided", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ sid: CALL_SID }), { status: 201 })
      );

      const statusCallback = "https://example.com/status";

      await createOutboundCall(ACCOUNT_SID, AUTH_TOKEN, {
        to: "+61412345678",
        from: "+61234567890",
        url: "https://example.com/twiml",
        statusCallback,
      });

      const call = fetchMock.mock.calls[0]!;
      const options = call[1] as RequestInit;
      const bodyStr = options.body as string;
      const params = new URLSearchParams(bodyStr);

      expect(params.get("StatusCallback")).toBe(statusCallback);
    });

    it("omits StatusCallback when not provided", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ sid: CALL_SID }), { status: 201 })
      );

      await createOutboundCall(ACCOUNT_SID, AUTH_TOKEN, {
        to: "+61412345678",
        from: "+61234567890",
        url: "https://example.com/twiml",
      });

      const call = fetchMock.mock.calls[0]!;
      const options = call[1] as RequestInit;
      const bodyStr = options.body as string;
      const params = new URLSearchParams(bodyStr);

      expect(params.get("StatusCallback")).toBeNull();
    });

    it("includes StatusCallbackEvent as comma-separated list when provided", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ sid: CALL_SID }), { status: 201 })
      );

      const events = ["initiated", "ringing", "answered"];

      await createOutboundCall(ACCOUNT_SID, AUTH_TOKEN, {
        to: "+61412345678",
        from: "+61234567890",
        url: "https://example.com/twiml",
        statusCallbackEvent: events,
      });

      const call = fetchMock.mock.calls[0]!;
      const options = call[1] as RequestInit;
      const bodyStr = options.body as string;
      const params = new URLSearchParams(bodyStr);

      expect(params.get("StatusCallbackEvent")).toBe("initiated,ringing,answered");
    });

    it("omits StatusCallbackEvent when not provided", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ sid: CALL_SID }), { status: 201 })
      );

      await createOutboundCall(ACCOUNT_SID, AUTH_TOKEN, {
        to: "+61412345678",
        from: "+61234567890",
        url: "https://example.com/twiml",
      });

      const call = fetchMock.mock.calls[0]!;
      const options = call[1] as RequestInit;
      const bodyStr = options.body as string;
      const params = new URLSearchParams(bodyStr);

      expect(params.get("StatusCallbackEvent")).toBeNull();
    });

    it("returns parsed sid on success (2xx response)", async () => {
      const expectedSid = "CAcall1234567890abcdef";
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ sid: expectedSid }), { status: 201 })
      );

      const result = await createOutboundCall(ACCOUNT_SID, AUTH_TOKEN, {
        to: "+61412345678",
        from: "+61234567890",
        url: "https://example.com/twiml",
      });

      expect(result).toEqual({ sid: expectedSid });
    });

    it("throws descriptive error on non-2xx response", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ error: "Invalid account" }), { status: 401 })
      );

      await expect(
        createOutboundCall(ACCOUNT_SID, AUTH_TOKEN, {
          to: "+61412345678",
          from: "+61234567890",
          url: "https://example.com/twiml",
        })
      ).rejects.toThrow("Twilio create-call failed: 401");
    });

    it("throws on 400 Bad Request", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ error: "Invalid To parameter" }), { status: 400 })
      );

      await expect(
        createOutboundCall(ACCOUNT_SID, AUTH_TOKEN, {
          to: "invalid",
          from: "+61234567890",
          url: "https://example.com/twiml",
        })
      ).rejects.toThrow("Twilio create-call failed: 400");
    });

    it("throws on 500 Server Error", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ error: "Internal server error" }), { status: 500 })
      );

      await expect(
        createOutboundCall(ACCOUNT_SID, AUTH_TOKEN, {
          to: "+61412345678",
          from: "+61234567890",
          url: "https://example.com/twiml",
        })
      ).rejects.toThrow("Twilio create-call failed: 500");
    });
  });

  describe("cancelCall", () => {
    it("sends POST request to correct Twilio API endpoint", async () => {
      fetchMock.mockResolvedValue(new Response("", { status: 200 }));

      await cancelCall(ACCOUNT_SID, AUTH_TOKEN, CALL_SID);

      expect(fetchMock).toHaveBeenCalledOnce();
      const call = fetchMock.mock.calls[0]!;
      expect(call[0]).toBe(
        `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Calls/${CALL_SID}.json`
      );
    });

    it("uses POST method", async () => {
      fetchMock.mockResolvedValue(new Response("", { status: 200 }));

      await cancelCall(ACCOUNT_SID, AUTH_TOKEN, CALL_SID);

      const call = fetchMock.mock.calls[0]!;
      const options = call[1] as RequestInit;
      expect(options.method).toBe("POST");
    });

    it("sends Basic Auth header with correct base64-encoded credentials", async () => {
      fetchMock.mockResolvedValue(new Response("", { status: 200 }));

      await cancelCall(ACCOUNT_SID, AUTH_TOKEN, CALL_SID);

      const call = fetchMock.mock.calls[0]!;
      const options = call[1] as RequestInit;
      const authHeader = options.headers as Record<string, string>;
      const expectedAuth = `Basic ${btoa(`${ACCOUNT_SID}:${AUTH_TOKEN}`)}`;
      expect(authHeader.Authorization).toBe(expectedAuth);

      // Verify base64 decoding
      const decodedAuth = atob(expectedAuth.replace("Basic ", ""));
      expect(decodedAuth).toBe(`${ACCOUNT_SID}:${AUTH_TOKEN}`);
    });

    it("sets Content-Type to application/x-www-form-urlencoded", async () => {
      fetchMock.mockResolvedValue(new Response("", { status: 200 }));

      await cancelCall(ACCOUNT_SID, AUTH_TOKEN, CALL_SID);

      const call = fetchMock.mock.calls[0]!;
      const options = call[1] as RequestInit;
      const headers = options.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    });

    it("sends Status=canceled in form body", async () => {
      fetchMock.mockResolvedValue(new Response("", { status: 200 }));

      await cancelCall(ACCOUNT_SID, AUTH_TOKEN, CALL_SID);

      const call = fetchMock.mock.calls[0]!;
      const options = call[1] as RequestInit;
      const bodyStr = options.body as string;
      const params = new URLSearchParams(bodyStr);

      expect(params.get("Status")).toBe("canceled");
    });

    it("returns void on success (2xx response)", async () => {
      fetchMock.mockResolvedValue(new Response("", { status: 200 }));

      const result = await cancelCall(ACCOUNT_SID, AUTH_TOKEN, CALL_SID);

      expect(result).toBeUndefined();
    });

    it("throws descriptive error on non-2xx response (401)", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })
      );

      await expect(cancelCall(ACCOUNT_SID, AUTH_TOKEN, CALL_SID)).rejects.toThrow(
        "Twilio cancel-call failed: 401"
      );
    });

    it("throws descriptive error on non-2xx response (404)", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ error: "Call not found" }), { status: 404 })
      );

      await expect(cancelCall(ACCOUNT_SID, AUTH_TOKEN, CALL_SID)).rejects.toThrow(
        "Twilio cancel-call failed: 404"
      );
    });

    it("throws descriptive error on non-2xx response (500)", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ error: "Internal server error" }), { status: 500 })
      );

      await expect(cancelCall(ACCOUNT_SID, AUTH_TOKEN, CALL_SID)).rejects.toThrow(
        "Twilio cancel-call failed: 500"
      );
    });
  });
});
