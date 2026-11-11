/**
 * Tripleseat discussion tools (added 2026-11-10).
 *
 * Tripleseat's public API has no endpoint for Discussions. Every discussion message is relayed by
 * email, though: guest replies arrive in events@ from a tripleseat.com address, and a reply to that
 * relay email is posted back into the event's discussion thread by Tripleseat. These tools use the
 * Microsoft Graph connection the inquiry agent already has to:
 *  - get_discussion_thread: rebuild an event's or lead's thread from the relay emails in the mailbox
 *  - send_discussion_message: reply on the latest relay email so the message lands on the thread
 *
 * Only messages that reached the mailbox can be shown; anything sent before the mailbox was set to
 * receive discussions, or deleted from it, is missing.
 */

import { tripleseatGet } from "./tripleseat.js";
import { graph } from "./agent/graph.js";
import { agentConfig } from "./agent/config.js";
import { newestText } from "./agent/intake.js";

export const DISCUSSION_TOOL_NAMES = ["get_discussion_thread", "send_discussion_message"] as const;

const OWN_DOMAINS = ["thevillagebigsur.com", "oroscogroup.com"];
const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024; // Graph's limit for a single attachment POST

const SELECT =
  "id,conversationId,receivedDateTime,sentDateTime,subject,from,replyTo,toRecipients,ccRecipients,body,bodyPreview,hasAttachments,isDraft";

export const DISCUSSION_TOOLS = [
  {
    name: "get_discussion_thread",
    description:
      "Rebuild the Tripleseat discussion thread for an event or lead from the Tripleseat relay emails in the events@ mailbox " +
      "(Tripleseat's API has no discussions endpoint). Give an event_id, lead_id or guest_email. Returns the messages oldest " +
      "first, each with a message_id; use the newest relay message_id with send_discussion_message to post on the thread. " +
      "Messages that never reached the mailbox are not shown.",
    inputSchema: {
      type: "object",
      properties: {
        event_id: { type: "string", description: "Tripleseat event ID" },
        lead_id: { type: "string", description: "Tripleseat lead ID" },
        guest_email: { type: "string", description: "Guest email address, if no event or lead ID" },
        mailbox: { type: "string", description: "Mailbox to search. Default events@thevillagebigsur.com" },
        max_messages: { type: "number", description: "Maximum messages to return (default 20, max 100)" },
      },
    },
  },
  {
    name: "send_discussion_message",
    description:
      "Post a message on a Tripleseat discussion thread by replying, from events@, to a Tripleseat relay email " +
      "(message_id from get_discussion_thread). Tripleseat relays the reply to the guest and logs it on the thread. " +
      "events@ is always copied. Optional attachments (base64, up to 3 MB each). Defaults to dry_run=true: set " +
      "dry_run=false only after the user approves the exact text, recipients and attachments.",
    inputSchema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "Graph message ID of a Tripleseat relay email (from get_discussion_thread)" },
        text: { type: "string", description: "The message to post, plain text" },
        cc: { type: "array", items: { type: "string" }, description: "Extra CC addresses (events@ is always added)" },
        attachments: {
          type: "array",
          description: "Files to attach",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              content_type: { type: "string", description: "e.g. application/pdf" },
              content_base64: { type: "string" },
            },
            required: ["name", "content_base64"],
          },
        },
        mailbox: { type: "string", description: "Mailbox to send from. Default events@thevillagebigsur.com" },
        dry_run: { type: "boolean", description: "Default true. Set false to send." },
      },
      required: ["message_id", "text"],
    },
  },
];

// ── helpers ──

function addr(x: any): string {
  return String(x?.emailAddress?.address || "").toLowerCase();
}

function isTripleseat(a: string): boolean {
  return (a.split("@")[1] || "").includes("tripleseat");
}

function isOwn(a: string): boolean {
  const d = a.split("@")[1] || "";
  return OWN_DOMAINS.some((o) => d.endsWith(o));
}

function rows(data: any, key: string): any {
  return data?.[key] ?? data;
}

interface Target {
  ids: string[];
  names: string[];
  emails: string[];
}

async function resolveTarget(args: any): Promise<Target> {
  const t: Target = { ids: [], names: [], emails: [] };
  const addContact = (c: any) => {
    if (!c) return;
    const n = [c.first_name, c.last_name].filter(Boolean).join(" ").trim();
    if (n) t.names.push(n);
    for (const e of c.email_addresses || []) if (e?.address) t.emails.push(String(e.address).toLowerCase());
  };
  if (args.event_id) {
    if (!/^\d+$/.test(String(args.event_id))) throw new Error("event_id must be numeric");
    const ev = rows((await tripleseatGet(`/events/${args.event_id}`)).data, "event");
    t.ids.push(String(args.event_id));
    if (ev?.booking_id) t.ids.push(String(ev.booking_id));
    if (ev?.lead?.id) t.ids.push(String(ev.lead.id));
    addContact(ev?.contact);
    for (const c of ev?.secondary_contacts || []) addContact(c);
    if (ev?.lead?.email_address) t.emails.push(String(ev.lead.email_address).toLowerCase());
  }
  if (args.lead_id) {
    if (!/^\d+$/.test(String(args.lead_id))) throw new Error("lead_id must be numeric");
    const lead = rows((await tripleseatGet(`/leads/${args.lead_id}`)).data, "lead");
    t.ids.push(String(args.lead_id));
    const n = [lead?.first_name, lead?.last_name].filter(Boolean).join(" ").trim();
    if (n) t.names.push(n);
    if (lead?.email_address) t.emails.push(String(lead.email_address).toLowerCase());
  }
  if (args.guest_email) t.emails.push(String(args.guest_email).toLowerCase());
  t.ids = [...new Set(t.ids)];
  t.names = [...new Set(t.names)];
  t.emails = [...new Set(t.emails)];
  if (!t.ids.length && !t.names.length && !t.emails.length) {
    throw new Error("Give an event_id, lead_id or guest_email");
  }
  return t;
}

async function searchMailbox(mailbox: string, term: string): Promise<any[]> {
  const q = encodeURIComponent(`"${term.replace(/"/g, "")}"`);
  const j = await graph(`/users/${encodeURIComponent(mailbox)}/messages?$search=${q}&$top=50&$select=${SELECT}`);
  return (j?.value || []).filter((m: any) => !m.isDraft);
}

function touchesTripleseat(m: any): boolean {
  const all = [addr(m.from), ...(m.replyTo || []).map(addr), ...(m.toRecipients || []).map(addr), ...(m.ccRecipients || []).map(addr)];
  return all.some((a) => a && isTripleseat(a));
}

function matchesTarget(m: any, t: Target): boolean {
  const hay = `${m.subject || ""}\n${m.body?.content || m.bodyPreview || ""}`.toLowerCase();
  if (t.ids.some((id) => new RegExp(`(leads|events|bookings)/${id}\\b|\\b${id}\\b`).test(hay))) return true;
  if (t.emails.some((e) => hay.includes(e))) return true;
  if (t.names.some((n) => hay.includes(n.toLowerCase()))) return true;
  return false;
}

// ── executor ──

export async function executeDiscussionTool(name: string, args: any): Promise<string | null> {
  switch (name) {
    case "get_discussion_thread": {
      const mailbox = String(args.mailbox || agentConfig.sendVia || agentConfig.sendAs); // events@ is a group, so read the service mailbox
      const limit = Math.min(Math.max(Number(args.max_messages) || 20, 1), 100);
      const t = await resolveTarget(args);
      const terms = [...t.emails, ...t.names, ...t.ids];
      const seen = new Map<string, any>();
      for (const term of terms) {
        for (const m of await searchMailbox(mailbox, term)) seen.set(m.id, m);
      }
      const msgs = [...seen.values()]
        .filter((m) => touchesTripleseat(m) && matchesTarget(m, t))
        .sort((a, b) => String(a.receivedDateTime || a.sentDateTime).localeCompare(String(b.receivedDateTime || b.sentDateTime)));
      const shown = msgs.slice(-limit).map((m) => {
        const from = addr(m.from);
        return {
          message_id: m.id,
          date: m.receivedDateTime || m.sentDateTime,
          direction: isOwn(from) ? "outbound (venue)" : isTripleseat(from) ? "relay from Tripleseat" : "inbound",
          from: `${m.from?.emailAddress?.name || ""} <${from}>`.trim(),
          to: (m.toRecipients || []).map(addr),
          subject: m.subject,
          text: newestText(m.body?.content || m.bodyPreview || "").slice(0, 1200),
          has_attachments: !!m.hasAttachments,
          can_reply_on_thread: isTripleseat(from),
        };
      });
      const latestRelay = [...shown].reverse().find((m) => m.can_reply_on_thread);
      return JSON.stringify(
        {
          mailbox,
          matched_on: t,
          total_found: msgs.length,
          showing: shown.length,
          latest_relay_message_id: latestRelay?.message_id || null,
          note:
            `Built from Tripleseat relay emails in ${mailbox}. Messages that never reached this mailbox are not shown. ` +
            (latestRelay
              ? "Use latest_relay_message_id with send_discussion_message to post on this thread."
              : "No relay email to reply to was found; start the thread from the event's Discussion tab in Tripleseat."),
          messages: shown,
        },
        null,
        2
      );
    }

    case "send_discussion_message": {
      const mailbox = String(args.mailbox || agentConfig.sendVia || agentConfig.sendAs); // events@ is a group, so read the service mailbox
      const target = await graph(
        `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(String(args.message_id))}?$select=${SELECT}`
      );
      const fromAddr = addr(target?.from);
      if (!isTripleseat(fromAddr)) {
        throw new Error(
          `message_id is not a Tripleseat relay email (from ${fromAddr || "unknown"}); a reply to it would not reach the discussion thread`
        );
      }
      const cc = [...new Set([agentConfig.ccOnEveryReply, ...(args.cc || [])].map((c: string) => String(c).toLowerCase()))]
        .filter((c) => c && c !== mailbox.toLowerCase());
      const attachments = (args.attachments || []).map((a: any) => {
        const bytes = Buffer.from(String(a.content_base64 || ""), "base64").length;
        if (!a.name || !bytes) throw new Error("each attachment needs a name and content_base64");
        if (bytes > MAX_ATTACHMENT_BYTES) throw new Error(`${a.name} is larger than 3 MB`);
        return { name: String(a.name), contentType: String(a.content_type || "application/octet-stream"), bytes, b64: String(a.content_base64) };
      });
      const summary = {
        from_mailbox: mailbox,
        replying_to: { subject: target.subject, relay_address: fromAddr, received: target.receivedDateTime },
        cc,
        text: String(args.text),
        attachments: attachments.map((a: any) => ({ name: a.name, content_type: a.contentType, bytes: a.bytes })),
      };
      if (args.dry_run !== false) return JSON.stringify({ dry_run: true, would_send: summary }, null, 2);

      const base = `/users/${encodeURIComponent(mailbox)}/messages`;
      const draft = await graph(`${base}/${encodeURIComponent(String(args.message_id))}/createReply`, {
        method: "POST",
        body: JSON.stringify({
          message: { ccRecipients: cc.map((address) => ({ emailAddress: { address } })) },
          comment: String(args.text),
        }),
      });
      try {
        for (const a of attachments) {
          await graph(`${base}/${draft.id}/attachments`, {
            method: "POST",
            body: JSON.stringify({
              "@odata.type": "#microsoft.graph.fileAttachment",
              name: a.name,
              contentType: a.contentType,
              contentBytes: a.b64,
            }),
          });
        }
        await graph(`${base}/${draft.id}/send`, { method: "POST" });
      } catch (e: any) {
        await graph(`${base}/${draft.id}`, { method: "DELETE" }).catch(() => undefined);
        throw new Error(`Not sent: ${e.message}`);
      }
      return JSON.stringify({ sent: true, ...summary }, null, 2);
    }

    default:
      return null;
  }
}
