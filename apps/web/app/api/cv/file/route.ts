import { NextResponse } from "next/server";
import { db, users } from "@ever-hust/db";
import { eq } from "drizzle-orm";
import { requireSessionUser } from "../../../../lib/get-session-user";
import { applyRateLimit } from "../../../../lib/rate-limit";
import { apiError, apiNotFound } from "../../../../lib/api-response";
import {
  cvStorageObject,
  downloadFile,
} from "@ever-hust/supabase/storage";

/**
 * The content type each CV extension is served with. The upload route only
 * stores these three, and the type is chosen here, never taken from Storage.
 */
const CV_CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain; charset=utf-8",
};

/**
 * GET /api/cv/file: the signed-in user's own CV, as a download.
 *
 * CVs live in a private bucket with no public URL. The file is read here with
 * the service-role key and handed only to its owner: the object comes from the
 * caller's own users.cv_url, and cvStorageObject accepts only a path inside the
 * caller's own folder. Nothing on the way may cache it.
 */
export async function GET() {
  let user;
  try {
    user = await requireSessionUser();
  } catch (response) {
    return response as NextResponse;
  }
  const userId = user.id;

  const rateLimited = applyRateLimit(userId, "authenticated");
  if (rateLimited) return rateLimited;

  let storedValue: string | null;
  try {
    const [row] = await db
      .select({ cvUrl: users.cvUrl })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    storedValue = row?.cvUrl ?? null;
  } catch (error) {
    console.error(
      "[cv/file] Failed to read the user's CV path:",
      error instanceof Error ? error.message : error,
    );
    return apiError("We could not load your CV right now. Please try again later.");
  }

  const object = cvStorageObject(storedValue, userId);
  if (!object) return apiNotFound("No CV uploaded");

  let file: Blob;
  try {
    file = await downloadFile(object.path, object.bucket);
  } catch (error) {
    console.error(
      "[cv/file] Storage download failed:",
      error instanceof Error ? error.message : error,
    );
    return apiError(
      "We could not load your CV right now. Please try again later.",
      503,
    );
  }

  const ext = object.path.split(".").pop()?.toLowerCase() ?? "";
  const contentType = CV_CONTENT_TYPES[ext];
  return new NextResponse(file, {
    status: 200,
    headers: {
      "Content-Type": contentType ?? "application/octet-stream",
      "Content-Length": String(file.size),
      // A download, never rendered on this origin.
      "Content-Disposition": `attachment; filename="cv${contentType ? `.${ext}` : ""}"`,
      "Cache-Control": "private, no-cache, no-store, must-revalidate",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
