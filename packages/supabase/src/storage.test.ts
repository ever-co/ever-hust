/**
 * uploadFile writes with the service-role key, and @supabase/storage-js puts the
 * path into the request URL unencoded. A ".." or "." segment (also as %2e) or a
 * backslash would be resolved by the URL parser and could reach another folder
 * or bucket, so uploadFile must refuse such paths before calling Storage.
 */
const mockUpload = jest.fn();
const mockGetPublicUrl = jest.fn();
const mockFrom = jest.fn();
jest.mock("./server", () => ({
  getSupabaseServer: () => ({
    storage: { from: (...args: unknown[]) => mockFrom(...args) },
  }),
}));

import {
  cvStorageObject,
  deleteFile,
  deleteUserFiles,
  downloadFile,
  storagePathFromPublicUrl,
  uploadFile,
  uploadPrivateFile,
} from "./storage";

const data = Buffer.from("hello world");

describe("uploadFile path guard", () => {
  beforeEach(() => {
    mockUpload.mockReset();
    mockGetPublicUrl.mockReset();
    mockFrom.mockReset();
    mockUpload.mockResolvedValue({ error: null });
    mockGetPublicUrl.mockImplementation((path: string) => ({
      data: { publicUrl: `https://storage.example.com/${path}` },
    }));
    mockFrom.mockReturnValue({
      upload: mockUpload,
      getPublicUrl: mockGetPublicUrl,
    });
  });

  it.each([
    ["a parent segment", "cvs/user-1/../victim/resume.pdf"],
    ["a leading parent segment", "../other/x.pdf"],
    ["a trailing parent segment", "cvs/user-1/.."],
    ["a current-directory segment", "cvs/./user-1/cv.pdf"],
    ["a lone dot", "."],
    ["a backslash", "cvs\\user-1\\cv.pdf"],
    ["a backslash parent segment", "cvs/user-1/..\\..\\other\\x.pdf"],
    ["a percent-encoded parent segment", "cvs/user-1/%2e%2e/victim/x.pdf"],
    [
      "a mixed-case percent-encoded parent segment",
      "cvs/user-1/.%2E/victim/x.pdf",
    ],
    ["a percent-encoded current-directory segment", "cvs/%2e/user-1/cv.pdf"],
    // The URL parser drops tab, CR and LF, so these become ".." segments.
    ["a tab inside a parent segment", "cvs/user-1/.\t./.\t./.\t./other/x.pdf"],
    ["a line feed inside a parent segment", "cvs/user-1/.\n./victim/x.pdf"],
    [
      "a carriage return inside a parent segment",
      "cvs/user-1/.\r./victim/x.pdf",
    ],
    ["a tab between encoded dots", "cvs/user-1/%2e\t%2e/victim/x.pdf"],
    ["a leading tab before a parent segment", "cvs/user-1/\t../victim/x.pdf"],
    ["a NUL character", "cvs/user-1/cv.pdf\u0000"],
    ["a DEL character", "cvs/user-1/cv\u007f.pdf"],
  ])(
    "throws for a path with %s and never calls Storage",
    async (_label, path) => {
      await expect(uploadFile(path, data, "application/pdf")).rejects.toThrow(
        /Invalid storage path/,
      );
      expect(mockFrom).not.toHaveBeenCalled();
      expect(mockUpload).not.toHaveBeenCalled();
    },
  );

  it("does not echo the refused path in the error", async () => {
    const error = await uploadFile(
      "cvs/u/../secret-name.pdf",
      data,
      "application/pdf",
    ).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/Invalid storage path/);
    expect((error as Error).message).not.toContain("secret-name");
  });

  it.each([
    ["a CV path", "cvs/user-1/0b6f3c9e-5d2a-4c1f-9a7e-2f1d3c4b5a69.pdf"],
    ["an avatar path", "avatars/user-1.webp"],
    [
      "a file name with dots that are not a segment",
      "cvs/user-1/my.resume.v2.pdf",
    ],
    ["a segment that starts with dots", "cvs/user-1/..hidden.pdf"],
  ])("uploads %s unchanged", async (_label, path) => {
    const url = await uploadFile(path, data, "application/pdf");
    expect(mockFrom).toHaveBeenCalledWith("user-uploads");
    expect(mockUpload).toHaveBeenCalledWith(path, data, {
      contentType: "application/pdf",
      upsert: true,
    });
    expect(url).toBe(`https://storage.example.com/${path}`);
  });

  it("guards paths for a non-default bucket too", async () => {
    await expect(
      uploadFile("../user-uploads/x.pdf", data, "application/pdf", "other"),
    ).rejects.toThrow(/Invalid storage path/);
    expect(mockUpload).not.toHaveBeenCalled();
  });
});

/**
 * Deleting an account must also erase the files the user uploaded: every CV
 * (name, email, phone, work history) in the private bucket's {userId}/ folder,
 * every CV from before CVs were private in the public bucket's cvs/{userId}/,
 * and the avatar, whatever its extension. Storage lists a folder 100 entries
 * at a time, so each folder has to be read page by page.
 */
describe("deleteUserFiles", () => {
  /** list(bucket, folder, options) and remove(bucket, paths): the bucket comes first. */
  const mockList = jest.fn();
  const mockRemove = jest.fn();
  let warn: jest.SpyInstance;

  /** A CV folder with more files than one list page holds. */
  const cvNames = Array.from(
    { length: 150 },
    (_, i) => `${String(i).padStart(3, "0")}.pdf`,
  );
  const avatarPaths = ["avatars/u1.jpg", "avatars/u1.png", "avatars/u1.webp"];
  const publicAvatars = avatarPaths.map((path) => `user-uploads:${path}`);

  /**
   * Serve each "bucket/folder" key's names the way Storage does: one page per
   * call, by offset and limit. Folders not named are empty.
   */
  function serveFolders(folders: Record<string, string[]>) {
    mockList.mockImplementation(
      async (
        bucket: string,
        folder: string,
        options: { limit: number; offset: number },
      ) => ({
        data: (folders[`${bucket}/${folder}`] ?? [])
          .slice(options.offset, options.offset + options.limit)
          .map((name) => ({ name, id: `id-${name}` })),
        error: null,
      }),
    );
  }

  /** Every "bucket:path" passed to remove(), across all calls, sorted. */
  function removed(): string[] {
    return mockRemove.mock.calls
      .flatMap(([bucket, paths]) =>
        (paths as string[]).map((path) => `${bucket as string}:${path}`),
      )
      .sort();
  }

  beforeEach(() => {
    mockList.mockReset();
    mockRemove.mockReset();
    mockFrom.mockReset();
    mockRemove.mockResolvedValue({ data: [], error: null });
    mockFrom.mockImplementation((bucket: string) => ({
      list: (...args: unknown[]) => mockList(bucket, ...args),
      remove: (...args: unknown[]) => mockRemove(bucket, ...args),
    }));
    warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("lists the private <userId> folder across two pages and removes every CV plus the avatar paths", async () => {
    serveFolders({ "cvs/u1": cvNames });

    await expect(deleteUserFiles("u1")).resolves.toBeUndefined();

    const cvListCalls = mockList.mock.calls.filter(([bucket]) => bucket === "cvs");
    // Two pages: the first is full, the second is not, so listing stops there.
    expect(cvListCalls.map((call) => call[1])).toEqual(["u1", "u1"]);
    expect(cvListCalls.map((call) => call[2].offset)).toEqual([0, 100]);
    expect(removed()).toEqual(
      [...cvNames.map((name) => `cvs:u1/${name}`), ...publicAvatars].sort(),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("also removes CVs from before CVs were private, in the public bucket's cvs/<userId>", async () => {
    serveFolders({
      "cvs/u1": ["new.pdf"],
      "user-uploads/cvs/u1": ["old-1.pdf", "old-2.docx"],
    });

    await deleteUserFiles("u1");

    expect(mockList.mock.calls.map((call) => `${call[0]}/${call[1]}`)).toEqual([
      "cvs/u1",
      "user-uploads/cvs/u1",
    ]);
    expect(removed()).toEqual(
      [
        "cvs:u1/new.pdf",
        "user-uploads:cvs/u1/old-1.pdf",
        "user-uploads:cvs/u1/old-2.docx",
        ...publicAvatars,
      ].sort(),
    );
  });

  it("removes only the avatar paths when the user has no CV", async () => {
    serveFolders({});

    await deleteUserFiles("u1");

    expect(mockList).toHaveBeenCalledTimes(2);
    expect(removed()).toEqual([...publicAvatars].sort());
  });

  it("logs a failed listing of the private folder and still cleans the public bucket", async () => {
    mockList.mockImplementation(async (bucket: string) =>
      bucket === "cvs"
        ? { data: null, error: { message: "list down" } }
        : { data: [], error: null },
    );

    await expect(deleteUserFiles("u1")).resolves.toBeUndefined();

    expect(removed()).toEqual([...publicAvatars].sort());
    expect(warn).toHaveBeenCalled();
  });

  it("logs a list call that throws and still cleans the public bucket", async () => {
    mockList.mockImplementation(async (bucket: string) => {
      if (bucket === "cvs") throw new Error("socket hang up");
      return { data: [], error: null };
    });

    await expect(deleteUserFiles("u1")).resolves.toBeUndefined();

    expect(removed()).toEqual([...publicAvatars].sort());
    expect(warn).toHaveBeenCalled();
  });

  it("logs a failed remove in one bucket and still removes in the other", async () => {
    serveFolders({ "cvs/u1": ["a.pdf"] });
    mockRemove.mockImplementation(async (bucket: string) =>
      bucket === "cvs"
        ? { data: null, error: { message: "remove down" } }
        : { data: [], error: null },
    );

    await expect(deleteUserFiles("u1")).resolves.toBeUndefined();

    expect(removed()).toContain("user-uploads:avatars/u1.webp");
    expect(warn).toHaveBeenCalled();
  });

  it("logs and does not throw when Storage is not reachable at all", async () => {
    mockFrom.mockImplementation(() => {
      throw new Error("Missing Supabase server environment variables");
    });

    await expect(deleteUserFiles("u1")).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalled();
  });

  it.each([
    ["an empty id", ""],
    ["a parent segment", ".."],
    ["a nested path", "u1/../u2"],
    ["a slash", "u1/u2"],
    ["a backslash", "u1\\..\\u2"],
    ["a control character", "u1\t"],
  ])("never calls Storage for a user id with %s", async (_label, userId) => {
    await expect(deleteUserFiles(userId)).resolves.toBeUndefined();

    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockList).not.toHaveBeenCalled();
    expect(mockRemove).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });
});

/**
 * CVs go to the private bucket: no public URL, never overwritten, and stored
 * with a Cache-Control that keeps Cloudflare (in front of the Storage host)
 * from keeping a copy.
 */
describe("uploadPrivateFile", () => {
  const mockUploadPrivate = jest.fn();
  beforeEach(() => {
    mockFrom.mockReset();
    mockUploadPrivate.mockReset();
    mockUploadPrivate.mockResolvedValue({ data: {}, error: null });
    mockFrom.mockReturnValue({ upload: mockUploadPrivate });
  });

  it("uploads to the private cvs bucket and returns the path, not a URL", async () => {
    const path = "user-1/0b6f3c9e-5d2a-4c1f-9a7e-2f1d3c4b5a69.pdf";

    await expect(uploadPrivateFile(path, data, "application/pdf")).resolves.toBe(path);

    expect(mockFrom).toHaveBeenCalledWith("cvs");
    expect(mockUploadPrivate).toHaveBeenCalledWith(path, data, {
      contentType: "application/pdf",
      upsert: false,
      headers: { "cache-control": "private, no-store" },
    });
  });

  it("throws when Storage refuses the upload", async () => {
    mockUploadPrivate.mockResolvedValue({
      data: null,
      error: { message: "Bucket not found" },
    });

    await expect(
      uploadPrivateFile("user-1/x.pdf", data, "application/pdf"),
    ).rejects.toThrow("Storage upload failed: Bucket not found");
  });

  it("refuses an unsafe path before calling Storage", async () => {
    await expect(
      uploadPrivateFile("user-1/../user-2/x.pdf", data, "application/pdf"),
    ).rejects.toThrow(/Invalid storage path/);
    expect(mockFrom).not.toHaveBeenCalled();
  });
});

describe("downloadFile", () => {
  const mockDownload = jest.fn();
  beforeEach(() => {
    mockFrom.mockReset();
    mockDownload.mockReset();
    mockFrom.mockReturnValue({ download: mockDownload });
  });

  it("returns the file from the private cvs bucket by default", async () => {
    const blob = new Blob(["%PDF-1.4"], { type: "application/pdf" });
    mockDownload.mockResolvedValue({ data: blob, error: null });

    await expect(downloadFile("user-1/x.pdf")).resolves.toBe(blob);

    expect(mockFrom).toHaveBeenCalledWith("cvs");
    expect(mockDownload).toHaveBeenCalledWith("user-1/x.pdf");
  });

  it("reads another bucket when asked", async () => {
    mockDownload.mockResolvedValue({ data: new Blob(["x"]), error: null });

    await downloadFile("cvs/user-1/x.pdf", "user-uploads");

    expect(mockFrom).toHaveBeenCalledWith("user-uploads");
  });

  it("throws when Storage does not return the file", async () => {
    mockDownload.mockResolvedValue({
      data: null,
      error: { message: "Object not found" },
    });

    await expect(downloadFile("user-1/x.pdf")).rejects.toThrow(
      "Storage download failed: Object not found",
    );
  });

  it("refuses an unsafe path before calling Storage", async () => {
    await expect(downloadFile("user-1/%2e%2e/user-2/x.pdf")).rejects.toThrow(
      /Invalid storage path/,
    );
    expect(mockFrom).not.toHaveBeenCalled();
  });
});

/**
 * users.cv_url names the CV to serve, replace or delete with the service-role
 * key, so it must only ever resolve to an object in the user's own folder.
 */
describe("cvStorageObject", () => {
  const publicBase =
    "https://supabase.example.com/storage/v1/object/public/user-uploads/";

  it("reads a path in the private bucket", () => {
    expect(cvStorageObject("user-1/0b6f.pdf", "user-1")).toEqual({
      bucket: "cvs",
      path: "user-1/0b6f.pdf",
    });
  });

  it("reads a public URL from before CVs were private", () => {
    expect(
      cvStorageObject(`${publicBase}cvs/user-1/0b6f.pdf`, "user-1"),
    ).toEqual({ bucket: "user-uploads", path: "cvs/user-1/0b6f.pdf" });
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an empty value", ""],
    ["another user's path", "user-2/0b6f.pdf"],
    ["a path whose folder only starts with the user id", "user-10/0b6f.pdf"],
    ["the user's folder itself", "user-1/"],
    ["a nested path", "user-1/sub/0b6f.pdf"],
    ["a parent segment", "user-1/../user-2/0b6f.pdf"],
    ["an encoded parent segment", "user-1/%2e%2e"],
    ["a backslash", "user-1/..\\user-2\\x.pdf"],
    ["a control character", "user-1/x.pdf\u0000"],
    ["a public URL of another user's CV", `${publicBase}cvs/user-2/0b6f.pdf`],
    ["a public URL of the user's avatar", `${publicBase}avatars/user-1.png`],
    ["a public URL with a parent segment", `${publicBase}cvs/user-1/../user-2/x.pdf`],
    ["a public URL of a nested path", `${publicBase}cvs/user-1/sub/x.pdf`],
    [
      "a public URL of another bucket",
      "https://supabase.example.com/storage/v1/object/public/other/cvs/user-1/x.pdf",
    ],
    ["a URL of another site", "https://evil.example.com/user-1/x.pdf"],
  ])("returns null for %s", (_label, stored) => {
    expect(cvStorageObject(stored, "user-1")).toBeNull();
  });

  it.each([
    ["an empty user id", ""],
    ["a user id with a slash", "user-1/x"],
    ["a dot-dot user id", ".."],
  ])("returns null for %s", (_label, userId) => {
    expect(cvStorageObject(`${userId}/x.pdf`, userId)).toBeNull();
  });
});

describe("storagePathFromPublicUrl", () => {
  const base =
    "https://abc.supabase.co/storage/v1/object/public/user-uploads/";

  it.each([
    ["a CV URL", `${base}cvs/user-1/0b6f3c9e.pdf`, "cvs/user-1/0b6f3c9e.pdf"],
    ["an encoded file name", `${base}cvs/user-1/My%20Resume.pdf`, "cvs/user-1/My Resume.pdf"],
    ["a URL with a query string", `${base}cvs/user-1/cv.pdf?download=1`, "cvs/user-1/cv.pdf"],
  ])("returns the path of %s", (_label, url, path) => {
    expect(storagePathFromPublicUrl(url)).toBe(path);
  });

  it.each([
    ["null", null],
    ["an empty string", ""],
    ["not a URL", "cvs/user-1/cv.pdf"],
    ["another bucket", "https://abc.supabase.co/storage/v1/object/public/other/cvs/user-1/cv.pdf"],
    ["a signed URL", "https://abc.supabase.co/storage/v1/object/sign/user-uploads/cvs/user-1/cv.pdf"],
    ["the bucket root", base],
    ["a parent segment", `${base}cvs/user-1/../user-2/cv.pdf`],
    ["an encoded parent segment", `${base}cvs/user-1/%2e%2e/user-2/cv.pdf`],
    ["an encoded backslash", `${base}cvs/user-1/..%5Cuser-2%5Ccv.pdf`],
    ["broken percent-encoding", `${base}cvs/user-1/%E0%A4%A.pdf`],
  ])("returns null for %s", (_label, url) => {
    expect(storagePathFromPublicUrl(url)).toBeNull();
  });
});

describe("deleteFile path guard", () => {
  const mockRemove = jest.fn();
  beforeEach(() => {
    mockFrom.mockReset();
    mockRemove.mockReset();
    mockRemove.mockResolvedValue({ error: null });
    mockFrom.mockReturnValue({ remove: mockRemove });
  });

  it("deletes a safe path", async () => {
    await deleteFile("cvs/user-1/cv.pdf");
    expect(mockRemove).toHaveBeenCalledWith(["cvs/user-1/cv.pdf"]);
  });

  it("throws for a parent segment and never calls Storage", async () => {
    await expect(deleteFile("cvs/user-1/../user-2/cv.pdf")).rejects.toThrow(
      /Invalid storage path/,
    );
    expect(mockFrom).not.toHaveBeenCalled();
  });
});
