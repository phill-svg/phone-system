/// <reference types="jest" />
jest.mock("../src/lib/session");
import * as session from "../src/lib/session";
import { ApiError, sendMessage } from "../src/lib/api";
import { sendFailureAlert, loginErrorMessage } from "../src/lib/apiErrors";

const jsonRes = (body: unknown, status: number) =>
  Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) } as Response);

beforeEach(() => { (session.getToken as jest.Mock).mockResolvedValue(null); });

// Every failed send used to read "Not connected yet -- messaging turns on once your TCB number is
// linked", including a Twilio rejection and plain no-signal, because sendMessage swallowed the
// error into `false` and the screen had nothing else to go on.
describe("sendMessage", () => {
  it("rejects with the server's own reason instead of swallowing it", async () => {
    (global as any).fetch = jest.fn().mockReturnValue(jsonRes({ error: "Could not send the message." }, 502));
    const err = await sendMessage("0412345678", "hi").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe("Could not send the message.");
  });
});

describe("sendFailureAlert", () => {
  it("keeps 'Not connected yet' for SMS that is genuinely not configured", () => {
    expect(sendFailureAlert(new ApiError(500, "SMS is not configured.")).title).toBe("Not connected yet");
    expect(sendFailureAlert(new ApiError(500, "Messenger sending is not configured.")).title).toBe("Not connected yet");
  });

  it("shows the real reason for any other server rejection", () => {
    const a = sendFailureAlert(new ApiError(502, "Could not send the message."));
    expect(a.title).toBe("Couldn't send");
    expect(a.message).toContain("Could not send the message.");
    // A 500 from anywhere else must not read as "SMS isn't linked".
    expect(sendFailureAlert(new ApiError(500, "request failed (500)")).title).toBe("Couldn't send");
  });

  it("says it is a connection problem when the request never reached the server", () => {
    const a = sendFailureAlert(new TypeError("Network request failed"));
    expect(a.title).toBe("Couldn't send");
    expect(a.message).toMatch(/connection/i);
  });
});

// Every sign-in failure read "Invalid email or password." -- including the 429 lockout, which sent
// people retrying a correct password into a longer lockout, and having no signal at all.
describe("loginErrorMessage", () => {
  it("keeps the generic text for wrong credentials", () => {
    expect(loginErrorMessage(new ApiError(401, "unauthorized"))).toBe("Invalid email or password.");
  });

  it("passes any other server reason through, e.g. the lockout", () => {
    expect(loginErrorMessage(new ApiError(429, "Too many attempts. Try again in a few minutes."))).toBe(
      "Too many attempts. Try again in a few minutes."
    );
  });

  it("says it is a connection problem when the server was never reached", () => {
    expect(loginErrorMessage(new TypeError("Network request failed"))).toMatch(/connection/i);
  });
});
