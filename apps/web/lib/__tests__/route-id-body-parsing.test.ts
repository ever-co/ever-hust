/**
 * Route-level id and body parsing. Every table id is a Postgres `integer` (int4). The routes
 * checked an id with `Number(raw)` and `Number.isInteger` (or only `Number.isFinite`) and no
 * upper bound, so /api/jobs/3000000000 reached Postgres ("out of range for type integer") and
 * ?jobId=1.5 too ("invalid input syntax"): an error log line and a 500 that anyone could cause.
 * safeJsonParse returns a `null` body as valid data, and three routes read fields off it with a
 * cast, outside any try: a body of `null` threw a TypeError and an unhandled 500.
 *
 * Every database call below throws, so a test that expects 400 also proves the route stopped
 * before it touched the database.
 */
const mockDbCall = jest.fn((op: string): never => {
  throw new Error(`db.${op} must not be reached`);
});

jest.mock("@ever-hust/db", () => ({
  db: {
    select: () => mockDbCall("select"),
    update: () => mockDbCall("update"),
    delete: () => mockDbCall("delete"),
    insert: () => mockDbCall("insert"),
    transaction: () => mockDbCall("transaction"),
  },
  jobs: {},
  applications: {},
  userJobs: {},
  apiKeys: {},
  evaluations: {},
  emailAccounts: {},
  emailMessages: {},
}));
jest.mock("@ever-hust/db/schema", () => ({
  organizations: {},
  organizationMembers: {},
}));
jest.mock("drizzle-orm", () => ({
  eq: () => ({}),
  ne: () => ({}),
  and: () => ({}),
  sql: () => ({}),
}));

const mockDecideApprovalGate = jest.fn();
jest.mock("@ever-hust/ai", () => ({
  isValidStage: (stage: string) => ["applied", "interviewing"].includes(stage),
  decideApprovalGate: (...args: unknown[]) => mockDecideApprovalGate(...args),
}));
jest.mock("@ever-hust/ai/crypto", () => ({ encryptApiKey: (s: string) => `enc:${s}` }));

jest.mock("../get-session-user", () => ({
  requireSessionUser: async () => ({ id: "user-1", email: "user@example.com" }),
  getSessionUser: async () => ({ id: "user-1", email: "user@example.com" }),
}));
jest.mock("../rate-limit", () => ({
  applyRateLimit: () => null,
  checkApiRateLimit: () => ({ allowed: true, resetAt: 0 }),
}));
jest.mock("../api-key-auth", () => ({ validateApiKey: async () => null }));

// Before the fix the org id reached the membership query; an out-of-range id failed there.
const mockRequireOrgMember = jest.fn(async (): Promise<never> => {
  throw new Error('value "3000000000" is out of range for type integer');
});
jest.mock("../auth-org", () => ({
  requireOrgMember: (...args: unknown[]) => (mockRequireOrgMember as jest.Mock)(...args),
  requireOrgRole: jest.fn(),
}));

const mockLoadAccount = jest.fn(async () => null);
jest.mock("../inbox", () => ({
  loadAccount: (...args: unknown[]) => (mockLoadAccount as jest.Mock)(...args),
  publicAccount: () => ({ connected: true }),
  resolveMailConfig: jest.fn(),
}));
const mockVerifyConnection = jest.fn();
jest.mock("../mail", () => ({
  presetForEmail: () => null,
  verifyConnection: (...args: unknown[]) => mockVerifyConnection(...args),
  sendMail: jest.fn(),
  threadKeyFor: jest.fn(),
}));
jest.mock("../mail-host-guard", () => ({
  assertPublicMailHost: jest.fn(),
  MailHostRefusedError: class MailHostRefusedError extends Error {},
}));

import { GET as getJob } from "../../app/api/jobs/[id]/route";
import { GET as getV1Job } from "../../app/api/v1/jobs/[jobId]/route";
import { PATCH as patchApplication } from "../../app/api/user/applications/[id]/route";
import { DELETE as unhideJob } from "../../app/api/user/hidden-jobs/route";
import { GET as getEvaluation } from "../../app/api/evaluations/[jobId]/route";
import { DELETE as revokeApiKey } from "../../app/api/developer/keys/[keyId]/route";
import { GET as getOrganization } from "../../app/api/organizations/[orgId]/route";
import { POST as decideApproval } from "../../app/api/approvals/route";
import { POST as connectInbox } from "../../app/api/inbox/account/route";
import { POST as sendInboxMail } from "../../app/api/inbox/send/route";

const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

function jsonRequest(method: string, path: string, rawBody: string): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: rawBody,
  });
}

async function errorOf(res: Response): Promise<string> {
  return ((await res.json()) as { error: string }).error;
}

beforeEach(() => {
  mockDbCall.mockClear();
  mockRequireOrgMember.mockClear();
  mockDecideApprovalGate.mockReset();
  mockLoadAccount.mockClear();
  mockVerifyConnection.mockReset();
});

const BAD_IDS = ["2147483648", "3000000000", "1.5", "1e3", "05", "-1", "0", "abc"];

describe("GET /api/jobs/[id]", () => {
  const get = (id: string) =>
    getJob(new Request(`http://localhost/api/jobs/${id}`) as never, params({ id }));

  it("returns 400 for 2147483648 without calling the database", async () => {
    const res = await get("2147483648");
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("Invalid job ID");
    expect(mockDbCall).not.toHaveBeenCalled();
  });

  it.each(BAD_IDS)("returns 400 for %j without calling the database", async (id) => {
    const res = await get(id);
    expect(res.status).toBe(400);
    expect(mockDbCall).not.toHaveBeenCalled();
  });

  it("queries the database for the largest Postgres integer", async () => {
    const res = await get("2147483647");
    // The stub database throws on any call, which the route turns into its 500.
    expect(res.status).toBe(500);
    expect(mockDbCall).toHaveBeenCalledWith("select");
  });
});

describe("GET /api/v1/jobs/[jobId]", () => {
  it.each(BAD_IDS)("returns 400 for %j without calling the database", async (jobId) => {
    const res = await getV1Job(
      new Request(`http://localhost/api/v1/jobs/${jobId}`) as never,
      params({ jobId }),
    );
    expect(res.status).toBe(400);
    expect(mockDbCall).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/user/applications/[id]", () => {
  const patch = (id: string, rawBody: string) =>
    patchApplication(jsonRequest("PATCH", `/api/user/applications/${id}`, rawBody), params({ id }));

  it("returns 400 for a body of null", async () => {
    const res = await patch("1", "null");
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("Request body must be a JSON object");
    expect(mockDbCall).not.toHaveBeenCalled();
  });

  it.each(["[]", '"interviewing"', "5", "true"])(
    "returns 400 for a body of %s",
    async (rawBody) => {
      const res = await patch("1", rawBody);
      expect(res.status).toBe(400);
      expect(mockDbCall).not.toHaveBeenCalled();
    },
  );

  it.each(BAD_IDS)("returns 400 for id %j without calling the database", async (id) => {
    const res = await patch(id, JSON.stringify({ stage: "interviewing" }));
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("Invalid application id");
    expect(mockDbCall).not.toHaveBeenCalled();
  });

  it("updates for a valid id and stage", async () => {
    const res = await patch("2147483647", JSON.stringify({ stage: "interviewing" }));
    // The stub database throws on any call, which the route turns into its 500.
    expect(res.status).toBe(500);
    expect(mockDbCall).toHaveBeenCalledWith("update");
  });
});

describe("DELETE /api/user/hidden-jobs", () => {
  it.each([...BAD_IDS, ""])("returns 400 for ?jobId=%j without calling the database", async (jobId) => {
    const res = await unhideJob(
      new Request(`http://localhost/api/user/hidden-jobs?jobId=${encodeURIComponent(jobId)}`, {
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(400);
    expect(mockDbCall).not.toHaveBeenCalled();
  });
});

describe("GET /api/evaluations/[jobId]", () => {
  it.each(BAD_IDS)("returns 400 for %j without calling the database", async (jobId) => {
    const res = await getEvaluation(new Request("http://localhost/"), params({ jobId }));
    expect(res.status).toBe(400);
    expect(mockDbCall).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/developer/keys/[keyId]", () => {
  it.each(BAD_IDS)("returns 400 for %j without calling the database", async (keyId) => {
    const res = await revokeApiKey(
      new Request("http://localhost/", { method: "DELETE" }),
      params({ keyId }),
    );
    expect(res.status).toBe(400);
    expect(mockDbCall).not.toHaveBeenCalled();
  });
});

describe("GET /api/organizations/[orgId]", () => {
  it.each(BAD_IDS)("returns 400 for %j before the membership check", async (orgId) => {
    const res = await getOrganization(new Request("http://localhost/"), params({ orgId }));
    expect(res.status).toBe(400);
    expect(mockRequireOrgMember).not.toHaveBeenCalled();
    expect(mockDbCall).not.toHaveBeenCalled();
  });
});

describe("POST /api/approvals", () => {
  it("returns 400 for a gateId past the Postgres integer range", async () => {
    const res = await decideApproval(
      jsonRequest("POST", "/api/approvals", JSON.stringify({ gateId: 2147483648, decision: "approved" })),
    );
    expect(res.status).toBe(400);
    expect(mockDecideApprovalGate).not.toHaveBeenCalled();
  });

  it("records the decision for the largest Postgres integer", async () => {
    mockDecideApprovalGate.mockResolvedValue({ ok: true });
    const res = await decideApproval(
      jsonRequest("POST", "/api/approvals", JSON.stringify({ gateId: 2147483647, decision: "approved" })),
    );
    expect(res.status).toBe(200);
    expect(mockDecideApprovalGate).toHaveBeenCalledWith(
      expect.objectContaining({ gateId: 2147483647 }),
    );
  });
});

describe("JSON bodies that are not an object", () => {
  it.each(["null", "[]", '"me@example.com"', "5"])(
    "POST /api/inbox/account returns 400 for %s",
    async (rawBody) => {
      const res = await connectInbox(jsonRequest("POST", "/api/inbox/account", rawBody));
      expect(res.status).toBe(400);
      expect(mockVerifyConnection).not.toHaveBeenCalled();
      expect(mockDbCall).not.toHaveBeenCalled();
    },
  );

  it.each(["null", "[]", '"hello"', "5"])(
    "POST /api/inbox/send returns 400 for %s",
    async (rawBody) => {
      const res = await sendInboxMail(jsonRequest("POST", "/api/inbox/send", rawBody));
      expect(res.status).toBe(400);
      expect(mockLoadAccount).not.toHaveBeenCalled();
      expect(mockDbCall).not.toHaveBeenCalled();
    },
  );

  it("POST /api/inbox/account names the problem for a body of null", async () => {
    const res = await connectInbox(jsonRequest("POST", "/api/inbox/account", "null"));
    expect(await errorOf(res)).toBe("Request body must be a JSON object");
  });

  it("POST /api/inbox/send names the problem for a body of null", async () => {
    const res = await sendInboxMail(jsonRequest("POST", "/api/inbox/send", "null"));
    expect(await errorOf(res)).toBe("Request body must be a JSON object");
  });
});
