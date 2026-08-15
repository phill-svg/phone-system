import { describe, expect, it } from "vitest";
import { renderSettingsPage } from "../../src/html/pages/settings";

// Leading args match the current renderSettingsPage signature:
// (schedule: BusinessHoursSchedule, blocklist: string[], staffRoster: StaffPresenceRow[])
const leadingArgs = [/* schedule */ {}, /* blocklist */ [], /* staffRoster */ []] as [any, any, any];

describe("settings staff access section", () => {
  it("admins see an invite control and the staff list with status", () => {
    const html = renderSettingsPage(
      ...leadingArgs,
      [{ email: "jake@example.com", role: "staff", hasPassword: false }],
      "admin"
    );
    expect(html).toContain("Staff access");
    expect(html).toContain("jake@example.com");
    expect(html).toContain("Invite");
    expect(html).toContain("Invited"); // status label for hasPassword=false
  });

  it("non-admins do not see the staff access section", () => {
    const html = renderSettingsPage(...leadingArgs, [], "staff");
    expect(html).not.toContain("Staff access");
  });
});
