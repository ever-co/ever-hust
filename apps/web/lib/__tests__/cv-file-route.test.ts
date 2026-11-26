/**
 * GET /api/cv/file: CVs sit in a private bucket with no public URL, and this
 * route is the only way to read one. It hands the signed-in user their own CV
 * and nothing else: the object comes from the caller's own users.cv_url and
 * must be inside the caller's own folder, and no cache on the way may keep it.
 */
const mockDownloadFile = jest.fn();
jest.mock("@ever-hust/supabase/server", () => ({
  getSupabaseServer: () => {
    throw new Error("this test never reaches Storage");
  },
}));
jest.mock("@ever-hust/supabase/storage", () => {
  // The real resolver of users.cv_url (tested in packages/supabase/src/storage.test.ts).
  const actual = jest.requireActual("@ever-hust/supabase/storage");
  return {
    cvStorageObject: actual.cvStorageObject,
    downloadFile: (...args: unknown[]) => mockDownloadFile(...args),
  };
});

/** The caller's users.cv_url, as the route reads it. */
let mockCvUrl: string | null = null;
let mockDbFails = false;
jest.mock("@ever-hust/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            if (mockDbFails) throw new Error("connection lost");
            return [{ cvUrl: mockCvUrl }];
          },
        }),
      }),
    }),
  },
  users: { cvUrl: "cvUrl", id: "id" },
}));
jest.mock("drizzle-orm", () => ({ eq: jest.fn() }));

let mockSignedIn = true;
jest.mock("../get-session-user", () => ({
  requireSessionUser: async () => {
    if (!mockSignedIn) {
      const { NextResponse } = jest.requireActual("next/server");
      throw NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return { id: "user-1" };
  },
}));
jest.mock("../rate-limit", () => ({ applyRateLimit: () => null }));

import { GET } from "../../app/api/cv/file/route";

const PDF = "%PDF-1.4 the owner's CV";

let errorSpy: jest.SpyInstance;
beforeEach(() => {
  mockDownloadFile.mockReset();
  mockDownloadFile.mockResolvedValue(
    new Blob([PDF], { type: "application/pdf" }),
  );
  mockCvUrl = null;
  mockDbFails = false;
  mockSignedIn = true;
  errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errorSpy.mockRestore());

describe("GET /api/cv/file", () => {
  it("answers 401 without a session and reads nothing", async () => {
    mockSignedIn = false;
    mockCvUrl = "user-1/cv.pdf";

    const res = await GET();

    expect(res.status).toBe(401);
    expect(mockDownloadFile).not.toHaveBeenCalled();
  });

  it("serves the owner's CV from the private bucket as an uncacheable download", async () => {
    mockCvUrl = "user-1/0b6f.pdf";

    const res = await GET();

    expect(res.status).toBe(200);
    expect(mockDownloadFile).toHaveBeenCalledWith("user-1/0b6f.pdf", "cvs");
    expect(await res.text()).toBe(PDF);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="cv.pdf"',
    );
    expect(res.headers.get("Cache-Control")).toMatch(/private/);
    expect(res.headers.get("Cache-Control")).toMatch(/no-store/);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("chooses the content type from the extension, not from Storage", async () => {
    mockCvUrl = "user-1/0b6f.txt";
    mockDownloadFile.mockResolvedValue(new Blob(["<script>"], { type: "text/html" }));

    const res = await GET();

    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
  });

  it("serves a CV from before CVs were private from the public bucket", async () => {
    mockCvUrl =
      "https://storage.example.com/storage/v1/object/public/user-uploads/cvs/user-1/old.docx";

    const res = await GET();

    expect(res.status).toBe(200);
    expect(mockDownloadFile).toHaveBeenCalledWith("cvs/user-1/old.docx", "user-uploads");
    expect(res.headers.get("Content-Type")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  });

  it("answers 404 when the user has no CV", async () => {
    const res = await GET();

    expect(res.status).toBe(404);
    expect(mockDownloadFile).not.toHaveBeenCalled();
  });

  it.each([
    ["another user's private path", "user-2/cv.pdf"],
    ["a path that climbs out of the folder", "user-1/../user-2/cv.pdf"],
    [
      "another user's public URL",
      "https://storage.example.com/storage/v1/object/public/user-uploads/cvs/user-2/cv.pdf",
    ],
    ["a URL of another site", "https://evil.example.com/user-1/cv.pdf"],
  ])("never reads a file named by %s", async (_label, stored) => {
    mockCvUrl = stored;

    const res = await GET();

    expect(res.status).toBe(404);
    expect(mockDownloadFile).not.toHaveBeenCalled();
  });

  it("answers 503 when Storage does not return the file", async () => {
    mockCvUrl = "user-1/0b6f.pdf";
    mockDownloadFile.mockRejectedValue(
      new Error("Storage download failed: fetch failed"),
    );

    const res = await GET();

    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toMatch(/no-store/);
  });

  it("answers 500 when the database read fails", async () => {
    mockDbFails = true;

    const res = await GET();

    expect(res.status).toBe(500);
    expect(mockDownloadFile).not.toHaveBeenCalled();
  });
});
