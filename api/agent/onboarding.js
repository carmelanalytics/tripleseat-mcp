"use strict";
/**
 * Bringing a conversation into Tripleseat.
 *
 * An event guest who writes in from outside Tripleseat (a direct email, The Knot, WeddingWire, Zola)
 * and is not in Tripleseat yet is invited, in the first reply, to fill out the Tripleseat events
 * inquiry form. That is how the events team has always done it: the form creates the lead with the
 * full questionnaire, and every message after that runs on the Tripleseat thread. The agent does not
 * create a lead of its own for these guests, so the form never produces a duplicate.
 *
 * The invitation is fixed wording added in code (editable on the settings page), modelled on the
 * events team's own replies, so the link is always exact and the model never writes it.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ORIGIN_LABEL = exports.DEFAULT_FORM_TEXT_TOUR = exports.DEFAULT_FORM_TEXT = void 0;
exports.formSettings = formSettings;
exports.formParagraph = formParagraph;
exports.priorFormInvites = priorFormInvites;
exports.isGuestAddress = isGuestAddress;
const config_js_1 = require("./config.js");
const store_js_1 = require("./store.js");
const db_js_1 = require("../db.js");
exports.DEFAULT_FORM_TEXT = "If you can please fill out our events inquiry form, our events team can send over our events packet with info for your date.\n\n{link}\n\nWe look forward to connecting and showing you around the property.";
exports.DEFAULT_FORM_TEXT_TOUR = "In the meantime, can you fill out our events inquiry form so we can schedule that tour for you? Here is the link:\n\n{link}";
async function formSettings() {
    return {
        // A saved blank switches the invitation off; an unset value uses the venue's form.
        link: (await (0, store_js_1.getSetting)("inquiry_form_link", config_js_1.agentConfig.inquiryFormLink)).trim(),
        text: (await (0, store_js_1.getSetting)("inquiry_form_text", "")).trim() || exports.DEFAULT_FORM_TEXT,
        textTour: (await (0, store_js_1.getSetting)("inquiry_form_text_tour", "")).trim() || exports.DEFAULT_FORM_TEXT_TOUR,
    };
}
/** The invitation paragraph for this guest, or "" when no form link is set. */
function formParagraph(s, guestAskedTour) {
    if (!s.link)
        return "";
    const tpl = guestAskedTour ? s.textTour : s.text;
    return (tpl.includes("{link}") ? tpl.replace(/\{link\}/g, s.link) : `${tpl}\n\n${s.link}`).trim();
}
/** How many sent replies have already invited this guest to the form. */
async function priorFormInvites(guestEmail) {
    if (!guestEmail)
        return 0;
    const row = await (0, db_js_1.query)(`SELECT COUNT(*)::int AS n FROM agent_messages
     WHERE form_invited_at IS NOT NULL AND LOWER(guest_email) = LOWER($1) AND created_at > NOW() - INTERVAL '120 days'`, [guestEmail]);
    return row[0]?.n || 0;
}
/** A guest's own address, as opposed to a marketplace relay, a Tripleseat address or one of ours. */
function isGuestAddress(email) {
    const e = (email || "").trim().toLowerCase();
    const dom = e.split("@")[1] || "";
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(e))
        return false;
    return !/(^|\.)(theknot|weddingwire|weddingpro|zola|tripleseat|tripleseatmail|thevillagebigsur)\./.test(dom);
}
exports.ORIGIN_LABEL = {
    direct: "Direct email",
    weddingpro: "The Knot / WeddingWire (WeddingPro) inquiry",
    zola: "Zola inquiry",
};
