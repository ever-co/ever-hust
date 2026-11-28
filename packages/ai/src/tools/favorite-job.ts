import { tool } from "ai";
import { z } from "zod";
import { db } from "@ever-hust/db";
import { userJobs } from "@ever-hust/db";
import { and, eq } from "drizzle-orm";

// The apply tool marks a job's user_jobs row 'applied' with appliedAt; the profile's applied
// list reads it. A favorite toggle never overwrites it, and the favorites list (status
// 'favorited' only) never shows that job. Same text as the web heart's 409
// (apps/web/app/api/user/favorites/route.ts), so chat and web say the same thing.
const APPLIED_JOB_MESSAGE =
  "You applied to this job, so it stays in your applications and can't be added to favorites.";

export const favoriteJobTool = tool({
  description:
    "Toggle a job as favorited for the current user. If already favorited, it removes the favorite. If not favorited, it adds it.",
  inputSchema: z.object({
    jobId: z.number().describe("The ID of the job to favorite/unfavorite"),
    // userId is injected server-side by the orchestrator — not LLM-provided
    userId: z.string().optional(),
  }),
  execute: async ({ jobId, userId }) => {
    if (!userId) return { jobId, favorited: false, message: "Not authenticated" };

    try {
    // Use a transaction to prevent TOCTOU race conditions when toggling
    const result = await db.transaction(async (tx) => {
      // Check for any existing userJobs record (regardless of status)
      // to avoid unique constraint violations when toggling favorites.
      // FOR UPDATE: an apply that marks this row 'applied' at the same moment (the AI SDK runs
      // one step's tool calls in parallel) is waited for and then seen, instead of being
      // overwritten by the update below
      const existing = await tx
        .select({ id: userJobs.id, status: userJobs.status })
        .from(userJobs)
        .where(
          and(eq(userJobs.userId, userId), eq(userJobs.jobId, jobId))
        )
        .limit(1)
        .for("update");

      if (existing.length > 0 && existing[0]!.status === "favorited") {
        // Already favorited — remove the favorite
        await tx
          .delete(userJobs)
          .where(eq(userJobs.id, existing[0]!.id));

        return { favorited: false, message: "Job removed from favorites." };
      }

      if (existing.length > 0 && existing[0]!.status === "applied") {
        // Don't overwrite "applied" status — it would lose application tracking.
        // Nothing is written and the job is not a favorite, as on the web
        return { favorited: false, message: APPLIED_JOB_MESSAGE };
      }

      if (existing.length > 0) {
        // Existing record with a different status — update to favorited
        await tx
          .update(userJobs)
          .set({ status: "favorited", updatedAt: new Date() })
          .where(eq(userJobs.id, existing[0]!.id));
      } else {
        // No existing record — insert new favorite
        await tx.insert(userJobs).values({
          userId,
          jobId,
          status: "favorited",
        });
      }

      return { favorited: true, message: "Job added to favorites!" };
    });

    return { jobId, ...result };
    } catch (err) {
      console.error("[favorite-job] execute failed:", err instanceof Error ? err.message : err);
      return { jobId, favorited: false, message: "Something went wrong while updating favorites. Please try again." };
    }
  },
});
