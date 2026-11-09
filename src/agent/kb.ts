/**
 * Knowledge base: approved FAQ answers synced from the FAQ Google Sheet.
 *
 * Only the Question and Answer columns are used. The "Based On" column often holds
 * internal or verbal-only notes and is never read. Rows whose Status is not an approved
 * status are stored as "not usable": the agent will not answer those questions itself and
 * lists them as open questions in the digest instead.
 */

import crypto from "node:crypto";
import { agentConfig } from "./config.js";
import { query } from "../db.js";

const USABLE_STATUSES = [/^answered/i, /^confirmed/i];

async function googleToken(): Promise<string> {
  const sa = JSON.parse(agentConfig.googleServiceAccountJson || "{}");
  if (!sa.client_email || !sa.private_key) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON not set");
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: any) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned =
    enc({ alg: "RS256", typ: "JWT" }) +
    "." +
    enc({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    });
  const sig = crypto.createSign("RSA-SHA256").update(unsigned).sign(sa.private_key, "base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${sig}`,
    }),
  });
  const j: any = await r.json();
  if (!r.ok) throw new Error(`Google token error: ${JSON.stringify(j).slice(0, 200)}`);
  return j.access_token;
}

export async function syncKbFromSheet(): Promise<{ rows: number; usable: number }> {
  const { faqSheetId, faqRange } = agentConfig;
  if (!faqSheetId) throw new Error("AGENT_FAQ_SHEET_ID not set");
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${faqSheetId}/values/${encodeURIComponent(faqRange)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${await googleToken()}` } });
  const j: any = await r.json();
  if (!r.ok) throw new Error(`Sheets error: ${JSON.stringify(j).slice(0, 200)}`);
  const [header, ...rows] = (j.values || []) as string[][];
  const col = (name: string) => header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
  const iDept = col("Department"), iTopic = col("Topic"), iQ = col("Question"), iA = col("Answer"), iS = col("Status");
  if (iQ < 0 || iA < 0) throw new Error("FAQ sheet must have Question and Answer columns");

  const clean = rows
    .map((r) => ({
      department: (r[iDept] || "").trim(),
      topic: (r[iTopic] || "").trim(),
      question: (r[iQ] || "").trim(),
      answer: (r[iA] || "").trim(),
      status: (r[iS] || "").trim(),
    }))
    .filter((r) => r.question);

  await query("BEGIN");
  try {
    await query("DELETE FROM agent_kb");
    for (const r of clean) {
      const usable = !!r.answer && USABLE_STATUSES.some((re) => re.test(r.status));
      await query(
        `INSERT INTO agent_kb (department, topic, question, answer, status, usable) VALUES ($1,$2,$3,$4,$5,$6)`,
        [r.department, r.topic, r.question, r.answer, r.status, usable]
      );
    }
    await query("COMMIT");
  } catch (e) {
    await query("ROLLBACK");
    throw e;
  }
  return { rows: clean.length, usable: clean.filter((r) => r.answer && USABLE_STATUSES.some((re) => re.test(r.status))).length };
}

export interface KbRow {
  id: number;
  department: string;
  topic: string;
  question: string;
  answer: string;
  status: string;
  usable: boolean;
}

export async function loadKb(): Promise<KbRow[]> {
  return query<KbRow>(`SELECT id, department, topic, question, answer, status, usable FROM agent_kb ORDER BY id`);
}

/** Compact text block of approved answers for the prompt, plus the list of known-but-unanswered questions. */
export function kbPromptBlock(kb: KbRow[]): { approved: string; unanswered: string } {
  const approved = kb
    .filter((r) => r.usable)
    .map((r) => `[KB${r.id}] (${r.department} / ${r.topic}) Q: ${r.question}\nA: ${r.answer}`)
    .join("\n");
  const unanswered = kb
    .filter((r) => !r.usable)
    .map((r) => `- (${r.department}) ${r.question}`)
    .join("\n");
  return { approved, unanswered };
}
