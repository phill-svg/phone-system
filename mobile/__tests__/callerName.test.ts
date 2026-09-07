/// <reference types="jest" />
import { contactForNumber } from "../src/lib/phone";
import type { Contact } from "../src/lib/api";

// Twilio hands us the caller as E.164 (+61402430107); contacts are stored however they were typed
// or created. Both sides go through normalizePhone, and this is the join the ringing and in-call
// screens depend on to name a caller -- which they never actually did until now.
const contact = (id: number, name: string, phone: string, normalized: string): Contact => ({
  id,
  name,
  company: null,
  phone,
  phone_normalized: normalized,
});

const BOOK: Contact[] = [
  contact(1, "Sue Dunkley", "+61402430107", "61402430107"),
  contact(2, "Renji Mathew", "0415 619 306", "61415619306"),
  contact(3, "TCB Office", "(02) 6105 9771", "61261059771"),
];

describe("contactForNumber", () => {
  it("names an inbound caller arriving in E.164, however the contact was stored", () => {
    expect(contactForNumber("+61402430107", BOOK)?.name).toBe("Sue Dunkley");
    expect(contactForNumber("+61415619306", BOOK)?.name).toBe("Renji Mathew");
    expect(contactForNumber("+61261059771", BOOK)?.name).toBe("TCB Office");
  });

  it("matches the same person dialled in local form", () => {
    expect(contactForNumber("0402 430 107", BOOK)?.name).toBe("Sue Dunkley");
    expect(contactForNumber("0402430107", BOOK)?.name).toBe("Sue Dunkley");
  });

  it("returns nothing for a caller who isn't in the book, rather than a wrong name", () => {
    expect(contactForNumber("+61499999999", BOOK)).toBeUndefined();
    expect(contactForNumber("", BOOK)).toBeUndefined();
    expect(contactForNumber("+61402430107", [])).toBeUndefined();
  });

  it("prefers an exact match over a suffix one", () => {
    const book = [contact(9, "Suffix Only", "430107", "430107"), ...BOOK];
    expect(contactForNumber("+61402430107", book)?.name).toBe("Sue Dunkley");
  });
});
