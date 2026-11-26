import { getSupabaseServer } from "./server";

/**
 * The public bucket: avatars, which anyone may fetch by URL. CVs uploaded
 * before they moved to {@link CV_BUCKET} sit here too, under `cvs/{userId}/`.
 */
export const PUBLIC_BUCKET = "user-uploads";

/**
 * The private bucket for CVs (name, email, phone, work history). It has no
 * public URL: only the service role reads it, and the app hands a CV to its
 * owner alone (GET /api/cv/file). Objects are `{userId}/{uuid}.{ext}`.
 */
export const CV_BUCKET = "cvs";

/** Default bucket name for user-uploaded files */
const DEFAULT_BUCKET = PUBLIC_BUCKET;

/**
 * Cache-Control stored with every private object and sent back whenever it is
 * read. The server reaches Storage through the public host, behind Cloudflare,
 * and a shared cache must never keep a copy of a private file.
 */
const PRIVATE_CACHE_CONTROL = "private, no-store";

/** How many entries one Storage list call returns. */
const LIST_PAGE_SIZE = 100;

/** Every extension the avatar route stores, as `avatars/{userId}.{ext}`. */
const AVATAR_EXTENSIONS = ["jpg", "png", "webp"] as const;

/**
 * Throw when a storage path could leave the folder it names.
 *
 * storage-js puts the path into the request URL without encoding it, and the
 * URL parser resolves "." and ".." segments (also written as %2e) and treats
 * "\" as "/". It also drops tab, CR and LF anywhere in the URL, so ".\t." would
 * become ".." after this check: control characters are refused too. The upload
 * runs with the service-role key, so such a path could write into another
 * user's folder or another bucket.
 */
function assertSafeStoragePath(path: string): void {
  const unsafe =
    path.includes("\\") ||
    hasControlCharacter(path) ||
    path.split("/").some((segment) => {
      const dots = segment.replace(/%2e/gi, ".");
      return dots === "." || dots === "..";
    });
  if (unsafe) {
    // Do not echo the path: it is often built from user input.
    throw new Error(
      "Invalid storage path: dot segments, backslashes and control characters are not allowed",
    );
  }
}

/** True when the string has an ASCII control character (U+0000-U+001F or U+007F). */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Upload a file to Supabase Storage and return its public URL. For files that
 * anyone may fetch (avatars); CVs go through {@link uploadPrivateFile}.
 *
 * Throws before any network call when the path has a "." or ".." segment
 * (also percent-encoded), a backslash or a control character.
 *
 * @param path   - Storage path, e.g. `avatars/{userId}.webp`
 * @param data   - File contents as Buffer or Uint8Array
 * @param contentType - MIME type of the file
 * @param bucket - Storage bucket name (defaults to "user-uploads")
 * @returns The public URL of the uploaded file
 */
export async function uploadFile(
  path: string,
  data: Buffer | Uint8Array,
  contentType: string,
  bucket = DEFAULT_BUCKET,
): Promise<string> {
  assertSafeStoragePath(path);
  const supabase = getSupabaseServer();

  const { error } = await supabase.storage
    .from(bucket)
    .upload(path, data, {
      contentType,
      upsert: true, // overwrite if exists (e.g. avatar re-upload)
    });

  if (error) {
    throw new Error(`Storage upload failed: ${error.message}`);
  }

  return getPublicUrl(path, bucket);
}

/**
 * Get the public URL for a file in Supabase Storage.
 *
 * @param path   - Storage path
 * @param bucket - Storage bucket name
 * @returns Public URL string
 */
export function getPublicUrl(
  path: string,
  bucket = DEFAULT_BUCKET,
): string {
  const supabase = getSupabaseServer();
  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  return data.publicUrl;
}

/**
 * Upload a file to a private bucket, never overwriting an existing object.
 * The object gets no public URL, and Storage answers every read of it with
 * `Cache-Control: private, no-store`.
 *
 * Throws before any network call on an unsafe path, like {@link uploadFile},
 * and throws when Storage refuses the upload.
 *
 * @param path        - Storage path inside the bucket, e.g. `{userId}/{uuid}.pdf`
 * @param data        - File contents as Buffer or Uint8Array
 * @param contentType - MIME type of the file
 * @param bucket      - Storage bucket name (defaults to {@link CV_BUCKET})
 * @returns The storage path, which is what callers keep (not a URL)
 */
export async function uploadPrivateFile(
  path: string,
  data: Buffer | Uint8Array,
  contentType: string,
  bucket = CV_BUCKET,
): Promise<string> {
  assertSafeStoragePath(path);
  const supabase = getSupabaseServer();

  const { error } = await supabase.storage.from(bucket).upload(path, data, {
    contentType,
    upsert: false,
    // storage-js would send "max-age=3600"; its headers option goes last.
    headers: { "cache-control": PRIVATE_CACHE_CONTROL },
  });

  if (error) {
    throw new Error(`Storage upload failed: ${error.message}`);
  }

  return path;
}

/**
 * Download a file with the service-role key, from any bucket (private or
 * public). Throws before any network call on an unsafe path, like
 * {@link uploadFile}, and throws when Storage does not return the file.
 *
 * @param path   - Storage path inside the bucket
 * @param bucket - Storage bucket name (defaults to {@link CV_BUCKET})
 * @returns The file contents; `type` is the content type Storage answered with
 */
export async function downloadFile(
  path: string,
  bucket = CV_BUCKET,
): Promise<Blob> {
  assertSafeStoragePath(path);
  const supabase = getSupabaseServer();
  const { data, error } = await supabase.storage.from(bucket).download(path);
  if (error || !data) {
    throw new Error(
      `Storage download failed: ${error?.message ?? "no data"}`,
    );
  }
  return data;
}

/** A Storage object: its bucket and its path inside that bucket. */
export interface StorageObject {
  bucket: string;
  path: string;
}

/**
 * The object that a `users.cv_url` value names, when it is one of `userId`'s
 * own CVs; null for an empty value, another user's file, a URL of anything
 * else, or an unsafe path.
 *
 * New uploads store the path in {@link CV_BUCKET}, `{userId}/{uuid}.{ext}`.
 * CVs uploaded before that stored a public URL of {@link PUBLIC_BUCKET}, whose
 * path is `cvs/{userId}/{uuid}.{ext}`: those are still found, so replacing or
 * serving such a CV keeps working.
 */
export function cvStorageObject(
  stored: string | null | undefined,
  userId: string,
): StorageObject | null {
  if (!stored || !isPlainUserId(userId)) return null;

  // A scheme ("https:") means a public URL from before CVs were private.
  if (/^[a-z][a-z\d+.-]*:/i.test(stored)) {
    const path = storagePathFromPublicUrl(stored, PUBLIC_BUCKET);
    const folder = `cvs/${userId}/`;
    if (!path?.startsWith(folder) || !isFileName(path.slice(folder.length))) {
      return null;
    }
    return { bucket: PUBLIC_BUCKET, path };
  }

  const folder = `${userId}/`;
  if (!stored.startsWith(folder) || !isFileName(stored.slice(folder.length))) {
    return null;
  }
  try {
    assertSafeStoragePath(stored);
  } catch {
    return null;
  }
  return { bucket: CV_BUCKET, path: stored };
}

/** A user id that can name a storage folder: non-empty, no slash, safe. */
function isPlainUserId(userId: string): boolean {
  if (!userId || userId.includes("/")) return false;
  try {
    assertSafeStoragePath(userId);
    return true;
  } catch {
    return false;
  }
}

/** One path segment: non-empty, no slash, not "." or "..". */
function isFileName(name: string): boolean {
  return name.length > 0 && !name.includes("/") && name !== "." && name !== "..";
}

/**
 * The storage path of a public URL that {@link getPublicUrl} built for
 * `bucket`, e.g. `cvs/{userId}/{uuid}.pdf`; null when the URL is not a public
 * object URL of that bucket or its path is unsafe (see assertSafeStoragePath).
 */
export function storagePathFromPublicUrl(
  url: string | null | undefined,
  bucket = DEFAULT_BUCKET,
): string | null {
  if (!url) return null;
  // Read the raw string, not new URL(url).pathname: the URL parser would
  // resolve a ".." (or "%2e%2e") segment into a different, valid-looking path
  // instead of letting the check below refuse it.
  const withoutQuery = url.split(/[?#]/, 1)[0] ?? "";
  const marker = `/storage/v1/object/public/${bucket}/`;
  const at = withoutQuery.indexOf(marker);
  if (at === -1) return null;
  let path: string;
  try {
    path = decodeURIComponent(withoutQuery.slice(at + marker.length));
  } catch {
    return null;
  }
  if (!path) return null;
  try {
    assertSafeStoragePath(path);
  } catch {
    return null;
  }
  return path;
}

/**
 * Delete a file from Supabase Storage. Logs (does not throw) when Storage
 * refuses; throws before any network call on an unsafe path, like
 * {@link uploadFile}.
 *
 * @param path   - Storage path
 * @param bucket - Storage bucket name
 */
export async function deleteFile(
  path: string,
  bucket = DEFAULT_BUCKET,
): Promise<void> {
  assertSafeStoragePath(path);
  const supabase = getSupabaseServer();
  const { error } = await supabase.storage.from(bucket).remove([path]);
  if (error) {
    console.warn(`[storage] Failed to delete ${path}:`, error.message);
  }
}

/**
 * Delete every file a user uploaded: each CV in `{userId}/` of
 * {@link CV_BUCKET}, each CV from before CVs were private in `cvs/{userId}/`
 * of {@link PUBLIC_BUCKET}, and the avatar at `avatars/{userId}.jpg`, `.png`
 * or `.webp`.
 *
 * Best effort: failures are logged and never thrown, so a caller that already
 * deleted the user's row can still answer the request. A user id that is
 * empty, has a slash or would fail the storage path check is refused before any
 * Storage call, because an empty or nested id would list another folder.
 *
 * @param userId - The deleted user's id
 */
export async function deleteUserFiles(userId: string): Promise<void> {
  try {
    if (!userId || userId.includes("/")) {
      throw new Error("Invalid user id for storage cleanup");
    }
    assertSafeStoragePath(`cvs/${userId}`);
  } catch (err) {
    console.warn(
      "[storage] Refused to delete user files:",
      err instanceof Error ? err.message : err,
    );
    return;
  }

  try {
    const storage = getSupabaseServer().storage;

    // The private CV folder: every CV uploaded since CVs left the public bucket.
    const cvFiles = storage.from(CV_BUCKET);
    await removeObjects(cvFiles, await listFolder(cvFiles, userId), userId);

    // The public bucket: CVs from before that, and the avatar.
    const publicFiles = storage.from(PUBLIC_BUCKET);
    await removeObjects(
      publicFiles,
      [
        ...(await listFolder(publicFiles, `cvs/${userId}`)),
        ...AVATAR_EXTENSIONS.map((ext) => `avatars/${userId}.${ext}`),
      ],
      userId,
    );
  } catch (err) {
    console.warn(
      `[storage] Failed to delete files of user ${userId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** The Storage API of one bucket, as `storage.from(bucket)` returns it. */
type BucketApi = ReturnType<ReturnType<typeof getSupabaseServer>["storage"]["from"]>;

/**
 * Every object path directly inside `folder`, read page by page. The whole
 * folder is listed before anything is removed: removing while paging by
 * offset would shift the later pages and skip files. Logs and returns what it
 * has when a page fails.
 */
async function listFolder(files: BucketApi, folder: string): Promise<string[]> {
  const paths: string[] = [];
  try {
    for (let offset = 0; ; offset += LIST_PAGE_SIZE) {
      const { data, error } = await files.list(folder, {
        limit: LIST_PAGE_SIZE,
        offset,
      });
      if (error || !data) {
        console.warn(
          `[storage] Failed to list ${folder}:`,
          error?.message ?? "no data",
        );
        break;
      }
      paths.push(...data.map((file) => `${folder}/${file.name}`));
      if (data.length < LIST_PAGE_SIZE) break;
    }
  } catch (err) {
    console.warn(
      `[storage] Failed to list ${folder}:`,
      err instanceof Error ? err.message : err,
    );
  }
  return paths;
}

/** Remove `paths` in batches of one list page; logs failures, never throws. */
async function removeObjects(
  files: BucketApi,
  paths: string[],
  userId: string,
): Promise<void> {
  for (let i = 0; i < paths.length; i += LIST_PAGE_SIZE) {
    try {
      const { error } = await files.remove(paths.slice(i, i + LIST_PAGE_SIZE));
      if (error) {
        console.warn(
          `[storage] Failed to delete files of user ${userId}:`,
          error.message,
        );
      }
    } catch (err) {
      console.warn(
        `[storage] Failed to delete files of user ${userId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}
