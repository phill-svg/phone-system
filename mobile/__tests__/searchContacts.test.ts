import { searchContacts } from "../src/lib/phone";
import type { Contact } from "../src/lib/api";

function contact(over: Partial<Contact>): Contact {
  return { id: 1, name: "", company: null, phone: "", phone_normalized: "", ...over };
}

const MARION = contact({ id: 1, name: "Marion Kelly", phone: "+61491570006", phone_normalized: "61491570006" });
const CAFE = contact({ id: 2, name: "Braddon Cafe", company: "Braddon Cafe", phone: "+61255501234", phone_normalized: "61255501234" });
const DEV = contact({ id: 3, name: "Dev Patel", phone: "+61491570156", phone_normalized: "61491570156" });
const ALL = [MARION, CAFE, DEV];

describe("searchContacts", () => {
  // The whole point: a phone-number-only field could never find someone by typing their name.
  it("matches by name", () => {
    expect(searchContacts("marion", ALL)).toEqual([MARION]);
  });

  it("matches by company", () => {
    expect(searchContacts("braddon", ALL)).toEqual([CAFE]);
  });

  it("matches by digits, regardless of formatting", () => {
    expect(searchContacts("0491 570 156", ALL)).toEqual([DEV]);
  });

  it("is case-insensitive", () => {
    expect(searchContacts("DEV", ALL)).toEqual([DEV]);
  });

  it("returns everything for an empty query, so a picker can show the full list on focus", () => {
    expect(searchContacts("", ALL)).toEqual(ALL);
    expect(searchContacts("   ", ALL)).toEqual(ALL);
  });

  it("requires at least two digits before matching on number, so a lone digit in a name isn't a false positive", () => {
    // "1" appears in Marion's number but is too short a digit query to match on number alone, and
    // it isn't in anyone's name either.
    expect(searchContacts("1", ALL)).toEqual([]);
  });

  it("returns no matches for an unrelated query", () => {
    expect(searchContacts("zzz", ALL)).toEqual([]);
  });
});
