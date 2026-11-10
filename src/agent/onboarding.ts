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

import { agentConfig } from "./config.js";
import { getSetting } from "./store.js";
import { query } from "../db.js";

export const DEFAULT_FORM_TEXT =
  "If you can please fill out our events inquiry form, our events team can send over our events packet with info for your date.\n\n{link}\n\nWe look forward to connecting and showing you around the property.";
export const DEFAULT_FORM_TEXT_TOUR =
  "In the meantime, can you fill out our events inquiry form so we can schedule that tour for you? Here is the link:\n\n{link}";

export interface FormSettings {
  link: string;
  text: string;
  textTour: string;
}

export async function formSettings(): Promise<FormSettings> {
  return {
    // A saved blank switches the invitation off; an unset value uses the venue's form.
    link: (await getSetting("inquiry_form_link", agentConfig.inquiryFormLink)).trim(),
    text: (await getSetting("inquiry_form_text", "")).trim() || DEFAULT_FORM_TEXT,
    textTour: (await getSetting("inquiry_form_text_tour", "")).trim() || DEFAULT_FORM_TEXT_TOUR,
  };
}

/** The invitation paragraph for this guest, or "" when no form link is set. */
export function formParagraph(s: FormSettings, guestAskedTour: boolean): string {
  if (!s.link) return "";
  const tpl = guestAskedTour ? s.textTour : s.text;
  return (tpl.includes("{link}") ? tpl.replace(/\{link\}/g, s.link) : `${tpl}\n\n${s.link}`).trim();
}

/** How many sent replies have already invited this guest to the form. */
export async function priorFormInvites(guestEmail: string): Promise<number> {
  if (!guestEmail) return 0;
  const row = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM agent_messages
     WHERE form_invited_at IS NOT NULL AND LOWER(guest_email) = LOWER($1) AND created_at > NOW() - INTERVAL '120 days'`,
    [guestEmail]
  );
  return row[0]?.n || 0;
}

/** A guest's own address, as opposed to a marketplace relay, a Tripleseat address or one of ours. */
export function isGuestAddress(email: string | null | undefined): boolean {
  const e = (email || "").trim().toLowerCase();
  const dom = e.split("@")[1] || "";
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(e)) return false;
  return !/(^|\.)(theknot|weddingwire|weddingpro|zola|tripleseat|tripleseatmail|thevillagebigsur)\./.test(dom);
}

export const ORIGIN_LABEL: Record<string, string> = {
  direct: "Direct email",
  weddingpro: "The Knot / WeddingWire (WeddingPro) inquiry",
  zola: "Zola inquiry",
};

// ─────────────────────────── "How'd you come across us?" ───────────────────────────
// The first reply to an event prospect ends with this question unless we already know how they found
// us. The wording is fixed (editable in settings) and added in code as the last paragraph before the
// sign-off. When the guest answers, the answer is written on their Tripleseat lead.

export const DEFAULT_ORIGIN_TEXT = "One last thing. How'd you come across us? A friend, a scroll, or a detour down Highway 1?";

export async function originQuestionText(): Promise<string> {
  // A saved blank switches the question off.
  return (await getSetting("origin_question_text", DEFAULT_ORIGIN_TEXT)).trim();
}

export const ORIGIN_CATEGORIES = ["friend_or_family", "social_media", "web_search", "the_knot", "weddingwire", "zola", "drove_by", "planner_or_vendor", "past_guest", "press", "other"] as const;

/** The Tripleseat Lead Source each answer maps to (names as they appear in Tripleseat's Lead Source list). */
export const ORIGIN_LEAD_SOURCE: Record<string, string> = {
  friend_or_family: "Referral Client",
  planner_or_vendor: "Referral Industry",
  social_media: "Instagram",
  drove_by: "Walk-in",
  past_guest: "Repeat",
  the_knot: "The Knot",
  weddingwire: "Wedding Wire",
  zola: "Zola",
  web_search: "Other",
  press: "Other",
  other: "Other",
};

/** Has this guest already told us how they found us (on an earlier message)? */
export async function priorOriginAnswer(guestEmail: string): Promise<string> {
  if (!guestEmail) return "";
  const row = await query<{ origin_answer: string }>(
    `SELECT origin_answer FROM agent_messages WHERE origin_answer IS NOT NULL AND LOWER(guest_email) = LOWER($1) ORDER BY id DESC LIMIT 1`,
    [guestEmail]
  );
  return row[0]?.origin_answer || "";
}
