/**
 * Routes for the inquiry agent.
 *   /agent/cron/poll     – every 5 minutes (Vercel cron)
 *   /agent/cron/digest   – daily
 *   /agent/cron/kb-sync  – hourly
 *   /admin/agent/...     – log, corrections, house rules, voice guide (admin login required)
 */

import { Router, Request, Response, NextFunction } from "express";
import { adminAuth } from "../middleware.js";
import { agentConfig } from "./config.js";
import { migrateAgent, getSetting, setSetting, AgentMessageRow } from "./store.js";
import { runPoll } from "./pipeline.js";
import { sendDigest } from "./digest.js";
import { syncKbFromSheet } from "./kb.js";
import { DEFAULT_VOICE_GUIDE } from "./voice.js";
import { query, queryOne } from "../db.js";

let migrated = false;
async function ensure(): Promise<void> {
  if (!migrated) {
    await migrateAgent();
    migrated = true;
  }
}

function cronAuth(req: Request, res: Response, next: NextFunction): void {
  const ok = agentConfig.cronSecret && req.headers.authorization === `Bearer ${agentConfig.cronSecret}`;
  if (!ok) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

export const agentCronRouter = Router();
agentCronRouter.use(cronAuth);

agentCronRouter.get("/poll", async (_req, res) => {
  try {
    await ensure();
    res.json({ ok: true, mode: agentConfig.mode, result: await runPoll() });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

agentCronRouter.get("/digest", async (_req, res) => {
  try {
    await ensure();
    res.json({ ok: true, ...(await sendDigest()) });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

agentCronRouter.get("/kb-sync", async (_req, res) => {
  try {
    await ensure();
    res.json({ ok: true, ...(await syncKbFromSheet()) });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─────────────────────────── Admin pages ───────────────────────────

export const agentAdminRouter = Router();
agentAdminRouter.use(adminAuth);
agentAdminRouter.use(async (_req, _res, next) => {
  await ensure();
  next();
});

function esc(s: string | null | undefined): string {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function page(title: string, body: string): string {
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
.sent{background:#d9eedf}.escalated{background:#f7e1c8}.error{background:#f4cccc}.drafted{background:#dde7f5}
nav a{margin-right:14px}
</style></head><body><main>
<nav><a href="/admin/agent">Log</a><a href="/admin/agent/settings">House rules &amp; voice</a><a href="/admin/agent/rules">Corrections</a><a href="/admin/dashboard">Admin</a></nav>
<h1>${esc(title)}</h1>${body}</main></body></html>`;
}

agentAdminRouter.get("/", async (req, res) => {
  const filter = String(req.query.action || "");
  const rows = await query<AgentMessageRow>(
    `SELECT * FROM agent_messages WHERE action <> 'duplicate' ${filter ? "AND action = $1" : ""} ORDER BY created_at DESC LIMIT 200`,
    filter ? [filter] : []
  );
  const counts = await query<{ action: string; n: string }>(
    `SELECT action, COUNT(*)::text n FROM agent_messages WHERE created_at > NOW() - INTERVAL '7 days' GROUP BY action`
  );
  const body = `
<p>Mode: <b>${agentConfig.mode}</b> &middot; Last 7 days: ${counts.map((c) => `<a href="?action=${c.action}">${c.action} ${c.n}</a>`).join(" &middot; ")} &middot; <a href="/admin/agent">all</a></p>
<table><tr><th>When (LA)</th><th>Guest</th><th>Source</th><th>Dept / topics</th><th>Action</th><th></th></tr>
${rows
  .map(
    (r) => `<tr>
<td>${new Date(r.created_at).toLocaleString("en-US", { timeZone: agentConfig.timezone })}</td>
<td>${esc(r.guest_name || r.from_address)}<br><span style="color:#777">${esc(r.subject)}</span></td>
<td>${esc(r.source)}</td>
<td>${esc(r.department)}<br><span style="color:#777">${esc((r.topics || []).join(", "))}</span></td>
<td><span class="tag ${esc(r.action)}">${esc(r.action)}</span>${r.corrected_at ? " ✓ corrected" : ""}</td>
<td><a href="/admin/agent/message/${r.id}">open</a></td></tr>`
  )
  .join("")}
</table>`;
  res.type("html").send(page("Inquiry agent", body));
});

agentAdminRouter.get("/message/:id", async (req, res) => {
  const r = await queryOne<AgentMessageRow>(`SELECT * FROM agent_messages WHERE id = $1`, [Number(req.params.id)]);
  if (!r) {
    res.status(404).send("Not found");
    return;
  }
  const body = `
<p><span class="tag ${esc(r.action)}">${esc(r.action)}</span> ${esc(r.source)} &middot; ${esc(r.department)} &middot; ${esc((r.topics || []).join(", "))}
${r.tripleseat_lead_id ? ` &middot; <a href="https://thevillagebigsur.tripleseat.com/leads/${esc(r.tripleseat_lead_id)}" target="_blank">Tripleseat lead</a>` : ""}
${r.tripleseat_event_id ? ` &middot; <a href="https://thevillagebigsur.tripleseat.com/events/${esc(r.tripleseat_event_id)}" target="_blank">Tripleseat event</a>` : ""}</p>
<h3>Guest wrote</h3><p><b>${esc(r.guest_name || r.from_address)}</b> &middot; ${esc(r.subject)}</p><pre>${esc(r.inbound_text)}</pre>
<h3>Agent reply</h3><pre>${esc(r.reply_text) || "(no reply written)"}</pre>
${r.review_notes ? `<p><b>Check notes:</b> ${esc(r.review_notes)}</p>` : ""}
${r.open_questions?.length ? `<p><b>Open questions:</b> ${r.open_questions.map(esc).join("; ")}</p>` : ""}
${r.error ? `<p style="color:#a00"><b>Error:</b> ${esc(r.error)}</p>` : ""}
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

agentAdminRouter.post("/message/:id/correct", async (req, res) => {
  const id = Number(req.params.id);
  const corrected = String(req.body.corrected_reply || "").trim();
  const rule = String(req.body.rule || "").trim();
  const r = await queryOne<AgentMessageRow>(`SELECT * FROM agent_messages WHERE id = $1`, [id]);
  if (!r) {
    res.status(404).send("Not found");
    return;
  }
  await query(`UPDATE agent_messages SET corrected_reply=$2, correction_note=$3, corrected_at=NOW() WHERE id=$1`, [id, corrected, rule]);
  if (rule) {
    await query(
      `INSERT INTO agent_voice_rules (rule, example_before, example_after, source_message_id) VALUES ($1,$2,$3,$4)`,
      [rule, r.reply_text, corrected !== r.reply_text ? corrected : null, id]
    );
  }
  res.redirect(`/admin/agent/message/${id}`);
});

agentAdminRouter.get("/rules", async (_req, res) => {
  const rules = await query<{ id: number; rule: string; active: boolean; created_at: string; source_message_id: number | null }>(
    `SELECT id, rule, active, created_at, source_message_id FROM agent_voice_rules ORDER BY id DESC`
  );
  const body = `<p>Every active correction is added to the agent's instructions on the next reply.</p>
<table><tr><th>#</th><th>Rule</th><th>From</th><th>Active</th></tr>
${rules
  .map(
    (r) => `<tr><td>${r.id}</td><td>${esc(r.rule)}</td><td>${r.source_message_id ? `<a href="/admin/agent/message/${r.source_message_id}">#${r.source_message_id}</a>` : ""}</td>
<td><form method="post" action="/admin/agent/rules/${r.id}/toggle"><button class="btn" type="submit">${r.active ? "On" : "Off"}</button></form></td></tr>`
  )
  .join("")}</table>`;
  res.type("html").send(page("Corrections", body));
});

agentAdminRouter.post("/rules/:id/toggle", async (req, res) => {
  await query(`UPDATE agent_voice_rules SET active = NOT active WHERE id = $1`, [Number(req.params.id)]);
  res.redirect("/admin/agent/rules");
});

agentAdminRouter.get("/settings", async (_req, res) => {
  const house = await getSetting("house_rules", "");
  const voice = await getSetting("voice_guide", "");
  const kb = await queryOne<{ total: string; usable: string; synced: string }>(
    `SELECT COUNT(*)::text total, COUNT(*) FILTER (WHERE usable)::text usable, MAX(synced_at)::text synced FROM agent_kb`
  );
  const body = `
<p>FAQ knowledge base: ${kb?.usable || 0} approved answers of ${kb?.total || 0} questions, last synced ${esc(kb?.synced || "never")}.
<form method="post" action="/admin/agent/settings/sync" style="display:inline"><button class="btn">Sync FAQ sheet now</button></form></p>
<form method="post" action="/admin/agent/settings">
<h3>House rules</h3><p>Internal policy the agent follows (never quoted to guests). Keep unpublished pricing out.</p>
<textarea name="house_rules" rows="18">${esc(house)}</textarea>
<h3>Voice guide</h3><p>Leave blank to use the built-in guide (shown below as a starting point).</p>
<textarea name="voice_guide" rows="18" placeholder="${esc(DEFAULT_VOICE_GUIDE)}">${esc(voice)}</textarea>
<p><button class="btn" type="submit">Save</button></p></form>`;
  res.type("html").send(page("House rules & voice", body));
});

agentAdminRouter.post("/settings", async (req, res) => {
  await setSetting("house_rules", String(req.body.house_rules || ""));
  await setSetting("voice_guide", String(req.body.voice_guide || ""));
  res.redirect("/admin/agent/settings");
});

agentAdminRouter.post("/settings/sync", async (_req, res) => {
  try {
    await syncKbFromSheet();
    res.redirect("/admin/agent/settings");
  } catch (e: any) {
    res.type("html").send(page("Sync failed", `<pre>${esc(e.message)}</pre>`));
  }
});
