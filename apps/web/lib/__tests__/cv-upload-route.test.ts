/**
 * POST /api/cv/upload.
 *
 * CVs are private: the file goes to the private `cvs` bucket under a
 * server-chosen key inside {userId}/, users.cv_url keeps the object path (never
 * a public URL), and the owner fetches it from GET /api/cv/file. The client's
 * file name never becomes part of the key, so a hand-made multipart filename
 * such as "../victim/resume.pdf" can't make the service-role upload write
 * outside the user's folder.
 *
 * Each upload gets a random key, so nothing is overwritten: the CV a new upload
 * replaces is deleted once the new path is saved (also a CV from before CVs
 * were private, in the public bucket), and the new object is deleted again
 * when saving fails.
 *
 * Failures are told apart: a file that cannot be read is the upload's fault
 * (422); a parser, Storage or database failure is the server's (5xx), each with
 * its own message.
 */
const PUBLIC_CV_URL =
  "https://storage.example.com/storage/v1/object/public/user-uploads/cvs/";
const mockUploadPrivateFile = jest.fn();
const mockDeleteFile = jest.fn();
jest.mock("@ever-hust/supabase/server", () => ({
  getSupabaseServer: () => {
    throw new Error("this test never reaches Storage");
  },
}));
jest.mock("@ever-hust/supabase/storage", () => {
  // The real resolver of users.cv_url (tested in packages/supabase/src/storage.test.ts).
  const actual = jest.requireActual("@ever-hust/supabase/storage");
  return {
    CV_BUCKET: actual.CV_BUCKET,
    cvStorageObject: actual.cvStorageObject,
    uploadPrivateFile: (...args: unknown[]) => mockUploadPrivateFile(...args),
    deleteFile: (...args: unknown[]) => mockDeleteFile(...args),
  };
});

const mockParseCV = jest.fn();
jest.mock("@ever-hust/cv-parser", () => ({
  parseCV: (...args: unknown[]) => mockParseCV(...args),
  isCvUnreadableError: (error: unknown) =>
    error instanceof Error && error.name === "CvUnreadableError",
  SUPPORTED_CV_MIME_TYPES: new Set([
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/plain",
  ]),
  SUPPORTED_CV_EXTENSIONS: new Set(["pdf", "docx", "txt"]),
}));

/** user-1's row, read under FOR UPDATE and written by the route's transaction. */
const mockUserRow: { skills: string[]; cvUrl: string | null } = {
  skills: [],
  cvUrl: null,
};
const mockDbCalls: string[] = [];
/**
 * How the transaction's update fails: "no" succeeds; "before-commit" fails
 * with the row unchanged; "after-commit" writes the row and then fails, as when
 * the commit reached the database but its reply was lost.
 */
let mockSaveFails: "no" | "before-commit" | "after-commit" = "no";
/** The re-read of users.cv_url after a failed save fails too. */
let mockRereadFails = false;
/** The account was deleted while the upload ran: the locked read finds no row. */
let mockUserGone = false;
jest.mock("@ever-hust/db", () => ({
  db: {
    // The re-read after a failed save, outside the transaction.
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            mockDbCalls.push("re-read");
            if (mockRereadFails) throw new Error("database down");
            return mockUserGone ? [] : [{ cvUrl: mockUserRow.cvUrl }];
          },
        }),
      }),
    }),
    transaction: async <T>(fn: (tx: object) => Promise<T>) =>
      fn({
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
            where: async () => {
              mockDbCalls.push(`update ${Object.keys(values).sort().join(",")}`);
              if (mockSaveFails === "before-commit") throw new Error("connection lost");
              Object.assign(mockUserRow, values);
              if (mockSaveFails === "after-commit") throw new Error("connection lost");
            },
          }),
        }),
      }),
  },
  users: { skills: "skills", cvUrl: "cvUrl", id: "id" },
}));
jest.mock("drizzle-orm", () => ({ eq: jest.fn() }));
jest.mock("../get-session-user", () => ({
  requireSessionUser: async () => ({ id: "user-1" }),
}));
jest.mock("../rate-limit", () => ({ applyRateLimit: () => null }));

import { POST } from "../../app/api/cv/upload/route";

const PDF_BYTES = "%PDF-1.4 fake resume body";

function upload(fileName: string, type = "application/pdf") {
  const form = new FormData();
  form.append("cv", new File([PDF_BYTES], fileName, { type }));
  return POST(
    new Request("http://localhost/api/cv/upload", {
      method: "POST",
      body: form,
    }),
  );
}

/** An error the real parser throws for bytes it cannot read. */
function unreadable(message: string): Error {
  const error = new Error(message);
  error.name = "CvUnreadableError";
  return error;
}

/** Every [path, bucket] uploadPrivateFile was asked to write. */
function uploads(): Array<[string, string]> {
  return mockUploadPrivateFile.mock.calls.map((call) => [
    String(call[0]),
    String(call[3]),
  ]);
}

/** The path of the one object this request uploaded. */
const newPath = () => String(mockUploadPrivateFile.mock.calls[0][0]);

function expectOnlyInsideUserFolder() {
  for (const [path, bucket] of uploads()) {
    expect(bucket).toBe("cvs");
    expect(path).not.toContain("..");
    expect(path).not.toContain("\\");
    expect(path.startsWith("user-1/")).toBe(true);
    expect(path.slice("user-1/".length)).not.toContain("/");
  }
}

async function errorOf(res: Response): Promise<string> {
  return ((await res.json()) as { error: string }).error;
}

let errorSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;
beforeEach(() => {
  mockUploadPrivateFile.mockReset();
  mockDeleteFile.mockReset();
  mockParseCV.mockReset();
  mockUploadPrivateFile.mockImplementation(async (path: string) => path);
  mockDeleteFile.mockResolvedValue(undefined);
  mockParseCV.mockResolvedValue({
    name: "Jane",
    skills: [],
    experience: [],
    education: [],
    rawText: "x",
  });
  mockUserRow.skills = [];
  mockUserRow.cvUrl = null;
  mockDbCalls.length = 0;
  mockSaveFails = "no";
  mockRereadFails = false;
  mockUserGone = false;
  errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
});

describe("POST /api/cv/upload storage path", () => {
  it("refuses a file name that climbs out of the user's folder", async () => {
    const res = await upload("../victim/resume.pdf");
    expect(mockUploadPrivateFile).not.toHaveBeenCalled();
    expect(res.status).toBe(400);
  });

  it("refuses a file name that climbs into another bucket", async () => {
    const res = await upload("../../../other/x.pdf");
    expect(mockUploadPrivateFile).not.toHaveBeenCalled();
    expect(res.status).toBe(400);
  });

  it.each([
    ["a backslash", "..\\victim\\resume.pdf"],
    ["a forward slash", "victim/resume.pdf"],
    ["a double dot", "resume..pdf"],
  ])("returns 400 for a file name with %s", async (_label, fileName) => {
    const res = await upload(fileName);
    expect(res.status).toBe(400);
    expect(mockUploadPrivateFile).not.toHaveBeenCalled();
  });

  it("stores a normal CV in the private bucket under a server-chosen name inside <userId>/", async () => {
    const res = await upload("My Resume.PDF");
    expect(res.status).toBe(200);
    expect(mockUploadPrivateFile).toHaveBeenCalledTimes(1);
    expectOnlyInsideUserFolder();
    const [path, , contentType, bucket] = mockUploadPrivateFile.mock.calls[0];
    expect(path).toMatch(/^user-1\/[0-9a-f-]{36}\.pdf$/);
    expect(path).not.toContain("resume");
    expect(contentType).toBe("application/pdf");
    expect(bucket).toBe("cvs");
  });

  it("keeps the extension check for names without a supported extension", async () => {
    const res = await upload("resume.exe");
    expect(res.status).toBe(400);
    expect(mockUploadPrivateFile).not.toHaveBeenCalled();
  });
});

describe("POST /api/cv/upload keeps CVs private", () => {
  it("saves the object path, not a URL, in users.cv_url", async () => {
    const res = await upload("resume.pdf");

    expect(res.status).toBe(200);
    expect(mockUserRow.cvUrl).toBe(newPath());
    expect(mockUserRow.cvUrl).not.toMatch(/^https?:/);
    // Read under a row lock, written in the same transaction.
    expect(mockDbCalls).toEqual([
      "select for update",
      "update cvParsedData,cvUrl,updatedAt",
    ]);
  });

  it("answers with the owner-only download route, never a storage URL", async () => {
    const res = await upload("resume.pdf");

    const body = (await res.json()) as { fileUrl: string };
    expect(body.fileUrl).toBe("/api/cv/file");
    expect(JSON.stringify(body)).not.toContain("storage");
    expect(res.headers.get("Cache-Control")).toContain("no-store");
  });
});

describe("POST /api/cv/upload and the CV objects it leaves behind", () => {
  it("deletes the private CV it replaces", async () => {
    mockUserRow.cvUrl = "user-1/old-cv.pdf";

    const res = await upload("resume.pdf");

    expect(res.status).toBe(200);
    expect(mockUserRow.cvUrl).toBe(newPath());
    expect(mockDeleteFile).toHaveBeenCalledTimes(1);
    expect(mockDeleteFile).toHaveBeenCalledWith("user-1/old-cv.pdf", "cvs");
  });

  it("deletes a CV from before CVs were private from the public bucket", async () => {
    mockUserRow.cvUrl = `${PUBLIC_CV_URL}user-1/old-cv.pdf`;

    const res = await upload("resume.pdf");

    expect(res.status).toBe(200);
    expect(mockUserRow.cvUrl).toBe(newPath());
    expect(mockDeleteFile).toHaveBeenCalledTimes(1);
    expect(mockDeleteFile).toHaveBeenCalledWith(
      "cvs/user-1/old-cv.pdf",
      "user-uploads",
    );
  });

  it("deletes nothing on a first upload", async () => {
    const res = await upload("resume.pdf");

    expect(res.status).toBe(200);
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });

  it.each([
    ["a private path", "user-2/their-cv.pdf"],
    ["a public URL", `${PUBLIC_CV_URL}user-2/their-cv.pdf`],
    ["a path with a parent segment", "user-1/../user-2/their-cv.pdf"],
  ])(
    "never deletes another user's CV named by %s",
    async (_label, stored) => {
      mockUserRow.cvUrl = stored;

      const res = await upload("resume.pdf");

      expect(res.status).toBe(200);
      expect(mockDeleteFile).not.toHaveBeenCalled();
    },
  );

  it("deletes the new object and keeps the current CV when saving fails", async () => {
    mockUserRow.cvUrl = "user-1/old-cv.pdf";
    mockSaveFails = "before-commit";

    const res = await upload("resume.pdf");

    expect(res.status).toBe(500);
    expect(await errorOf(res)).toMatch(/could not save your CV/);
    // The row was re-read and does not point at the new object.
    expect(mockDbCalls).toContain("re-read");
    expect(mockDeleteFile).toHaveBeenCalledTimes(1);
    expect(mockDeleteFile).toHaveBeenCalledWith(newPath(), "cvs");
    expect(mockUserRow.cvUrl).toBe("user-1/old-cv.pdf");
  });

  it("keeps the new object when the save committed but reported an error", async () => {
    mockUserRow.cvUrl = "user-1/old-cv.pdf";
    mockSaveFails = "after-commit";

    const res = await upload("resume.pdf");

    // The row points at the new object: deleting it would leave a dangling
    // users.cv_url. The replaced CV is not known any more, so it stays.
    expect(res.status).toBe(200);
    expect(mockUserRow.cvUrl).toBe(newPath());
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });

  it("keeps the new object when neither the save nor the re-read works", async () => {
    mockUserRow.cvUrl = "user-1/old-cv.pdf";
    mockSaveFails = "before-commit";
    mockRereadFails = true;

    const res = await upload("resume.pdf");

    expect(res.status).toBe(500);
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });

  it("deletes the new object when the account was deleted while the upload ran", async () => {
    mockUserGone = true;

    const res = await upload("resume.pdf");

    expect(res.status).toBe(404);
    expect(mockDeleteFile).toHaveBeenCalledTimes(1);
    expect(mockDeleteFile).toHaveBeenCalledWith(newPath(), "cvs");
    expect(mockDbCalls).toEqual(["select for update"]);
  });

  it("answers 200 when deleting the replaced CV fails", async () => {
    mockUserRow.cvUrl = "user-1/old-cv.pdf";
    mockDeleteFile.mockRejectedValue(new Error("storage down"));

    const res = await upload("resume.pdf");

    expect(res.status).toBe(200);
    expect(mockUserRow.cvUrl).toBe(newPath());
  });

  it("merges the CV's skills into the user's skills", async () => {
    mockUserRow.skills = ["Go"];
    mockParseCV.mockResolvedValue({
      name: "Jane",
      skills: ["Go", "Rust"],
      experience: [],
      education: [],
      rawText: "x",
    });

    await upload("resume.pdf");

    expect(mockUserRow.skills).toEqual(["Go", "Rust"]);
  });
});

/**
 * The route used to answer every failure, a Storage outage included, with
 * "Failed to parse CV. Please ensure the file is valid." and a 500: a user
 * whose file was fine was told it was broken.
 */
describe("POST /api/cv/upload tells failures apart", () => {
  it("answers 422 for a file the parser cannot read, and stores nothing", async () => {
    mockUserRow.cvUrl = "user-1/old-cv.pdf";
    mockParseCV.mockRejectedValue(unreadable("Unreadable PDF: Invalid PDF structure."));

    const res = await upload("resume.pdf");

    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatch(/could not read this CV/);
    expect(mockUploadPrivateFile).not.toHaveBeenCalled();
    expect(mockDeleteFile).not.toHaveBeenCalled();
    expect(mockDbCalls).toEqual([]);
    expect(mockUserRow.cvUrl).toBe("user-1/old-cv.pdf");
  });

  it("answers 500, not 'invalid file', when the parser itself fails", async () => {
    mockParseCV.mockRejectedValue(new Error("Cannot find module 'unpdf'"));

    const res = await upload("resume.pdf");

    expect(res.status).toBe(500);
    const message = await errorOf(res);
    expect(message).toMatch(/could not process your CV/);
    expect(message).not.toMatch(/valid|read this CV/);
    expect(mockUploadPrivateFile).not.toHaveBeenCalled();
  });

  it("answers 503 with a storage message when Storage refuses the upload", async () => {
    mockUserRow.cvUrl = "user-1/old-cv.pdf";
    mockUploadPrivateFile.mockRejectedValue(
      new Error("Storage upload failed: Bucket not found"),
    );

    const res = await upload("resume.pdf");

    expect(res.status).toBe(503);
    const message = await errorOf(res);
    expect(message).toMatch(/could not store your CV/);
    expect(message).not.toMatch(/valid|parse/i);
    // Nothing was stored, so nothing is saved or deleted.
    expect(mockDbCalls).toEqual([]);
    expect(mockDeleteFile).not.toHaveBeenCalled();
    expect(mockUserRow.cvUrl).toBe("user-1/old-cv.pdf");
  });

  it("gives each failure its own message", async () => {
    const messages = new Set<string>();

    mockParseCV.mockRejectedValueOnce(unreadable("Unreadable DOCX: zip"));
    messages.add(await errorOf(await upload("resume.pdf")));

    mockParseCV.mockRejectedValueOnce(new Error("parser crashed"));
    messages.add(await errorOf(await upload("resume.pdf")));

    mockUploadPrivateFile.mockRejectedValueOnce(new Error("storage down"));
    messages.add(await errorOf(await upload("resume.pdf")));

    mockSaveFails = "before-commit";
    messages.add(await errorOf(await upload("resume.pdf")));

    expect(messages.size).toBe(4);
  });
});
