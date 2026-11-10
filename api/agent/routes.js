"use strict";
/**
 * Routes for the inquiry agent.
 *   /agent/cron/poll     – every 5 minutes (Vercel cron)
 *   /agent/cron/digest   – daily
 *   /agent/cron/kb-sync  – hourly
 *   /admin/agent/...     – log, corrections, house rules, voice guide (admin login required)
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.agentAdminRouter = exports.agentCronRouter = void 0;
const express_1 = __importStar(require("express"));
const middleware_js_1 = require("../middleware.js");
const config_js_1 = require("./config.js");
const store_js_1 = require("./store.js");
const pipeline_js_1 = require("./pipeline.js");
const digest_js_1 = require("./digest.js");
const kb_js_1 = require("./kb.js");
const voice_js_1 = require("./voice.js");
const checks_js_1 = require("./checks.js");
const db_js_1 = require("../db.js");
let migrated = false;
async function ensure() {
    if (!migrated) {
        await (0, store_js_1.migrateAgent)();
        migrated = true;
    }
}
function cronAuth(req, res, next) {
    const ok = config_js_1.agentConfig.cronSecret && req.headers.authorization === `Bearer ${config_js_1.agentConfig.cronSecret}`;
    if (!ok) {
        res.status(401).json({ error: "unauthorized" });
        return;
    }
    next();
}
exports.agentCronRouter = (0, express_1.Router)();
exports.agentCronRouter.use(cronAuth);
exports.agentCronRouter.get("/poll", async (_req, res) => {
    try {
        await ensure();
        res.json({ ok: true, mode: config_js_1.agentConfig.mode, result: await (0, pipeline_js_1.runPoll)() });
    }
    catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});
exports.agentCronRouter.get("/digest", async (_req, res) => {
    try {
        await ensure();
        res.json({ ok: true, ...(await (0, digest_js_1.sendDigest)()) });
    }
    catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});
exports.agentCronRouter.get("/kb-sync", async (_req, res) => {
    try {
        await ensure();
        res.json({ ok: true, ...(await (0, kb_js_1.syncKbFromSheet)()) });
    }
    catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});
// ─────────────────────────── Admin pages ───────────────────────────
exports.agentAdminRouter = (0, express_1.Router)();
exports.agentAdminRouter.use(middleware_js_1.adminAuth);
exports.agentAdminRouter.use(async (_req, _res, next) => {
    await ensure();
    next();
});
function esc(s) {
    return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function page(title, body) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,Arial,sans-serif;margin:0;background:#faf9f6;color:#222}
main{max-width:980px;margin:0 auto;padding:18px}
a{color:#2f5d50}
table{border-collapse:collapse;width:100%;font-size:14px}
th{background:#2f5d50;color:#fff;text-align:left;padding:6px;position:sticky;top:0}
td{border-bottom:1px solid #e3e0d8;padding:6px;vertical-align:top}
pre{white-space:pre-wrap;font-family:inherit;background:#f1efe9;padding:10px;border-radius:6px}
textarea{width:100%;font-family:inherit;font-size:14px;padding:8px}
.btn{background:#2f5d50;color:#fff;border:0;padding:8px 14px;border-radius:6px;cursor:pointer}
.tag{display:inline-block;padding:1px 7px;border-radius:10px;font-size:12px;background:#e8e4da}
.ok{background:#d9eedf}.bad{background:#f4cccc}.note{background:#f7e1c8}
.sent{background:#d9eedf}.escalated{background:#f7e1c8}.error{background:#f4cccc}.drafted{background:#dde7f5}
nav a{margin-right:14px}
</style></head><body><main>
<nav><a href="/admin/agent">Log</a><a href="/admin/agent/checks">Checks</a><a href="/admin/agent/exemplars">Your replies</a><a href="/admin/agent/settings">House rules &amp; voice</a><a href="/admin/agent/rules">Corrections</a><a href="/admin/dashboard">Admin</a></nav>
<h1>${esc(title)}</h1>${body}</main></body></html>`;
}
exports.agentAdminRouter.get("/", async (req, res) => {
    const filter = String(req.query.action || "");
    const rows = await (0, db_js_1.query)(`SELECT * FROM agent_messages WHERE action <> 'duplicate' ${filter ? "AND action = $1" : ""} ORDER BY created_at DESC LIMIT 200`, filter ? [filter] : []);
    const counts = await (0, db_js_1.query)(`SELECT action, COUNT(*)::text n FROM agent_messages WHERE created_at > NOW() - INTERVAL '7 days' GROUP BY action`);
    const body = `
<p>Mode: <b>${config_js_1.agentConfig.mode}</b> &middot; Last 7 days: ${counts.map((c) => `<a href="?action=${c.action}">${c.action} ${c.n}</a>`).join(" &middot; ")} &middot; <a href="/admin/agent">all</a></p>
<table><tr><th>When (LA)</th><th>Guest</th><th>Source</th><th>Dept / topics</th><th>Action</th><th></th></tr>
${rows
        .map((r) => `<tr>
<td>${new Date(r.created_at).toLocaleString("en-US", { timeZone: config_js_1.agentConfig.timezone })}</td>
<td>${esc(r.guest_name || r.from_address)}<br><span style="color:#777">${esc(r.subject)}</span></td>
<td>${esc(r.source)}</td>
<td>${esc(r.department)}<br><span style="color:#777">${esc((r.topics || []).join(", "))}</span></td>
<td><span class="tag ${esc(r.action)}">${esc(r.action)}</span>${r.corrected_at ? " ✓ corrected" : ""}</td>
<td><a href="/admin/agent/message/${r.id}">open</a></td></tr>`)
        .join("")}
</table>`;
    res.type("html").send(page("Inquiry agent", body));
});
exports.agentAdminRouter.get("/message/:id", async (req, res) => {
    const r = await (0, db_js_1.queryOne)(`SELECT * FROM agent_messages WHERE id = $1`, [Number(req.params.id)]);
    if (!r) {
        res.status(404).send("Not found");
        return;
    }
    const results = await (0, db_js_1.query)(`SELECT DISTINCT ON (check_id) check_id, kind, mode, pass, evidence, attempt FROM agent_check_results
     WHERE message_id = $1 ORDER BY check_id, attempt DESC`, [r.id]);
    const labels = await (0, db_js_1.query)(`SELECT check_id, owner_pass FROM agent_check_labels WHERE message_id = $1`, [r.id]);
    const labelOf = new Map(labels.map((l) => [l.check_id, l.owner_pass]));
    const resultOf = new Map(results.map((x) => [x.check_id, x]));
    const checksHtml = results.length
        ? `<h3>Checks</h3>
<p>Each check is a yes or no. Your label is what the right answer was. Leave the agent's verdict selected where you agree, change it where you don't, then save. Your labels are what each check is measured against.</p>
<form method="post" action="/admin/agent/message/${r.id}/label">
<table><tr><th>Check</th><th>Decided by</th><th>Agent verdict</th><th>Evidence</th><th>Your label</th></tr>
${checks_js_1.CHECKS.filter((c) => resultOf.has(c.id))
            .map((c) => {
            const x = resultOf.get(c.id);
            const mine = labelOf.has(c.id) ? labelOf.get(c.id) : x.pass;
            return `<tr><td>${esc(c.label)}${x.mode === "report" ? ' <span class="tag note">noted only</span>' : ""}</td>
<td>${c.kind === "code" ? "rule" : "review model"}</td>
<td><span class="tag ${x.pass ? "ok" : "bad"}">${x.pass ? "pass" : "fail"}</span></td>
<td>${esc(x.evidence)}</td>
<td><select name="label_${c.id}"><option value="pass"${mine ? " selected" : ""}>pass</option><option value="fail"${mine ? "" : " selected"}>fail</option></select>${labelOf.has(c.id) ? " ✓" : ""}</td></tr>`;
        })
            .join("")}
</table>
<p>Would you have sent this reply unchanged?
<label><input type="radio" name="sent_unchanged" value="yes"${r.owner_sent_unchanged === true ? " checked" : ""} required> Yes</label>
<label><input type="radio" name="sent_unchanged" value="no"${r.owner_sent_unchanged === false ? " checked" : ""}> No</label></p>
<p>Anything the checks missed (optional):</p>
<textarea name="critique" rows="2">${esc(r.owner_critique)}</textarea>
<p><button class="btn" type="submit">Save my labels</button>${r.owner_labelled_at ? " Labelled." : ""}
${r.alt_reply_text ? ` &middot; <a href="/admin/agent/message/${r.id}/voice">Blind voice comparison for this reply</a>` : ""}</p>
</form>`
        : "";
    const body = `
<p><span class="tag ${esc(r.action)}">${esc(r.action)}</span> ${esc(r.source)} &middot; ${esc(r.department)} &middot; ${esc((r.topics || []).join(", "))}
${r.tripleseat_lead_id ? ` &middot; <a href="https://thevillagebigsur.tripleseat.com/leads/${esc(r.tripleseat_lead_id)}" target="_blank">Tripleseat lead</a>` : ""}
${r.tripleseat_event_id ? ` &middot; <a href="https://thevillagebigsur.tripleseat.com/events/${esc(r.tripleseat_event_id)}" target="_blank">Tripleseat event</a>` : ""}</p>
<h3>Guest wrote</h3><p><b>${esc(r.guest_name || r.from_address)}</b> &middot; ${esc(r.subject)}</p><pre>${esc(r.inbound_text)}</pre>
<h3>Agent reply</h3><pre>${esc(r.reply_text) || "(no reply written)"}</pre>
${r.review_notes ? `<p><b>Check notes:</b> ${esc(r.review_notes)}</p>` : ""}
${r.open_questions?.length ? `<p><b>Open questions:</b> ${r.open_questions.map(esc).join("; ")}</p>` : ""}
${r.error ? `<p style="color:#a00"><b>Error:</b> ${esc(r.error)}</p>` : ""}
${checksHtml}
<h3>Correct this reply</h3>
<form method="post" action="/admin/agent/message/${r.id}/correct">
<p>How it should have read (edit the reply):</p>
<textarea name="corrected_reply" rows="12">${esc(r.corrected_reply || r.reply_text)}</textarea>
<p>What was wrong, written as a rule the agent should follow from now on (e.g. "Don't mention the River Inn unless asked about lodging"):</p>
<textarea name="rule" rows="3">${esc(r.correction_note)}</textarea>
<p><button class="btn" type="submit">Save correction and teach the agent</button></p>
</form>`;
    res.type("html").send(page(`Message #${r.id}`, body));
});
exports.agentAdminRouter.post("/message/:id/correct", async (req, res) => {
    const id = Number(req.params.id);
    const corrected = String(req.body.corrected_reply || "").trim();
    const rule = String(req.body.rule || "").trim();
    const r = await (0, db_js_1.queryOne)(`SELECT * FROM agent_messages WHERE id = $1`, [id]);
    if (!r) {
        res.status(404).send("Not found");
        return;
    }
    await (0, db_js_1.query)(`UPDATE agent_messages SET corrected_reply=$2, correction_note=$3, corrected_at=NOW() WHERE id=$1`, [id, corrected, rule]);
    if (rule) {
        await (0, db_js_1.query)(`INSERT INTO agent_voice_rules (rule, example_before, example_after, source_message_id) VALUES ($1,$2,$3,$4)`, [rule, r.reply_text, corrected !== r.reply_text ? corrected : null, id]);
    }
    res.redirect(`/admin/agent/message/${id}`);
});
exports.agentAdminRouter.post("/message/:id/label", async (req, res) => {
    const id = Number(req.params.id);
    for (const c of checks_js_1.CHECKS) {
        const v = req.body[`label_${c.id}`];
        if (v !== "pass" && v !== "fail")
            continue;
        await (0, db_js_1.query)(`INSERT INTO agent_check_labels (message_id, check_id, owner_pass) VALUES ($1,$2,$3)
       ON CONFLICT (message_id, check_id) DO UPDATE SET owner_pass = EXCLUDED.owner_pass, created_at = NOW()`, [id, c.id, v === "pass"]);
    }
    const unchanged = req.body.sent_unchanged === "yes" ? true : req.body.sent_unchanged === "no" ? false : null;
    await (0, db_js_1.query)(`UPDATE agent_messages SET owner_sent_unchanged=$2, owner_critique=$3, owner_labelled_at=NOW() WHERE id=$1`, [
        id, unchanged, String(req.body.critique || "").trim() || null,
    ]);
    res.redirect(`/admin/agent/message/${id}`);
});
// Blind voice comparison: the two drafts in an order fixed by the message id, with no sign of which one was kept.
exports.agentAdminRouter.get("/message/:id/voice", async (req, res) => {
    const r = await (0, db_js_1.queryOne)(`SELECT * FROM agent_messages WHERE id = $1`, [Number(req.params.id)]);
    if (!r || !r.alt_reply_text || !r.reply_text) {
        res.status(404).send("No second draft for this message");
        return;
    }
    const keptFirst = r.id % 2 === 0;
    const first = keptFirst ? r.reply_text : r.alt_reply_text;
    const second = keptFirst ? r.alt_reply_text : r.reply_text;
    const body = `
<p>Two drafts answering the same guest. Which one reads more like you wrote it? Judge the voice, not the facts.</p>
<h3>Guest wrote</h3><pre>${esc(r.inbound_text)}</pre>
<form method="post" action="/admin/agent/message/${r.id}/voice">
<h3>Draft 1</h3><pre>${esc(first)}</pre>
<h3>Draft 2</h3><pre>${esc(second)}</pre>
<p><button class="btn" name="pick" value="1" type="submit">Draft 1 sounds more like me</button>
<button class="btn" name="pick" value="2" type="submit">Draft 2 sounds more like me</button></p>
${r.owner_voice_pick ? "<p>You have already judged this pair; picking again replaces your answer.</p>" : ""}
</form>`;
    res.type("html").send(page(`Voice comparison #${r.id}`, body));
});
exports.agentAdminRouter.post("/message/:id/voice", async (req, res) => {
    const id = Number(req.params.id);
    const keptFirst = id % 2 === 0;
    const pickedFirst = String(req.body.pick) === "1";
    await (0, db_js_1.query)(`UPDATE agent_messages SET owner_voice_pick=$2 WHERE id=$1`, [id, pickedFirst === keptFirst ? "kept" : "other"]);
    const next = await (0, db_js_1.queryOne)(`SELECT id FROM agent_messages WHERE alt_reply_text IS NOT NULL AND owner_voice_pick IS NULL ORDER BY id DESC LIMIT 1`);
    res.redirect(next ? `/admin/agent/message/${next.id}/voice` : "/admin/agent/checks");
});
exports.agentAdminRouter.get("/checks", async (_req, res) => {
    const modes = await (0, checks_js_1.checkModes)();
    const stats = await (0, db_js_1.query)(`
    WITH latest AS (
      SELECT DISTINCT ON (message_id, check_id) message_id, check_id, pass
      FROM agent_check_results ORDER BY message_id, check_id, attempt DESC
    )
    SELECT l.check_id,
      COUNT(*)::int AS runs,
      COUNT(*) FILTER (WHERE l.pass)::int AS passes,
      COUNT(lb.owner_pass)::int AS labels,
      COUNT(*) FILTER (WHERE lb.owner_pass IS NOT NULL AND lb.owner_pass = l.pass)::int AS agree,
      COUNT(*) FILTER (WHERE lb.owner_pass = false)::int AS owner_fail,
      COUNT(*) FILTER (WHERE lb.owner_pass = false AND l.pass = false)::int AS caught,
      COUNT(*) FILTER (WHERE lb.owner_pass = true)::int AS owner_ok,
      COUNT(*) FILTER (WHERE lb.owner_pass = true AND l.pass = false)::int AS false_alarm
    FROM latest l LEFT JOIN agent_check_labels lb ON lb.message_id = l.message_id AND lb.check_id = l.check_id
    GROUP BY l.check_id`);
    const by = new Map(stats.map((x) => [x.check_id, x]));
    const head = await (0, db_js_1.queryOne)(`
    SELECT COUNT(*) FILTER (WHERE owner_sent_unchanged IS NOT NULL)::int AS labelled,
           COUNT(*) FILTER (WHERE owner_sent_unchanged)::int AS unchanged,
           COUNT(*) FILTER (WHERE alt_reply_text IS NOT NULL)::int AS pairs,
           COUNT(*) FILTER (WHERE owner_voice_pick IS NOT NULL)::int AS judged,
           COUNT(*) FILTER (WHERE owner_voice_pick = 'kept')::int AS agreed,
           COUNT(*) FILTER (WHERE alt_reply_text IS NOT NULL AND owner_voice_pick IS NULL)::int AS waiting
    FROM agent_messages`);
    const nextPair = await (0, db_js_1.queryOne)(`SELECT id FROM agent_messages WHERE alt_reply_text IS NOT NULL AND owner_voice_pick IS NULL ORDER BY id DESC LIMIT 1`);
    const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "n/a");
    const TARGET = 100;
    const body = `
<p><b>Sent unchanged:</b> ${head?.unchanged || 0} of ${head?.labelled || 0} labelled replies (${pct(head?.unchanged || 0, head?.labelled || 0)}).
<b>Voice comparison:</b> the review model's pick matched yours on ${head?.agreed || 0} of ${head?.judged || 0} pairs (${pct(head?.agreed || 0, head?.judged || 0)}); ${head?.waiting || 0} pairs waiting${nextPair ? ` &middot; <a href="/admin/agent/message/${nextPair.id}/voice">judge the next pair</a>` : ""}.</p>
<p>A check counts as validated once it has ${TARGET} of your labels, agrees with you at least 90% of the time and catches at least 80% of the replies you failed.
"Blocks" means a failure stops the reply; "noted only" means it is logged and shown but does not stop the reply.</p>
<table><tr><th>Check</th><th>Decided by</th><th>Runs</th><th>Passed</th><th>Your labels</th><th>Agrees with you</th><th>Catches your fails</th><th>False alarms</th><th>Status</th><th>On failure</th></tr>
${checks_js_1.CHECKS.map((c) => {
        const x = by.get(c.id);
        const labels = x?.labels || 0;
        const agreeRate = labels ? (x.agree / labels) : 0;
        const catchRate = x?.owner_fail ? x.caught / x.owner_fail : 1;
        const status = labels >= TARGET && agreeRate >= 0.9 && catchRate >= 0.8
            ? '<span class="tag ok">validated</span>'
            : labels >= TARGET
                ? '<span class="tag bad">not reliable yet</span>'
                : `<span class="tag note">${TARGET - labels} more labels</span>`;
        return `<tr><td>${esc(c.label)}</td><td>${c.kind === "code" ? "rule" : "review model"}</td>
<td>${x?.runs || 0}</td><td>${pct(x?.passes || 0, x?.runs || 0)}</td><td>${labels}</td>
<td>${pct(x?.agree || 0, labels)}</td><td>${x?.owner_fail ? `${x.caught} of ${x.owner_fail}` : "n/a"}</td><td>${x?.owner_ok ? `${x.false_alarm} of ${x.owner_ok}` : "n/a"}</td>
<td>${status}</td>
<td><form method="post" action="/admin/agent/checks/${c.id}/mode"><button class="btn" type="submit">${modes[c.id] === "gate" ? "Blocks" : "Noted only"}</button></form></td></tr>`;
    }).join("")}
</table>`;
    res.type("html").send(page("Checks", body));
});
exports.agentAdminRouter.post("/checks/:id/mode", async (req, res) => {
    const modes = await (0, checks_js_1.checkModes)();
    const id = String(req.params.id);
    if (checks_js_1.CHECKS.some((c) => c.id === id)) {
        modes[id] = modes[id] === "gate" ? "report" : "gate";
        await (0, store_js_1.setSetting)("check_modes", JSON.stringify(modes));
    }
    res.redirect("/admin/agent/checks");
});
// Patrick's own replies: the reference for the voice comparison.
exports.agentAdminRouter.get("/exemplars", async (_req, res) => {
    const rows = await (0, db_js_1.query)(`SELECT id, sent_at, event_type, recipient_type, situation_tags, reply_text, active FROM agent_exemplars ORDER BY sent_at DESC NULLS LAST, id DESC LIMIT 500`);
    const body = `
<p>${rows.filter((r) => r.active).length} of ${rows.length} replies in use. With three or more in use, the agent writes two drafts for each reply and keeps the one the review model judges closer to these.</p>
<table><tr><th>Sent</th><th>Type</th><th>Reply</th><th>In use</th></tr>
${rows
        .map((r) => `<tr><td>${r.sent_at ? new Date(r.sent_at).toLocaleDateString("en-US", { timeZone: config_js_1.agentConfig.timezone }) : ""}</td>
<td>${esc(r.event_type)}<br><span style="color:#777">${esc((r.situation_tags || []).join(", "))}</span></td>
<td><pre>${esc(r.reply_text)}</pre></td>
<td><form method="post" action="/admin/agent/exemplars/${r.id}/toggle"><button class="btn" type="submit">${r.active ? "Yes" : "No"}</button></form></td></tr>`)
        .join("")}
</table>
<h3>Add replies</h3>
<p>Paste a JSON list. Each item needs reply_text; inquiry_text, sent_utc, event_type, recipient_type, situation_tags and internetMessageId are optional.</p>
<form method="post" action="/admin/agent/exemplars/import"><textarea name="json" rows="8"></textarea>
<p><button class="btn" type="submit">Add</button></p></form>`;
    res.type("html").send(page("Your replies", body));
});
exports.agentAdminRouter.post("/exemplars/import", express_1.default.urlencoded({ extended: true, limit: "4mb" }), async (req, res) => {
    try {
        const items = JSON.parse(String(req.body.json || "[]"));
        if (!Array.isArray(items))
            throw new Error("Expected a JSON list");
        let added = 0;
        for (const it of items) {
            const reply = String(it.reply_text || "").trim();
            if (!reply)
                continue;
            const out = await (0, db_js_1.query)(`INSERT INTO agent_exemplars (source, source_ref, sent_at, recipient_type, event_type, situation_tags, inquiry_text, reply_text)
         VALUES ('outlook', $1, $2, $3, $4, $5, $6, $7) ON CONFLICT (source, source_ref) DO NOTHING RETURNING id`, [
                String(it.internetMessageId || it.id || `${reply.slice(0, 60)}:${reply.length}`),
                it.sent_utc || null, it.recipient_type || null, it.event_type || null,
                Array.isArray(it.situation_tags) ? it.situation_tags.map(String) : [],
                it.inquiry_text ? String(it.inquiry_text) : null, reply,
            ]);
            added += out.length;
        }
        res.type("html").send(page("Replies added", `<p>${added} added (${items.length - added} skipped as empty or already present).</p><p><a href="/admin/agent/exemplars">Back</a></p>`));
    }
    catch (e) {
        res.type("html").send(page("Could not add", `<pre>${esc(e.message)}</pre>`));
    }
});
exports.agentAdminRouter.post("/exemplars/:id/toggle", async (req, res) => {
    await (0, db_js_1.query)(`UPDATE agent_exemplars SET active = NOT active WHERE id = $1`, [Number(req.params.id)]);
    res.redirect("/admin/agent/exemplars");
});
exports.agentAdminRouter.get("/rules", async (_req, res) => {
    const rules = await (0, db_js_1.query)(`SELECT id, rule, active, created_at, source_message_id FROM agent_voice_rules ORDER BY id DESC`);
    const body = `<p>Every active correction is added to the agent's instructions on the next reply.</p>
<table><tr><th>#</th><th>Rule</th><th>From</th><th>Active</th></tr>
${rules
        .map((r) => `<tr><td>${r.id}</td><td>${esc(r.rule)}</td><td>${r.source_message_id ? `<a href="/admin/agent/message/${r.source_message_id}">#${r.source_message_id}</a>` : ""}</td>
<td><form method="post" action="/admin/agent/rules/${r.id}/toggle"><button class="btn" type="submit">${r.active ? "On" : "Off"}</button></form></td></tr>`)
        .join("")}</table>`;
    res.type("html").send(page("Corrections", body));
});
exports.agentAdminRouter.post("/rules/:id/toggle", async (req, res) => {
    await (0, db_js_1.query)(`UPDATE agent_voice_rules SET active = NOT active WHERE id = $1`, [Number(req.params.id)]);
    res.redirect("/admin/agent/rules");
});
exports.agentAdminRouter.get("/settings", async (_req, res) => {
    const house = await (0, store_js_1.getSetting)("house_rules", "");
    const voice = await (0, store_js_1.getSetting)("voice_guide", "");
    const tourLink = await (0, store_js_1.getSetting)("tour_link", "");
    const minWords = await (0, store_js_1.getSetting)("reply_min_words", "20");
    const maxWords = await (0, store_js_1.getSetting)("reply_max_words", "200");
    const pairwise = await (0, store_js_1.getSetting)("voice_pairwise", "on");
    const kb = await (0, db_js_1.queryOne)(`SELECT COUNT(*)::text total, COUNT(*) FILTER (WHERE usable)::text usable, MAX(synced_at)::text synced FROM agent_kb`);
    const body = `
<p>FAQ knowledge base: ${kb?.usable || 0} approved answers of ${kb?.total || 0} questions, last synced ${esc(kb?.synced || "never")}.
<form method="post" action="/admin/agent/settings/sync" style="display:inline"><button class="btn">Sync FAQ sheet now</button></form></p>
<form method="post" action="/admin/agent/settings">
<h3>House rules</h3><p>Internal policy the agent follows (never quoted to guests). Keep unpublished pricing out.</p>
<textarea name="house_rules" rows="18">${esc(house)}</textarea>
<h3>Reply structure</h3>
<p>Tour scheduling link for the P.S. (leave blank to invite guests to send a day and time):<br>
<input name="tour_link" style="width:100%;padding:8px" value="${esc(tourLink)}"></p>
<p>Body length in words: from <input name="reply_min_words" size="4" value="${esc(minWords)}"> to <input name="reply_max_words" size="4" value="${esc(maxWords)}">
&middot; Two drafts with voice comparison: <select name="voice_pairwise"><option value="on"${pairwise === "on" ? " selected" : ""}>on</option><option value="off"${pairwise === "off" ? " selected" : ""}>off</option></select></p>
<h3>Voice guide</h3><p>Leave blank to use the built-in guide (shown below as a starting point).</p>
<textarea name="voice_guide" rows="18" placeholder="${esc(voice_js_1.DEFAULT_VOICE_GUIDE)}">${esc(voice)}</textarea>
<p><button class="btn" type="submit">Save</button></p></form>`;
    res.type("html").send(page("House rules & voice", body));
});
exports.agentAdminRouter.post("/settings", async (req, res) => {
    await (0, store_js_1.setSetting)("house_rules", String(req.body.house_rules || ""));
    await (0, store_js_1.setSetting)("voice_guide", String(req.body.voice_guide || ""));
    await (0, store_js_1.setSetting)("tour_link", String(req.body.tour_link || "").trim());
    await (0, store_js_1.setSetting)("reply_min_words", String(Number(req.body.reply_min_words) || 20));
    await (0, store_js_1.setSetting)("reply_max_words", String(Number(req.body.reply_max_words) || 200));
    await (0, store_js_1.setSetting)("voice_pairwise", req.body.voice_pairwise === "off" ? "off" : "on");
    res.redirect("/admin/agent/settings");
});
exports.agentAdminRouter.post("/settings/sync", async (_req, res) => {
    try {
        await (0, kb_js_1.syncKbFromSheet)();
        res.redirect("/admin/agent/settings");
    }
    catch (e) {
        res.type("html").send(page("Sync failed", `<pre>${esc(e.message)}</pre>`));
    }
});
