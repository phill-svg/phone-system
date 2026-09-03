import { resolveSendingNumber } from "../src/lib/sendingNumber";

type Num = { e164: string; def: boolean };
const isDefault = (n: Num) => n.def;

const MAIN: Num = { e164: "+61866108941", def: true };
const SMS: Num = { e164: "+61485034869", def: false };
const PORTED: Num = { e164: "+61261059771", def: false };

describe("resolveSendingNumber", () => {
  it("uses the remembered number when it is still available", () => {
    expect(resolveSendingNumber([MAIN, SMS, PORTED], "+61261059771", isDefault)).toBe("+61261059771");
  });

  // The important case: a remembered number that has since been deleted or lost its capability
  // must not keep being used -- otherwise the app sends from a number the business no longer owns.
  it("ignores a remembered number that is no longer in the list", () => {
    expect(resolveSendingNumber([MAIN, SMS], "+61261059771", isDefault)).toBe("+61866108941");
  });

  it("falls back to the business default when nothing is remembered", () => {
    expect(resolveSendingNumber([SMS, MAIN], null, isDefault)).toBe("+61866108941");
  });

  it("falls back to the first number when there is no default", () => {
    expect(resolveSendingNumber([SMS, PORTED], null, isDefault)).toBe("+61485034869");
  });

  it("returns undefined when there are no numbers at all", () => {
    expect(resolveSendingNumber([], "+61261059771", isDefault)).toBeUndefined();
  });
});
