"use strict";
/**
 * Live Tripleseat lookups and record-keeping for the inquiry agent.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.findGuest = findGuest;
exports.availability = availability;
exports.createLead = createLead;
exports.logToTripleseat = logToTripleseat;
const tripleseat_js_1 = require("../tripleseat.js");
const config_js_1 = require("./config.js");
function rows(data) {
    if (Array.isArray(data))
        return data;
    return data?.results || data?.leads || data?.events || data?.contacts || [];
}
/** Find what Tripleseat already knows about this guest (by email). */
async function findGuest(email) {
    if (!email)
        return { stage: "new", summary: "No email address on the inquiry." };
    try {
        const ev = rows((await (0, tripleseat_js_1.tripleseatGet)("/events/search", { query: email, order: "event_start", sort_direction: "desc" })).data);
        const booked = ev.find((e) => /definite|closed/i.test(String(e.status || "")));
        if (booked) {
            return {
                stage: "booked",
                eventId: String(booked.id),
                summary: `Booked event: ${booked.name} on ${booked.event_start} (status ${booked.status}).`,
            };
        }
        const leads = rows((await (0, tripleseat_js_1.tripleseatGet)("/leads/search", { query: email, order: "created_at", sort_direction: "desc" })).data);
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
    }
    catch (err) {
        return { stage: "new", summary: `Tripleseat lookup failed: ${err.message.slice(0, 120)}` };
    }
    return { stage: "new", summary: "Not yet in Tripleseat." };
}
/** Availability facts for each requested date (YYYY-MM-DD). */
async function availability(dates) {
    const lines = [];
    for (const d of dates.slice(0, 4)) {
        try {
            const day = (0, tripleseat_js_1.formatDate)(d + "T12:00:00");
            const params = { event_start_date: day, event_end_date: day };
            if (config_js_1.agentConfig.tripleseatLocationId)
                params.location_id = config_js_1.agentConfig.tripleseatLocationId;
            const ev = rows((await (0, tripleseat_js_1.tripleseatGet)("/events/search", params)).data);
            const firm = ev.filter((e) => /definite|closed/i.test(String(e.status || "")));
            const holds = ev.filter((e) => /tentative|prospect/i.test(String(e.status || "")));
            if (firm.length)
                lines.push(`${d}: BOOKED (a confirmed event is on this date). Not available.`);
            else if (holds.length)
                lines.push(`${d}: ON HOLD for another couple. Can offer a second-position (backup) hold or nearby dates.`);
            else
                lines.push(`${d}: OPEN in Tripleseat as of today. Not reserved until a contract and deposit are in.`);
        }
        catch (err) {
            lines.push(`${d}: could not check (${err.message.slice(0, 80)}). Say the team will confirm availability.`);
        }
    }
    return lines.join("\n");
}
/** Create a Tripleseat lead for a marketplace or direct inquiry. */
async function createLead(input) {
    const lead = {
        first_name: input.firstName || "Guest",
        last_name: input.lastName || "(inquiry)",
        email_address: input.email,
        phone_number: input.phone || "",
        event_description: input.description,
        additional_information: input.notes.slice(0, 3000),
        contact_preference: "Email",
    };
    if (input.eventDate)
        lead.event_date = (0, tripleseat_js_1.formatDate)(input.eventDate + "T12:00:00");
    if (input.guestCount)
        lead.guest_count = input.guestCount;
    if (config_js_1.agentConfig.tripleseatLocationId)
        lead.location_id = Number(config_js_1.agentConfig.tripleseatLocationId);
    const { data } = await (0, tripleseat_js_1.tripleseatPost)("/leads", { lead });
    return String(data?.lead?.id || data?.id || "") || undefined;
}
/**
 * Put a copy of a sent reply on the Tripleseat record as a completed-style task, so replies that
 * travel outside a Tripleseat discussion are still on the record.
 */
async function logToTripleseat(rec, body) {
    const siteId = Number(process.env.TRIPLESEAT_SITE_ID || 0);
    const taskTypeId = Number(process.env.TRIPLESEAT_TASK_TYPE_ID || 0);
    const assignees = (process.env.TRIPLESEAT_TASK_ASSIGNEE_IDS || "")
        .split(",")
        .map((s) => Number(s.trim()))
        .filter(Boolean);
    if (!rec.leadId || !siteId || !taskTypeId || !assignees.length)
        return;
    await (0, tripleseat_js_1.tripleseatPost)(`/leads/${rec.leadId}/tasks`, {
        body: body.slice(0, 4000),
        due_date: new Date().toISOString(),
        priority: 1,
        task_type_id: taskTypeId,
        assignee_ids: assignees,
        site_id: siteId,
    });
}
