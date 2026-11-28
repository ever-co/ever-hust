import { db, applications } from "@ever-hust/db";
import { and, eq } from "drizzle-orm";
import type { NextResponse } from "next/server";
import { isValidStage } from "@ever-hust/ai";
import { requireSessionUser } from "../../../../../lib/get-session-user";
import { applyRateLimit } from "../../../../../lib/rate-limit";
import {
  apiSuccess,
  apiBadRequest,
  apiError,
  isJsonObject,
  safeJsonParse,
} from "../../../../../lib/api-response";
import { parsePositiveIntId } from "../../../../../lib/id-param";

// PATCH /api/user/applications/[id] — move an application to a new pipeline stage (spec #2).
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let user;
  try {
    user = await requireSessionUser();
  } catch (response) {
    return response as NextResponse;
  }
  const userId = user.id;

  const rateLimited = applyRateLimit(userId, "authenticated");
  if (rateLimited) return rateLimited;

  const { id: idRaw } = await params;
  const id = parsePositiveIntId(idRaw);
  if (id === null) {
    return apiBadRequest("Invalid application id");
  }

  const jsonResult = await safeJsonParse(req);
  if (!jsonResult.ok) return jsonResult.response;
  if (!isJsonObject(jsonResult.data)) {
    return apiBadRequest("Request body must be a JSON object");
  }
  const body = jsonResult.data;
  if (typeof body.stage !== "string" || !isValidStage(body.stage)) {
    return apiBadRequest("Invalid pipeline stage");
  }

  try {
    const now = new Date();
    const rows = await db
      .update(applications)
      .set({ pipelineStage: body.stage, stageChangedAt: now, updatedAt: now })
      .where(and(eq(applications.id, id), eq(applications.userId, userId)))
      .returning({ id: applications.id });

    if (rows.length === 0) return apiError("Application not found", 404);
    return apiSuccess({ id, stage: body.stage });
  } catch (err) {
    console.error(
      "[api/user/applications/[id]] PATCH failed:",
      err instanceof Error ? err.message : err
    );
    return apiError("Failed to update application stage");
  }
}
