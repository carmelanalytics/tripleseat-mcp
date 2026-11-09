/**
 * Inquiry agent pipeline: intake -> triage -> Tripleseat context -> compose -> check -> send/escalate.
 */

import { agentConfig } from "./config.js";
import { fetchNewMessages, getMessage, replyToMessage, sendInternal, categorize, MailMessage } from "./graph.js";
import { classifyIntake, Intake } from "./intake.js";
import { loadKb, kbPromptBlock } from "./kb.js";
import { voiceGuide, BANNED_PATTERNS, discountProblems } from "./voice.js";
import { callJson } from "./llm.js";
import { findGuest, availability, createLead, logToTripleseat, GuestRecord } from "./ts-context.js";
import { getSetting } from "./store.js";
import { query, queryOne } from "../db.js";

// ─────────────────────────── Triage ───────────────────────────

interface Triage {
  is_inquiry: boolean;
  not_inquiry_reason: string;
  department: "Events" | "Events (Idlewild)" | "Solstice" | "Bodega" | "Yoga" | "Village (General)";
  topics: string[];
  guest_first_name: string;
  guest_last_name: string;
  guest_email: string;
  guest_phone: string;
  requested_dates: string[];
  guest_count: number;
  questions: string[];
  escalate: boolean;
  escalate_reason: string;
}

const TRIAGE_SCHEMA = {
  type: "object",
  properties: {
    is_inquiry: { type: "boolean", description: "True if a guest, couple, planner or diner is asking The Village something or requesting something. False for vendor pitches, spam, newsletters, receipts, reviews, job applications and internal mail." },
    not_inquiry_reason: { type: "string" },
    department: { type: "string", enum: ["Events", "Events (Idlewild)", "Solstice", "Bodega", "Yoga", "Village (General)"] },
    topics: { type: "array", items: { type: "string" }, description: "Short topic labels, e.g. Availability & dates, Pricing, Guest count, Tours, Bar, Lodging, Idlewild, Reservations." },
    guest_first_name: { type: "string" },
    guest_last_name: { type: "string" },
    guest_email: { type: "string", description: "The guest's own email if it appears in the message (not a Tripleseat/Knot/Zola relay address)." },
    guest_phone: { type: "string" },
    requested_dates: { type: "array", items: { type: "string" }, description: "Specific requested event or reservation dates as YYYY-MM-DD. Empty if only a month/season is given." },
    guest_count: { type: "number", description: "0 if unknown" },
    questions: { type: "array", items: { type: "string" }, description: "Each distinct question or request, in the guest's order." },
    escalate: { type: "boolean" },
    escalate_reason: { type: "string" },
  },
  required: ["is_inquiry", "department", "topics", "questions", "requested_dates", "guest_count", "escalate", "escalate_reason", "guest_first_name", "guest_last_name", "guest_email", "guest_phone", "not_inquiry_reason"],
};

const ESCALATION_RULES = `
Set escalate=true (a person must handle it; the agent sends nothing to the guest) when the message:
- concerns money already owed or paid: payments, wires, invoices, refunds, deposits returned, chargebacks, balances;
- asks to change a signed contract, move or release a booked date, reduce a guarantee on a booked event, or raises fire, road closure or other emergency effects on a booked event;
- is a complaint, a dispute, a bad experience, a threat of a bad review, or mentions a lawyer, insurance claim, injury or damage;
- comes from press, media, a film/photo shoot location scout, a government agency or a landlord/neighbor matter;
- asks for a custom price, discount, or a deal beyond published packages;
- is emotional or sensitive (illness, death in the family, a breakup).
Ordinary questions from booked couples (timeline, vendors, menu, guest logistics) are NOT escalations.
`;

async function triage(intake: Intake, guest: GuestRecord): Promise<Triage> {
  return callJson<Triage>({
    system: `You triage inbound email for The Village Big Sur (wedding and event venue, Solstice restaurant, Big Sur Bodega, Word of Mouth Yoga, Idlewild river ceremony site). Today is ${todayLA()} (America/Los_Angeles).\n${ESCALATION_RULES}`,
    user: `SOURCE: ${intake.source}\nFROM: ${intake.fromName} <${intake.fromAddress}>\nSUBJECT: ${intake.subject}\nTRIPLESEAT: ${guest.summary}\n\nMESSAGE:\n${intake.text}`,
    toolName: "triage",
    schema: TRIAGE_SCHEMA,
    maxTokens: 1200,
  });
}

// ─────────────────────────── Compose ───────────────────────────

interface Draft {
  reply_subject: string;
  reply_text: string;
  kb_ids_used: number[];
  open_questions: string[];
  confidence: "high" | "medium" | "low";
}

const DRAFT_SCHEMA = {
  type: "object",
  properties: {
    reply_subject: { type: "string" },
    reply_text: { type: "string", description: "Plain-text email body, greeting through sign-off." },
    kb_ids_used: { type: "array", items: { type: "number" } },
    open_questions: { type: "array", items: { type: "string" }, description: "Guest questions you could not answer from the provided facts. The reply must say the team will confirm each one." },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["reply_subject", "reply_text", "kb_ids_used", "open_questions", "confidence"],
};

async function compose(intake: Intake, t: Triage, guest: GuestRecord, avail: string, priorReplies: string): Promise<Draft> {
  const kb = await loadKb();
  const { approved, unanswered } = kbPromptBlock(kb);
  const houseRules = await getSetting("house_rules", "");
  const voice = await voiceGuide();

  return callJson<Draft>({
    system: `${voice}\n\nHOUSE RULES (internal policy; follow them, do not quote them verbatim; where a house rule and an approved answer disagree, the house rule wins)\n${houseRules || "(none set)"}\n\nAPPROVED ANSWERS (the only source of facts besides house rules and live Tripleseat context)\n${approved}\n\nKNOWN QUESTIONS WITHOUT AN APPROVED ANSWER (do not answer these yourself; say the team will confirm)\n${unanswered}`,
    user: `Write the reply to this ${t.department} inquiry. Today is ${todayLA()}.\n\nSOURCE: ${intake.source}\nGUEST: ${t.guest_first_name} ${t.guest_last_name}\nSUBJECT: ${intake.subject}\nTOPICS: ${t.topics.join(", ")}\nQUESTIONS (answer all, in order):\n${t.questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}\n\nLIVE TRIPLESEAT CONTEXT\n${guest.summary}\n${avail ? `Date availability:\n${avail}` : "No specific date requested."}\n\nOUR EARLIER REPLIES ON THIS THREAD (do not repeat them)\n${priorReplies || "(none)"}\n\nGUEST MESSAGE\n${intake.text}`,
    toolName: "draft_reply",
    schema: DRAFT_SCHEMA,
    maxTokens: 2000,
  });
}

// ─────────────────────────── Check ───────────────────────────

interface Review {
  pass: boolean;
  problems: string[];
  corrected_reply: string;
}

function codeChecks(text: string, approvedAnswers: string): string[] {
  const problems = BANNED_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.why);
  problems.push(...discountProblems(text, approvedAnswers));
  if (text.length < 60) problems.push("reply is too short");
  if (text.length > 2600) problems.push("reply is too long");
  if (!/The Village Events Team/.test(text)) problems.push("missing sign-off");
  return problems;
}

async function review(intake: Intake, draft: Draft, avail: string): Promise<Review> {
  const kb = await loadKb();
  const { approved } = kbPromptBlock(kb);
  const houseRules = await getSetting("house_rules", "");
  return callJson<Review>({
    model: agentConfig.reviewModel,
    system: `You are the final check before an email goes to a guest of The Village Big Sur with no human review.\nFail the draft (pass=false) if ANY of these is true:\n- it states a price, fee, capacity, time, date, policy, vendor or availability that is not supported by the approved answers, house rules or availability lines below;\n- it promises or confirms anything a person must decide (a booking, a contract change, a discount, a hold longer than 7 days);\n- it leaves a guest question unanswered without saying the team will confirm it;\n- it is rude, cold, overly salesy, or breaks the voice rules.\nIf the problems are fixable by deleting or softening wording, return corrected_reply with the fix and pass=true. Otherwise pass=false and corrected_reply empty.\n\nAPPROVED ANSWERS\n${approved}\n\nHOUSE RULES\n${houseRules}\n\nAVAILABILITY\n${avail || "(none)"}`,
    user: `GUEST MESSAGE\n${intake.text}\n\nDRAFT REPLY\n${draft.reply_text}`,
    toolName: "review",
    schema: {
      type: "object",
      properties: {
        pass: { type: "boolean" },
        problems: { type: "array", items: { type: "string" } },
        corrected_reply: { type: "string" },
      },
      required: ["pass", "problems", "corrected_reply"],
    },
    maxTokens: 2000,
  });
}

// ─────────────────────────── Helpers ───────────────────────────

function todayLA(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: agentConfig.timezone }).format(new Date());
}

function nameFromTripleseatSubject(subject: string): string {
  const m = subject.match(/^(.+?)\s+sent you a new message/i);
  return m ? m[1].trim() : "";
}

async function priorRepliesOn(conversationId: string | undefined): Promise<{ text: string; todayCount: number }> {
  if (!conversationId) return { text: "", todayCount: 0 };
  const rows = await query<{ reply_text: string; sent_at: string }>(
    `SELECT reply_text, sent_at FROM agent_messages
     WHERE conversation_id = $1 AND action IN ('sent','drafted') AND reply_text IS NOT NULL
     ORDER BY created_at DESC LIMIT 3`,
    [conversationId]
  );
  const today = await queryOne<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM agent_messages
     WHERE conversation_id = $1 AND action = 'sent' AND sent_at > NOW() - INTERVAL '24 hours'`,
    [conversationId]
  );
  return { text: rows.map((r) => r.reply_text).join("\n---\n").slice(0, 3000), todayCount: Number(today?.n || 0) };
}

async function escalate(rowId: number, intake: Intake, reason: string, suggested?: string): Promise<void> {
  await query(`UPDATE agent_messages SET action='escalated', review_notes=$2 WHERE id=$1`, [rowId, reason]);
  const html = `<p><b>The inquiry agent did not reply to this message.</b> Reason: ${esc(reason)}</p>
<p><b>From:</b> ${esc(intake.fromName)} &lt;${esc(intake.fromAddress)}&gt;<br><b>Subject:</b> ${esc(intake.subject)}</p>
<pre style="white-space:pre-wrap;font-family:inherit;background:#f6f6f6;padding:10px">${esc(intake.text)}</pre>
${suggested ? `<p><b>Suggested reply (not sent):</b></p><pre style="white-space:pre-wrap;font-family:inherit;background:#eef5ee;padding:10px">${esc(suggested)}</pre>` : ""}
<p>Reply to the guest through Tripleseat. Agent log #${rowId}.</p>`;
  await sendInternal(agentConfig.sendAs, agentConfig.escalateTo, `Needs a person: ${intake.subject}`.slice(0, 180), html);
}

/** Real-time copy of every sent reply to Patrick, with a one-click link to correct it. */
async function sendCopy(rowId: number, intake: Intake, reply: string): Promise<void> {
  const to = (process.env.AGENT_COPY_TO || "patrick@thevillagebigsur.com").split(",").map((s) => s.trim()).filter(Boolean);
  if (!to.length) return;
  const base = process.env.PUBLIC_BASE_URL || "";
  const html = `<p><b>Sent automatically</b> (${esc(intake.source)}) &middot; <a href="${base}/admin/agent/message/${rowId}">Correct this reply</a></p>
<p><b>Guest wrote:</b></p><pre style="white-space:pre-wrap;font-family:inherit;background:#f6f6f6;padding:10px">${esc(intake.text)}</pre>
<p><b>We replied:</b></p><pre style="white-space:pre-wrap;font-family:inherit;background:#eef5ee;padding:10px">${esc(reply)}</pre>`;
  await sendInternal(agentConfig.sendAs, to, `Agent replied: ${intake.subject}`.slice(0, 180), html);
}

function esc(s: string): string {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ─────────────────────────── Main ───────────────────────────

/** Store new messages as a queue first, so nothing is lost if a run times out. */
async function enqueue(mailbox: string, m: MailMessage): Promise<void> {
  await query(
    `INSERT INTO agent_messages (mailbox, graph_message_id, internet_message_id, conversation_id, received_at, source, from_address, subject, inbound_text)
     VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,'')
     ON CONFLICT (mailbox, graph_message_id) DO NOTHING`,
    [mailbox, m.id, m.internetMessageId || null, m.conversationId || null, m.receivedDateTime || null,
     m.from?.emailAddress?.address || "", m.subject || ""]
  );
}

async function handle(rowId: number, mailbox: string, m: MailMessage, sendsLeft: { n: number }): Promise<void> {
  await query(`UPDATE agent_messages SET action='working' WHERE id=$1`, [rowId]);

  // The same email can land in more than one watched mailbox (e.g. events@ and patrick@). Handle it once.
  if (m.internetMessageId) {
    const dup = await queryOne<{ id: number }>(
      `SELECT id FROM agent_messages WHERE internet_message_id = $1 AND id < $2 LIMIT 1`,
      [m.internetMessageId, rowId]
    );
    if (dup) {
      await query(`UPDATE agent_messages SET action='duplicate', source='duplicate' WHERE id=$1`, [rowId]);
      return;
    }
  }

  const intake = classifyIntake(m);
  await query(`UPDATE agent_messages SET source=$2, inbound_text=$3 WHERE id=$1`, [rowId, intake.source, intake.text]);
  if (intake.source === "ignore") {
    await query(`UPDATE agent_messages SET action='ignored', review_notes=$2 WHERE id=$1`, [rowId, intake.ignoreReason || ""]);
    return;
  }

  try {
    const lookupKey = intake.source === "direct" ? intake.fromAddress : "";
    let guest = await findGuest(lookupKey);
    const t = await triage(intake, guest);
    if (!guest.leadId && !guest.eventId && t.guest_email && t.guest_email !== lookupKey) guest = await findGuest(t.guest_email);
    if (!t.guest_first_name && intake.source === "tripleseat_guest_message") {
      t.guest_first_name = nameFromTripleseatSubject(intake.subject).split(" ")[0] || "";
    }

    await query(
      `UPDATE agent_messages SET guest_name=$2, guest_email=$3, department=$4, topics=$5, tripleseat_lead_id=$6, tripleseat_event_id=$7 WHERE id=$1`,
      [rowId, `${t.guest_first_name} ${t.guest_last_name}`.trim(), t.guest_email || lookupKey, t.department, t.topics, guest.leadId || null, guest.eventId || null]
    );

    if (!t.is_inquiry) {
      await query(`UPDATE agent_messages SET action='ignored', review_notes=$2 WHERE id=$1`, [rowId, t.not_inquiry_reason]);
      return;
    }
    if (t.escalate) return escalate(rowId, intake, t.escalate_reason);

    const prior = await priorRepliesOn(m.conversationId);
    if (prior.todayCount >= agentConfig.maxRepliesPerThreadPerDay) {
      return escalate(rowId, intake, `Agent already replied ${prior.todayCount} times on this thread in 24 hours (loop guard).`);
    }

    const avail = t.requested_dates.length ? await availability(t.requested_dates) : "";
    const draft = await compose(intake, t, guest, avail, prior.text);

    const approvedText = kbPromptBlock(await loadKb()).approved;
    let finalText = draft.reply_text;
    let problems = codeChecks(finalText, approvedText);
    const rv = await review(intake, { ...draft, reply_text: finalText }, avail);
    if (!rv.pass) problems = problems.concat(rv.problems);
    else if (rv.corrected_reply?.trim()) {
      finalText = rv.corrected_reply.trim();
      problems = codeChecks(finalText, approvedText);
    }

    await query(
      `UPDATE agent_messages SET reply_text=$2, reply_subject=$3, open_questions=$4, review_notes=$5 WHERE id=$1`,
      [rowId, finalText, draft.reply_subject, draft.open_questions, [...rv.problems, `confidence: ${draft.confidence}`].join(" | ")]
    );

    if (problems.length || draft.confidence === "low") {
      return escalate(rowId, intake, `Failed final check: ${problems.join("; ") || "low confidence"}`, finalText);
    }

    if (agentConfig.mode !== "live") {
      await query(`UPDATE agent_messages SET action='drafted', send_transport=$2 WHERE id=$1`, [rowId, intake.transport]);
      await categorize(mailbox, m.id, "Agent drafted");
      return;
    }

    if (sendsLeft.n <= 0) return escalate(rowId, intake, "Per-run send limit reached; held for the next run or a person.", finalText);
    sendsLeft.n--;

    // New marketplace or direct inquiries become Tripleseat leads before we answer.
    if (!guest.leadId && !guest.eventId && intake.source !== "tripleseat_guest_message" && intake.source !== "tripleseat_new_lead" && t.department.startsWith("Events")) {
      const email = t.guest_email || lookupKey;
      if (email) {
        guest.leadId = await createLead({
          firstName: t.guest_first_name,
          lastName: t.guest_last_name,
          email,
          phone: t.guest_phone,
          eventDate: t.requested_dates[0],
          guestCount: t.guest_count || undefined,
          description: `${t.department} inquiry via ${intake.source}`,
          notes: `Original message (${intake.source}):\n${intake.text}`,
        });
        await query(`UPDATE agent_messages SET tripleseat_lead_id=$2 WHERE id=$1`, [rowId, guest.leadId || null]);
      }
    }

    await query(`UPDATE agent_messages SET action='sending' WHERE id=$1`, [rowId]);
    await replyToMessage(mailbox, m.id, finalText, [agentConfig.ccOnEveryReply]);
    await query(`UPDATE agent_messages SET action='sent', sent_at=NOW(), send_transport=$2 WHERE id=$1`, [rowId, intake.transport]);
    await categorize(mailbox, m.id, "Agent replied");
    await sendCopy(rowId, intake, finalText).catch(() => {});

    if (intake.transport !== "tripleseat_relay") {
      await logToTripleseat(guest, `Inquiry agent replied by email (${intake.source}) on ${todayLA()}:\n\n${finalText}`).catch((e) =>
        query(`UPDATE agent_messages SET error=$2 WHERE id=$1`, [rowId, `Tripleseat log failed: ${e.message}`])
      );
    }
  } catch (err: any) {
    await query(`UPDATE agent_messages SET action='error', error=$2 WHERE id=$1`, [rowId, String(err.message).slice(0, 1000)]);
    await escalate(rowId, intake, `Agent error: ${String(err.message).slice(0, 200)}`).catch(() => {});
  }
}

export async function runPoll(): Promise<{ queued: number; processed: number }> {
  if (agentConfig.mode === "off") return { queued: 0, processed: 0 };
  let queued = 0;
  for (const mailbox of agentConfig.mailboxes) {
    const msgs = await fetchNewMessages(mailbox);
    for (const m of msgs) await enqueue(mailbox, m);
    queued += msgs.length;
  }

  // Work through the queue oldest first, a few per run so a run never times out.
  const perRun = Number(process.env.AGENT_MAX_PER_RUN || "6");
  const pending = await query<{ id: number; mailbox: string; graph_message_id: string }>(
    `SELECT id, mailbox, graph_message_id FROM agent_messages
     WHERE action = 'pending' OR (action = 'working' AND created_at < NOW() - INTERVAL '15 minutes')
     ORDER BY received_at NULLS LAST, id LIMIT $1`,
    [perRun]
  );
  const sendsLeft = { n: agentConfig.maxSendsPerRun };
  for (const p of pending) {
    try {
      const m = await getMessage(p.mailbox, p.graph_message_id);
      await handle(p.id, p.mailbox, m, sendsLeft);
    } catch (e: any) {
      await query(`UPDATE agent_messages SET action='error', error=$2 WHERE id=$1`, [p.id, String(e.message).slice(0, 1000)]);
    }
  }
  return { queued, processed: pending.length };
}
