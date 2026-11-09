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

/** Availability facts for each requested date (YYYY-MM-DD). */
export async function availability(dates: string[]): Promise<string> {
  const lines: string[] = [];
  for (const d of dates.slice(0, 4)) {
    try {
      const day = formatDate(d + "T12:00:00");
      const params: Record<string, string> = { event_start_date: day, event_end_date: day };
      if (agentConfig.tripleseatLocationId) params.location_id = agentConfig.tripleseatLocationId;
      const ev = rows((await tripleseatGet("/events/search", params)).data);
      const firm = ev.filter((e: any) => /definite|closed/i.test(String(e.status || "")));
      const holds = ev.filter((e: any) => /tentative|prospect/i.test(String(e.status || "")));
      if (firm.length) lines.push(`${d}: BOOKED (a confirmed event is on this date). Not available.`);
      else if (holds.length) lines.push(`${d}: ON HOLD for another couple. Can offer a second-position (backup) hold or nearby dates.`);
      else lines.push(`${d}: OPEN in Tripleseat as of today. Not reserved until a contract and deposit are in.`);
    } catch (err: any) {
      lines.push(`${d}: could not check (${err.message.slice(0, 80)}). Say the team will confirm availability.`);
    }
  }
  return lines.join("\n");
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
 * Put a copy of a sent reply on the Tripleseat record as a completed-style task, so replies that
 * travel outside a Tripleseat discussion are still on the record.
 */
export async function logToTripleseat(
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
