/**
 * Which PDF failures are the upload's fault. POST /api/cv/upload answers 422
 * ("check that the file is valid") for a CvUnreadableError and 500 for
 * anything else, so only PDF.js's errors about the file may become one.
 *
 * unpdf loads PDF.js lazily, inside getDocumentProxy: a PDF.js that cannot load
 * (the DOMMatrix failure of the old pdf-parse build, a chunk missing from the
 * server image) must stay a server fault, not "your file is broken".
 */
const mockGetResolvedPDFJS = jest.fn();
const mockGetDocumentProxy = jest.fn();
const mockExtractText = jest.fn();
const mockDestroy = jest.fn();
jest.mock("unpdf", () => ({
  getResolvedPDFJS: (...args: unknown[]) => mockGetResolvedPDFJS(...args),
  getDocumentProxy: (...args: unknown[]) => mockGetDocumentProxy(...args),
  extractText: (...args: unknown[]) => mockExtractText(...args),
}));

import { extractTextFromPDF, isCvUnreadableError } from "./index";

/** An error the way PDF.js builds one: its class name in `name`. */
function pdfjsError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

const bytes = Buffer.from("%PDF-1.4 whatever");

beforeEach(() => {
  mockGetResolvedPDFJS.mockReset().mockResolvedValue({});
  mockGetDocumentProxy.mockReset();
  mockExtractText.mockReset();
  mockDestroy.mockReset().mockResolvedValue(undefined);
  mockGetDocumentProxy.mockResolvedValue({
    loadingTask: { destroy: mockDestroy },
  });
});

describe("extractTextFromPDF error classes", () => {
  it("throws a PDF.js that cannot load as a server fault and never opens the file", async () => {
    mockGetResolvedPDFJS.mockRejectedValue(
      new Error("PDF.js could not be resolved: ReferenceError: DOMMatrix is not defined"),
    );

    const error = await extractTextFromPDF(bytes).catch((err: unknown) => err);

    expect(isCvUnreadableError(error)).toBe(false);
    expect((error as Error).message).toMatch(/could not be resolved/);
    expect(mockGetDocumentProxy).not.toHaveBeenCalled();
  });

  it.each([
    ["InvalidPDFException", "Invalid PDF structure."],
    ["PasswordException", "No password given"],
    ["FormatError", "Bad FCHECK in flate stream"],
    ["UnknownErrorException", "Unknown error in the PDF worker"],
  ])("turns %s on open into CvUnreadableError", async (name, message) => {
    mockGetDocumentProxy.mockRejectedValue(pdfjsError(name, message));

    const error = await extractTextFromPDF(bytes).catch((err: unknown) => err);

    expect(isCvUnreadableError(error)).toBe(true);
    expect((error as Error).message).toContain(message);
  });

  it("keeps any other error on open a server fault", async () => {
    mockGetDocumentProxy.mockRejectedValue(
      new TypeError("Cannot read properties of undefined (reading 'getDocument')"),
    );

    const error = await extractTextFromPDF(bytes).catch((err: unknown) => err);

    expect(isCvUnreadableError(error)).toBe(false);
    expect(error).toBeInstanceOf(TypeError);
  });

  it("turns a PDF.js file error while reading the text into CvUnreadableError and frees the document", async () => {
    mockExtractText.mockRejectedValue(pdfjsError("FormatError", "Invalid stream"));

    const error = await extractTextFromPDF(bytes).catch((err: unknown) => err);

    expect(isCvUnreadableError(error)).toBe(true);
    expect(mockDestroy).toHaveBeenCalledTimes(1);
  });

  it("keeps any other error while reading the text a server fault and frees the document", async () => {
    mockExtractText.mockRejectedValue(new RangeError("Maximum call stack size exceeded"));

    const error = await extractTextFromPDF(bytes).catch((err: unknown) => err);

    expect(isCvUnreadableError(error)).toBe(false);
    expect(mockDestroy).toHaveBeenCalledTimes(1);
  });

  it("returns the text of a readable PDF", async () => {
    mockExtractText.mockResolvedValue({ text: "Jane Doe" });

    await expect(extractTextFromPDF(bytes)).resolves.toBe("Jane Doe");
    expect(mockDestroy).toHaveBeenCalledTimes(1);
  });
});
