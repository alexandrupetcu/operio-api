import { google } from "googleapis";
import type { PrismaClient } from "@prisma/client";
import { env } from "../config/env.js";

interface InboxConfig {
  id: string;
  email: string;
  refreshToken: string | null;
  accessToken: string | null;
  tokenExpiresAt: Date | null;
}

function getOAuthCredentials() {
  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET) {
    throw new Error("GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be set in environment variables");
  }
  return { clientId: env.GMAIL_CLIENT_ID, clientSecret: env.GMAIL_CLIENT_SECRET };
}

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface IncomingEmail {
  messageId: string;
  from: string;
  subject: string;
  date: Date;
  attachments: EmailAttachment[];
}

const SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];

function defaultRedirectUri(): string {
  return `${env.FRONTEND_URL.replace(/\/$/, "")}/admin/integrations/gmail-oauth-callback`;
}

/** Create OAuth2 client from inbox config */
function createOAuth2Client(inbox: InboxConfig) {
  const { clientId, clientSecret } = getOAuthCredentials();
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, defaultRedirectUri());
  if (inbox.refreshToken) {
    oauth2.setCredentials({
      refresh_token: inbox.refreshToken,
      access_token: inbox.accessToken ?? undefined,
      expiry_date: inbox.tokenExpiresAt?.getTime() ?? undefined,
    });
  }
  return oauth2;
}

/** Generate OAuth2 consent URL for authorization */
export function getAuthUrl(redirectUri?: string, state?: string): string {
  const { clientId, clientSecret } = getOAuthCredentials();
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri ?? defaultRedirectUri());
  return oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    state,
  });
}

/** Exchange authorization code for tokens */
export async function exchangeCode(
  code: string,
  redirectUri?: string
): Promise<{ refreshToken: string; accessToken: string; expiresAt: Date }> {
  const { clientId, clientSecret } = getOAuthCredentials();
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri ?? defaultRedirectUri());
  const { tokens } = await oauth2.getToken(code);

  if (!tokens.refresh_token) {
    throw new Error("No refresh token received. Make sure to use prompt=consent and access_type=offline.");
  }

  return {
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token ?? "",
    expiresAt: new Date(tokens.expiry_date ?? Date.now() + 3600_000),
  };
}

/** Refresh access token if expired, update DB */
export async function refreshAccessTokenIfNeeded(
  prisma: PrismaClient,
  inbox: InboxConfig
): Promise<InboxConfig> {
  const now = Date.now();
  const expiresAt = inbox.tokenExpiresAt?.getTime() ?? 0;

  // Refresh if token expires within 5 minutes
  if (inbox.accessToken && expiresAt > now + 5 * 60_000) {
    return inbox;
  }

  if (!inbox.refreshToken) {
    throw new Error(`Inbox ${inbox.id} has no refresh token. Re-authorize.`);
  }

  const oauth2 = createOAuth2Client(inbox);
  const { credentials } = await oauth2.refreshAccessToken();

  const updated = {
    accessToken: credentials.access_token ?? null,
    tokenExpiresAt: credentials.expiry_date ? new Date(credentials.expiry_date) : null,
  };

  await prisma.emailInbox.update({
    where: { id: inbox.id },
    data: updated,
  });

  return { ...inbox, ...updated };
}

/** Fetch unread emails with PDF attachments */
export async function fetchUnreadPdfEmails(inbox: InboxConfig): Promise<IncomingEmail[]> {
  const oauth2 = createOAuth2Client(inbox);
  const gmail = google.gmail({ version: "v1", auth: oauth2 });

  // List unread messages with PDF attachments
  const listRes = await gmail.users.messages.list({
    userId: "me",
    q: "is:unread has:attachment filename:pdf",
    maxResults: 20,
  });

  const messageIds = listRes.data.messages ?? [];
  if (messageIds.length === 0) return [];

  const emails: IncomingEmail[] = [];

  for (const msg of messageIds) {
    if (!msg.id) continue;

    const fullMsg = await gmail.users.messages.get({
      userId: "me",
      id: msg.id,
      format: "full",
    });

    const headers = fullMsg.data.payload?.headers ?? [];
    const from = headers.find((h) => h.name?.toLowerCase() === "from")?.value ?? "";
    const subject = headers.find((h) => h.name?.toLowerCase() === "subject")?.value ?? "";
    const dateStr = headers.find((h) => h.name?.toLowerCase() === "date")?.value;
    const date = dateStr ? new Date(dateStr) : new Date();

    // Extract PDF attachments
    const attachments: EmailAttachment[] = [];
    const parts = flattenParts(fullMsg.data.payload ?? null);

    for (const part of parts) {
      if (
        part.mimeType === "application/pdf" &&
        part.body?.attachmentId &&
        part.filename
      ) {
        const attachRes = await gmail.users.messages.attachments.get({
          userId: "me",
          messageId: msg.id,
          id: part.body.attachmentId,
        });

        if (attachRes.data.data) {
          const content = Buffer.from(attachRes.data.data, "base64url");
          attachments.push({
            filename: part.filename,
            content,
            contentType: "application/pdf",
          });
        }
      }
    }

    if (attachments.length > 0) {
      emails.push({
        messageId: msg.id,
        from,
        subject,
        date,
        attachments,
      });
    }
  }

  return emails;
}

/** Mark email as read */
export async function markAsRead(inbox: InboxConfig, messageId: string): Promise<void> {
  const oauth2 = createOAuth2Client(inbox);
  const gmail = google.gmail({ version: "v1", auth: oauth2 });

  await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: {
      removeLabelIds: ["UNREAD"],
    },
  });
}

/** Flatten MIME parts recursively */
function flattenParts(
  payload: { parts?: any[]; mimeType?: string | null; body?: any; filename?: string | null } | undefined | null
): Array<{ mimeType?: string | null; body?: any; filename?: string | null }> {
  if (!payload) return [];
  const result: Array<{ mimeType?: string | null; body?: any; filename?: string | null }> = [];

  if (payload.filename && payload.body?.attachmentId) {
    result.push(payload);
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      result.push(...flattenParts(part));
    }
  }

  return result;
}
