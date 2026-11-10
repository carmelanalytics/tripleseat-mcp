/**
 * Inquiry agent pipeline: intake -> triage -> Tripleseat context -> compose -> check -> send/escalate.
 */

import { agentConfig } from "./config.js";
import { fetchNewMessages, getMessage, replyToMessage, sendFrom, sendInternal, categorize, MailMessage } from "./graph.js";
import { classifyIntake, Intake } from "./intake.js";
import { loadKb, kbPromptBlock } from "./kb.js";
import { voiceGuide, activeCorrections } from "./voice.js";
import { callJson } from "./llm.js";
import { findGuest, dateFacts, longDate, createLead, followUpTask, originNote, idsFromTripleseatEmail, guestFromIds, GuestRecord, DateFacts } from "./ts-context.js";
import { formSettings, formParagraph, priorFormInvites, isGuestAddress, ORIGIN_LABEL } from "./onboarding.js";
import { runChecks, gateFailures, describeFailures, saveCheckResults, loadExemplars, pickExemplars, pickCloserVoice, CheckContext, CheckResult, GUEST_TOUR_RE } from "./checks.js";
import { disclosureSettings, assemble, ASKED_IF_HUMAN_RE } from "./disclosure.js";
import { answerLink } from "./links.js";
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
  recipient_type: "couple" | "planner" | "corporate" | "family_member" | "other";
  situation_tags: string[];
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
    recipient_type: { type: "string", enum: ["couple", "planner", "corporate", "family_member", "other"], description: "Who is writing. planner = a professional planner or agency acting for a client (agency signature, 'my client', several dates, RFP wording). corporate = a company contact arranging a work event. Use couple or other unless the message clearly shows a planner or a company." },
    situation_tags: { type: "array", items: { type: "string", enum: ["pricing", "capacity", "tour_or_visit", "idlewild", "lodging", "food_beverage", "bar", "vendor_policy", "music_or_noise", "weather_road_fire", "logistics", "follow_up", "booked_client", "other"] }, description: "What the message is about, for choosing voice examples." },
    escalate: { type: "boolean" },
    escalate_reason: { type: "string" },
  },
  required: ["is_inquiry", "department", "topics", "questions", "requested_dates", "guest_count", "recipient_type", "situation_tags", "escalate", "escalate_reason", "guest_first_name", "guest_last_name", "guest_email", "guest_phone", "not_inquiry_reason"],
};

const ESCALATION_RULES = `
Set escalate=true (a person must handle it; the agent sends nothing to the guest) when the message:
- concerns money already owed or paid: payments, wires, invoices, refunds, deposits returned, chargebacks, balances;
- asks to change a signed contract, move or release a booked date, reduce a guarantee on a booked event, or raises fire, road closure or other emergency effects on a booked event;
- is a complaint, a dispute, a bad experience, a threat of a bad review, or mentions a lawyer, insurance claim, injury or damage;
- comes from press, media, a film/photo shoot location scout, a government agency or a landlord/neighbor matter;
- asks for a custom price, discount, or a deal beyond published packages;
- is emotional or sensitive (illness, death in the family, a breakup);
- shows the guest is angry or frustrated with us, whatever the subject;
- is mainly a personal note that a person should answer: thanks after an event, congratulations, condolences.
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

/** What the reply should end with, decided in code from the guest's stage and the date state. */
interface ReplyPlan {
  stage: "prospect" | "booked" | "general";
  recipientType: Triage["recipient_type"];
  signoffName: string;
  question: string;
  tourPs: boolean;
  tourPsReason: string;
  tourLink: string;
  guestAskedTour: boolean;
  guestAskedPacket: boolean;
  packetLink: string;
  /** The system will add the inquiry form invitation, so the draft ends after its answer. */
  formInvite: boolean;
}

/** The guest asked for the Event Info Packet (or a brochure or price sheet) by name. */
export const PACKET_RE = /\b(event info(rmation)? packet|info(rmation)? packet|packet|brochure|price ?sheet|pricing (sheet|guide|packet|brochure)|rate sheet)\b/i;

const QUESTION_BY_DATE_STATE: Record<DateFacts["state"], string> = {
  open: "When do you hope to decide on a venue?",
  taken: "How flexible is your date?",
  none: "When do you expect to set a date?",
  unknown: "How flexible is your date?",
};

function planBlock(plan: ReplyPlan, facts: DateFacts): string {
  const lines: string[] = [];
  lines.push(`Sign-off name: ${plan.signoffName}`);
  lines.push(
    plan.guestAskedPacket
      ? plan.packetLink
        ? `Event Info Packet: the guest asked for it. Give this link: ${plan.packetLink}`
        : "Event Info Packet: the guest asked for it, and no link is set. Say our events team will send it, and list that as an open question."
      : "Event Info Packet: the guest did not ask for it, so do not offer, link or mention it."
  );
  if (plan.recipientType === "planner") lines.push("Writer: a professional planner. Use the planner format.");
  else if (plan.recipientType === "corporate") lines.push("Writer: a company contact. Use the planner format.");
  if (plan.stage !== "prospect") {
    lines.push(`Guest stage: ${plan.stage === "booked" ? "booked client" : "general guest (not an event prospect)"}.`);
    lines.push("A question is optional: at most one, and only if you need the answer to help them. No tour P.S.");
    return lines.join("\n");
  }
  lines.push("Guest stage: prospect (has not booked).");
  if (facts.state === "open") lines.push("Date state: OPEN.");
  else if (facts.state === "taken")
    lines.push(
      facts.alternatives.length
        ? `Date state: TAKEN. Name these open alternatives in the paragraph above the question: ${facts.alternatives.map(longDate).join("; ")}.`
        : "Date state: TAKEN. No open alternative was found nearby, so say the team will send the closest open dates."
    );
  else if (facts.state === "none") lines.push("Date state: NO DATE GIVEN.");
  else lines.push("Date state: COULD NOT BE CHECKED. Say the team will confirm availability.");
  if (plan.formInvite) {
    lines.push(
      "This guest wrote in from outside Tripleseat and has not filled out our events inquiry form yet. " +
        "Ending: stop after your answer, then the sign-off. Ask no question and add no P.S. " +
        "The system adds a paragraph above your sign-off inviting them to fill out the form, with the link; it also says our events team will send the events packet. " +
        "So do not mention the form, a link or the packet yourself, and do not offer times for a visit."
    );
    if (plan.guestAskedTour) lines.push("The guest asked about visiting: say in one sentence that we would be glad to show them around. The added paragraph explains that the form is how the tour gets scheduled.");
    return lines.join("\n");
  }
  lines.push(
    `The one question, as its own final paragraph before the sign-off: "${plan.question}" A close variation is fine. ` +
      `If an earlier reply on this thread already asked it, ask the next easiest question instead.`
  );
  if (plan.guestAskedTour) lines.push("The guest asked about visiting, so answer that in the body. No P.S.");
  else if (plan.tourPs)
    lines.push(
      `P.S.: after the sign-off, add the tour invitation as a statement. ` +
        (plan.tourLink ? `Scheduling link to include: ${plan.tourLink}` : "No scheduling link is set, so invite them to send a day and time after 12:00 pm.")
    );
  else lines.push(`P.S.: none (${plan.tourPsReason}).`);
  return lines.join("\n");
}

async function compose(
  intake: Intake,
  t: Triage,
  guest: GuestRecord,
  facts: DateFacts,
  threadBrief: string,
  plan: ReplyPlan,
  examples: { id: number; text: string }[],
  feedback = ""
): Promise<Draft> {
  const kb = await loadKb();
  const { approved, unanswered } = kbPromptBlock(kb);
  const houseRules = await getSetting("house_rules", "");
  const voice = await voiceGuide();
  const exampleBlock = examples.length
    ? `\n\nEXAMPLES OF PATRICK'S OWN REPLIES (for voice only)\nThese are real replies the owner wrote in similar situations, with names and amounts blanked out. ` +
      `Match their greeting style, rhythm, sentence length, punctuation habits and directness. Take no fact, price, date, policy or name from them: ` +
      `facts come only from APPROVED ANSWERS, HOUSE RULES and LIVE TRIPLESEAT CONTEXT. Where an example and the rules above differ on how a reply is built or how it ends, follow the rules.\n` +
      examples.map((e) => `<example>\n${e.text}\n</example>`).join("\n")
    : "";

  return callJson<Draft>({
    system: `${voice}\n\nHOUSE RULES (internal policy; follow them, do not quote them verbatim; where a house rule and an approved answer disagree, the house rule wins)\n${houseRules || "(none set)"}\n\nAPPROVED ANSWERS (the only source of facts besides house rules and live Tripleseat context)\n${approved}\n\nKNOWN QUESTIONS WITHOUT AN APPROVED ANSWER (do not answer these yourself; say the team will confirm)\n${unanswered}${exampleBlock}`,
    user:
      `Write the reply to this ${t.department} inquiry. Today is ${todayLA()}.\n\nSOURCE: ${intake.source}\nGUEST: ${t.guest_first_name} ${t.guest_last_name}\nSUBJECT: ${intake.subject}\nTOPICS: ${t.topics.join(", ")}\nQUESTIONS (answer all, in order):\n${t.questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}\n\n` +
      `LIVE TRIPLESEAT CONTEXT\n${guest.summary}\n${facts.text ? `Date availability:\n${facts.text}` : "No specific date requested."}\n\n` +
      `REPLY PLAN\n${planBlock(plan, facts)}\n\n` +
      `THREAD SO FAR (what they asked, what we said, what is still open; use it for continuity, do not repeat or quote it back)\n${threadBrief || "(this is the first exchange)"}\n\nGUEST MESSAGE\n${intake.text}` +
      (feedback
        ? `\n\nYOUR PREVIOUS DRAFT FAILED THESE CHECKS. Write the reply again so that each one passes, keeping every supported fact:\n${feedback}`
        : ""),
    toolName: "draft_reply",
    schema: DRAFT_SCHEMA,
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

interface ThreadHistory {
  /** What they asked, what we said, what is still open: built from the agent's own log. */
  brief: string;
  todayCount: number;
  repliedBefore: boolean;
  invitedBefore: boolean;
}

function squash(text: string | null, max: number): string {
  const t = (text || "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}...` : t;
}

/** Earlier exchanges with this guest, matched by email thread, guest address or Tripleseat record. */
async function threadHistory(rowId: number, conversationId: string | undefined, guestEmail: string, leadId?: string, eventId?: string): Promise<ThreadHistory> {
  const rows = await query<{ inbound_text: string | null; reply_text: string | null; model_reply_text: string | null; open_questions: string[]; action: string; created_at: string; sent_at: string | null }>(
    `SELECT inbound_text, reply_text, model_reply_text, open_questions, action, created_at, sent_at FROM agent_messages
     WHERE id <> $1 AND action IN ('sent','drafted') AND reply_text IS NOT NULL
       AND ( ($2 <> '' AND conversation_id = $2) OR ($3 <> '' AND LOWER(guest_email) = LOWER($3))
          OR ($4 <> '' AND tripleseat_lead_id = $4) OR ($5 <> '' AND tripleseat_event_id = $5) )
     ORDER BY created_at DESC LIMIT 4`,
    [rowId, conversationId || "", guestEmail || "", leadId || "", eventId || ""]
  );
  const chron = rows.slice().reverse();
  const day = (d: string) => new Intl.DateTimeFormat("en-CA", { timeZone: agentConfig.timezone }).format(new Date(d));
  const brief = chron
    .map((r, i) => {
      const open = (r.open_questions || []).length ? `\n   Left for our team to confirm: ${r.open_questions.join("; ")}` : "";
      return `${i + 1}. ${day(r.created_at)}: the guest asked: ${squash(r.inbound_text, 500)}\n   We replied: ${squash(r.model_reply_text || r.reply_text, 700)}${open}`;
    })
    .join("\n");
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  return {
    brief,
    todayCount: rows.filter((r) => r.action === "sent" && r.sent_at && new Date(r.sent_at).getTime() > dayAgo).length,
    repliedBefore: rows.length > 0,
    invitedBefore: rows.some((r) => /(^|\n)p\.?\s?s\.?\b|\btours?\b/i.test(r.model_reply_text || r.reply_text || "")),
  };
}

async function escalate(rowId: number, intake: Intake, reason: string, suggested?: string, brief = ""): Promise<void> {
  await query(`UPDATE agent_messages SET action='escalated', review_notes=$2 WHERE id=$1`, [rowId, reason]);
  const html = `<p><b>The inquiry agent did not reply to this message.</b> Reason: ${esc(reason).replace(/\n/g, "<br>")}</p>
<p><b>From:</b> ${esc(intake.fromName)} &lt;${esc(intake.fromAddress)}&gt;<br><b>Subject:</b> ${esc(intake.subject)}</p>
${brief ? `<p><b>So you do not have to re-read the thread:</b></p><pre style="white-space:pre-wrap;font-family:inherit;background:#f3f1ea;padding:10px">${esc(brief)}</pre>` : ""}
<pre style="white-space:pre-wrap;font-family:inherit;background:#f6f6f6;padding:10px">${esc(intake.text)}</pre>
${suggested ? `<p><b>Suggested reply (not sent):</b></p><pre style="white-space:pre-wrap;font-family:inherit;background:#eef5ee;padding:10px">${esc(suggested)}</pre>` : ""}
<p>Reply to the guest through Tripleseat. Agent log #${rowId}.</p>`;
  await sendInternal(agentConfig.sendAs, agentConfig.escalateTo, `Needs a person: ${intake.subject}`.slice(0, 180), html);
}

/**
 * A copy of every reply the agent writes goes to Patrick as it happens, sent or (in shadow mode) only
 * drafted, with the question his answers are scored on: "Would you have sent this unchanged?"
 */
async function sendCopy(rowId: number, intake: Intake, reply: string, sent: boolean, to_guest = ""): Promise<void> {
  const to = (process.env.AGENT_COPY_TO || "patrick@thevillagebigsur.com").split(",").map((s) => s.trim()).filter(Boolean);
  if (!to.length) return;
  const base = process.env.PUBLIC_BASE_URL || "";
  const btn = (href: string, label: string, bg: string) =>
    `<a href="${href}" style="display:inline-block;padding:10px 18px;margin-right:10px;background:${bg};color:#ffffff;text-decoration:none;border-radius:4px;font-weight:bold">${label}</a>`;
  const html = `<p><b>${sent ? "Sent automatically" : "Draft only. Nothing was sent to the guest."}</b> (${esc(intake.source)}${to_guest ? `, to ${esc(to_guest)}` : ""})</p>
<p><b>Guest wrote:</b></p><pre style="white-space:pre-wrap;font-family:inherit;background:#f6f6f6;padding:10px">${esc(intake.text)}</pre>
<p><b>${sent ? "We replied:" : "The agent would have replied:"}</b></p><pre style="white-space:pre-wrap;font-family:inherit;background:#eef5ee;padding:10px">${esc(reply)}</pre>
<p style="font-size:16px"><b>Would you have sent this unchanged?</b></p>
<p>${btn(answerLink(rowId, "yes"), "Yes", "#2e6b4f")}${btn(answerLink(rowId, "no"), "No", "#8a3b2e")}</p>
<p style="color:#666">Each answer opens a page with one button to confirm. On No, you can say what you would change. <a href="${base}/admin/agent/message/${rowId}">Open the full record</a> to correct the reply or label the individual checks.</p>`;
  await sendInternal(agentConfig.sendAs, to, `${sent ? "Agent replied" : "Agent draft (not sent)"}: ${intake.subject}`.slice(0, 180), html);
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
    const fromTs = intake.source === "tripleseat_guest_message" || intake.source === "tripleseat_new_lead";
    const lookupKey = intake.source === "direct" ? intake.fromAddress : "";

    // Who is this? Tripleseat notifications link to the lead/event; otherwise look up by email.
    let guest: GuestRecord =
      (fromTs && (await guestFromIds(idsFromTripleseatEmail(m.body?.content || "")))) || (await findGuest(lookupKey));

    // An inquiry that came in by Knot/Zola/direct email and is waiting for its Tripleseat thread
    // gets answered here, inside Tripleseat, together with whatever the latest message says.
    let waiting: { id: number; inbound_text: string; source: string }[] = [];
    if (fromTs) {
      const tsName = nameFromTripleseatSubject(intake.subject);
      waiting = await query(
        `SELECT id, inbound_text, source FROM agent_messages
         WHERE action = 'awaiting_ts' AND created_at > NOW() - INTERVAL '5 days'
           AND ((tripleseat_lead_id IS NOT NULL AND tripleseat_lead_id = $1)
             OR (tripleseat_event_id IS NOT NULL AND tripleseat_event_id = $2)
             OR ($3 <> '' AND LOWER(guest_name) = LOWER($3)))
         ORDER BY id`,
        [guest.leadId || "", guest.eventId || "", tsName]
      );
      if (waiting.length) {
        intake.text =
          waiting.map((w) => `EARLIER INQUIRY (arrived via ${w.source}, not yet answered):\n${w.inbound_text}`).join("\n\n") +
          `\n\nLATEST MESSAGE ON THE TRIPLESEAT THREAD:\n${intake.text}`;
      }
    }

    const t = await triage(intake, guest);
    if (!guest.leadId && !guest.eventId && t.guest_email && t.guest_email !== lookupKey) guest = await findGuest(t.guest_email);
    if (!t.guest_first_name && fromTs) t.guest_first_name = nameFromTripleseatSubject(intake.subject).split(" ")[0] || "";
    if (waiting.length) t.is_inquiry = true;
    const isEvent = t.department.startsWith("Events");

    await query(
      `UPDATE agent_messages SET guest_name=$2, guest_email=$3, department=$4, topics=$5, tripleseat_lead_id=$6, tripleseat_event_id=$7 WHERE id=$1`,
      [rowId, `${t.guest_first_name} ${t.guest_last_name}`.trim(), t.guest_email || lookupKey, t.department, t.topics, guest.leadId || null, guest.eventId || null]
    );

    if (!t.is_inquiry) {
      await query(`UPDATE agent_messages SET action='ignored', review_notes=$2 WHERE id=$1`, [rowId, t.not_inquiry_reason]);
      return;
    }
    const handoffBrief =
      `Who: ${`${t.guest_first_name} ${t.guest_last_name}`.trim() || intake.fromName || intake.fromAddress} (${t.recipient_type}), ${t.department}\n` +
      `Tripleseat: ${guest.summary}\n` +
      (t.requested_dates.length ? `Dates asked about: ${t.requested_dates.join(", ")}\n` : "") +
      (t.guest_count ? `Guests: ${t.guest_count}\n` : "") +
      `What they asked:\n${t.questions.map((q, i) => `${i + 1}. ${q}`).join("\n") || "(no specific question)"}`;
    if (t.escalate) return escalate(rowId, intake, t.escalate_reason, undefined, handoffBrief);

    // A lead that began outside Tripleseat (we invited the guest to the form) gets its origin written on it.
    if (fromTs && guest.leadId && t.guest_email && agentConfig.mode === "live") {
      const began = await query<{ id: number; source: string; mailbox: string; created_at: string }>(
        `SELECT id, source, mailbox, created_at FROM agent_messages
         WHERE form_invited_at IS NOT NULL AND origin_noted_at IS NULL AND LOWER(guest_email) = LOWER($1)
           AND created_at > NOW() - INTERVAL '120 days' ORDER BY id LIMIT 1`,
        [t.guest_email]
      ).catch(() => []);
      if (began.length) {
        const first = began[0];
        const on = new Date(first.created_at).toLocaleDateString("en-US", { timeZone: agentConfig.timezone });
        await originNote(guest.leadId, `ORIGIN: ${ORIGIN_LABEL[first.source] || first.source} to ${first.mailbox} on ${on}. Invited to the events inquiry form by the inquiry agent.`)
          .then(() => query(`UPDATE agent_messages SET origin_noted_at = NOW() WHERE form_invited_at IS NOT NULL AND LOWER(guest_email) = LOWER($1)`, [t.guest_email]))
          .catch((e) => query(`UPDATE agent_messages SET error=$2 WHERE id=$1`, [rowId, `Origin note not written on lead ${guest.leadId}: ${String(e.message).slice(0, 200)}`]));
      }
    }

    // ── Event inquiries that arrived outside Tripleseat ──
    // A guest who is not in Tripleseat yet is answered by email from events@ and invited, in that first
    // reply, to fill out the Tripleseat inquiry form. The form creates the lead, and the conversation
    // carries on inside Tripleseat. A guest who is already in Tripleseat is answered on their thread there.
    let formText = "";
    let outsideTo = "";
    if (isEvent && !fromTs) {
      const email = t.guest_email || lookupKey;
      const inTripleseat = !!(guest.leadId || guest.eventId);
      // With The Knot's own Tripleseat integration on, Tripleseat creates that lead itself.
      const knotNative = process.env.AGENT_KNOT_NATIVE === "true" && intake.source === "weddingpro";
      const form = await formSettings();
      if (!inTripleseat && !knotNative && form.link) {
        const invites = await priorFormInvites(email);
        if (invites >= agentConfig.formInviteMax) {
          return escalate(rowId, intake, `Invited to the events inquiry form ${invites} times and still not in Tripleseat. Please call or write to them, or create the lead by hand.`, undefined, handoffBrief);
        }
        // Marketplace notices arrive from a relay address, so write to the guest's own address.
        outsideTo = intake.source === "direct" ? intake.replyAddress : isGuestAddress(t.guest_email) ? t.guest_email : "";
        if (!outsideTo) {
          return escalate(rowId, intake, `This ${ORIGIN_LABEL[intake.source] || intake.source} has no guest email address to write to. Please reply on that platform and invite them to the inquiry form: ${form.link}`, undefined, handoffBrief);
        }
        formText = formParagraph(form, GUEST_TOUR_RE.test(intake.text) || t.topics.some((x) => /tour|visit/i.test(x)));
      } else {
        // Already in Tripleseat, or Tripleseat is about to create the lead: wait for the thread there.
        // With the form switched off (blank link), the agent creates the lead itself, as before.
        if (!inTripleseat && email && !knotNative && agentConfig.mode === "live") {
          guest.leadId = await createLead({
            firstName: t.guest_first_name,
            lastName: t.guest_last_name,
            email,
            phone: t.guest_phone,
            eventDate: t.requested_dates[0],
            guestCount: t.guest_count || undefined,
            description: `${t.department} inquiry via ${intake.source}`,
            notes: `ORIGIN: ${ORIGIN_LABEL[intake.source] || intake.source}.\nOriginal message:\n${intake.text}`,
          });
        }
        await query(
          `UPDATE agent_messages SET action='awaiting_ts', tripleseat_lead_id=COALESCE($2, tripleseat_lead_id), send_transport='tripleseat_relay',
             review_notes=$3 WHERE id=$1`,
          [rowId, guest.leadId || null, guest.leadId || guest.eventId ? "Waiting for the Tripleseat thread to answer in." : "Waiting for the lead to appear in Tripleseat."]
        );
        await categorize(mailbox, m.id, "Agent: moved to Tripleseat");
        return;
      }
    }
    const formInvite = !!formText;

    const guestEmail = t.guest_email || lookupKey;
    const history = await threadHistory(rowId, m.conversationId, guestEmail, guest.leadId, guest.eventId);
    if (history.todayCount >= agentConfig.maxRepliesPerThreadPerDay) {
      return escalate(rowId, intake, `Agent already replied ${history.todayCount} times to this guest in 24 hours (loop guard).`, undefined, handoffBrief);
    }

    const facts = await dateFacts(t.requested_dates, todayLA());

    // Decide in code how the reply ends: one question picked by date state, tour invitation in a P.S.
    const prospect = isEvent && guest.stage !== "booked";
    const guestAskedTour = GUEST_TOUR_RE.test(intake.text) || t.topics.some((x) => /tour|visit/i.test(x));
    const guestAskedPacket = PACKET_RE.test(intake.text);
    const plan: ReplyPlan = {
      stage: prospect ? "prospect" : guest.stage === "booked" ? "booked" : "general",
      recipientType: t.recipient_type,
      signoffName: isEvent ? "The Village Events Team" : "The Village Big Sur",
      question: formInvite ? "" : QUESTION_BY_DATE_STATE[facts.state],
      tourPs: prospect && !formInvite && !guestAskedTour && !history.invitedBefore,
      tourPsReason: formInvite ? "the inquiry form is the one ask" : history.invitedBefore ? "an earlier reply already invited them" : "not a prospect",
      tourLink: (await getSetting("tour_link", "")).trim(),
      guestAskedTour,
      guestAskedPacket,
      packetLink: (await getSetting("packet_link", "")).trim(),
      formInvite,
    };

    // Voice examples: a few of Patrick's own replies from the same kind of situation and reader.
    const tags = [
      ...t.situation_tags,
      facts.state === "open" ? "date_open" : facts.state === "taken" ? "date_taken" : facts.state === "none" ? "no_date" : "",
      guest.stage === "booked" ? "booked_client" : "",
    ].filter(Boolean);
    const useExamples = (await getSetting("voice_examples", "on")) === "on";
    const examples = useExamples ? await pickExemplars(tags, t.recipient_type, 4).catch(() => []) : [];
    await query(`UPDATE agent_messages SET recipient_type=$2, situation_tags=$3, compose_exemplar_ids=$4 WHERE id=$1`, [
      rowId, t.recipient_type, tags, examples.map((e) => e.id),
    ]);

    let draft = await compose(intake, t, guest, facts, history.brief, plan, examples);

    // Voice comparison: write a second draft on a different set of examples and keep whichever reads
    // more like Patrick's replies. The pick is recorded so it can be compared with Patrick's own pick.
    const reference = (await getSetting("voice_pairwise", "on")) === "on" ? await loadExemplars(5).catch(() => []) : [];
    if (reference.length >= 3) {
      const second = await compose(intake, t, guest, facts, history.brief, plan, useExamples ? await pickExemplars(tags, t.recipient_type, 4).catch(() => []) : []);
      const flip = Math.random() < 0.5; // hide which draft came first from the judge
      const v = await pickCloserVoice(flip ? second.reply_text : draft.reply_text, flip ? draft.reply_text : second.reply_text, reference);
      const secondWon = (v.pick === "A") === flip;
      const loser = secondWon ? draft : second;
      if (secondWon) draft = second;
      await query(`UPDATE agent_messages SET alt_reply_text=$2, voice_pick_reason=$3, voice_exemplar_ids=$4 WHERE id=$1`, [
        rowId, loser.reply_text, v.reason, reference.map((e) => e.id),
      ]);
    }

    // Yes/no checks. One automatic rewrite if a blocking check fails, then a person.
    const kbNow = kbPromptBlock(await loadKb());
    const disclosure = await disclosureSettings();
    const firstReply = !history.repliedBefore;
    const ctx: CheckContext = {
      rowId,
      guestText: intake.text,
      guestEmail,
      questions: t.questions,
      tsSummary: guest.summary,
      availability: facts.text,
      approved: kbNow.approved,
      houseRules: await getSetting("house_rules", ""),
      corrections: await activeCorrections(),
      prospect,
      guestAskedTour,
      guestAskedPacket,
      formInvite,
      formParagraph: formText,
      signoffName: plan.signoffName,
      isEvent,
      firstReply,
      guestAskedIfHuman: ASKED_IF_HUMAN_RE.test(intake.text),
      disclosure,
    };
    let results: CheckResult[] = await runChecks(draft.reply_text, ctx);
    await saveCheckResults(rowId, 1, results);
    let attempts = 1;
    if (gateFailures(results).length) {
      draft = await compose(intake, t, guest, facts, history.brief, plan, examples, describeFailures(gateFailures(results)));
      results = await runChecks(draft.reply_text, ctx);
      await saveCheckResults(rowId, 2, results);
      attempts = 2;
    }
    // The model's text plus the fixed disclosure wording is what the guest receives.
    const finalText = assemble(draft.reply_text, disclosure, firstReply, isEvent, formText);
    const failed = gateFailures(results);
    const reported = results.filter((r) => !r.pass && r.mode === "report");

    await query(
      `UPDATE agent_messages SET reply_text=$2, model_reply_text=$7, reply_subject=$3, open_questions=$4, review_notes=$5, check_attempts=$6 WHERE id=$1`,
      [
        rowId, finalText, draft.reply_subject, draft.open_questions,
        [
          `checks: ${results.filter((r) => r.pass).length}/${results.length} passed${attempts > 1 ? " after one rewrite" : ""}`,
          failed.length ? `blocking: ${failed.map((r) => r.id).join(", ")}` : "",
          reported.length ? `noted: ${reported.map((r) => r.id).join(", ")}` : "",
          `confidence: ${draft.confidence}`,
        ].filter(Boolean).join(" | "),
        attempts,
        draft.reply_text,
      ]
    );

    if (failed.length || draft.confidence === "low") {
      return escalate(rowId, intake, failed.length ? `Failed checks after one rewrite:\n${describeFailures(failed)}` : "Low confidence", finalText, handoffBrief);
    }

    // Event conversations run on the Tripleseat thread from events@. Restaurant, Bodega, yoga and
    // general questions leave from info@ with the department copied.
    const viaEvents = isEvent || fromTs;
    const fromMailbox = viaEvents ? agentConfig.sendAs : agentConfig.generalSendAs;
    const cc = viaEvents ? [agentConfig.ccOnEveryReply] : [agentConfig.deptCc[t.department] || ""].filter(Boolean);
    const transport = fromTs ? "tripleseat_relay" : viaEvents ? "email_from_events" : "email_from_info";
    const closeWaiting = async (action: string) => {
      if (waiting.length) await query(`UPDATE agent_messages SET action=$2, review_notes='Answered in Tripleseat with message #' || $3 WHERE id = ANY($1)`, [waiting.map((w) => w.id), action, String(rowId)]);
    };

    if (agentConfig.mode !== "live") {
      await query(`UPDATE agent_messages SET action='drafted', send_transport=$2 WHERE id=$1`, [rowId, transport]);
      await closeWaiting("drafted_in_ts");
      await categorize(mailbox, m.id, "Agent drafted");
      await sendCopy(rowId, intake, finalText, false).catch(() => {});
      return;
    }

    if (sendsLeft.n <= 0) return escalate(rowId, intake, "Per-run send limit reached; held for the next run or a person.", finalText, handoffBrief);
    sendsLeft.n--;

    // If this copy of the message already sits in the sending mailbox, reply on it; otherwise send
    // from that mailbox to the same reply address with the original quoted (which keeps a Tripleseat
    // thread token, so Tripleseat files the reply on the thread).
    await query(`UPDATE agent_messages SET action='sending' WHERE id=$1`, [rowId]);
    const marketplace = intake.source === "weddingpro" || intake.source === "zola";
    if (mailbox.toLowerCase() === fromMailbox.toLowerCase() && !marketplace) {
      await replyToMessage(mailbox, m.id, finalText, cc);
    } else if (marketplace) {
      // A fresh email to the guest's own address: the marketplace notice is not quoted back to them.
      await sendFrom(fromMailbox, outsideTo, draft.reply_subject || "Your inquiry with The Village Big Sur", finalText, "", "", cc);
    } else {
      await sendFrom(fromMailbox, outsideTo || intake.replyAddress, intake.subject, finalText, `${intake.fromName} <${intake.fromAddress}>`, m.body?.content || intake.text, cc);
    }
    await query(`UPDATE agent_messages SET action='sent', sent_at=NOW(), send_transport=$2, form_invited_at = CASE WHEN $3 THEN NOW() ELSE form_invited_at END WHERE id=$1`, [rowId, transport, formInvite]);
    await closeWaiting("answered_in_ts");
    await categorize(mailbox, m.id, "Agent replied");
    await sendCopy(rowId, intake, finalText, true, outsideTo || intake.replyAddress).catch(() => {});

    // "Our team will confirm" has to have an owner: put the open points on the Tripleseat lead as a task.
    if (draft.open_questions.length) {
      await followUpTask(guest, `The inquiry agent told ${t.guest_first_name || "the guest"} that the team will confirm:\n- ${draft.open_questions.join("\n- ")}`).catch((e) =>
        query(`UPDATE agent_messages SET error=$2 WHERE id=$1`, [rowId, `Follow-up task not created: ${String(e.message).slice(0, 300)}`])
      );
    }
  } catch (err: any) {
    await query(`UPDATE agent_messages SET action='error', error=$2 WHERE id=$1`, [rowId, String(err.message).slice(0, 1000)]);
    await escalate(rowId, intake, `Agent error: ${String(err.message).slice(0, 200)}`).catch(() => {});
  }
}

/** Event inquiries that never got a Tripleseat thread go to a person after a wait. */
async function sweepAwaiting(): Promise<void> {
  const wait = Number(process.env.AGENT_TS_WAIT_MINUTES || "120");
  const stale = await query<{ id: number; source: string; from_address: string; guest_name: string; subject: string; inbound_text: string; tripleseat_lead_id: string | null }>(
    `SELECT id, source, from_address, guest_name, subject, inbound_text, tripleseat_lead_id FROM agent_messages
     WHERE action = 'awaiting_ts' AND created_at < NOW() - ($1 || ' minutes')::interval LIMIT 10`,
    [String(wait)]
  );
  for (const r of stale) {
    const intake = {
      source: r.source as any, transport: "none" as const, fromAddress: r.from_address || "", fromName: r.guest_name || "",
      replyAddress: r.from_address || "", subject: r.subject || "", text: r.inbound_text || "",
    };
    const where = r.tripleseat_lead_id ? `Tripleseat lead #${r.tripleseat_lead_id} exists, but no discussion thread reached events@` : "No Tripleseat lead was found or created";
    await escalate(r.id, intake, `${where} within ${wait} minutes. Please start the thread in Tripleseat; the agent will take it from the guest's next message.`);
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
  await sweepAwaiting();
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
