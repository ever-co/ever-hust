import { NextResponse } from "next/server";
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
  deleteFile,
  storagePathFromPublicUrl,
  uploadFile,
} from "@ever-hust/supabase/storage";

/** Allowed MIME types for avatar uploads */
const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

/** Maximum file size: 5 MB */
const MAX_FILE_SIZE = 5 * 1024 * 1024;

/** Every extension this route stores, as `avatars/{userId}.{ext}`. */
const AVATAR_EXTENSIONS = ["jpg", "png", "webp"] as const;

/**
 * Best-effort delete of an avatar object. A failed delete only leaves an
 * orphaned object behind, so it never fails the request.
 */
async function removeAvatarObject(path: string): Promise<void> {
  try {
    await deleteFile(path);
  } catch (error) {
    console.warn(
      "[api/user/avatar] Failed to delete avatar object:",
      path,
      error instanceof Error ? error.message : error,
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

  // Rate limit: prevent abuse of file upload
  const rateLimited = applyRateLimit(userId, "authenticated");
  if (rateLimited) return rateLimited;

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch (err) {
    console.error(
      "[api/user/avatar] Failed to parse form data:",
      err instanceof Error ? err.message : err
    );
    return apiBadRequest("Invalid multipart form data");
  }

  const fileEntry = formData.get("avatar");
  if (!fileEntry || !(fileEntry instanceof File)) {
    return apiBadRequest("No file provided");
  }

  // Validate MIME type
  if (!ALLOWED_MIME_TYPES.has(fileEntry.type)) {
    return apiBadRequest("Only JPEG, PNG, and WebP images are supported");
  }

  // Validate file size
  if (fileEntry.size > MAX_FILE_SIZE) {
    return apiBadRequest("File must be under 5MB");
  }

  if (fileEntry.size < 100) {
    return apiBadRequest("File appears to be empty or too small");
  }

  try {
    const arrayBuffer = await fileEntry.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Determine file extension from MIME type
    const ext = fileEntry.type === "image/png"
      ? "png"
      : fileEntry.type === "image/webp"
        ? "webp"
        : "jpg";

    // Upload to Supabase Storage
    const storagePath = `avatars/${userId}.${ext}`;
    const publicUrl = await uploadFile(storagePath, buffer, fileEntry.type);

    // Save the URL under a lock on the user row, so two uploads at once each
    // see the other's URL: the URL read here is the one this upload replaces.
    const { saved, previousUrl } = await db.transaction(async (tx) => {
      const [current] = await tx
        .select({ photoUrl: users.photoUrl })
        .from(users)
        .where(eq(users.id, userId))
        .for("update");
      const updated = await tx
        .update(users)
        .set({ photoUrl: publicUrl, updatedAt: new Date() })
        .where(eq(users.id, userId))
        .returning({ id: users.id });
      return {
        saved: updated.length > 0,
        previousUrl: current?.photoUrl ?? null,
      };
    });

    // The account was deleted while this upload ran, so its files may already
    // be gone: delete the new object instead of leaving an avatar behind that
    // no account references. Only here: on any other failure the path may be
    // the one the row still points at (same extension, overwritten in place).
    if (!saved) {
      console.error("[api/user/avatar] Upload error: User no longer exists");
      await removeAvatarObject(storagePath);
      return apiError("Failed to upload avatar. Please try again.");
    }

    // A new extension is a new path: the previous avatar is no longer
    // referenced. Only this user's own avatar object is ever deleted.
    const previousPath = storagePathFromPublicUrl(previousUrl);
    if (
      previousPath &&
      previousPath !== storagePath &&
      AVATAR_EXTENSIONS.some(
        (extension) => previousPath === `avatars/${userId}.${extension}`,
      )
    ) {
      await removeAvatarObject(previousPath);
    }

    return apiSuccess({ url: publicUrl });
  } catch (error) {
    console.error(
      "[api/user/avatar] Upload error:",
      error instanceof Error ? error.message : error
    );
    return apiError("Failed to upload avatar. Please try again.");
  }
}
