/**
 * Signed links for the "Would you have sent this unchanged?" question on each copy Patrick receives.
 * The link carries a key derived from the message number, so it can be answered from a phone without
 * signing in to the admin pages, and nobody can answer for a message they were not sent.
 */

import crypto from "crypto";
import { agentConfig } from "./config.js";

function secret(): string {
  return process.env.AGENT_LINK_SECRET || agentConfig.cronSecret || "";
}

export function answerKey(id: number): string {
  const s = secret();
  return s ? crypto.createHmac("sha256", s).update(`answer:${id}`).digest("hex").slice(0, 32) : "";
}

export function answerKeyValid(id: number, key: string): boolean {
  const want = answerKey(id);
  if (!want || !key || key.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(key));
}

/** Where this deployment is reached from an email link. */
export function baseUrl(): string {
  const set = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  if (set) return set;
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL || "";
  return vercel ? `https://${vercel}` : "";
}

/** Link to the answer page, or to the signed-in message page when no link secret is set. */
export function answerLink(id: number, answer: "yes" | "no"): string {
  const base = baseUrl();
  const k = answerKey(id);
  return k ? `${base}/agent/answer/${id}?k=${k}&a=${answer}` : `${base}/admin/agent/message/${id}`;
}
