/**
 * useFavorites (the hearts on the /jobs list) shows the server's reason when POST
 * /api/user/favorites refuses a toggle with 409 (the job is tracked as an application), and the
 * generic "Failed to update favorite" for every other failure. A network failure rejects fetch()
 * with a TypeError whose message ("Failed to fetch") is not meant for the user.
 *
 * React and React Query are replaced by a harness that keeps the mutation options the hook
 * passes, so the test runs the hook's own mutationFn and onError (this repo has no DOM renderer).
 */
jest.mock("sonner", () => ({
  toast: { error: jest.fn(), success: jest.fn() },
}));
jest.mock("react", () => ({
  useCallback: (fn: unknown) => fn,
  useRef: (initial: unknown) => ({ current: initial }),
}));

type MutationOptions = {
  mutationFn: (jobId: number) => Promise<unknown>;
  onError: (err: Error, jobId: number, context: unknown) => void;
};
let mockMutation: MutationOptions | undefined;
jest.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ setQueryData: jest.fn(), getQueryData: jest.fn() }),
  useQuery: () => ({ data: new Set<number>(), isLoading: false }),
  useMutation: (options: MutationOptions) => {
    mockMutation = options;
    return { mutate: jest.fn() };
  },
}));

import { toast } from "sonner";
import { useFavorites } from "../../hooks/use-favorites";

const realFetch = global.fetch;

// Called outside React, through the harness above; the alias keeps the
// rules-of-hooks lint off this plain helper call.
const renderFavorites: typeof useFavorites = useFavorites;

/** Run one toggle the way React Query does: mutationFn, then onError when it throws. */
async function toggleAndFail(jobId: number) {
  renderFavorites();
  const mutation = mockMutation!;
  try {
    await mutation.mutationFn(jobId);
  } catch (err) {
    mutation.onError(err as Error, jobId, undefined);
    return;
  }
  throw new Error("expected the toggle to fail");
}

describe("useFavorites: the toast for a failed toggle", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMutation = undefined;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it("a 409 shows the server's reason", async () => {
    const reason =
      "You applied to this job, so it stays in your applications and can't be added to favorites.";
    global.fetch = jest.fn(
      async () =>
        new Response(JSON.stringify({ error: reason }), { status: 409 }),
    ) as unknown as typeof fetch;

    await toggleAndFail(4);

    expect(toast.error).toHaveBeenCalledWith(reason);
  });

  it("a 500 shows the generic text", async () => {
    global.fetch = jest.fn(
      async () =>
        new Response(JSON.stringify({ error: "db down" }), { status: 500 }),
    ) as unknown as typeof fetch;

    await toggleAndFail(4);

    expect(toast.error).toHaveBeenCalledWith("Failed to update favorite");
  });

  it("a network failure shows the generic text, not the TypeError's message", async () => {
    global.fetch = jest.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    await toggleAndFail(4);

    expect(toast.error).toHaveBeenCalledWith("Failed to update favorite");
  });
});
