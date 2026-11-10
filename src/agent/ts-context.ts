/**
 * Live Tripleseat lookups and record-keeping for the inquiry agent.
 */

import { tripleseatGet, tripleseatPost, formatDate } from "../tripleseat.js";
import { agentConfig } from "./config.js";

function rows(data: any): any[] {
  if (Array.isArray(data)) return data;
  return data?.results || data?.leads || data?.events || data?.contacts || [];
}

export interface GuestRecord {
  stage: "new" | "lead" | "booked";
  leadId?: string;
  eventId?: string;
  summary: string;
}

/** Find what Tripleseat already knows about this guest (by email). */
export async function findGuest(email: string): Promise<GuestRecord> {
  if (!email) return { stage: "new", summary: "No email address on the inquiry." };
  try {
    const ev = rows((await tripleseatGet("/events/search", { query: email, order: "event_start", sort_direction: "desc" })).data);
    const booked = ev.find((e: any) => /definite|closed/i.test(String(e.status || "")));
    if (booked) {
      return {
        stage: "booked",
        eventId: String(booked.id),
        summary: `Booked event: ${booked.name} on ${booked.event_start} (status ${booked.status}).`,
      };
    }
    const leads = rows((await tripleseatGet("/leads/search", { query: email, order: "created_at", sort_direction: "desc" })).data);
    if (leads.length) {
      const l = leads[0];
      return {
        stage: "lead",
        leadId: String(l.id),
        summary: `Existing lead #${l.id}: ${l.first_name || ""} ${l.last_name || ""}, event date ${l.event_date || "not set"}, guests ${l.guest_count || "not set"}, status ${l.status || "open"}.`,
      };
    }
    if (ev.length) {
      const e = ev[0];
      return {
        stage: "lead",
        eventId: String(e.id),
        summary: `Tentative/prospect event: ${e.name} on ${e.event_start} (status ${e.status}).`,
      };
    }
  } catch (err: any) {
    return { stage: "new", summary: `Tripleseat lookup failed: ${err.message.slice(0, 120)}` };
  }
  return { stage: "new", summary: "Not yet in Tripleseat." };
}

/** Tripleseat notification emails link to the record; pull the lead or event id out of the body. */
export function idsFromTripleseatEmail(body: string): { leadId?: string; eventId?: string } {
  const lead = body.match(/tripleseat\.com\/leads\/(\d+)/i);
  const ev = body.match(/tripleseat\.com\/(?:events|bookings)\/(\d+)/i);
  return { leadId: lead?.[1], eventId: ev?.[1] };
}

export async function guestFromIds(ids: { leadId?: string; eventId?: string }): Promise<GuestRecord | null> {
  try {
    if (ids.eventId) {
      const { data } = await tripleseatGet(`/events/${ids.eventId}`);
      const e: any = (data as any)?.event || data;
      const booked = /definite|closed/i.test(String(e?.status || ""));
      return { stage: booked ? "booked" : "lead", eventId: ids.eventId, summary: `Event: ${e?.name} on ${e?.event_start} (status ${e?.status}).` };
    }
    if (ids.leadId) {
      const { data } = await tripleseatGet(`/leads/${ids.leadId}`);
      const l: any = (data as any)?.lead || data;
      return { stage: "lead", leadId: ids.leadId, summary: `Lead #${ids.leadId}: ${l?.first_name || ""} ${l?.last_name || ""}, event date ${l?.event_date || "not set"}, guests ${l?.guest_count || "not set"}.` };
    }
  } catch {
    /* fall through */
  }
  return null;
}

export type DateState = "open" | "taken" | "none" | "unknown";
type DayStatus = "open" | "hold" | "booked" | "unknown";

async function dayStatus(d: string): Promise<DayStatus> {
  try {
    const day = formatDate(d + "T12:00:00");
    const params: Record<string, string> = { event_start_date: day, event_end_date: day };
    if (agentConfig.tripleseatLocationId) params.location_id = agentConfig.tripleseatLocationId;
    const ev = rows((await tripleseatGet("/events/search", params)).data);
    if (ev.some((e: any) => /definite|closed/i.test(String(e.status || "")))) return "booked";
    if (ev.some((e: any) => /tentative|prospect/i.test(String(e.status || "")))) return "hold";
    return "open";
  } catch {
    return "unknown";
  }
}

function shiftDate(d: string, days: number): string {
  const t = new Date(d + "T12:00:00Z");
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

/** "Saturday, October 3, 2026" */
export function longDate(d: string): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(
    new Date(d + "T12:00:00Z")
  );
}

export interface DateFacts {
  /** Lines for the prompt and the checks: the only availability facts a reply may state. */
  text: string;
  /** open = at least one requested date is open; taken = every requested date is booked or on hold. */
  state: DateState;
  /** Up to two open dates near the first requested date (only when state is "taken"). */
  alternatives: string[];
}

/**
 * Availability for the requested dates (YYYY-MM-DD). When every requested date is taken, looks for
 * the two nearest open dates: the same weekday in the weeks either side first, then adjacent days.
 */
export async function dateFacts(dates: string[], today: string): Promise<DateFacts> {
  const asked = dates.slice(0, 4);
  if (!asked.length) return { text: "", state: "none", alternatives: [] };

  const lines: string[] = [];
  const statuses: DayStatus[] = [];
  for (const d of asked) {
    const st = await dayStatus(d);
    statuses.push(st);
    if (st === "booked") lines.push(`${d} (${longDate(d)}): BOOKED (a confirmed event is on this date). Not available.`);
    else if (st === "hold") lines.push(`${d} (${longDate(d)}): ON HOLD for another couple. Can offer a second-position (backup) hold or nearby dates.`);
    else if (st === "open") lines.push(`${d} (${longDate(d)}): OPEN in Tripleseat as of today. Not reserved until a contract and deposit are in.`);
    else lines.push(`${d} (${longDate(d)}): could not be checked. Say the team will confirm availability.`);
  }

  if (statuses.includes("open")) return { text: lines.join("\n"), state: "open", alternatives: [] };
  if (statuses.every((s) => s === "unknown")) return { text: lines.join("\n"), state: "unknown", alternatives: [] };

  const alternatives: string[] = [];
  let lookups = 0;
  for (const off of [7, -7, 14, -14, 1, -1, 21, -21, 2, -2]) {
    if (alternatives.length >= 2 || lookups >= 8) break;
    const cand = shiftDate(asked[0], off);
    if (cand <= today || asked.includes(cand)) continue;
    lookups++;
    if ((await dayStatus(cand)) === "open") alternatives.push(cand);
  }
  alternatives.sort();
  lines.push(
    alternatives.length
      ? `Open alternatives near ${asked[0]}: ${alternatives.map((d) => `${d} (${longDate(d)})`).join("; ")}. Open in Tripleseat as of today.`
      : `No open alternative was found near ${asked[0]}. Say the team will send the closest open dates.`
  );
  return { text: lines.join("\n"), state: "taken", alternatives };
}

/** Create a Tripleseat lead for a marketplace or direct inquiry. */
export async function createLead(input: {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  eventDate?: string;
  guestCount?: number;
  description: string;
  notes: string;
}): Promise<string | undefined> {
  const lead: Record<string, any> = {
    first_name: input.firstName || "Guest",
    last_name: input.lastName || "(inquiry)",
    email_address: input.email,
    phone_number: input.phone || "",
    event_description: input.description,
    additional_information: input.notes.slice(0, 3000),
    contact_preference: "Email",
  };
  if (input.eventDate) lead.event_date = formatDate(input.eventDate + "T12:00:00");
  if (input.guestCount) lead.guest_count = input.guestCount;
  if (agentConfig.tripleseatLocationId) lead.location_id = Number(agentConfig.tripleseatLocationId);
  const { data } = await tripleseatPost("/leads", { lead });
  return String((data as any)?.lead?.id || (data as any)?.id || "") || undefined;
}

/**
 * When a reply tells a guest that the team will confirm something, put a task on the Tripleseat lead
 * so the promise has an owner.
 */
export async function followUpTask(
  rec: { leadId?: string; eventId?: string },
  body: string
): Promise<void> {
  const siteId = Number(process.env.TRIPLESEAT_SITE_ID || 0);
  const taskTypeId = Number(process.env.TRIPLESEAT_TASK_TYPE_ID || 0);
  const assignees = (process.env.TRIPLESEAT_TASK_ASSIGNEE_IDS || "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter(Boolean);
  if (!rec.leadId || !siteId || !taskTypeId || !assignees.length) return;
  await tripleseatPost(`/leads/${rec.leadId}/tasks`, {
    body: body.slice(0, 4000),
    due_date: new Date().toISOString(),
    priority: 1,
    task_type_id: taskTypeId,
    assignee_ids: assignees,
    site_id: siteId,
  });
}

/**
 * Write where an inquiry began on its Tripleseat lead ("ORIGIN: ..."). Tripleseat has accepted more
 * than one field name for a note's text, so try each in turn.
 */
export async function originNote(leadId: string, text: string): Promise<void> {
  const shapes = [{ note: { body: text } }, { note: { content: text } }, { note: { note: text } }];
  let lastErr: any;
  for (const body of shapes) {
    try {
      await tripleseatPost(`/leads/${leadId}/notes`, body);
      return;
    } catch (e: any) {
      lastErr = e;
    }
  }
  throw lastErr;
}
