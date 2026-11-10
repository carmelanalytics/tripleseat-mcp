"use strict";
/**
 * Authorship disclosure and final assembly of a reply.
 *
 * The model writes the reply itself; the fixed disclosure wording is added here, in code, so it is
 * always present, always the same, and always true. The first reply to a guest carries one plain
 * sentence in the body (placed above the closing question so the question stays last); every reply
 * carries a short footer with a way to reach a person and the venue's postal address.
 *
 * Wording is editable on the settings page. Everything it says has to stay true of how the agent
 * runs: replies are copied to the team as they go out, they are not read by a person first.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ASKED_IF_HUMAN_RE = exports.DEFAULT_FOOTER = exports.DEFAULT_LINE_GENERAL = exports.DEFAULT_LINE_EVENTS = void 0;
exports.disclosureSettings = disclosureSettings;
exports.assemble = assemble;
exports.disclosureCheck = disclosureCheck;
const store_js_1 = require("./store.js");
exports.DEFAULT_LINE_EVENTS = "This reply was written by The Village's AI assistant, which works only from details our team has confirmed, and it is copied to our events team. Contracts, custom pricing and date holds go to them directly.";
exports.DEFAULT_LINE_GENERAL = "This reply was written by The Village's AI assistant from details our team has confirmed, and it is copied to our team.";
exports.DEFAULT_FOOTER = "Written by The Village's AI assistant and copied to our team. Reply here any time to reach a person, or to ask us not to write again. The Village Big Sur, 46840 Highway 1, Big Sur, California.";
async function disclosureSettings() {
    return {
        on: (await (0, store_js_1.getSetting)("disclosure_mode", "on")) !== "off",
        lineEvents: (await (0, store_js_1.getSetting)("disclosure_line_events", "")).trim() || exports.DEFAULT_LINE_EVENTS,
        lineGeneral: (await (0, store_js_1.getSetting)("disclosure_line_general", "")).trim() || exports.DEFAULT_LINE_GENERAL,
        footer: (await (0, store_js_1.getSetting)("disclosure_footer", "")).trim() || exports.DEFAULT_FOOTER,
    };
}
const SIGNOFF_RE = /^(warmly|best|thanks|thank you|cheers|sincerely|kindly)[,.!]?\s*(\n|$)/i;
/** Put the disclosure sentence (first reply only) and the footer (every reply) around the model's text. */
function assemble(modelText, d, firstReply, isEvent, formParagraph = "") {
    const paras = modelText.replace(/\r/g, "").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    const signoffAt = () => {
        const i = paras.findIndex((p) => SIGNOFF_RE.test(p) || /^The Village\b/m.test(p.split("\n").slice(-1)[0] || ""));
        return i < 0 ? paras.length : i;
    };
    if (d.on && firstReply) {
        const signIdx = signoffAt();
        const lastBody = signIdx - 1;
        const insertAt = lastBody >= 1 && /\?\s*$/.test(paras[lastBody]) ? lastBody : signIdx;
        paras.splice(insertAt, 0, isEvent ? d.lineEvents : d.lineGeneral);
    }
    // The inquiry form invitation is the last thing before the sign-off, so the reply ends on the ask.
    if (formParagraph)
        paras.splice(signoffAt(), 0, formParagraph.trim());
    if (d.on && d.footer)
        paras.push(d.footer);
    return paras.join("\n\n");
}
/** Yes/no: does the assembled reply carry the disclosure it should, and does the draft itself stay quiet about authorship? */
function disclosureCheck(modelText, finalText, d, firstReply, isEvent, guestAskedIfHuman) {
    if (!d.on)
        return { pass: true, evidence: "disclosure is switched off in settings" };
    const problems = [];
    if (d.footer && !finalText.trimEnd().endsWith(d.footer))
        problems.push("footer missing or not last");
    if (firstReply && !finalText.includes(isEvent ? d.lineEvents : d.lineGeneral))
        problems.push("first-reply sentence missing");
    if (!guestAskedIfHuman && /\b(AI assistant|artificial intelligence|chatbot|automated (reply|response|assistant))\b/i.test(modelText))
        problems.push("the draft writes its own statement about being automated");
    if (/\breviewed by\b/i.test(modelText))
        problems.push('the draft says it was "reviewed by" someone');
    return {
        pass: problems.length === 0,
        evidence: problems.join("; ") || (firstReply ? "first-reply sentence and footer present" : "footer present"),
    };
}
exports.ASKED_IF_HUMAN_RE = /\b(are you|is this|am i (talking|speaking|chatting) (to|with))\s+(a\s+)?(real\s+)?(person|human|bot|robot|ai|a\.i\.|automated|chatbot|machine)\b|\b(bot|ai|a\.i\.|chatgpt|automated)\b[^.?!]{0,40}\?/i;
