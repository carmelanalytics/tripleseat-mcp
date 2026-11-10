"use strict";
/**
 * Signed links for the "Would you have sent this unchanged?" question on each copy Patrick receives.
 * The link carries a key derived from the message number, so it can be answered from a phone without
 * signing in to the admin pages, and nobody can answer for a message they were not sent.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.answerKey = answerKey;
exports.answerKeyValid = answerKeyValid;
exports.answerLink = answerLink;
const crypto_1 = __importDefault(require("crypto"));
const config_js_1 = require("./config.js");
function secret() {
    return process.env.AGENT_LINK_SECRET || config_js_1.agentConfig.cronSecret || "";
}
function answerKey(id) {
    const s = secret();
    return s ? crypto_1.default.createHmac("sha256", s).update(`answer:${id}`).digest("hex").slice(0, 32) : "";
}
function answerKeyValid(id, key) {
    const want = answerKey(id);
    if (!want || !key || key.length !== want.length)
        return false;
    return crypto_1.default.timingSafeEqual(Buffer.from(want), Buffer.from(key));
}
/** Link to the answer page, or to the signed-in message page when no link secret is set. */
function answerLink(id, answer) {
    const base = process.env.PUBLIC_BASE_URL || "";
    const k = answerKey(id);
    return k ? `${base}/agent/answer/${id}?k=${k}&a=${answer}` : `${base}/admin/agent/message/${id}`;
}
