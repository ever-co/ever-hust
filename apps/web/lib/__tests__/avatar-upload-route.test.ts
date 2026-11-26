/**
 * POST /api/user/avatar stores the avatar as avatars/<userId>.<ext>, the extension taken from the
 * image type, and saves its public URL in users.photo_url.
 *
 * Two kinds of avatar object used to stay in Storage with a working public URL:
 * - an upload that finished after the account was deleted: DELETE /api/user/account had already
 *   removed the user's files, and the profile write matched no row, but the route answered 200
 *   and kept the new object;
 * - the previous avatar when the new one has another extension (a JPEG replaced by a PNG), until
 *   the account was deleted.
 */
const MOCK_STORAGE =
  "https://storage.example.com/storage/v1/object/public/user-uploads/";
const mockUploadFile = jest.fn();
const mockDeleteFile = jest.fn();
jest.mock("@ever-hust/supabase/storage", () => ({
  uploadFile: (...args: unknown[]) => mockUploadFile(...args),
  deleteFile: (...args: unknown[]) => mockDeleteFile(...args),
  // Stand-in for the real helper (tested in packages/supabase/src/storage.test.ts).
  storagePathFromPublicUrl: (url: string | null) =>
    url?.startsWith(MOCK_STORAGE) ? url.slice(MOCK_STORAGE.length) : null,
}));

/** user-1's row. */
const mockUserRow: { photoUrl: string | null } = { photoUrl: null };
const mockDbCalls: string[] = [];
let mockSaveFails = false;
/** The account was deleted while the upload ran: no user row is left. */
let mockUserGone = false;

/** The statements the route can run, on the db itself or on a transaction. */
function mockQueries() {
  const write = async (values: Record<string, unknown>) => {
    mockDbCalls.push(`update ${Object.keys(values).sort().join(",")}`);
    if (mockSaveFails) throw new Error("connection lost");
    if (mockUserGone) return [];
    Object.assign(mockUserRow, values);
    return [{ id: "user-1" }];
  };
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          for: async (strength: string) => {
            mockDbCalls.push(`select for ${strength}`);
            return mockUserGone ? [] : [{ ...mockUserRow }];
          },
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: () => write(values),
          then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
            write(values).then(() => resolve(undefined), reject),
        }),
      }),
    }),
  };
}
jest.mock("@ever-hust/db", () => ({
  db: {
    ...mockQueries(),
    transaction: async <T>(fn: (tx: object) => Promise<T>) => fn(mockQueries()),
  },
  users: { id: "id", photoUrl: "photoUrl" },
}));
jest.mock("drizzle-orm", () => ({ eq: jest.fn() }));
jest.mock("../get-session-user", () => ({
  requireSessionUser: async () => ({ id: "user-1" }),
}));
jest.mock("../rate-limit", () => ({ applyRateLimit: () => null }));

import { POST } from "../../app/api/user/avatar/route";

/** Big enough for the route's 100-byte minimum. */
const IMAGE_BYTES = "x".repeat(200);

function upload(type: string) {
  const form = new FormData();
  form.append("avatar", new File([IMAGE_BYTES], "me", { type }));
  return POST(
    new Request("http://localhost/api/user/avatar", {
      method: "POST",
      body: form,
    }),
  );
}

describe("POST /api/user/avatar and the avatar objects it leaves behind", () => {
  let errorSpy: jest.SpyInstance;
  beforeEach(() => {
    mockUploadFile.mockReset();
    mockDeleteFile.mockReset();
    mockUploadFile.mockImplementation(
      async (path: string) => `${MOCK_STORAGE}${path}`,
    );
    mockDeleteFile.mockResolvedValue(undefined);
    mockUserRow.photoUrl = null;
    mockDbCalls.length = 0;
    mockSaveFails = false;
    mockUserGone = false;
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => errorSpy.mockRestore());

  it("stores the avatar as avatars/<userId>.<ext> and saves its URL", async () => {
    const res = await upload("image/png");

    expect(res.status).toBe(200);
    expect(mockUploadFile).toHaveBeenCalledTimes(1);
    expect(mockUploadFile.mock.calls[0][0]).toBe("avatars/user-1.png");
    expect(mockUserRow.photoUrl).toBe(`${MOCK_STORAGE}avatars/user-1.png`);
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });

  it("deletes the previous avatar when the new one has another extension", async () => {
    mockUserRow.photoUrl = `${MOCK_STORAGE}avatars/user-1.jpg`;

    const res = await upload("image/png");

    expect(res.status).toBe(200);
    expect(mockUserRow.photoUrl).toBe(`${MOCK_STORAGE}avatars/user-1.png`);
    expect(mockDeleteFile).toHaveBeenCalledTimes(1);
    expect(mockDeleteFile).toHaveBeenCalledWith("avatars/user-1.jpg");
    // Read under a row lock, written in the same transaction.
    expect(mockDbCalls).toEqual([
      "select for update",
      "update photoUrl,updatedAt",
    ]);
  });

  it("keeps the object when the new avatar has the same extension (it was overwritten)", async () => {
    mockUserRow.photoUrl = `${MOCK_STORAGE}avatars/user-1.jpg`;

    const res = await upload("image/jpeg");

    expect(res.status).toBe(200);
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a sign-in provider's picture",
      "https://media.example.com/photo/user-1.jpg",
    ],
    ["another user's avatar", `${MOCK_STORAGE}avatars/user-2.jpg`],
    ["a file outside avatars/", `${MOCK_STORAGE}cvs/user-1/cv.pdf`],
    [
      "a path that only starts like the user's avatar",
      `${MOCK_STORAGE}avatars/user-1.jpg/x`,
    ],
  ])("never deletes %s", async (_label, photoUrl) => {
    mockUserRow.photoUrl = photoUrl;

    const res = await upload("image/png");

    expect(res.status).toBe(200);
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });

  it("deletes the new object when the account was deleted while the upload ran", async () => {
    mockUserGone = true;

    const res = await upload("image/webp");

    expect(res.status).toBe(500);
    expect(mockDeleteFile).toHaveBeenCalledTimes(1);
    expect(mockDeleteFile).toHaveBeenCalledWith("avatars/user-1.webp");
  });

  it("keeps the current avatar when saving fails", async () => {
    // The same extension means the same path: deleting it would remove the avatar the row
    // still points at.
    mockUserRow.photoUrl = `${MOCK_STORAGE}avatars/user-1.png`;
    mockSaveFails = true;

    const res = await upload("image/png");

    expect(res.status).toBe(500);
    expect(mockDeleteFile).not.toHaveBeenCalled();
    expect(mockUserRow.photoUrl).toBe(`${MOCK_STORAGE}avatars/user-1.png`);
  });

  it("answers 200 when deleting the previous avatar fails", async () => {
    mockUserRow.photoUrl = `${MOCK_STORAGE}avatars/user-1.jpg`;
    mockDeleteFile.mockRejectedValue(new Error("storage down"));
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const res = await upload("image/png");

    expect(res.status).toBe(200);
    expect(mockUserRow.photoUrl).toBe(`${MOCK_STORAGE}avatars/user-1.png`);
    warnSpy.mockRestore();
  });
});
