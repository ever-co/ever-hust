/**
 * /api/og is the Open Graph and Twitter image of every page (app/layout.tsx). It runs on the
 * Node.js runtime: Next 16 deprecates the Edge Runtime and warns on every build while a route
 * uses it, and a release that drops it would break the share image of every page.
 */
import * as ogRoute from "../../app/api/og/route";

function get(query = "") {
  return ogRoute.GET(new Request(`http://localhost/api/og${query}`) as never);
}

describe("/api/og route segment config", () => {
  it("runs on the Node.js runtime, not the deprecated Edge Runtime", () => {
    expect((ogRoute as { runtime?: string }).runtime).toBe("nodejs");
  });
});

describe("GET /api/og", () => {
  it("renders a 1200x630 PNG for ?title=Test", async () => {
    const res = await get("?title=Test");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");

    const png = Buffer.from(await res.arrayBuffer());
    // PNG signature, then the IHDR chunk: width and height as big-endian 32-bit integers.
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
    expect(png.readUInt32BE(16)).toBe(1200);
    expect(png.readUInt32BE(20)).toBe(630);
  }, 30_000);

  it("renders the default image when no title or description is given", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
  }, 30_000);

  it("renders when title and description are longer than the 100/200 character caps", async () => {
    const res = await get(
      `?title=${"t".repeat(500)}&description=${"d".repeat(1000)}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
  }, 30_000);
});
