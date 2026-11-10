"use strict";
/**
 * Reply checks.
 *
 * Every reply is scored on a fixed list of yes/no checks before it can go out. Checks that a rule
 * can decide are decided in code; checks that need reading are decided by the review model, one
 * verdict per check, each with the evidence it relied on. Nothing here asks "does this sound right?":
 * automated judges are reliable on facts and structure and close to chance on taste, so voice is
 * measured separately, by a pairwise comparison against Patrick's own replies and by Patrick's labels.
 *
 * Each check runs in one of two modes:
 *   gate   – a failure stops the reply (one automatic rewrite, then a person)
 *   report – a failure is logged and shown, but does not stop the reply
 * Checks whose verdicts have not yet been validated against Patrick's labels default to "report".
 * Modes can be changed on the Checks admin page (agent_settings.check_modes).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.GUEST_TOUR_RE = exports.CHECKS = void 0;
exports.parseReply = parseReply;
exports.wordCount = wordCount;
exports.codeChecks = codeChecks;
exports.structureChecks = structureChecks;
exports.judgeChecks = judgeChecks;
exports.checkModes = checkModes;
exports.runChecks = runChecks;
exports.gateFailures = gateFailures;
exports.describeFailures = describeFailures;
exports.saveCheckResults = saveCheckResults;
exports.loadExemplars = loadExemplars;
exports.pickCloserVoice = pickCloserVoice;
exports.pickExemplars = pickExemplars;
const config_js_1 = require("./config.js");
const llm_js_1 = require("./llm.js");
const voice_js_1 = require("./voice.js");
const store_js_1 = require("./store.js");
const db_js_1 = require("../db.js");
const disclosure_js_1 = require("./disclosure.js");
exports.CHECKS = [
    // ── decided by rule ──
    { id: "banned_phrase", label: "No banned word, filler opener, placeholder or unapproved discount", kind: "code", defaultMode: "gate" },
    { id: "one_question", label: "One question (exactly one for a prospect, at most one otherwise)", kind: "code", defaultMode: "gate" },
    { id: "question_last", label: "The question is its own final paragraph, with no closer after it", kind: "code", defaultMode: "gate" },
    { id: "tour_in_ps_only", label: "Tour invitation appears only in the P.S., and the P.S. is a statement", kind: "code", defaultMode: "gate" },
    { id: "form_invite", label: "Inquiry form invitation is added by the system, once, and only for guests not yet in Tripleseat", kind: "code", defaultMode: "gate" },
    { id: "packet_on_request", label: "Event Info Packet mentioned only when the guest asked for it", kind: "code", defaultMode: "gate" },
    { id: "length", label: "Length fits the number of questions asked", kind: "code", defaultMode: "gate" },
    { id: "plain_text", label: "Plain text with sign-off: no lists, bold, headings or emoji; one exclamation mark at most", kind: "code", defaultMode: "gate" },
    { id: "disclosure", label: "Authorship disclosed: first-reply sentence and footer present, nothing claims a person read it first", kind: "code", defaultMode: "gate" },
    { id: "no_repeat_sentence", label: "No sentence copied from a recent reply to a different guest", kind: "code", defaultMode: "report" },
    // ── decided by the review model ──
    {
        id: "facts_supported", label: "Every fact traces to the FAQ, house rules, Tripleseat or the guest's own message", kind: "judge", defaultMode: "gate",
        ask: "PASS only if every price, fee, capacity, time, date, policy, vendor name and availability statement in the draft is supported by APPROVED ANSWERS, HOUSE RULES, AVAILABILITY, TRIPLESEAT CONTEXT or the guest's own message. Evidence: quote the first unsupported statement, or write none.",
    },
    {
        id: "no_unauthorized_promise", label: "No promise only a person can make", kind: "judge", defaultMode: "gate",
        ask: "PASS only if the draft does not confirm a booking, promise a hold longer than 7 days, agree to a contract or price change, offer a discount that is not in APPROVED ANSWERS, or commit staff to a specific time that is not given in the context.",
    },
    {
        id: "every_question_answered", label: "Every guest question answered or openly deferred, in order", kind: "judge", defaultMode: "gate",
        ask: "PASS only if each numbered GUEST QUESTION is either answered or explicitly deferred to the team, in the guest's order. Evidence: the first question left out, or none.",
    },
    {
        id: "no_unsupplied_personal_fact", label: "No personal detail the guest did not give us", kind: "judge", defaultMode: "gate",
        ask: "PASS only if every personal or situational fact about the guest in the draft appears in the guest's message, the thread, or TRIPLESEAT CONTEXT. FAIL for anything inferred or taken from anywhere else.",
    },
    {
        id: "no_persona_or_process_claim", label: "No invented person, presence or process", kind: "judge", defaultMode: "gate",
        ask: "PASS only if the draft does not present the writer as a named individual, does not claim to have been somewhere or seen something in person, and does not claim to have already checked or spoken with someone. Saying the team WILL confirm something is fine.",
    },
    {
        id: "corrections_followed", label: "Breaks none of Patrick's corrections", kind: "judge", defaultMode: "gate",
        ask: "PASS only if the draft breaks none of PATRICK'S CORRECTIONS. If none are listed, PASS. Evidence: the correction broken and the words that break it, or none.",
    },
    {
        id: "answer_first", label: "Main question answered in the first two sentences", kind: "judge", defaultMode: "report",
        ask: "PASS only if the guest's main question is answered within the first two sentences after the greeting.",
    },
    {
        id: "specific_detail", label: "First two sentences use a detail the guest gave (and it is not decoration)", kind: "judge", defaultMode: "report",
        ask: "PASS only if the first two sentences use at least one detail the guest supplied (their date, guest count, occasion, a name, something they asked) and deleting that detail would change the message. If the guest supplied no usable detail, PASS.",
    },
    {
        id: "warm_not_mirrored", label: "Warm and plain; no first-person feelings, no mirrored anger", kind: "judge", defaultMode: "report",
        ask: "PASS only if the tone is warm and plain (not cold, not salesy, not gushing), the writer states no feelings of their own (for example I'd love, we're thrilled, so sorry you're frustrated), and the draft does not mirror the guest's anger or stress.",
    },
    {
        id: "no_writing_tells", label: "None of the habits that read as machine-written", kind: "judge", defaultMode: "report",
        ask: "PASS only if the draft has none of these habits: a contrast that knocks down something nobody said (not just X, it's Y); a closing line that only restates the paragraph or says that something matters; a group of three chosen for rhythm; a run-up before the point; sales language; a sentence that could be sent unchanged to any other guest. Evidence: quote the first instance and name the habit, or none.",
    },
    {
        id: "deferral_names_owner", label: "Anything deferred names who will follow up", kind: "judge", defaultMode: "report",
        ask: "PASS if the draft defers nothing. If it defers anything, PASS only if it says who will follow up (the events team or a named person) and states a time only when one is given in the context.",
    },
];
const SIGNOFF_RE = /^(warmly|best|thanks|thank you|cheers|sincerely|kindly)[,.!]?\s*(\n|$)/i;
const GREETING_ONLY_RE = /^(hi|hello|hey|dear|good (morning|afternoon|evening))\b[^.?!\n]{0,60}[,–-]?\s*$/i;
function parseReply(text) {
    const paras = text.replace(/\r/g, "").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    let signIdx = paras.findIndex((p) => SIGNOFF_RE.test(p) || /^The Village\b[^\n]*$/.test(p));
    if (signIdx < 0)
        signIdx = paras.length;
    let body = paras.slice(0, signIdx);
    if (body.length && GREETING_ONLY_RE.test(body[0]))
        body = body.slice(1);
    const rest = paras.slice(signIdx + 1);
    const psIdx = rest.findIndex((p) => /^p\.?\s?s\.?\b/i.test(p));
    return {
        body,
        signoff: paras[signIdx] || "",
        ps: psIdx >= 0 ? rest[psIdx] : "",
        afterPs: psIdx >= 0 ? rest.slice(psIdx + 1).join("\n\n") : rest.join("\n\n"),
    };
}
function wordCount(s) {
    return (s.match(/[A-Za-z0-9$%'’]+/g) || []).length;
}
function sentences(s) {
    return s.split(/(?<=[.!?])\s+/).map((x) => x.replace(/^[-*\u2022]\s+/, "").trim()).filter(Boolean);
}
const TOUR_RE = /\b(tour|tours|site visit|show you (around|the property)|come (see|by|visit)|walk[- ]?through|visit us)\b/i;
const CLOSER_RE = /hit us back|feel free to (reach|contact|hit|get in touch|email|call)|don[’']?t hesitate|let (me|us) know if you have|hope to hear from you/i;
exports.GUEST_TOUR_RE = /\b(tour|site visit|visit|see the (venue|property|space|grounds)|walk[- ]?through|come (by|see)|stop by|show us)\b/i;
// ─────────────────────────── Checks decided by rule ───────────────────────────
async function recentSentences(ctx) {
    const rows = await (0, db_js_1.query)(`SELECT reply_text FROM agent_messages
     WHERE id <> $1 AND reply_text IS NOT NULL AND action IN ('sent','drafted')
       AND COALESCE(guest_email,'') <> $2
     ORDER BY created_at DESC LIMIT 30`, [ctx.rowId, ctx.guestEmail || ""]);
    const set = new Set();
    for (const r of rows) {
        const p = parseReply(r.reply_text);
        for (const para of p.body) {
            if (para.includes("?"))
                continue; // the standard question repeats by design
            for (const s of sentences(para))
                if (wordCount(s) >= 10)
                    set.add(s.toLowerCase().replace(/\s+/g, " "));
        }
    }
    return set;
}
async function codeChecks(text, ctx) {
    const min = Number(await (0, store_js_1.getSetting)("reply_min_words", "30")) || 30;
    const maxShort = Number(await (0, store_js_1.getSetting)("reply_max_words_short", "120")) || 120;
    const maxLong = Number(await (0, store_js_1.getSetting)("reply_max_words_long", "150")) || 150;
    const seen = await recentSentences(ctx).catch(() => new Set());
    const out = structureChecks(text, ctx, { min, maxShort, maxLong, seen });
    const finalText = (0, disclosure_js_1.assemble)(text, ctx.disclosure, ctx.firstReply, ctx.isEvent, ctx.formInvite ? ctx.formParagraph : "");
    const d = (0, disclosure_js_1.disclosureCheck)(text, finalText, ctx.disclosure, ctx.firstReply, ctx.isEvent, ctx.guestAskedIfHuman);
    out.push({ id: "disclosure", kind: "code", pass: d.pass, evidence: d.evidence });
    // The assembled reply must carry the invitation exactly once when it is due.
    const fi = out.find((r) => r.id === "form_invite");
    if (fi && fi.pass && ctx.formInvite) {
        const n = finalText.split(ctx.formParagraph.trim()).length - 1;
        fi.pass = n === 1;
        fi.evidence = n === 1 ? "invitation added once, above the sign-off" : `invitation appears ${n} times in the assembled reply`;
    }
    return out;
}
/** The rule-decided checks, with no database access (so they can be tested on their own). */
function structureChecks(text, ctx, opts) {
    const p = parseReply(text);
    const bodyText = p.body.join("\n\n");
    const out = [];
    const add = (id, pass, evidence) => out.push({ id, kind: "code", pass, evidence });
    // banned_phrase
    const banned = [...voice_js_1.BANNED_PATTERNS.filter((b) => b.re.test(text)).map((b) => b.why), ...(0, voice_js_1.discountProblems)(text, ctx.approved)];
    add("banned_phrase", banned.length === 0, banned.join("; ") || "none");
    // one_question
    const qCount = (bodyText.match(/\?/g) || []).length;
    // When the reply carries the inquiry form invitation, the form is the one ask, so the draft asks nothing.
    const qOk = ctx.formInvite ? qCount === 0 : ctx.prospect ? qCount === 1 : qCount <= 1;
    add("one_question", qOk, `${qCount} question mark${qCount === 1 ? "" : "s"} in the body${ctx.formInvite ? " (the inquiry form is the one ask, so the draft asks nothing)" : ctx.prospect ? " (a prospect reply needs exactly one)" : ""}`);
    // question_last
    if (qCount === 0) {
        add("question_last", true, "no question in this reply");
    }
    else {
        const last = p.body[p.body.length - 1] || "";
        const endsWithQ = /\?\s*$/.test(last);
        const single = sentences(last).length === 1;
        const closer = CLOSER_RE.test(bodyText);
        const problems = [
            !endsWithQ ? "the last paragraph before the sign-off is not the question" : "",
            endsWithQ && !single ? "the question shares its paragraph with other sentences" : "",
            closer ? "a closer line appears alongside the question" : "",
        ].filter(Boolean);
        add("question_last", problems.length === 0, problems.join("; ") || `final paragraph: "${last.slice(0, 120)}"`);
    }
    // tour_in_ps_only
    {
        const problems = [];
        if (!ctx.guestAskedTour && TOUR_RE.test(bodyText))
            problems.push("a tour or visit is mentioned in the body though the guest did not ask about one");
        if (p.ps && p.ps.includes("?"))
            problems.push("the P.S. asks a question");
        if (p.ps && p.afterPs)
            problems.push("text follows the P.S.");
        if (!p.ps && p.afterPs)
            problems.push("text follows the sign-off that is not a P.S.");
        if (ctx.formInvite && p.ps)
            problems.push("a P.S. appears though the inquiry form is the one ask in this reply");
        add("tour_in_ps_only", problems.length === 0, problems.join("; ") || (p.ps ? "tour invitation is in the P.S." : "no tour invitation"));
    }
    // form_invite: the draft itself never writes about the form or its link; the system adds the paragraph.
    {
        const wrote = /\b(inquiry form|events? form|questionnaire|fill (it |this |that )?out)\b|party_request|tripleseat\.com/i.test(text);
        add("form_invite", !wrote, wrote
            ? "the draft writes its own invitation to the form or a form link"
            : ctx.formInvite
                ? "the draft leaves the invitation to the system"
                : "no form invitation in this reply");
    }
    // packet_on_request
    {
        const mentions = /\b(packet|brochure|price ?sheet)\b/i.test(text);
        add("packet_on_request", ctx.guestAskedPacket || !mentions, mentions ? (ctx.guestAskedPacket ? "the guest asked for it" : "the packet is mentioned though the guest did not ask for it") : "not mentioned");
    }
    // length
    {
        // Target: up to maxShort words for one or two guest questions, up to maxLong for three or more.
        // The gate allows 15% over the target so a reply a few words long is not sent back for a rewrite.
        const n = wordCount(bodyText);
        const target = ctx.questions.length >= 3 ? opts.maxLong : opts.maxShort;
        const ceiling = Math.round(target * 1.15);
        const floor = ctx.prospect ? opts.min : Math.min(opts.min, 12);
        add("length", n >= floor && n <= ceiling, `${n} words in the body; target up to ${target} for ${ctx.questions.length} question${ctx.questions.length === 1 ? "" : "s"} (limit ${ceiling}, minimum ${floor})`);
    }
    // plain_text
    {
        const problems = [];
        if (/^\s*([-*•]|\d+[.)])\s+\S/m.test(text))
            problems.push("list formatting");
        if (/\*\*|__|^#{1,6}\s/m.test(text))
            problems.push("bold or heading markup");
        if (!p.signoff || !text.includes(ctx.signoffName))
            problems.push(`sign-off "${ctx.signoffName}" missing`);
        const bangs = (text.match(/!/g) || []).length;
        if (bangs > 1)
            problems.push(`${bangs} exclamation marks`);
        add("plain_text", problems.length === 0, problems.join("; ") || "plain text with sign-off");
    }
    // no_repeat_sentence
    {
        const seen = opts.seen;
        const dup = p.body
            .filter((para) => !para.includes("?"))
            .flatMap((para) => sentences(para))
            .find((s) => wordCount(s) >= 10 && seen.has(s.toLowerCase().replace(/\s+/g, " ")));
        add("no_repeat_sentence", !dup, dup ? `also sent to another guest: "${dup.slice(0, 160)}"` : "none");
    }
    return out;
}
// ─────────────────────────── Checks decided by the review model ───────────────────────────
async function judgeChecks(text, ctx) {
    const defs = exports.CHECKS.filter((c) => c.kind === "judge");
    const properties = {};
    for (const d of defs) {
        properties[d.id] = {
            type: "object",
            description: d.ask,
            properties: {
                evidence: { type: "string", description: "The words from the draft (or the missing item) this verdict rests on, in under 30 words. Write this before deciding." },
                pass: { type: "boolean" },
            },
            required: ["evidence", "pass"],
        };
    }
    const res = await (0, llm_js_1.callJson)({
        model: config_js_1.agentConfig.reviewModel,
        system: `You check a draft email before it goes to a guest of The Village Big Sur with no person reading it first. ` +
            `You are given a fixed list of checks. Decide each one separately, on its own pass condition, as yes or no. ` +
            `Do not weigh checks against each other and do not judge overall quality or style beyond what a check asks. ` +
            `For each check, first write the evidence, then the verdict.\n\n` +
            `APPROVED ANSWERS\n${ctx.approved || "(none)"}\n\nHOUSE RULES\n${ctx.houseRules || "(none)"}\n\n` +
            `AVAILABILITY\n${ctx.availability || "(no date checked)"}\n\nTRIPLESEAT CONTEXT\n${ctx.tsSummary || "(none)"}\n\n` +
            `PATRICK'S CORRECTIONS\n${ctx.corrections || "(none)"}`,
        user: `GUEST MESSAGE\n${ctx.guestText}\n\nGUEST QUESTIONS\n${ctx.questions.map((q, i) => `${i + 1}. ${q}`).join("\n") || "(none listed)"}\n\n` +
            `DRAFT REPLY\n${text}`,
        toolName: "check_reply",
        schema: { type: "object", properties, required: defs.map((d) => d.id) },
        maxTokens: 2500,
    });
    return defs.map((d) => ({
        id: d.id,
        kind: "judge",
        pass: !!res?.[d.id]?.pass,
        evidence: String(res?.[d.id]?.evidence || "").slice(0, 400),
    }));
}
// ─────────────────────────── Runner ───────────────────────────
async function checkModes() {
    let saved = {};
    try {
        saved = JSON.parse((await (0, store_js_1.getSetting)("check_modes", "{}")) || "{}");
    }
    catch {
        saved = {};
    }
    const modes = {};
    for (const c of exports.CHECKS)
        modes[c.id] = saved[c.id] === "gate" || saved[c.id] === "report" ? saved[c.id] : c.defaultMode;
    return modes;
}
async function runChecks(text, ctx) {
    const modes = await checkModes();
    const [code, judge] = await Promise.all([codeChecks(text, ctx), judgeChecks(text, ctx)]);
    return [...code, ...judge].map((r) => ({ ...r, mode: modes[r.id] || "gate" }));
}
function gateFailures(results) {
    return results.filter((r) => !r.pass && r.mode === "gate");
}
function describeFailures(results) {
    return results
        .filter((r) => !r.pass)
        .map((r) => {
        const def = exports.CHECKS.find((c) => c.id === r.id);
        return `- ${def?.label || r.id}: ${r.evidence}`;
    })
        .join("\n");
}
async function saveCheckResults(rowId, attempt, results) {
    for (const r of results) {
        await (0, db_js_1.query)(`INSERT INTO agent_check_results (message_id, attempt, check_id, kind, mode, pass, evidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (message_id, attempt, check_id) DO UPDATE SET pass = EXCLUDED.pass, evidence = EXCLUDED.evidence, mode = EXCLUDED.mode`, [rowId, attempt, r.id, r.kind, r.mode, r.pass, r.evidence]);
    }
}
/** A rotating handful of Patrick's own replies, used as the reference for voice. */
async function loadExemplars(n = 5) {
    return (0, db_js_1.query)(`SELECT id, reply_text, situation_tags, recipient_type FROM agent_exemplars WHERE active ORDER BY random() LIMIT $1`, [n]);
}
/**
 * Which of two drafts reads more like the reference replies? Returns "A" or "B".
 * A score, never a gate: the caller records the pick so it can be compared with Patrick's own pick.
 */
async function pickCloserVoice(a, b, exemplars) {
    const refs = exemplars.map((e, i) => `<example index="${i + 1}">\n${e.reply_text}\n</example>`).join("\n");
    const res = await (0, llm_js_1.callJson)({
        model: config_js_1.agentConfig.reviewModel,
        system: `You compare writing voice. The examples are real replies written by the owner of The Village Big Sur. ` +
            `Two drafts answer the same guest. Decide which draft reads more like the same person wrote it: ` +
            `greeting, rhythm, sentence length, punctuation habits, word choice, how directly it gets to the point, how it closes. ` +
            `Ignore the facts (both drafts carry the same facts) and ignore which one is more polished. ` +
            `Write the reason first, then the pick.\n\n${refs}`,
        user: `DRAFT A\n${a}\n\nDRAFT B\n${b}`,
        toolName: "pick_voice",
        schema: {
            type: "object",
            properties: {
                reason: { type: "string", description: "One or two sentences naming the concrete features that decided it." },
                pick: { type: "string", enum: ["A", "B"] },
            },
            required: ["reason", "pick"],
        },
        maxTokens: 400,
    });
    return { pick: res.pick === "B" ? "B" : "A", reason: String(res.reason || "").slice(0, 400) };
}
/**
 * Voice examples for drafting: a few of Patrick's replies from the same kind of situation and the
 * same kind of reader, with names and amounts blanked. Chosen by situation, never by similar wording,
 * and rotated so two guests in a week do not get replies built on the same examples.
 */
async function pickExemplars(tags, recipientType, n = 4) {
    return (0, db_js_1.query)(`SELECT id, COALESCE(reply_neutral, reply_text) AS text FROM agent_exemplars
     WHERE active AND char_length(reply_text) BETWEEN 60 AND 2500
     ORDER BY (CASE WHEN $2 <> '' AND recipient_type = $2 THEN 1 ELSE 0 END) DESC,
              (SELECT COUNT(*) FROM unnest(situation_tags) t WHERE t = ANY($1::text[])) DESC,
              random()
     LIMIT $3`, [tags, recipientType || "", n]);
}
