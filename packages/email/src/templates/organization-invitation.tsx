import {
  Html,
  Body,
  Container,
  Head,
  Heading,
  Hr,
  Link,
  Preview,
  Section,
  Text,
  Button,
} from "@react-email/components";
import * as React from "react";
import { APP_NAME } from "@ever-hust/utils";

interface OrganizationInvitationEmailProps {
  orgName: string;
  inviterName: string;
  role: string;
  acceptUrl: string;
}

/**
 * The org name and the inviter name are chosen by the inviter and go to an address that did not
 * ask for this email. React escapes them as text; never paste them into raw HTML.
 */
export function OrganizationInvitationEmail({
  orgName = "Acme",
  inviterName = "A teammate",
  role = "member",
  acceptUrl = "https://hust.so/organizations/invitations/xxx",
}: OrganizationInvitationEmailProps) {
  const roleLabel = role === "admin" ? "an admin" : "a member";
  return (
    <Html>
      <Head />
      <Preview>
        {inviterName} invited you to join {orgName} on {APP_NAME}
      </Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={heading}>Join {orgName}</Heading>

          <Text style={paragraph}>Hi there,</Text>

          <Text style={paragraph}>
            {inviterName} invited you to join {orgName} on {APP_NAME} as{" "}
            {roleLabel}.
          </Text>

          <Section style={ctaSection}>
            <Button href={acceptUrl} style={button}>
              Accept Invitation
            </Button>
          </Section>

          <Text style={paragraph}>
            Or open this link in your browser:{" "}
            <Link href={acceptUrl} style={link}>
              {acceptUrl}
            </Link>
          </Text>

          <Text style={paragraph}>
            Sign in with this email address to accept. The invitation expires
            in 7 days. If you weren&apos;t expecting it, you can safely ignore
            this email.
          </Text>

          <Hr style={hr} />

          <Text style={footer}>
            {APP_NAME} · Your AI-Powered Job Search Assistant
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

const main = {
  backgroundColor: "#f6f9fc",
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Ubuntu, sans-serif',
};

const container = {
  backgroundColor: "#ffffff",
  margin: "0 auto",
  padding: "20px 0 48px",
  marginBottom: "64px",
  maxWidth: "600px",
};

const heading = {
  fontSize: "28px",
  letterSpacing: "-0.5px",
  lineHeight: "1.3",
  fontWeight: "700" as const,
  color: "#484848",
  padding: "17px 0 0",
  textAlign: "center" as const,
};

const paragraph = {
  margin: "0 0 15px",
  fontSize: "15px",
  lineHeight: "1.4",
  color: "#3c4149",
  padding: "0 40px",
};

const ctaSection = {
  textAlign: "center" as const,
  margin: "24px 0",
};

const button = {
  backgroundColor: "#000000",
  borderRadius: "6px",
  color: "#ffffff",
  fontSize: "15px",
  fontWeight: "600" as const,
  textDecoration: "none",
  textAlign: "center" as const,
  display: "inline-block",
  padding: "12px 24px",
};

const link = {
  color: "#2563eb",
  wordBreak: "break-all" as const,
};

const hr = {
  borderColor: "#dfe1e4",
  margin: "20px 40px",
};

const footer = {
  fontSize: "12px",
  color: "#9ca3af",
  textAlign: "center" as const,
  padding: "0 40px",
  marginTop: "20px",
};
