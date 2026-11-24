/**
 * useHiddenJobs must load the saved hidden jobs from GET /api/user/hidden-jobs.
 * It used to read `data.data?.hiddenJobIds`, but the route returns
 * `{ hiddenJobIds }` at the top level, so the saved list never reached the
 * hook and every hidden job showed again after a reload.
 *
 * The real route handler builds the response the hook reads. React is
 * replaced by a one-slot harness (this repo has no DOM test renderer), which
 * is enough for this hook: one useState, one mount effect, plain callbacks.
 */
jest.mock("drizzle-orm", () => ({ eq: jest.fn(), and: jest.fn() }));

// The session user's user_jobs rows with status 'hidden'.
let mockSavedRows: Array<{ jobId: number }> = [];
jest.mock("@ever-hust/db", () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => mockSavedRows }) }),
  },
  userJobs: { userId: "user_id", jobId: "job_id", status: "status" },
}));
jest.mock("../get-session-user", () => ({
  requireSessionUser: async () => ({ id: "user-1", email: "user@example.com" }),
}));
jest.mock("../rate-limit", () => ({ applyRateLimit: () => null }));
jest.mock("sonner", () => ({
  toast: { error: jest.fn(), success: jest.fn() },
}));

let mockState: unknown;
let mockEffects: Array<() => void> = [];
jest.mock("react", () => ({
  useState: (initial: unknown) => {
    if (mockState === undefined) mockState = initial;
    const setState = (update: unknown) => {
      mockState =
        typeof update === "function"
          ? (update as (prev: unknown) => unknown)(mockState)
          : update;
    };
    return [mockState, setState];
  },
  useEffect: (effect: () => void) => {
    mockEffects.push(effect);
  },
  useCallback: (fn: unknown) => fn,
}));

import { GET } from "../../app/api/user/hidden-jobs/route";
import { useHiddenJobs } from "../../hooks/use-hidden-jobs";

const realFetch = global.fetch;

// Called outside React, through the harness above; the alias keeps the
// rules-of-hooks lint off these plain helper calls.
const renderHiddenJobs: typeof useHiddenJobs = useHiddenJobs;

/** Render the hook once and run its mount effect. */
function mount() {
  const hook = renderHiddenJobs();
  mockEffects.forEach((effect) => effect());
  return hook;
}

/** Let the pending fetch and json() promises settle. */
async function settle() {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function hiddenNow(): number[] {
  return [...renderHiddenJobs().hiddenJobIds].sort((a, b) => a - b);
}

describe("useHiddenJobs loads the saved hidden jobs", () => {
  beforeEach(() => {
    mockState = undefined;
    mockEffects = [];
    mockSavedRows = [];
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it("hides the jobs the route returns after a reload", async () => {
    mockSavedRows = [{ jobId: 3 }, { jobId: 5 }];
    const saved = await GET(
      new Request("http://localhost/api/user/hidden-jobs"),
    );
    const fetchMock = jest.fn(async () => saved);
    global.fetch = fetchMock as unknown as typeof fetch;

    mount();
    await settle();

    expect(fetchMock).toHaveBeenCalledWith("/api/user/hidden-jobs");
    expect(hiddenNow()).toEqual([3, 5]);
    expect(renderHiddenJobs().isHidden(3)).toBe(true);
    expect(renderHiddenJobs().isHidden(4)).toBe(false);
  });

  it("keeps a job hidden while the saved list is still loading", async () => {
    mockSavedRows = [{ jobId: 3 }];
    const saved = await GET(
      new Request("http://localhost/api/user/hidden-jobs"),
    );
    let releaseGet: (res: Response) => void = () => {};
    global.fetch = jest.fn((_url: string, init?: RequestInit) =>
      init
        ? Promise.resolve(new Response("{}", { status: 200 }))
        : new Promise<Response>((resolve) => {
            releaseGet = resolve;
          }),
    ) as unknown as typeof fetch;

    const { hideJob } = mount();
    await hideJob(9);
    releaseGet(saved);
    await settle();

    expect(hiddenNow()).toEqual([3, 9]);
  });

  it("hides nothing when the saved list is empty or the request fails", async () => {
    const empty = await GET(
      new Request("http://localhost/api/user/hidden-jobs"),
    );
    global.fetch = jest.fn(async () => empty) as unknown as typeof fetch;
    mount();
    await settle();
    expect(hiddenNow()).toEqual([]);

    mockState = undefined;
    mockEffects = [];
    global.fetch = jest.fn(
      async () =>
        new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
        }),
    ) as unknown as typeof fetch;
    mount();
    await settle();
    expect(hiddenNow()).toEqual([]);
  });
});
