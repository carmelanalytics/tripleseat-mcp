/**
 * Inquiry agent pipeline: intake -> triage -> Tripleseat context -> compose -> check -> send/escalate.
 */

import { agentConfig } from "./config.js";
import { fetchNewMessages, getMessage, replyToMessage, sendAsEvents, sendInternal, categorize, MailMessage } from "./graph.js";
import { classifyIntake, Intake } from "./intake.js";
import { loadKb, kbPromptBlock } from "./kb.js";
import { voiceGuide, activeCorrections } from "./voice.js";
import { callJson } from "./llm.js";
import { findGuest, dateFacts, longDate, createLead, idsFromTripleseatEmail, guestFromIds, GuestRecord, DateFacts } from "./ts-context.js";
import { runChecks, gateFailures, describeFailures, saveCheckResults, loadExemplars, pickCloserVoice, CheckContext, CheckResult, GUEST_TOUR_RE } from "./checks.js";
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

/** What the reply should end with, decided in code from the guest's stage and the date state. */
interface ReplyPlan {
  stage: "prospect" | "booked" | "general";
  question: string;
  tourPs: boolean;
  tourPsReason: string;
  tourLink: string;
  guestAskedTour: boolean;
}

const QUESTION_BY_DATE_STATE: Record<DateFacts["state"], string> = {
  open: "When do you hope to decide on a venue?",
  taken: "How flexible is your date?",
  none: "When do you expect to set a date?",
  unknown: "How flexible is your date?",
};

function planBlock(plan: ReplyPlan, facts: DateFacts): string {
  const lines: string[] = [];
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
  priorReplies: string,
  plan: ReplyPlan,
  feedback = ""
): Promise<Draft> {
  const kb = await loadKb();
  const { approved, unanswered } = kbPromptBlock(kb);
  const houseRules = await getSetting("house_rules", "");
  const voice = await voiceGuide();

  return callJson<Draft>({
    system: `${voice}\n\nHOUSE RULES (internal policy; follow them, do not quote them verbatim; where a house rule and an approved answer disagree, the house rule wins)\n${houseRules || "(none set)"}\n\nAPPROVED ANSWERS (the only source of facts besides house rules and live Tripleseat context)\n${approved}\n\nKNOWN QUESTIONS WITHOUT AN APPROVED ANSWER (do not answer these yourself; say the team will confirm)\n${unanswered}`,
    user:
      `Write the reply to this ${t.department} inquiry. Today is ${todayLA()}.\n\nSOURCE: ${intake.source}\nGUEST: ${t.guest_first_name} ${t.guest_last_name}\nSUBJECT: ${intake.subject}\nTOPICS: ${t.topics.join(", ")}\nQUESTIONS (answer all, in order):\n${t.questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}\n\n` +
      `LIVE TRIPLESEAT CONTEXT\n${guest.summary}\n${facts.text ? `Date availability:\n${facts.text}` : "No specific date requested."}\n\n` +
      `REPLY PLAN\n${planBlock(plan, facts)}\n\n` +
      `OUR EARLIER REPLIES ON THIS THREAD (do not repeat them)\n${priorReplies || "(none)"}\n\nGUEST MESSAGE\n${intake.text}` +
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
    if (t.escalate) return escalate(rowId, intake, t.escalate_reason);

    // ── Event inquiries that arrived outside Tripleseat: move them into Tripleseat, reply there later ──
    if (isEvent && !fromTs) {
      const email = t.guest_email || lookupKey;
      const knotNative = process.env.AGENT_KNOT_NATIVE === "true" && intake.source === "weddingpro";
      if (!guest.leadId && !guest.eventId && email && !knotNative && agentConfig.mode === "live") {
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
      }
      await query(
        `UPDATE agent_messages SET action='awaiting_ts', tripleseat_lead_id=COALESCE($2, tripleseat_lead_id), send_transport='tripleseat_relay',
           review_notes=$3 WHERE id=$1`,
        [rowId, guest.leadId || null, guest.leadId || guest.eventId ? "Waiting for the Tripleseat thread to answer in." : "Waiting for the lead to appear in Tripleseat."]
      );
      await categorize(mailbox, m.id, "Agent: moved to Tripleseat");
      return;
    }

    const prior = await priorRepliesOn(m.conversationId);
    if (prior.todayCount >= agentConfig.maxRepliesPerThreadPerDay) {
      return escalate(rowId, intake, `Agent already replied ${prior.todayCount} times on this thread in 24 hours (loop guard).`);
    }

    const facts = await dateFacts(t.requested_dates, todayLA());

    // Decide in code how the reply ends: one question picked by date state, tour invitation in a P.S.
    const prospect = isEvent && guest.stage !== "booked";
    const guestAskedTour = GUEST_TOUR_RE.test(intake.text) || t.topics.some((x) => /tour|visit/i.test(x));
    const alreadyInvited = /p\.?\s?s\.?\b|\btour\b|show the property/i.test(prior.text);
    const plan: ReplyPlan = {
      stage: prospect ? "prospect" : guest.stage === "booked" ? "booked" : "general",
      question: QUESTION_BY_DATE_STATE[facts.state],
      tourPs: prospect && !guestAskedTour && !alreadyInvited,
      tourPsReason: alreadyInvited ? "an earlier reply already invited them" : "not a prospect",
      tourLink: (await getSetting("tour_link", "")).trim(),
      guestAskedTour,
    };

    let draft = await compose(intake, t, guest, facts, prior.text, plan);

    // Voice: when Patrick's own replies are loaded, write a second draft and keep whichever reads
    // more like them. The pick is recorded so it can be compared with Patrick's own pick.
    const exemplars = (await getSetting("voice_pairwise", "on")) === "on" ? await loadExemplars(5).catch(() => []) : [];
    if (exemplars.length >= 3) {
      const second = await compose(intake, t, guest, facts, prior.text, plan);
      const flip = Math.random() < 0.5; // hide which draft came first from the judge
      const v = await pickCloserVoice(flip ? second.reply_text : draft.reply_text, flip ? draft.reply_text : second.reply_text, exemplars);
      const secondWon = (v.pick === "A") === flip;
      const loser = secondWon ? draft : second;
      if (secondWon) draft = second;
      await query(`UPDATE agent_messages SET alt_reply_text=$2, voice_pick_reason=$3, voice_exemplar_ids=$4 WHERE id=$1`, [
        rowId, loser.reply_text, v.reason, exemplars.map((e) => e.id),
      ]);
    }

    // Yes/no checks. One automatic rewrite if a gating check fails, then a person.
    const kbNow = kbPromptBlock(await loadKb());
    const ctx: CheckContext = {
      rowId,
      guestText: intake.text,
      guestEmail: t.guest_email || lookupKey,
      questions: t.questions,
      tsSummary: guest.summary,
      availability: facts.text,
      approved: kbNow.approved,
      houseRules: await getSetting("house_rules", ""),
      corrections: await activeCorrections(),
      prospect,
      guestAskedTour,
    };
    let results: CheckResult[] = await runChecks(draft.reply_text, ctx);
    await saveCheckResults(rowId, 1, results);
    let attempts = 1;
    if (gateFailures(results).length) {
      draft = await compose(intake, t, guest, facts, prior.text, plan, describeFailures(gateFailures(results)));
      results = await runChecks(draft.reply_text, ctx);
      await saveCheckResults(rowId, 2, results);
      attempts = 2;
    }
    const finalText = draft.reply_text;
    const failed = gateFailures(results);
    const reported = results.filter((r) => !r.pass && r.mode === "report");

    await query(
      `UPDATE agent_messages SET reply_text=$2, reply_subject=$3, open_questions=$4, review_notes=$5, check_attempts=$6 WHERE id=$1`,
      [
        rowId, finalText, draft.reply_subject, draft.open_questions,
        [
          `checks: ${results.filter((r) => r.pass).length}/${results.length} passed${attempts > 1 ? " after one rewrite" : ""}`,
          failed.length ? `blocking: ${failed.map((r) => r.id).join(", ")}` : "",
          reported.length ? `noted: ${reported.map((r) => r.id).join(", ")}` : "",
          `confidence: ${draft.confidence}`,
        ].filter(Boolean).join(" | "),
        attempts,
      ]
    );

    if (failed.length || draft.confidence === "low") {
      return escalate(rowId, intake, failed.length ? `Failed checks after one rewrite:\n${describeFailures(failed)}` : "Low confidence", finalText);
    }

    const transport = fromTs ? "tripleseat_relay" : "email_from_events";
    const closeWaiting = async (action: string) => {
      if (waiting.length) await query(`UPDATE agent_messages SET action=$2, review_notes='Answered in Tripleseat with message #' || $3 WHERE id = ANY($1)`, [waiting.map((w) => w.id), action, String(rowId)]);
    };

    if (agentConfig.mode !== "live") {
      await query(`UPDATE agent_messages SET action='drafted', send_transport=$2 WHERE id=$1`, [rowId, transport]);
      await closeWaiting("drafted_in_ts");
      await categorize(mailbox, m.id, "Agent drafted");
      return;
    }

    if (sendsLeft.n <= 0) return escalate(rowId, intake, "Per-run send limit reached; held for the next run or a person.", finalText);
    sendsLeft.n--;

    // Every guest email leaves from events@. If this copy is already in events@, reply on it;
    // otherwise send from events@ to the same reply address with the original quoted
    // (that keeps the Tripleseat thread token, so Tripleseat files it on the thread).
    await query(`UPDATE agent_messages SET action='sending' WHERE id=$1`, [rowId]);
    if (mailbox.toLowerCase() === agentConfig.sendAs.toLowerCase()) {
      await replyToMessage(mailbox, m.id, finalText, [agentConfig.ccOnEveryReply]);
    } else {
      await sendAsEvents(
        intake.replyAddress,
        intake.subject,
        finalText,
        `${intake.fromName} <${intake.fromAddress}>`,
        m.body?.content || intake.text,
        [agentConfig.ccOnEveryReply]
      );
    }
    await query(`UPDATE agent_messages SET action='sent', sent_at=NOW(), send_transport=$2 WHERE id=$1`, [rowId, transport]);
    await closeWaiting("answered_in_ts");
    await categorize(mailbox, m.id, "Agent replied");
    await sendCopy(rowId, intake, finalText).catch(() => {});
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
