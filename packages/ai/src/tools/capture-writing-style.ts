import { tool } from "ai";
import { z } from "zod";
import { db, users } from "@ever-hust/db";
import { eq } from "drizzle-orm";
import { extractStyleFingerprint } from "../style/fingerprint";

/**
 * Capture the user's writing style (spec #14) from samples they've written/approved, storing ONLY
 * the aggregate fingerprint in `users.preferences.writingStyle` — never the raw text (privacy
 * invariant). Future generation (cover letters, outreach) can read the fingerprint to match voice.
 * `userId` injected server-side.
 */
export const captureWritingStyleTool = tool({
  description:
    "Learn the user's writing voice from samples they wrote or approved (e.g. a bio, a past cover " +
    "letter), storing only an aggregate style fingerprint (sentence length, formality, etc.) — never " +
    "the raw text. Use when the user shares writing and wants future drafts to sound like them.",
  inputSchema: z.object({
    samples: z
      .array(z.string().max(8000))
      .min(1)
      .max(10)
      .describe("Text samples the user wrote/approved. Stored only as an aggregate fingerprint."),
    userId: z.string().optional(),
  }),
  execute: async ({ samples, userId }) => {
    if (!userId) return { captured: false, error: "Not authenticated." };
    try {
      const fingerprint = extractStyleFingerprint(samples);
      // Read the row under FOR UPDATE in the transaction that writes it back: the AI SDK runs
      // the tool calls of one step in parallel, and a concurrent writer must not lose its keys
      // to a stale copy of the JSON.
      const found = await db.transaction(async (tx) => {
        const rows = await tx
          .select({ preferences: users.preferences })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1)
          .for("update");
        if (rows.length === 0) return false;

        const prefs = (rows[0]!.preferences ?? {}) as Record<string, unknown>;
        // Persist the fingerprint only — never the raw samples.
        const newPrefs = { ...prefs, writingStyle: fingerprint };
        await tx
          .update(users)
          .set({ preferences: newPrefs, updatedAt: new Date() })
          .where(eq(users.id, userId));
        return true;
      });
      if (!found) return { captured: false, error: "User not found." };

      return { captured: true, fingerprint };
    } catch (err) {
      console.error(
        "[capture-writing-style] execute failed:",
        err instanceof Error ? err.message : err,
      );
      return { captured: false, error: "Something went wrong while learning your style." };
    }
  },
});
