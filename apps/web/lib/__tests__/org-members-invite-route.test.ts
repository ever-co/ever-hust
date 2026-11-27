/**
 * POST /api/organizations/[orgId]/members: inviting a member stored the invitation and answered
 * 201, but no email was sent and the accept link was not returned, so the invitee had no way to
 * join. The route now emails the accept link (/organizations/invitations/<token>) and returns
 * `emailSent` and `inviteUrl`, so the page can show the link when the email did not go out.
 *
 * The db below answers the route's query shapes with rows per table, projected through the
 * columns the route selects. `@ever-hust/email` is mocked: no email is sent.
 */
type Row = Record<string, unknown>;
type Column = { table: string; column: string };

function mockTable(name: string, columns: string[]) {
  const t: Record<string, unknown> = { _name: name };
  for (const column of columns) t[column] = { table: name, column };
  return t as { _name: string } & Record<string, Column>;
}

const mockOrganizations = mockTable("organizations", ["id", "name", "maxMembers"]);
const mockMembers = mockTable("organizationMembers", [
  "id",
  "organizationId",
  "userId",
  "role",
  "joinedAt",
]);
const mockInvitations = mockTable("organizationInvitations", [
  "id",
  "organizationId",
  "email",
  "role",
  "status",
  "token",
  "invitedById",
  "expiresAt",
  "createdAt",
]);
const mockUsers = mockTable("users", ["id", "name", "email", "image"]);

jest.mock("@ever-hust/db/schema", () => ({
  organizations: mockOrganizations,
  organizationMembers: mockMembers,
  organizationInvitations: mockInvitations,
  users: mockUsers,
}));
jest.mock("drizzle-orm", () => ({
  eq: jest.fn(),
  and: jest.fn(),
  count: jest.fn(() => ({ aggregate: "count" })),
  sql: jest.fn(),
}));

/** Rows per table; `.limit()` projects them through the selected columns. */
const mockRows = new Map<string, Row[]>();
/** Rows an awaited `.where()` (the member count) answers with, per table. */
const mockCountRows = new Map<string, Row[]>();
const mockInserted: Row[] = [];

function mockProject(projection: Record<string, unknown>, rows: Row[]): Row[] {
  return rows.map((row) => {
    const out: Row = {};
    for (const [key, col] of Object.entries(projection)) {
      if (col && typeof col === "object" && "column" in col) {
        out[key] = row[(col as Column).column];
      }
    }
    return out;
  });
}

jest.mock("@ever-hust/db", () => ({
  db: {
    select: (projection: Record<string, unknown>) => ({
      from: (table: { _name: string }) => ({
        where: () => ({
          limit: async (n: number) =>
            mockProject(projection, (mockRows.get(table._name) ?? []).slice(0, n)),
          then: (resolve: (v: Row[]) => unknown, reject: (e: unknown) => unknown) =>
            Promise.resolve(mockCountRows.get(table._name) ?? []).then(resolve, reject),
        }),
      }),
    }),
    insert: () => ({
      values: (values: Row) => ({
        returning: async () => {
          const row = { id: 55, status: "pending", createdAt: new Date(), ...values };
          mockInserted.push(row);
          return [row];
        },
      }),
    }),
  },
}));

let mockInviter: { id: string; name: string; email: string; emailVerified: boolean };
jest.mock("../auth-org", () => ({
  requireOrgRole: async () => ({ user: mockInviter, orgRole: "owner" }),
  requireOrgMember: async () => ({ user: mockInviter, orgRole: "owner" }),
}));
jest.mock("../rate-limit", () => ({ applyRateLimit: () => null }));

const mockSendInvitation = jest.fn();
jest.mock("@ever-hust/email", () => ({
  sendOrganizationInvitationEmail: (...args: unknown[]) => mockSendInvitation(...args),
  getAppUrl: () => "https://app.hust.test",
  isDeduplicatedEmail: (r: unknown) =>
    (r as { deduplicated?: unknown } | null)?.deduplicated === true,
}));

import { POST } from "../../app/api/organizations/[orgId]/members/route";

const context = { params: Promise.resolve({ orgId: "42" }) };
const inviteRequest = (body: unknown = { email: "Invitee@Example.com", role: "member" }) =>
  new Request("http://localhost/api/organizations/42/members", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

function storedToken(): string {
  expect(mockInserted).toHaveLength(1);
  const token = mockInserted[0]!.token;
  expect(typeof token).toBe("string");
  return token as string;
}

describe("POST /api/organizations/[orgId]/members sends the invitation", () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRows.clear();
    mockCountRows.clear();
    mockInserted.length = 0;
    mockRows.set("organizations", [{ id: 42, name: "Acme & <Co>", maxMembers: 10 }]);
    mockRows.set("users", []);
    mockRows.set("organizationMembers", []);
    mockRows.set("organizationInvitations", []);
    mockCountRows.set("organizationMembers", [{ value: 1 }]);
    mockInviter = {
      id: "user-owner",
      name: "  Olivia Owner  ",
      email: "olivia@acme.test",
      emailVerified: true,
    };
    mockSendInvitation.mockResolvedValue({ id: "email_1" });
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("emails the invitee once, with an accept URL that carries the stored token", async () => {
    const res = await POST(inviteRequest(), context);
    expect(res.status).toBe(201);

    const token = storedToken();
    expect(mockSendInvitation).toHaveBeenCalledTimes(1);
    expect(mockSendInvitation).toHaveBeenCalledWith({
      to: "invitee@example.com",
      orgName: "Acme & <Co>",
      inviterName: "Olivia Owner",
      role: "member",
      acceptUrl: `https://app.hust.test/organizations/invitations/${token}`,
      invitationId: 55,
    });
  });

  it("returns emailSent and the invite URL with the invitation", async () => {
    const res = await POST(inviteRequest(), context);
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      invitation: { id: number };
      emailSent: boolean;
      inviteUrl: string;
    };

    const token = storedToken();
    expect(body.invitation.id).toBe(55);
    expect(body.emailSent).toBe(true);
    expect(body.inviteUrl).toBe(`https://app.hust.test/organizations/invitations/${token}`);
  });

  it("still answers 201 with emailSent false and the invite URL when the send throws", async () => {
    mockSendInvitation.mockRejectedValueOnce(new Error("RESEND_API_KEY environment variable is not configured"));

    const res = await POST(inviteRequest(), context);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { emailSent: boolean; inviteUrl: string };

    const token = storedToken();
    expect(body.emailSent).toBe(false);
    expect(body.inviteUrl).toBe(`https://app.hust.test/organizations/invitations/${token}`);
    expect(mockSendInvitation).toHaveBeenCalledTimes(1);

    // The failure is logged, and the log never carries the token.
    expect(errorSpy).toHaveBeenCalled();
    for (const call of errorSpy.mock.calls) {
      expect(JSON.stringify(call.map((a: unknown) => (a instanceof Error ? a.message : a)))).not.toContain(token);
    }
  });

  it("keeps the token out of the log even when the send error echoes the accept URL", async () => {
    mockSendInvitation.mockImplementationOnce(async ({ acceptUrl }: { acceptUrl: string }) => {
      throw new Error(`Failed to send organization invitation email: bad link ${acceptUrl}`);
    });

    const res = await POST(inviteRequest(), context);
    expect(res.status).toBe(201);
    expect(((await res.json()) as { emailSent: boolean }).emailSent).toBe(false);

    const token = storedToken();
    expect(errorSpy).toHaveBeenCalled();
    for (const call of errorSpy.mock.calls) {
      expect(JSON.stringify(call.map((a: unknown) => (a instanceof Error ? a.message : a)))).not.toContain(token);
    }
  });

  it("reports emailSent false when Resend says the same send is still in flight", async () => {
    mockSendInvitation.mockResolvedValueOnce({ id: null, deduplicated: true, reason: "in_flight" });

    const res = await POST(inviteRequest(), context);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { emailSent: boolean; inviteUrl: string };
    expect(body.emailSent).toBe(false);
    expect(body.inviteUrl).toContain(`/organizations/invitations/${storedToken()}`);
  });

  it("does not email from an unverified inviter (a guest), but still returns the invite URL", async () => {
    mockInviter = {
      id: "guest-1",
      name: "Your account is locked, restore it at evil.example",
      email: "guest-1@hust.local",
      emailVerified: false,
    };

    const res = await POST(inviteRequest(), context);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { emailSent: boolean; inviteUrl: string };

    expect(mockSendInvitation).not.toHaveBeenCalled();
    expect(body.emailSent).toBe(false);
    expect(body.inviteUrl).toBe(`https://app.hust.test/organizations/invitations/${storedToken()}`);
  });

  it("falls back to the inviter's email local part when the name is blank", async () => {
    mockInviter = { ...mockInviter, name: "   " };

    const res = await POST(inviteRequest(), context);
    expect(res.status).toBe(201);
    expect(mockSendInvitation).toHaveBeenCalledWith(
      expect.objectContaining({ inviterName: "olivia" }),
    );
  });

  it("sends nothing when the invitation is refused (already pending)", async () => {
    mockRows.set("organizationInvitations", [{ id: 9 }]);

    const res = await POST(inviteRequest(), context);
    expect(res.status).toBe(400);
    expect(mockInserted).toHaveLength(0);
    expect(mockSendInvitation).not.toHaveBeenCalled();
  });
});
