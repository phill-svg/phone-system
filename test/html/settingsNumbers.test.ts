import { describe, expect, it } from "vitest";
import { renderSettingsPage } from "../../src/html/pages/settings";

const leadingArgs = [/* schedule */ {}, /* blocklist */ [], /* staffRoster */ []] as [any, any, any];
const adminPage = () => renderSettingsPage(...leadingArgs, [], "admin");

describe("phone numbers region control", () => {
  it("offers a region on each row and on the add form", () => {
    const html = adminPage();
    expect(html).toContain('<select id="num-add-region">');
    expect(html).toContain('<option value="au1">au1 (Australia)</option>');
    expect(html).toContain('<option value="us1">us1 (United States)</option>');
    expect(html).toContain("region.value = n.region || ''");
  });

  // Every number added through this page used to be saved with region NULL, because the add form
  // never sent one and Save echoed the stored value straight back.
  it("sends the chosen region when adding and when saving", () => {
    const html = adminPage();
    expect(html).toContain("region: document.getElementById('num-add-region').value");
    expect(html).toContain("region: region.value || null");
    expect(html).not.toContain("region: n.region }");
  });

  // Inbound calls are processed in the number's Twilio region and the softphone only registers in
  // au1, so a Voice number pointed elsewhere silently never rings -- the failure that cost a day
  // on the ported landline.
  it("warns when a voice number is not in au1", () => {
    const html = adminPage();
    expect(html).toContain("inbound calls won't ring the app");
    expect(html).toContain("voice._input.checked && region.value && region.value !== 'au1'");
    expect(html).toContain("region.addEventListener('change', syncWarn)");
  });

  it("keeps the numbers section admin-only", () => {
    expect(renderSettingsPage(...leadingArgs, [], "staff")).not.toContain('id="num-add-region"');
  });
});
