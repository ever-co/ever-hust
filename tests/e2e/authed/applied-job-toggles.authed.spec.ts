import { test, expect } from "@playwright/test";
import { db, users, userJobs } from "@ever-hust/db";
import { and, eq } from "drizzle-orm";

test.use({ storageState: "tests/e2e/.auth/user.json" });

// Job 4 exists from the seeded corpus and no other spec touches it (1 is favorited, 2 is
// evaluated, 3 is hidden).
const JOB_ID = 4;
const TEST_EMAIL = "e2e.tester@hust.test";
const APPLIED_AT = new Date("2026-11-20T10:00:00.000Z");

/**
 * The apply tool marks a job's user_jobs row 'applied' with appliedAt, and the profile's applied
 * list reads it. Clicking the heart or hiding that job used to overwrite 'applied' (and a second
 * click, or an unhide, deleted the row with appliedAt).
 */
test.describe("Authenticated — a job the user applied to", () => {
  let userId: string;

  const appliedRow = () =>
    db
      .select({ status: userJobs.status, appliedAt: userJobs.appliedAt })
      .from(userJobs)
      .where(and(eq(userJobs.userId, userId), eq(userJobs.jobId, JOB_ID)));

  test.beforeAll(async () => {
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, TEST_EMAIL))
      .limit(1);
    userId = rows[0]!.id;
    // What packages/ai/src/tools/apply-job.ts writes. Idempotent across re-runs.
    await db
      .insert(userJobs)
      .values({
        userId,
        jobId: JOB_ID,
        status: "applied",
        appliedAt: APPLIED_AT,
      })
      .onConflictDoUpdate({
        target: [userJobs.userId, userJobs.jobId],
        set: { status: "applied", appliedAt: APPLIED_AT },
      });
  });

  test.afterAll(async () => {
    await db
      .delete(userJobs)
      .where(and(eq(userJobs.userId, userId), eq(userJobs.jobId, JOB_ID)));
  });

  test("favorite and hide toggles answer 409 and keep it in the applications", async ({
    request,
  }) => {
    for (let click = 0; click < 2; click++) {
      const res = await request.post("/api/user/favorites", {
        data: { jobId: JOB_ID },
      });
      expect(res.status()).toBe(409);
      expect((await res.json()).error).toMatch(/applied/i);
    }
    const unfavorite = await request.delete("/api/user/favorites", {
      data: { jobId: JOB_ID },
    });
    expect(unfavorite.status()).toBe(200);

    const hide = await request.post("/api/user/hidden-jobs", {
      data: { jobId: JOB_ID },
    });
    expect(hide.status()).toBe(409);
    expect((await hide.json()).error).toMatch(/applied/i);
    const unhide = await request.delete(
      `/api/user/hidden-jobs?jobId=${JOB_ID}`,
    );
    expect(unhide.status()).toBe(200);

    expect(await appliedRow()).toEqual([
      { status: "applied", appliedAt: APPLIED_AT },
    ]);

    const hidden = (await (await request.get("/api/user/hidden-jobs")).json())
      .hiddenJobIds as number[];
    expect(hidden).not.toContain(JOB_ID);

    const profile = await request.get("/api/user/profile");
    expect(profile.status()).toBe(200);
    const applied = (await profile.json()).applications as Array<{
      jobId: number;
    }>;
    expect(applied.map((a) => a.jobId)).toContain(JOB_ID);
  });
});
