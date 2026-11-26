import { NextResponse } from "next/server";
import {
  isCvUnreadableError,
  parseCV,
  SUPPORTED_CV_MIME_TYPES,
  SUPPORTED_CV_EXTENSIONS,
} from "@ever-hust/cv-parser";
import type { ParsedCV } from "@ever-hust/cv-parser";
import { db } from "@ever-hust/db";
import { users } from "@ever-hust/db";
import { eq } from "drizzle-orm";
import { requireSessionUser } from "../../../../lib/get-session-user";
import { applyRateLimit } from "../../../../lib/rate-limit";
import {
  apiSuccess,
  apiBadRequest,
  apiError,
} from "../../../../lib/api-response";
import {
  CV_BUCKET,
  cvStorageObject,
  deleteFile,
  uploadPrivateFile,
} from "@ever-hust/supabase/storage";
import type { StorageObject } from "@ever-hust/supabase/storage";

/** Maximum file size: 10 MB */
const MAX_FILE_SIZE = 10 * 1024 * 1024;

/**
 * Map of file extensions to their human-readable format names.
 * Used for error messages.
 */
const EXTENSION_LABELS = "PDF, Word (.docx), or plain text (.txt)";

/** Where the owner fetches their CV: the bucket is private, there is no public URL. */
const CV_FILE_ROUTE = "/api/cv/file";

/** 422: the file's bytes could not be read. The only failure that is the upload's fault. */
const UNREADABLE_MESSAGE =
  "We could not read this CV. Please check that the file is a valid PDF, Word (.docx) or plain-text file.";
/** 500: the parser itself failed (not the file). */
const PARSER_FAILED_MESSAGE =
  "We could not process your CV right now. Please try again later.";
/** 503: Storage refused or could not be reached. */
const STORAGE_FAILED_MESSAGE =
  "We could not store your CV right now. Please try again later.";
/** 500: the database update failed. */
const SAVE_FAILED_MESSAGE =
  "We could not save your CV right now. Please try again later.";

/** The account was deleted while the upload ran. */
class UserGoneError extends Error {
  constructor() {
    super("User no longer exists");
    this.name = "UserGoneError";
  }
}

/** The message of a caught error, for the log. */
function errorMessage(error: unknown): unknown {
  return error instanceof Error ? error.message : error;
}

/**
 * Best-effort delete of a CV object. A failed delete only leaves an orphaned
 * object behind, so it never fails the request.
 */
async function removeCvObject(object: StorageObject): Promise<void> {
  try {
    await deleteFile(object.path, object.bucket);
  } catch (error) {
    console.warn(
      "[cv/upload] Failed to delete CV object:",
      `${object.bucket}/${object.path}`,
      errorMessage(error),
    );
  }
}

export async function POST(req: Request) {
  let user;
  try {
    user = await requireSessionUser();
  } catch (response) {
    return response as NextResponse;
  }
  const userId = user.id;

  // Rate limit: prevent abuse of file upload (uses authenticated tier)
  const rateLimited = applyRateLimit(userId, "authenticated");
  if (rateLimited) return rateLimited;

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch (err) {
    console.error("[api/cv/upload] Failed to parse form data:", err instanceof Error ? err.message : err);
    return apiBadRequest("Invalid multipart form data");
  }

  const fileEntry = formData.get("cv");
  if (!fileEntry || !(fileEntry instanceof File)) {
    return apiBadRequest("No file provided");
  }
  const file = fileEntry;

  // Validate file type (MIME)
  if (!SUPPORTED_CV_MIME_TYPES.has(file.type)) {
    return apiBadRequest(`Unsupported file type. Accepted: ${EXTENSION_LABELS}`);
  }

  // Refuse path-like names. The name is never used as the storage key, but a
  // hand-made multipart filename such as "../x.pdf" is never a real upload.
  const rawName = file.name ?? "";
  if (rawName.includes("/") || rawName.includes("\\") || rawName.includes("..")) {
    return apiBadRequest("Invalid file name");
  }

  // Validate file extension
  const fileName = rawName.toLowerCase();
  const ext = fileName.split(".").pop() ?? "";
  if (!fileName || !SUPPORTED_CV_EXTENSIONS.has(ext)) {
    return apiBadRequest(`File must have a supported extension: ${EXTENSION_LABELS}`);
  }

  // Validate file size
  if (file.size > MAX_FILE_SIZE) {
    return apiBadRequest("File must be under 10MB");
  }

  // Reject empty or suspiciously small files
  if (file.size < 10) {
    return apiBadRequest(
      "File appears to be empty or too small to be valid",
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  // 1. Read the CV before storing anything, so a file that cannot be read
  // never reaches Storage. Only unreadable bytes are the upload's fault.
  let parsed: ParsedCV;
  try {
    parsed = await parseCV(buffer, file.type);
  } catch (error) {
    if (isCvUnreadableError(error)) {
      console.warn("[cv/upload] Unreadable CV:", errorMessage(error));
      return apiError(UNREADABLE_MESSAGE, 422);
    }
    console.error("[cv/upload] CV parser failed:", errorMessage(error));
    return apiError(PARSER_FAILED_MESSAGE, 500);
  }

  // 2. Store it in the private CV bucket under a server-chosen name: the
  // client's file name must never reach the storage key (path traversal).
  // Every upload gets a new random key, so nothing is overwritten: the object
  // written here is deleted again when saving fails, and the CV it replaces is
  // deleted once the new path is saved.
  const stored: StorageObject = {
    bucket: CV_BUCKET,
    path: `${userId}/${crypto.randomUUID()}.${ext}`,
  };
  try {
    await uploadPrivateFile(stored.path, buffer, file.type, stored.bucket);
  } catch (error) {
    console.error("[cv/upload] Storage upload failed:", errorMessage(error));
    return apiError(STORAGE_FAILED_MESSAGE, 503);
  }

  // 3. Store the parsed data and the object path, and merge skills, under a
  // lock on the user row, so two uploads at once each see the other's path
  // and skills: the value read here is the CV this upload replaces.
  let previousValue: string | null;
  try {
    previousValue = await db.transaction(async (tx) => {
      const [current] = await tx
        .select({ skills: users.skills, cvUrl: users.cvUrl })
        .from(users)
        .where(eq(users.id, userId))
        .for("update");

      // The account was deleted while this upload ran, so its files may
      // already be gone: fail, and the new object is deleted below instead of
      // leaving a CV behind that no account references.
      if (!current) throw new UserGoneError();

      // users.cv_url holds the object path in the private bucket, not a URL.
      const updateFields: Partial<typeof users.$inferInsert> = {
        cvParsedData: parsed,
        cvUrl: stored.path,
        updatedAt: new Date(),
      };

      // Merge CV skills with existing user skills
      if ((parsed.skills ?? []).length > 0) {
        const existingSkills = (current.skills as string[] | null) ?? [];
        updateFields.skills = [
          ...new Set([...existingSkills, ...(parsed.skills ?? [])]),
        ];
      }

      await tx.update(users).set(updateFields).where(eq(users.id, userId));
      return current.cvUrl ?? null;
    });
  } catch (error) {
    // The new object is not referenced by the user row: delete it.
    await removeCvObject(stored);
    if (error instanceof UserGoneError) {
      return apiError("Your account no longer exists.", 404);
    }
    console.error("[cv/upload] Saving the CV failed:", errorMessage(error));
    return apiError(SAVE_FAILED_MESSAGE, 500);
  }

  // The previous CV is no longer referenced. Only one of this user's own CVs
  // is ever deleted (cvStorageObject checks the folder), in the private bucket
  // or, for a CV from before CVs were private, in the public one.
  const previous = cvStorageObject(previousValue, userId);
  if (
    previous &&
    !(previous.bucket === stored.bucket && previous.path === stored.path)
  ) {
    await removeCvObject(previous);
  }

  return apiSuccess({
    parsed: {
      name: parsed.name,
      email: parsed.email,
      phone: parsed.phone,
      skills: parsed.skills ?? [],
      skillsCount: (parsed.skills ?? []).length,
      hasExperience: (parsed.experience ?? []).length > 0,
      hasEducation: (parsed.education ?? []).length > 0,
      textLength: parsed.rawText?.length ?? 0,
    },
    // Only the owner can fetch it there; there is no public URL.
    fileUrl: CV_FILE_ROUTE,
  });
}
