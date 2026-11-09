"use strict";
/**
 * Works out where an inbound email came from and how a reply can travel back.
 * Deterministic rules first; the model's triage step makes the final inquiry/not-inquiry call.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.newestText = newestText;
exports.classifyIntake = classifyIntake;
const OWN_DOMAINS = ["thevillagebigsur.com", "oroscogroup.com"];
const IGNORE_SENDERS = [
    "yelp.com",
    "tripadvisor.com",
    "google.com",
    "opentable.com",
    "toasttab.com",
    "exploretock.com",
    "docusign.net",
    "intuit.com",
    "bill.com",
    "stripe.com",
    "square.com",
    "mailchimp",
    "facebookmail.com",
    "instagram.com",
    "linkedin.com",
];
const NO_REPLY = /(^|[._-])(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?)@/i;
function domainOf(addr) {
    return (addr.split("@")[1] || "").toLowerCase();
}
/** Strip quoted history and signatures so the model sees only the new message. */
function newestText(body) {
    const lines = body.replace(/\r/g, "").split("\n");
    const out = [];
    for (const line of lines) {
        if (/^On .+wrote:\s*$/.test(line))
            break;
        if (/^-{2,}\s*Original Message/i.test(line))
            break;
        if (/^From: .+/.test(line) && out.length > 3)
            break;
        if (/^>/.test(line))
            continue;
        out.push(line);
    }
    return out.join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 6000);
}
function classifyIntake(m) {
    const fromAddress = (m.from?.emailAddress?.address || "").toLowerCase();
    const fromName = m.from?.emailAddress?.name || "";
    const replyAddress = (m.replyTo?.[0]?.emailAddress?.address || fromAddress).toLowerCase();
    const subject = m.subject || "";
    const text = newestText(m.body?.content || m.bodyPreview || "");
    const dom = domainOf(fromAddress);
    const base = { fromAddress, fromName, replyAddress, subject, text };
    if (OWN_DOMAINS.some((d) => dom.endsWith(d))) {
        return { ...base, source: "ignore", transport: "none", ignoreReason: "internal sender" };
    }
    if (dom.endsWith("tripleseat.com")) {
        if (/sent you a new message|new message from|replied/i.test(subject)) {
            return { ...base, source: "tripleseat_guest_message", transport: "tripleseat_relay" };
        }
        if (/new lead|lead received|lead form/i.test(subject)) {
            return { ...base, source: "tripleseat_new_lead", transport: "tripleseat_relay" };
        }
        return { ...base, source: "ignore", transport: "none", ignoreReason: "Tripleseat system email" };
    }
    if (/(theknot|weddingwire|weddingpro)\./.test(dom)) {
        if (/review/i.test(subject)) {
            return { ...base, source: "ignore", transport: "none", ignoreReason: "review notification" };
        }
        return { ...base, source: "weddingpro", transport: "marketplace_thread" };
    }
    if (dom.includes("zola.com")) {
        return { ...base, source: "zola", transport: "marketplace_thread" };
    }
    if (IGNORE_SENDERS.some((s) => dom.includes(s))) {
        return { ...base, source: "ignore", transport: "none", ignoreReason: `platform notice (${dom})` };
    }
    if (NO_REPLY.test(fromAddress)) {
        return { ...base, source: "ignore", transport: "none", ignoreReason: "no-reply sender" };
    }
    return { ...base, source: "direct", transport: "email_thread" };
}
