import { describe, expect, it } from "vitest";
import { renderMessagesPage } from "../../src/html/pages/messages";

const html = renderMessagesPage();

// The page ships its client code as one inline <script> built by string concatenation, so a stray
// quote or escape breaks the whole Messages page at runtime with nothing failing at build time.
// (The layout injects scripts of its own, so anchor on this page's first statement.)
function clientJs(): string {
  const at = html.indexOf("var current = null;");
  expect(at).toBeGreaterThan(-1);
  const open = html.lastIndexOf("<script>", at);
  const close = html.indexOf("</script>", at);
  return html.slice(open + "<script>".length, close);
}

describe("messages page client JS", () => {
  it("parses as JavaScript", () => {
    expect(() => new Function(clientJs())).not.toThrow();
  });
});

describe("SMS vs Messenger are told apart", () => {
  it("tags every conversation with its channel", () => {
    const js = clientJs();
    expect(js).toContain('function isMessenger(number){ return String(number==null?"":number).indexOf("messenger:")===0; }');
    // Both branches exist: a Messenger conversation is labelled, and so is an SMS one.
    expect(js).toContain('class=\\"chan chan-fb\\">Messenger<');
    expect(js).toContain('class=\\"chan chan-sms\\">SMS<');
    // The chip is rendered in the list rows and above the open thread.
    expect(js).toContain("+chanChip(c.number)+");
    expect(js).toContain('"</strong></span>"+chanChip(number)');
    expect(js).toContain('"</strong>"+chanChip(number)');
    expect(html).toContain(".chan-fb {");
    expect(html).toContain(".chan-sms {");
  });

  it("replies to a Messenger thread say so instead of offering an SMS number", () => {
    expect(clientJs()).toContain('fb.textContent="Replying via Facebook Messenger"');
  });

  it("never runs a Messenger PSID through the phone-number helpers", () => {
    const js = clientJs();
    expect(js).toContain('function label(c){ if(isMessenger(c.number)) return c.name||"Facebook user"; ');
    expect(js).toContain("var c=isMessenger(number)?null:contactsByNorm[normalizePhoneJS(number)];");
  });
});

describe("Messenger senders with no name", () => {
  it("offers to fetch names, and only while some sender is missing one", () => {
    const js = clientJs();
    expect(js).toContain("if(isMessenger(list[i].number)&&!list[i].name) missing++;");
    expect(js).toContain('bar.style.display=missing?"flex":"none"');
    expect(js).toContain('api("/api/facebook/resolve-names",{method:"POST"})');
    expect(html).toContain('id="fbNamesBtn"');
  });

  it("repeats Facebook's own objection rather than a generic failure", () => {
    const js = clientJs();
    expect(js).toContain('"Facebook could not name "');
    expect(js).toContain("bad[0].error");
    expect(js).toContain("FB_PAGE_ACCESS_TOKEN");
  });
});

describe("naming a Messenger sender by hand", () => {
  it("offers the button on Messenger threads only, labelled for the state it is in", () => {
    const js = clientJs();
    expect(js).toContain('if(isMessenger(number))addFbNameButton(number,disp!=="Facebook user")');
    expect(js).toContain('b.textContent=named?"Rename":"Add name"');
  });

  it("saves through the API and refreshes what the page shows", () => {
    const js = clientJs();
    expect(js).toContain('api("/api/facebook/name",{method:"PUT",body:JSON.stringify({psid:number,name:name})})');
    expect(js).toContain("loadConversations();openThread(number,name);");
  });

  it("does not prefill the placeholder as if it were their name", () => {
    expect(clientJs()).toContain('if(cur==="Facebook user")cur="";');
  });

  it("renames through the in-page editor, not a browser prompt", () => {
    const js = clientJs();
    expect(js).toContain('headEditor("Facebook contact"');
  });
});

// A native prompt()/dialog reads as the browser talking, not the app, and cannot be styled or
// placed. Every flow that used to open one now edits in place instead.
describe("no native browser dialogs for input", () => {
  it("uses no prompt() anywhere in the page's client JS", () => {
    expect(clientJs()).not.toContain("prompt(");
  });

  it("starts a new message with an inline To field", () => {
    const js = clientJs();
    expect(js).toContain('input.id="toInput"');
    expect(js).toContain('input.setAttribute("list","contactNumbers")');
    expect(js).toContain('lbl.textContent="To"');
  });

  it("exposes a contacts datalist for the To field to autocomplete against", () => {
    expect(html).toContain('<datalist id="contactNumbers"></datalist>');
    expect(clientJs()).toContain("function fillContactDatalist()");
  });

  it("sends to the typed number when no thread is open yet", () => {
    const js = clientJs();
    expect(js).toContain('var to=current||(ti?(ti.value||"").trim():"");');
    expect(js).toContain("if(fresh){openThread(to);}");
  });
});

describe("saving a contact from a thread", () => {
  it("offers the button only on SMS threads whose number is not already a contact", () => {
    // openThread's else-branch is the "no known contact" case; Messenger peers are excluded
    // because they have no phone number to save.
    expect(clientJs()).toContain("if(!isMessenger(number))addSaveContactButton(number);");
  });

  it("posts the new contact and refreshes the thread once saved", () => {
    const js = clientJs();
    expect(js).toContain('api("/api/contacts",{method:"POST",body:JSON.stringify({name:name,phone:number})})');
    expect(js).toContain("return loadContacts();");
  });
});
