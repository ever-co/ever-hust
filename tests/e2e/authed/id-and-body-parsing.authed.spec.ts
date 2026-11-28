import { test, expect } from "@playwright/test";

test.use({ storageState: "tests/e2e/.auth/user.json" });

// Every table id is a Postgres integer (int4). An id past 2147483647 or one that is not a whole
// number used to reach Postgres, fail there and come back as a 500; a JSON body of `null` threw
// in the route. Each of these is the client's mistake: 400.
test.describe("Authenticated — ids and JSON bodies the database cannot take", () => {
  test("GET /api/jobs/[id] answers 400 past the integer range and for 1.5", async ({ request }) => {
    // Public route with a 20 req/min limit per IP: keep the calls few.
    expect((await request.get("/api/jobs/2147483648")).status()).toBe(400);
    expect((await request.get("/api/jobs/1.5")).status()).toBe(400);
    // The largest integer is a valid id that matches no job.
    expect((await request.get("/api/jobs/2147483647")).status()).toBe(404);
  });

  test("PATCH /api/user/applications/[id] answers 400 for a null body and an out-of-range id", async ({
    request,
  }) => {
    const list = await request.get("/api/user/applications");
    const apps = (await list.json()).applications as { id: number }[];
    const target = apps[0]!.id;

    const nullBody = await request.patch(`/api/user/applications/${target}`, {
      headers: { "Content-Type": "application/json" },
      data: "null",
    });
    expect(nullBody.status()).toBe(400);
    expect((await nullBody.json()).error).toBe("Request body must be a JSON object");

    const outOfRange = await request.patch("/api/user/applications/3000000000", {
      data: { stage: "offer" },
    });
    expect(outOfRange.status()).toBe(400);
  });

  test("DELETE /api/user/hidden-jobs answers 400 for ?jobId=1.5", async ({ request }) => {
    const res = await request.delete("/api/user/hidden-jobs?jobId=1.5");
    expect(res.status()).toBe(400);
  });

  test("GET /api/organizations/[orgId] answers 400 past the integer range", async ({ request }) => {
    const res = await request.get("/api/organizations/3000000000");
    expect(res.status()).toBe(400);
  });

  test("POST /api/inbox/send answers 400 for a null body", async ({ request }) => {
    const res = await request.post("/api/inbox/send", {
      headers: { "Content-Type": "application/json" },
      data: "null",
    });
    expect(res.status()).toBe(400);
  });
});
