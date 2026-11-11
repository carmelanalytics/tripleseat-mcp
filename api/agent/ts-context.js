"use strict";
/**
 * Live Tripleseat lookups and record-keeping for the inquiry agent.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.findGuest = findGuest;
exports.idsFromTripleseatEmail = idsFromTripleseatEmail;
exports.guestFromIds = guestFromIds;
exports.longDate = longDate;
exports.dateFacts = dateFacts;
exports.createLead = createLead;
exports.followUpTask = followUpTask;
exports.originNote = originNote;
exports.tagOrigin = tagOrigin;
const tripleseat_js_1 = require("../tripleseat.js");
const config_js_1 = require("./config.js");
function rows(data) {
    if (Array.isArray(data))
        return data;
    return data?.results || data?.leads || data?.events || data?.contacts || [];
}
/** A lead source or referral already on the Tripleseat lead that says how the guest found us. */
function knownOrigin(l) {
    const names = [l?.lead_source?.name, ...(l?.lead_sources || []).map((x) => x?.name)].filter(Boolean);
    const real = names.find((n) => !/tripleseat web lead|direct book/i.test(n));
    return real || String(l?.referral_source_other || "").trim() || (l?.referral_source_id ? "referral recorded" : "") || undefined;
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
                origin: knownOrigin(l),
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
/** Tripleseat notification emails link to the record; pull the lead or event id out of the body. */
function idsFromTripleseatEmail(body) {
    const lead = body.match(/tripleseat\.com\/leads\/(\d+)/i);
    const ev = body.match(/tripleseat\.com\/(?:events|bookings)\/(\d+)/i);
    return { leadId: lead?.[1], eventId: ev?.[1] };
}
async function guestFromIds(ids) {
    try {
        if (ids.eventId) {
            const { data } = await (0, tripleseat_js_1.tripleseatGet)(`/events/${ids.eventId}`);
            const e = data?.event || data;
            const booked = /definite|closed/i.test(String(e?.status || ""));
            return { stage: booked ? "booked" : "lead", eventId: ids.eventId, summary: `Event: ${e?.name} on ${e?.event_start} (status ${e?.status}).` };
        }
        if (ids.leadId) {
            const { data } = await (0, tripleseat_js_1.tripleseatGet)(`/leads/${ids.leadId}`);
            const l = data?.lead || data;
            return { stage: "lead", leadId: ids.leadId, origin: knownOrigin(l), summary: `Lead #${ids.leadId}: ${l?.first_name || ""} ${l?.last_name || ""}, event date ${l?.event_date || "not set"}, guests ${l?.guest_count || "not set"}.` };
        }
    }
    catch {
        /* fall through */
    }
    return null;
}
async function dayStatus(d) {
    try {
        const day = (0, tripleseat_js_1.formatDate)(d + "T12:00:00");
        const params = { event_start_date: day, event_end_date: day };
        if (config_js_1.agentConfig.tripleseatLocationId)
            params.location_id = config_js_1.agentConfig.tripleseatLocationId;
        const ev = rows((await (0, tripleseat_js_1.tripleseatGet)("/events/search", params)).data);
        if (ev.some((e) => /definite|closed/i.test(String(e.status || ""))))
            return "booked";
        if (ev.some((e) => /tentative|prospect/i.test(String(e.status || ""))))
            return "hold";
        return "open";
    }
    catch {
        return "unknown";
    }
}
function shiftDate(d, days) {
    const t = new Date(d + "T12:00:00Z");
    t.setUTCDate(t.getUTCDate() + days);
    return t.toISOString().slice(0, 10);
}
/** "Saturday, October 3, 2026" */
function longDate(d) {
    return new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(d + "T12:00:00Z"));
}
/**
 * Availability for the requested dates (YYYY-MM-DD). When every requested date is taken, looks for
 * the two nearest open dates: the same weekday in the weeks either side first, then adjacent days.
 */
async function dateFacts(dates, today) {
    const asked = dates.slice(0, 4);
    if (!asked.length)
        return { text: "", state: "none", alternatives: [] };
    const lines = [];
    const statuses = [];
    for (const d of asked) {
        const st = await dayStatus(d);
        statuses.push(st);
        if (st === "booked")
            lines.push(`${d} (${longDate(d)}): BOOKED (a confirmed event is on this date). Not available.`);
        else if (st === "hold")
            lines.push(`${d} (${longDate(d)}): ON HOLD for another couple. Can offer a second-position (backup) hold or nearby dates.`);
        else if (st === "open")
            lines.push(`${d} (${longDate(d)}): OPEN in Tripleseat as of today. Not reserved until a contract and deposit are in.`);
        else
            lines.push(`${d} (${longDate(d)}): could not be checked. Say the team will confirm availability.`);
    }
    if (statuses.includes("open"))
        return { text: lines.join("\n"), state: "open", alternatives: [] };
    if (statuses.every((s) => s === "unknown"))
        return { text: lines.join("\n"), state: "unknown", alternatives: [] };
    const alternatives = [];
    let lookups = 0;
    for (const off of [7, -7, 14, -14, 1, -1, 21, -21, 2, -2]) {
        if (alternatives.length >= 2 || lookups >= 8)
            break;
        const cand = shiftDate(asked[0], off);
        if (cand <= today || asked.includes(cand))
            continue;
        lookups++;
        if ((await dayStatus(cand)) === "open")
            alternatives.push(cand);
    }
    alternatives.sort();
    lines.push(alternatives.length
        ? `Open alternatives near ${asked[0]}: ${alternatives.map((d) => `${d} (${longDate(d)})`).join("; ")}. Open in Tripleseat as of today.`
        : `No open alternative was found near ${asked[0]}. Say the team will send the closest open dates.`);
    return { text: lines.join("\n"), state: "taken", alternatives };
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
 * When a reply tells a guest that the team will confirm something, put a task on the Tripleseat lead
 * so the promise has an owner.
 */
async function followUpTask(rec, body) {
    const siteId = Number(process.env.TRIPLESEAT_SITE_ID || 12601);
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
/**
 * Write where an inquiry began on its Tripleseat lead ("ORIGIN: ..."). Tripleseat has accepted more
 * than one field name for a note's text, so try each in turn.
 */
async function originNote(leadId, text) {
    const shapes = [{ note: { body: text } }, { note: { content: text } }, { note: { note: text } }];
    let lastErr;
    for (const body of shapes) {
        try {
            await (0, tripleseat_js_1.tripleseatPost)(`/leads/${leadId}/notes`, body);
            return;
        }
        catch (e) {
            lastErr = e;
        }
    }
    throw lastErr;
}
let leadSourceCache = null;
/** Tripleseat's Lead Source ids by name, read from the site record and kept for an hour. */
async function leadSourceIds() {
    if (leadSourceCache && Date.now() - leadSourceCache.at < 3600_000)
        return leadSourceCache.byName;
    const byName = new Map();
    const walk = (node, key = "") => {
        if (Array.isArray(node)) {
            if (/lead_source/i.test(key))
                for (const x of node)
                    if (x && x.id && x.name)
                        byName.set(String(x.name).toLowerCase(), Number(x.id));
            for (const x of node)
                walk(x, key);
        }
        else if (node && typeof node === "object") {
            for (const [k, v] of Object.entries(node))
                walk(v, k);
        }
    };
    try {
        walk((await (0, tripleseat_js_1.tripleseatGet)("/sites")).data);
    }
    catch {
        /* the note below still records the answer */
    }
    leadSourceCache = { at: Date.now(), byName };
    return byName;
}
/**
 * Tag a lead with how the guest found us: always an "ORIGIN:" note in the guest's own words, and the
 * Lead Source drop-down when Tripleseat has a source by that name. Returns what was done.
 */
async function tagOrigin(leadId, answer, sourceName) {
    await originNote(leadId, `ORIGIN: the guest says they found us through: "${answer.slice(0, 300)}". Lead source: ${sourceName}.`);
    const id = (await leadSourceIds()).get(sourceName.toLowerCase());
    if (!id)
        return `note written; Lead Source "${sourceName}" not set (no id found for it)`;
    try {
        await (0, tripleseat_js_1.tripleseatPut)(`/leads/${leadId}`, { lead: { lead_source_id: id, selected_lead_sources_attributes: [{ lead_source_id: id }] } });
        return `note written; Lead Source set to ${sourceName}`;
    }
    catch (e) {
        return `note written; Lead Source not set (${String(e.message).slice(0, 120)})`;
    }
}
