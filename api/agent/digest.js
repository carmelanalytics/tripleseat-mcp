"use strict";
/**
 * Daily digest: everything the agent saw and did in the last 24 hours, plus the questions it
 * could not answer (those are the next rows to fill in on the FAQ sheet).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendDigest = sendDigest;
const config_js_1 = require("./config.js");
const graph_js_1 = require("./graph.js");
const db_js_1 = require("../db.js");
function esc(s) {
    return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
async function sendDigest() {
    const rows = await (0, db_js_1.query)(`SELECT * FROM agent_messages WHERE created_at > NOW() - INTERVAL '24 hours' AND action <> 'duplicate' ORDER BY created_at`);
    const by = (a) => rows.filter((r) => r.action === a);
    const waiting = by("awaiting_ts");
    const sent = by("sent"), drafted = by("drafted"), escalated = by("escalated"), errored = by("error"), ignored = by("ignored");
    const base = process.env.PUBLIC_BASE_URL || "";
    const failing = await (0, db_js_1.query)(`
    WITH latest AS (
      SELECT DISTINCT ON (message_id, check_id) message_id, check_id, pass, created_at
      FROM agent_check_results ORDER BY message_id, check_id, attempt DESC
    )
    SELECT check_id, COUNT(*)::int AS n FROM latest
    WHERE NOT pass AND created_at > NOW() - INTERVAL '24 hours' GROUP BY check_id ORDER BY n DESC LIMIT 6`).catch(() => []);
    const toLabel = rows.filter((r) => r.reply_text && !r.owner_labelled_at).length;
    const openQs = rows.flatMap((r) => (r.open_questions || []).map((q) => ({ q, r })));
    const card = (r) => `
<div style="border:1px solid #ddd;border-radius:6px;padding:10px;margin:10px 0">
  <div><b>${esc(r.guest_name || r.from_address)}</b> &middot; ${esc(r.source)} &middot; ${esc(r.department)} &middot; ${esc((r.topics || []).join(", "))}</div>
  <div style="color:#666">${esc(r.subject)}</div>
  <pre style="white-space:pre-wrap;font-family:inherit;background:#f6f6f6;padding:8px">${esc((r.inbound_text || "").slice(0, 1200))}</pre>
  ${r.reply_text ? `<pre style="white-space:pre-wrap;font-family:inherit;background:#eef5ee;padding:8px">${esc(r.reply_text)}</pre>` : ""}
  ${r.review_notes ? `<div style="color:#8a5a00">Notes: ${esc(r.review_notes)}</div>` : ""}
  <a href="${base}/admin/agent/message/${r.id}">Open / correct</a>
</div>`;
    const html = `
<div style="font-family:Arial,sans-serif;max-width:760px">
<h2>Inquiry agent: last 24 hours</h2>
<p>Mode: <b>${config_js_1.agentConfig.mode}</b> &middot; Sent ${sent.length} &middot; Drafted (not sent) ${drafted.length} &middot; Handed to a person ${escalated.length} &middot; Errors ${errored.length} &middot; Waiting for a Tripleseat thread ${waiting.length} &middot; Not inquiries ${ignored.length}</p>
<p>Checks failed most often: ${failing.length ? failing.map((f) => `${esc(f.check_id)} (${f.n})`).join(", ") : "none"}. Replies waiting for your pass/fail labels: ${toLabel} &middot; <a href="${base}/admin/agent/checks">check statistics</a></p>
${openQs.length ? `<h3>Questions the agent could not answer (add these to the FAQ sheet)</h3><ul>${openQs.map((o) => `<li>${esc(o.q)} <span style="color:#666">(${esc(o.r.guest_name || o.r.from_address)})</span></li>`).join("")}</ul>` : ""}
${escalated.length ? `<h3>Handed to a person</h3>${escalated.map(card).join("")}` : ""}
${sent.length ? `<h3>Sent</h3>${sent.map(card).join("")}` : ""}
${drafted.length ? `<h3>Drafted, not sent</h3>${drafted.map(card).join("")}` : ""}
${errored.length ? `<h3>Errors</h3>${errored.map(card).join("")}` : ""}
<p style="color:#666">Full log: <a href="${base}/admin/agent">${base}/admin/agent</a></p>
</div>`;
    await (0, graph_js_1.sendInternal)(config_js_1.agentConfig.sendAs, config_js_1.agentConfig.digestTo, `Inquiry agent digest: ${sent.length} sent, ${escalated.length} for a person`, html, config_js_1.agentConfig.digestCc);
    return { count: rows.length };
}
