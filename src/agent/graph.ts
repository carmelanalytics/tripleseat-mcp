/**
 * Microsoft Graph client (client-credentials flow) for the Village mailboxes.
 */

import { agentConfig } from "./config.js";
import { query, queryOne } from "../db.js";

const GRAPH = "https://graph.microsoft.com/v1.0";

let cached: { token: string; expires: number } | null = null;

async function token(): Promise<string> {
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  const { msTenant, msClientId, msClientSecret } = agentConfig;
  if (!msTenant || !msClientId || !msClientSecret) {
    throw new Error("Microsoft Graph is not configured (MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET).");
  }
  const body = new URLSearchParams({
    client_id: msClientId,
    client_secret: msClientSecret,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  const r = await fetch(`https://login.microsoftonline.com/${msTenant}/oauth2/v2.0/token`, {
    method: "POST",
    body,
  });
  const j: any = await r.json();
  if (!r.ok) throw new Error(`Graph token error: ${JSON.stringify(j).slice(0, 300)}`);
  cached = { token: j.access_token, expires: Date.now() + j.expires_in * 1000 };
  return cached.token;
}

async function graph(path: string, init: RequestInit = {}): Promise<any> {
  const url = path.startsWith("http") ? path : `${GRAPH}${path}`;
  const r = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${await token()}`,
      "Content-Type": "application/json",
      Prefer: 'outlook.body-content-type="text"',
      ...(init.headers || {}),
    },
  });
  if (r.status === 202 || r.status === 204) return null;
  const text = await r.text();
  if (!r.ok) throw new Error(`Graph ${r.status} on ${url}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

export interface MailMessage {
  id: string;
  internetMessageId?: string;
  conversationId?: string;
  receivedDateTime?: string;
  subject?: string;
  from?: { emailAddress: { name?: string; address?: string } };
  replyTo?: { emailAddress: { name?: string; address?: string } }[];
  toRecipients?: { emailAddress: { name?: string; address?: string } }[];
  body?: { content?: string };
  bodyPreview?: string;
  isDraft?: boolean;
  "@removed"?: unknown;
}

const SELECT =
  "id,internetMessageId,conversationId,receivedDateTime,subject,from,replyTo,toRecipients,body,bodyPreview,isDraft";

/**
 * New Inbox messages since the last run, using a delta query per mailbox.
 * The first run only stores a cursor (starting from "now") so old mail is never answered.
 */
export async function fetchNewMessages(mailbox: string): Promise<MailMessage[]> {
  const row = await queryOne<{ delta_link: string | null }>(
    `SELECT delta_link FROM agent_cursors WHERE mailbox = $1`,
    [mailbox]
  );
  const firstRun = !row?.delta_link;
  let url =
    row?.delta_link ||
    `${GRAPH}/users/${encodeURIComponent(mailbox)}/mailFolders/inbox/messages/delta?$select=${SELECT}`;

  const out: MailMessage[] = [];
  let deltaLink: string | null = null;
  for (let page = 0; page < 20 && url; page++) {
    const j = await graph(url);
    for (const m of j.value || []) if (!m["@removed"] && !m.isDraft) out.push(m);
    if (j["@odata.nextLink"]) url = j["@odata.nextLink"];
    else {
      deltaLink = j["@odata.deltaLink"] || null;
      url = "";
    }
  }
  if (deltaLink) {
    await query(
      `INSERT INTO agent_cursors (mailbox, delta_link, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (mailbox) DO UPDATE SET delta_link = EXCLUDED.delta_link, updated_at = NOW()`,
      [mailbox, deltaLink]
    );
  }
  return firstRun ? [] : out;
}

export async function getMessage(mailbox: string, id: string): Promise<MailMessage> {
  return graph(`/users/${encodeURIComponent(mailbox)}/messages/${id}?$select=${SELECT}`);
}

/** Reply on the existing email thread (keeps the Tripleseat relay / marketplace thread intact). */
export async function replyToMessage(
  mailbox: string,
  messageId: string,
  text: string,
  cc: string[] = []
): Promise<void> {
  await graph(`/users/${encodeURIComponent(mailbox)}/messages/${messageId}/reply`, {
    method: "POST",
    body: JSON.stringify({
      message: {
        ccRecipients: cc.map((address) => ({ emailAddress: { address } })),
      },
      comment: text,
    }),
  });
}

/**
 * Send a guest-facing email from one of the venue's mailboxes when the inbound copy sits in another
 * mailbox. The original message is quoted underneath so a Tripleseat thread token travels with it.
 */
export async function sendFrom(
  fromMailbox: string,
  to: string,
  subject: string,
  text: string,
  quotedFrom: string,
  quotedBody: string,
  cc: string[] = []
): Promise<void> {
  const fresh = !quotedBody;
  const body = fresh ? text : `${text}\n\n----- Original message -----\nFrom: ${quotedFrom}\nSubject: ${subject}\n\n${quotedBody}`;
  await graph(`/users/${encodeURIComponent(fromMailbox)}/sendMail`, {
    method: "POST",
    body: JSON.stringify({
      message: {
        subject: fresh || /^re:/i.test(subject) ? subject : `Re: ${subject}`,
        body: { contentType: "Text", content: body },
        toRecipients: [{ emailAddress: { address: to } }],
        ccRecipients: cc.filter((c) => c && c.toLowerCase() !== to.toLowerCase()).map((address) => ({ emailAddress: { address } })),
      },
      saveToSentItems: true,
    }),
  });
}

/** Plain send (used for the digest and internal escalations only — never to guests). */
export async function sendInternal(
  fromMailbox: string,
  to: string[],
  subject: string,
  html: string,
  cc: string[] = []
): Promise<void> {
  await graph(`/users/${encodeURIComponent(fromMailbox)}/sendMail`, {
    method: "POST",
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: "HTML", content: html },
        toRecipients: to.map((address) => ({ emailAddress: { address } })),
        ccRecipients: cc.map((address) => ({ emailAddress: { address } })),
      },
      saveToSentItems: true,
    }),
  });
}

/** Tag a message in Outlook so staff can see what the agent did with it. */
export async function categorize(mailbox: string, messageId: string, category: string): Promise<void> {
  try {
    await graph(`/users/${encodeURIComponent(mailbox)}/messages/${messageId}`, {
      method: "PATCH",
      body: JSON.stringify({ categories: [category] }),
    });
  } catch (e: any) {
    console.warn("[Agent] categorize failed:", e.message);
  }
}
