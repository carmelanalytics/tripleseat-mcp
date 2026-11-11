"use strict";
/**
 * Knowledge base: approved FAQ answers synced from the FAQ Google Sheet.
 *
 * Only the Question and Answer columns are used. The "Based On" column often holds
 * internal or verbal-only notes and is never read. Rows whose Status is not an approved
 * status are stored as "not usable": the agent will not answer those questions itself and
 * lists them as open questions in the digest instead.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncKbFromSheet = syncKbFromSheet;
exports.parsePastedTable = parsePastedTable;
exports.storeKbRows = storeKbRows;
exports.loadKb = loadKb;
exports.kbPromptBlock = kbPromptBlock;
const node_crypto_1 = __importDefault(require("node:crypto"));
const config_js_1 = require("./config.js");
const db_js_1 = require("../db.js");
const USABLE_STATUSES = [/^answered/i, /^confirmed/i];
async function googleToken() {
    const sa = JSON.parse(config_js_1.agentConfig.googleServiceAccountJson || "{}");
    if (!sa.client_email || !sa.private_key)
        throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON not set");
    const now = Math.floor(Date.now() / 1000);
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = enc({ alg: "RS256", typ: "JWT" }) +
        "." +
        enc({
            iss: sa.client_email,
            scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
            aud: "https://oauth2.googleapis.com/token",
            iat: now,
            exp: now + 3600,
        });
    const sig = node_crypto_1.default.createSign("RSA-SHA256").update(unsigned).sign(sa.private_key, "base64url");
    const r = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion: `${unsigned}.${sig}`,
        }),
    });
    const j = await r.json();
    if (!r.ok)
        throw new Error(`Google token error: ${JSON.stringify(j).slice(0, 200)}`);
    return j.access_token;
}
async function syncKbFromSheet() {
    const { faqSheetId, faqRange } = config_js_1.agentConfig;
    if (!faqSheetId)
        throw new Error("AGENT_FAQ_SHEET_ID not set");
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${faqSheetId}/values/${encodeURIComponent(faqRange)}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${await googleToken()}` } });
    const j = await r.json();
    if (!r.ok)
        throw new Error(`Sheets error: ${JSON.stringify(j).slice(0, 200)}`);
    return storeKbRows((j.values || []));
}
/** Split text copied from a spreadsheet (tab-separated; cells with line breaks are quoted) into rows. */
function parsePastedTable(text) {
    const rows = [];
    let row = [], cell = "", quoted = false;
    const t = text.replace(/\r\n?/g, "\n");
    for (let i = 0; i < t.length; i++) {
        const c = t[i];
        if (quoted) {
            if (c === '"' && t[i + 1] === '"') {
                cell += '"';
                i++;
            }
            else if (c === '"')
                quoted = false;
            else
                cell += c;
        }
        else if (c === '"' && cell === "")
            quoted = true;
        else if (c === "\t") {
            row.push(cell);
            cell = "";
        }
        else if (c === "\n") {
            row.push(cell);
            rows.push(row);
            row = [];
            cell = "";
        }
        else
            cell += c;
    }
    if (cell !== "" || row.length) {
        row.push(cell);
        rows.push(row);
    }
    return rows.filter((r) => r.some((x) => x.trim()));
}
/** Replace the stored FAQ with these rows (first row is the header). */
async function storeKbRows(values) {
    const [header, ...rows] = values;
    if (!header)
        throw new Error("No rows found");
    const col = (name) => header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
    const iDept = col("Department"), iTopic = col("Topic"), iQ = col("Question"), iA = col("Answer"), iS = col("Status");
    if (iQ < 0 || iA < 0)
        throw new Error("FAQ sheet must have Question and Answer columns");
    const clean = rows
        .map((r) => ({
        department: (r[iDept] || "").trim(),
        topic: (r[iTopic] || "").trim(),
        question: (r[iQ] || "").trim(),
        answer: (r[iA] || "").trim(),
        status: (r[iS] || "").trim(),
    }))
        .filter((r) => r.question);
    await (0, db_js_1.query)("BEGIN");
    try {
        await (0, db_js_1.query)("DELETE FROM agent_kb");
        for (const r of clean) {
            const usable = !!r.answer && USABLE_STATUSES.some((re) => re.test(r.status));
            await (0, db_js_1.query)(`INSERT INTO agent_kb (department, topic, question, answer, status, usable) VALUES ($1,$2,$3,$4,$5,$6)`, [r.department, r.topic, r.question, r.answer, r.status, usable]);
        }
        await (0, db_js_1.query)("COMMIT");
    }
    catch (e) {
        await (0, db_js_1.query)("ROLLBACK");
        throw e;
    }
    return { rows: clean.length, usable: clean.filter((r) => r.answer && USABLE_STATUSES.some((re) => re.test(r.status))).length };
}
async function loadKb() {
    return (0, db_js_1.query)(`SELECT id, department, topic, question, answer, status, usable FROM agent_kb ORDER BY id`);
}
/** Compact text block of approved answers for the prompt, plus the list of known-but-unanswered questions. */
function kbPromptBlock(kb) {
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
