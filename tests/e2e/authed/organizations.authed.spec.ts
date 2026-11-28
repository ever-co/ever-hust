import { test, expect, type APIRequestContext } from "@playwright/test";

// Authenticated via the storage state produced by the `setup` project (auth.setup.ts).
test.use({ storageState: "tests/e2e/.auth/user.json" });

const INVITE_URL = /\/organizations\/invitations\/[0-9a-f-]{36}$/;

async function createOrg(request: APIRequestContext) {
  const res = await request.post("/api/organizations", {
    data: { name: `E2E Invite Org ${Date.now()}` },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { organization: { id: number } }).organization.id;
}

test.describe("Authenticated — organization invitations", () => {
  test("POST members returns the invite URL and whether the email went out", async ({ request }) => {
    const orgId = await createOrg(request);

    const res = await request.post(`/api/organizations/${orgId}/members`, {
      data: { email: `invitee.${Date.now()}@hust.test`, role: "member" },
    });
    expect(res.status()).toBe(201);
    const body = (await res.json()) as {
      invitation: { id: number; token: string };
      emailSent: boolean;
      inviteUrl: string;
    };
    expect(typeof body.emailSent).toBe("boolean");
    expect(body.inviteUrl).toMatch(INVITE_URL);
    expect(body.inviteUrl.endsWith(`/organizations/invitations/${body.invitation.token}`)).toBe(true);
  });

  test("shows the invite link with a copy button when the email cannot be sent", async ({ page, request }) => {
    // CI runs without RESEND_API_KEY, so the send fails and the page must hand over the link.
    test.skip(!!process.env.RESEND_API_KEY, "Resend is configured: the email is sent instead");
    const orgId = await createOrg(request);
    const email = `invitee.ui.${Date.now()}@hust.test`;

    await page.goto(`/organizations/${orgId}`);
    await page.getByLabel("Invitee email address").fill(email);
    await page.getByRole("button", { name: "Invite", exact: true }).click();

    const box = page.getByTestId("invite-link");
    await expect(box).toBeVisible();
    await expect(box).toContainText(email);
    const link = box.getByLabel(`Invite link for ${email}`);
    await expect(link).toHaveValue(INVITE_URL);
    await expect(box.getByRole("button", { name: "Copy link" })).toBeVisible();
    await expect(page.getByText(`Invitation sent to ${email}`)).toHaveCount(0);
  });
});
