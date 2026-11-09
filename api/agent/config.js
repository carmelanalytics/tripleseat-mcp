"use strict";
/**
 * Inquiry agent configuration.
 *
 * AGENT_MODE controls what the agent is allowed to do:
 *   off     – nothing runs
 *   shadow  – reads inquiries, writes replies, logs them and puts them in the
 *             digest, but sends nothing to guests (use while the send path is verified)
 *   live    – sends replies automatically
 *
 * Business facts, house rules and FAQ answers are NOT kept in this repository.
 * They live in the database (agent_kb, agent_settings) and are loaded at run time.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.agentConfig = void 0;
exports.agentEnabled = agentEnabled;
function env(name, fallback = "") {
    return (process.env[name] ?? fallback).trim();
}
function list(name, fallback) {
    return env(name, fallback)
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
}
exports.agentConfig = {
    mode: env("AGENT_MODE", "shadow"),
    // Claude API
    anthropicKey: env("ANTHROPIC_API_KEY"),
    model: env("AGENT_MODEL", "claude-sonnet-5-5"),
    reviewModel: env("AGENT_REVIEW_MODEL", "claude-opus-5-5"),
    // Microsoft Graph (app registration with Mail.ReadWrite + Mail.Send, application permissions,
    // restricted by an Exchange application access policy to the mailboxes below)
    msTenant: env("MS_TENANT_ID"),
    msClientId: env("MS_CLIENT_ID"),
    msClientSecret: env("MS_CLIENT_SECRET"),
    // Mailboxes the agent watches
    mailboxes: list("AGENT_MAILBOXES", "events@thevillagebigsur.com,patrick@thevillagebigsur.com,info@thevillagebigsur.com"),
    // Who gets the reply copy, the digest and escalations
    ccOnEveryReply: env("AGENT_CC", "events@thevillagebigsur.com"),
    digestTo: list("AGENT_DIGEST_TO", "patrick@thevillagebigsur.com,events@thevillagebigsur.com"),
    digestCc: list("AGENT_DIGEST_CC", "accounting@thevillagebigsur.com"),
    escalateTo: list("AGENT_ESCALATE_TO", "events@thevillagebigsur.com,patrick@thevillagebigsur.com"),
    sendAs: env("AGENT_SEND_AS", "events@thevillagebigsur.com"),
    // Google Sheet that holds the FAQ (shared with the service account, read-only)
    faqSheetId: env("AGENT_FAQ_SHEET_ID"),
    faqRange: env("AGENT_FAQ_RANGE", "FAQ!A1:G400"),
    googleServiceAccountJson: env("GOOGLE_SERVICE_ACCOUNT_JSON"),
    // Tripleseat
    tripleseatLocationId: env("TRIPLESEAT_LOCATION_ID"),
    // Cron shared secret (Vercel sends Authorization: Bearer <CRON_SECRET>)
    cronSecret: env("CRON_SECRET"),
    // Safety limits
    maxRepliesPerThreadPerDay: Number(env("AGENT_MAX_REPLIES_PER_THREAD_PER_DAY", "3")),
    maxSendsPerRun: Number(env("AGENT_MAX_SENDS_PER_RUN", "25")),
    timezone: "America/Los_Angeles",
};
function agentEnabled() {
    return exports.agentConfig.mode !== "off";
}
