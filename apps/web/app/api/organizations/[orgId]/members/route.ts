import { db } from "@ever-hust/db";
import {
  organizationMembers,
  organizationInvitations,
  organizations,
  users,
} from "@ever-hust/db/schema";
import {
  getAppUrl,
  isDeduplicatedEmail,
  sendOrganizationInvitationEmail,
} from "@ever-hust/email";
import { eq, and, count, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireOrgMember, requireOrgRole } from "../../../../../lib/auth-org";
import { applyRateLimit } from "../../../../../lib/rate-limit";
import { inviteMemberSchema, parseBody } from "../../../../../lib/api-schemas";
import {
  apiSuccess,
  apiBadRequest,
  apiError,
  safeJsonParse,
} from "../../../../../lib/api-response";
import { parsePositiveIntId } from "../../../../../lib/id-param";

type RouteContext = { params: Promise<{ orgId: string }> };

/** Longest inviter name the invitation email prints. */
const INVITER_NAME_MAX_LENGTH = 100;

/** The inviter as the email names them: the trimmed name, or the email's local part. */
function inviterDisplayName(user: { name?: string | null; email: string }): string {
  const name = user.name?.trim() || user.email.split("@")[0]?.trim() || "A teammate";
  // Cap by code point so an emoji or other astral character is never cut in half.
  return Array.from(name).slice(0, INVITER_NAME_MAX_LENGTH).join("").trimEnd();
}

// GET /api/organizations/[orgId]/members - List org members
export async function GET(
  _req: Request,
  context: RouteContext
) {
  const { orgId: orgIdStr } = await context.params;
  const orgId = parsePositiveIntId(orgIdStr);
  if (orgId === null) {
    return apiBadRequest("Invalid organization ID");
  }

  let memberInfo;
  try {
    memberInfo = await requireOrgMember(orgId);
  } catch (response) {
    return response as NextResponse;
  }

  const rateLimited = applyRateLimit(memberInfo.user.id, "authenticated");
  if (rateLimited) return rateLimited;

  try {
    const members = await db
      .select({
        id: organizationMembers.id,
        userId: organizationMembers.userId,
        role: organizationMembers.role,
        joinedAt: organizationMembers.joinedAt,
        userName: users.name,
        userEmail: users.email,
        userImage: users.image,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(organizationMembers.userId, users.id))
      .where(eq(organizationMembers.organizationId, orgId))
      .limit(200);

    // Also fetch pending invitations if user is owner/admin
    let invitations: Array<{
      id: number;
      email: string;
      role: string;
      status: string;
      expiresAt: Date;
      createdAt: Date;
    }> = [];

    if (memberInfo.orgRole === "owner" || memberInfo.orgRole === "admin") {
      invitations = await db
        .select({
          id: organizationInvitations.id,
          email: organizationInvitations.email,
          role: organizationInvitations.role,
          status: organizationInvitations.status,
          expiresAt: organizationInvitations.expiresAt,
          createdAt: organizationInvitations.createdAt,
        })
        .from(organizationInvitations)
        .where(
          and(
            eq(organizationInvitations.organizationId, orgId),
            eq(organizationInvitations.status, "pending")
          )
        )
        .limit(200);
    }

    return apiSuccess({ members, invitations });
  } catch (err) {
    console.error(
      "[api/organizations/[orgId]/members] GET failed:",
      err instanceof Error ? err.message : err
    );
    return apiError("Failed to load members");
  }
}

// POST /api/organizations/[orgId]/members - Invite a new member
export async function POST(
  req: Request,
  context: RouteContext
) {
  const { orgId: orgIdStr } = await context.params;
  const orgId = parsePositiveIntId(orgIdStr);
  if (orgId === null) {
    return apiBadRequest("Invalid organization ID");
  }

  let memberInfo;
  try {
    memberInfo = await requireOrgRole(orgId, "owner", "admin");
  } catch (response) {
    return response as NextResponse;
  }

  const rateLimited = applyRateLimit(memberInfo.user.id, "authenticated");
  if (rateLimited) return rateLimited;

  const jsonResult = await safeJsonParse(req);
  if (!jsonResult.ok) return jsonResult.response;
  const validation = parseBody(inviteMemberSchema, jsonResult.data);
  if (!validation.success) {
    return apiBadRequest(validation.error);
  }
  const body = validation.data;

  // Only owners can invite users as admins (prevent privilege escalation)
  if (body.role === "admin" && memberInfo.orgRole !== "owner") {
    return apiBadRequest("Only organization owners can invite admins");
  }

  try {
    // Check org member limit
    const [org] = await db
      .select({ name: organizations.name, maxMembers: organizations.maxMembers })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);

    if (!org) {
      return apiBadRequest("Organization not found");
    }

    const [memberCount] = await db
      .select({ value: count() })
      .from(organizationMembers)
      .where(eq(organizationMembers.organizationId, orgId));

    if ((memberCount?.value ?? 0) >= org.maxMembers) {
      return apiBadRequest(
        `Organization has reached its member limit of ${org.maxMembers}`
      );
    }

    // Check if user is already a member (by email)
    const [existingUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${body.email}`)
      .limit(1);

    if (existingUser) {
      const [existingMember] = await db
        .select({ id: organizationMembers.id })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.organizationId, orgId),
            eq(organizationMembers.userId, existingUser.id)
          )
        )
        .limit(1);

      if (existingMember) {
        return apiBadRequest("This user is already a member of the organization");
      }
    }

    // Check for existing pending invitation
    const [existingInvitation] = await db
      .select({ id: organizationInvitations.id })
      .from(organizationInvitations)
      .where(
        and(
          eq(organizationInvitations.organizationId, orgId),
          sql`lower(${organizationInvitations.email}) = ${body.email}`,
          eq(organizationInvitations.status, "pending")
        )
      )
      .limit(1);

    if (existingInvitation) {
      return apiBadRequest("An invitation is already pending for this email");
    }

    // Generate a secure token
    const token = crypto.randomUUID();

    // Create invitation (expires in 7 days)
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    const [invitation] = await db
      .insert(organizationInvitations)
      .values({
        organizationId: orgId,
        email: body.email,
        role: body.role,
        token,
        invitedById: memberInfo.user.id,
        expiresAt,
      })
      .returning();

    if (!invitation) {
      return apiError("Failed to create invitation");
    }

    // The invitee opens this page, signed in with the invited address, to join. The token is the
    // secret: the URL goes to the invitee and back to the owner/admin who invited, never to a log.
    const inviteUrl = `${getAppUrl()}/organizations/invitations/${token}`;

    // A guest (anonymous trial user) has no verified address, so we do not send mail on their
    // behalf from our own sender; they get the link to share themselves.
    let emailSent = false;
    if (memberInfo.user.emailVerified === true) {
      try {
        const result = await sendOrganizationInvitationEmail({
          to: invitation.email,
          orgName: org.name,
          inviterName: inviterDisplayName(memberInfo.user),
          role: invitation.role,
          acceptUrl: inviteUrl,
          invitationId: invitation.id,
          invitedAt: invitation.createdAt,
        });
        // `in_flight`: an earlier attempt with this key is still running, so delivery is unknown.
        emailSent = !isDeduplicatedEmail(result) || result.reason === "replayed";
      } catch (err) {
        // The invitation stands: the owner/admin gets the link to share instead.
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[api/organizations/[orgId]/members] invitation ${invitation.id} email failed:`,
          message.split(token).join("[token]")
        );
      }
    }

    return apiSuccess({ invitation, emailSent, inviteUrl }, { status: 201 });
  } catch (err) {
    console.error(
      "[api/organizations/[orgId]/members] POST failed:",
      err instanceof Error ? err.message : err
    );
    return apiError("Failed to create invitation");
  }
}
