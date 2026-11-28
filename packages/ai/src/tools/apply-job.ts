import { tool } from "ai";
import { z } from "zod";
import { db } from "@ever-hust/db";
import { users, jobs, applications, agentInstances, userJobs } from "@ever-hust/db";
import { proOnlyToolError } from "../payments";
import { eq, and, ne, sql } from "drizzle-orm";

export const applyJobTool = tool({
  description:
    "Initiate a job application for the user. This will open the job's application page and track the application. REQUIRES USER APPROVAL before executing.",
  inputSchema: z.object({
    // userId is injected server-side by the orchestrator — not LLM-provided
    userId: z.string().optional(),
    jobId: z.number().describe("The job ID to apply for"),
    coverLetter: z
      .string()
      .max(10_000)
      .optional()
      .describe("Optional cover letter text to include"),
  }),
  execute: async ({ userId, jobId, coverLetter }) => {
    if (!userId) return { applied: false, error: "Not authenticated" };

    try {
    // Get user profile
    const userResult = await db
      .select({
        name: users.name,
        email: users.email,
        subscriptionStatus: users.subscriptionStatus,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (userResult.length === 0) {
      return { applied: false, error: "User not found" };
    }

    const user = userResult[0]!;
    if (user.subscriptionStatus !== "active" && user.subscriptionStatus !== "past_due") {
      return {
        applied: false,
        error: proOnlyToolError("Job applications require a Pro subscription."),
        requiresUpgrade: true,
      };
    }

    // Get job details
    const jobResult = await db
      .select({
        title: jobs.title,
        companyName: jobs.companyName,
        jobUrl: jobs.jobUrl,
        applyUrl: jobs.applyUrl,
      })
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .limit(1);

    if (jobResult.length === 0) {
      return { applied: false, error: "Job not found" };
    }

    const job = jobResult[0]!;
    const applicationUrl = job.applyUrl ?? job.jobUrl;

    if (!applicationUrl) {
      return { applied: false, error: "No application URL available for this job" };
    }

    // Create agent instance, application record, and update userJobs
    // inside a transaction to prevent orphaned records on partial failure.
    const txResult = await db.transaction(async (tx) => {
      // The duplicate check below is a plain select, which does not block another apply under
      // READ COMMITTED: two applies for the same job (one step's parallel tool calls, or two
      // tabs) both found nothing and both inserted. Lock (user, job) first, so the second apply
      // waits for the first to commit and then sees its application. Held until the
      // transaction ends (commit or rollback), never left on a pooled connection.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('apply-job:' || ${userId}), ${jobId})`,
      );

      // Skip failed applications in SQL, not after `limit(1)`: an older failed row came back
      // first and hid the active one, so every apply after it went through.
      const existingApp = await tx
        .select({ id: applications.id })
        .from(applications)
        .where(
          and(
            eq(applications.userId, userId),
            eq(applications.jobId, jobId),
            ne(applications.status, "failed"),
          ),
        )
        .limit(1);

      if (existingApp.length > 0) {
        return {
          duplicate: true as const,
          existingApplicationId: existingApp[0]!.id,
          applicationUrl,
        };
      }
      // Create agent instance to track this application
      const agentResult = await tx
        .insert(agentInstances)
        .values({
          userId,
          agentType: "application",
          jobId,
          status: "running",
          state: { step: "initiated", coverLetter: coverLetter ?? null },
        })
        .returning({ id: agentInstances.id });

      const newAgentId = agentResult[0]?.id;
      if (!newAgentId) {
        throw new Error("Failed to create application agent instance");
      }

      // Create application record
      const appResult = await tx
        .insert(applications)
        .values({
          userId,
          jobId,
          agentInstanceId: newAgentId,
          status: "in_progress",
          coverLetter: coverLetter ?? null,
        })
        .returning({ id: applications.id });

      const newApplicationId = appResult[0]?.id;
      if (!newApplicationId) {
        throw new Error("Failed to create application record");
      }

      // Track in userJobs as "applied" in ONE upsert on (userId, jobId). A select followed by
      // an update or an insert races the favorite toggles: an unfavorite that deletes the row
      // after the select leaves the update with no row (the application commits, no row says
      // "applied"), and a favorite inserted after it makes the insert hit user_jobs_unique and
      // roll the whole application back. The upsert waits for the other writer instead.
      const appliedAt = new Date();
      await tx
        .insert(userJobs)
        .values({ userId, jobId, status: "applied", appliedAt })
        .onConflictDoUpdate({
          target: [userJobs.userId, userJobs.jobId],
          set: { status: "applied", appliedAt, updatedAt: appliedAt },
        });

      return {
        duplicate: false as const,
        agentId: newAgentId,
        applicationId: newApplicationId,
      };
    });

    // Handle duplicate early-return from within the transaction
    if (txResult.duplicate) {
      return {
        applied: false,
        error: "You already have an active application for this job.",
        existingApplicationId: txResult.existingApplicationId,
        applicationUrl: txResult.applicationUrl,
      };
    }

    return {
      applied: true,
      applicationId: txResult.applicationId,
      agentInstanceId: txResult.agentId,
      jobTitle: job.title,
      companyName: job.companyName,
      applicationUrl,
      instruction:
        "The application has been initiated. Direct the user to open the application URL to complete their application. If a cover letter was provided, let them know it's ready to paste. Track the application status in the user's profile.",
    };
    } catch (err) {
      console.error("[apply-job] execute failed:", err instanceof Error ? err.message : err);
      return { applied: false, error: "Something went wrong while processing the application. Please try again." };
    }
  },
});
