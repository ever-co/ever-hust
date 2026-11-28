import { db, userJobs } from "@ever-hust/db";
import { and, eq, ne } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireSessionUser } from "../../../../lib/get-session-user";
import { applyRateLimit } from "../../../../lib/rate-limit";
import { hiddenJobToggleSchema, parseBody } from "../../../../lib/api-schemas";
import {
  apiSuccess,
  apiBadRequest,
  apiError,
  safeJsonParse,
} from "../../../../lib/api-response";

// The apply tool marks a job's user_jobs row 'applied' with appliedAt; the profile's applied
// list and the inbox job matching read it. Hiding must never overwrite it (and the unhide
// DELETE would then remove the row).
const APPLIED_JOB_MESSAGE =
  "You applied to this job, so it stays in your applications and can't be hidden.";

/**
 * POST /api/user/hidden-jobs — Hide a job for the user
 * DELETE /api/user/hidden-jobs — Unhide a job
 * GET /api/user/hidden-jobs — List hidden job IDs
 */

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function GET(_req: Request) {
  let user;
  try {
    user = await requireSessionUser();
  } catch (response) {
    return response as NextResponse;
  }

  const rateLimited = applyRateLimit(user.id, "authenticated");
  if (rateLimited) return rateLimited;

  try {
    const result = await db
      .select({ jobId: userJobs.jobId })
      .from(userJobs)
      .where(
        and(
          eq(userJobs.userId, user.id),
          eq(userJobs.status, "hidden")
        )
      );

    return apiSuccess({ hiddenJobIds: result.map((r) => r.jobId) });
  } catch (err) {
    console.error(
      "[api/user/hidden-jobs] GET failed:",
      err instanceof Error ? err.message : err,
    );
    return apiError("Failed to fetch hidden jobs");
  }
}

export async function POST(req: Request) {
  let user;
  try {
    user = await requireSessionUser();
  } catch (response) {
    return response as NextResponse;
  }

  const rateLimited = applyRateLimit(user.id, "authenticated");
  if (rateLimited) return rateLimited;

  const jsonResult = await safeJsonParse(req);
  if (!jsonResult.ok) return jsonResult.response;
  const validation = parseBody(hiddenJobToggleSchema, jsonResult.data);
  if (!validation.success) {
    return apiBadRequest(validation.error);
  }
  const { jobId } = validation.data;

  try {
    const hidden = await db
      .insert(userJobs)
      .values({
        userId: user.id,
        jobId,
        status: "hidden",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [userJobs.userId, userJobs.jobId],
        set: { status: "hidden", updatedAt: new Date() },
        // Don't overwrite "applied" status: it would lose the application tracking
        setWhere: ne(userJobs.status, "applied"),
      })
      .returning({ id: userJobs.id });

    // No row returned: the existing row is 'applied' and was left as it was
    if (hidden.length === 0) return apiError(APPLIED_JOB_MESSAGE, 409);
    return apiSuccess({ hidden: true, jobId });
  } catch (err) {
    console.error(
      "[api/user/hidden-jobs] POST failed:",
      err instanceof Error ? err.message : err,
    );
    return apiError("Failed to hide job");
  }
}

export async function DELETE(req: Request) {
  let user;
  try {
    user = await requireSessionUser();
  } catch (response) {
    return response as NextResponse;
  }

  const rateLimited = applyRateLimit(user.id, "authenticated");
  if (rateLimited) return rateLimited;

  const url = new URL(req.url);
  const rawJobId = url.searchParams.get("jobId");
  const jobId = Number(rawJobId);
  if (!rawJobId || !Number.isFinite(jobId) || jobId < 1) {
    return apiBadRequest("Invalid or missing jobId query parameter");
  }

  try {
    await db
      .delete(userJobs)
      .where(
        and(
          eq(userJobs.userId, user.id),
          eq(userJobs.jobId, jobId),
          eq(userJobs.status, "hidden")
        )
      );

    return apiSuccess({ hidden: false, jobId });
  } catch (err) {
    console.error(
      "[api/user/hidden-jobs] DELETE failed:",
      err instanceof Error ? err.message : err,
    );
    return apiError("Failed to unhide job");
  }
}
