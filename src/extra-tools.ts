/**
 * Extra tools for The Village, Big Sur (added 2026-11-09).
 *
 * Covers work that previously needed the Tripleseat web app in a browser:
 *  - Lead origin tracking (lead sources + "ORIGIN:" notes)
 *  - Notes on leads, events, bookings, contacts and accounts
 *  - Billing line items on event documents (discounts, service charge, etc.)
 *  - Event and account tasks
 *  - Payment and refund reports (read-only) for reconciliation
 *  - A guarded raw request for documented endpoints the named tools don't cover
 *
 * Tripleseat's public API has no endpoint to create or edit payments or to add
 * menu/rental line items, so those stay in the web app.
 */

import { tripleseatGet, tripleseatRequest } from "./tripleseat.js";

const RECORD_TYPES = ["lead", "event", "booking", "contact", "account"] as const;
type RecordType = (typeof RECORD_TYPES)[number];

const RECORD_PATH: Record<RecordType, string> = {
  lead: "leads",
  event: "events",
  booking: "bookings",
  contact: "contacts",
  account: "accounts",
};

export const EXTRA_TOOL_NAMES = [
  "list_lead_sources",
  "set_lead_source",
  "list_notes",
  "add_note",
  "update_note",
  "delete_note",
  "update_billing_amount",
  "create_event_task",
  "create_account_task",
  "payment_transaction_report",
  "payment_refund_report",
  "tripleseat_api_request",
] as const;

const recordTypeProp = {
  type: "string",
  enum: [...RECORD_TYPES],
  description: "Which kind of record: lead, event, booking, contact or account",
};

const dryRunProp = {
  type: "boolean",
  description: "If true, return the request that would be sent without changing Tripleseat. Default false.",
};

export const EXTRA_TOOLS = [
  {
    name: "list_lead_sources",
    description:
      "List the Lead Source options configured in Tripleseat (from the Sites API), with their numeric IDs, plus referral sources. " +
      "Use before set_lead_source. New options (e.g. The Knot, WeddingWire, Zola) must be added in Tripleseat under " +
      "Settings > Preferences > Drop-downs > Lead Source; the API cannot create them.",
    inputSchema: {
      type: "object",
      properties: {
        site_id: { type: "number", description: "Optional site ID to limit the output (The Village is 12601)" },
      },
    },
  },
  {
    name: "set_lead_source",
    description:
      "Set the Lead Source on a lead (the searchable, reportable origin field) and, optionally, add an 'ORIGIN:' note " +
      "to the lead describing where it came from. Replaces the lead's selected sources with the IDs given.",
    inputSchema: {
      type: "object",
      properties: {
        lead_id: { type: "string", description: "The Tripleseat lead ID" },
        lead_source_ids: {
          type: "array",
          items: { type: "number" },
          description: "One or more lead source IDs from list_lead_sources",
        },
        origin_note: {
          type: "string",
          description:
            "Optional text for an origin note on the lead, e.g. 'The Knot inquiry 2026-01-13; resubmitted via website form'. " +
            "Saved as a lead note prefixed with 'ORIGIN: '.",
        },
        dry_run: dryRunProp,
      },
      required: ["lead_id", "lead_source_ids"],
    },
  },
  {
    name: "list_notes",
    description: "List the notes on a lead, event, booking, contact or account.",
    inputSchema: {
      type: "object",
      properties: {
        record_type: recordTypeProp,
        record_id: { type: "string", description: "ID of the lead/event/booking/contact/account" },
      },
      required: ["record_type", "record_id"],
    },
  },
  {
    name: "add_note",
    description:
      "Add a note to a lead, event, booking, contact or account (e.g. payment references, 'deposit satisfied in trade', " +
      "lead origin). Notes are visible on the record in the Tripleseat web app.",
    inputSchema: {
      type: "object",
      properties: {
        record_type: recordTypeProp,
        record_id: { type: "string", description: "ID of the lead/event/booking/contact/account" },
        text: { type: "string", description: "The note text" },
        dry_run: dryRunProp,
      },
      required: ["record_type", "record_id", "text"],
    },
  },
  {
    name: "update_note",
    description: "Replace the text of an existing note on a lead, event, booking, contact or account.",
    inputSchema: {
      type: "object",
      properties: {
        record_type: recordTypeProp,
        record_id: { type: "string" },
        note_id: { type: "string" },
        text: { type: "string", description: "New note text" },
        dry_run: dryRunProp,
      },
      required: ["record_type", "record_id", "note_id", "text"],
    },
  },
  {
    name: "delete_note",
    description: "Delete a note from a lead, event, booking, contact or account. Confirm with the user first.",
    inputSchema: {
      type: "object",
      properties: {
        record_type: recordTypeProp,
        record_id: { type: "string" },
        note_id: { type: "string" },
        dry_run: dryRunProp,
      },
      required: ["record_type", "record_id", "note_id"],
    },
  },
  {
    name: "update_billing_amount",
    description:
      "Set the value of a billing line item on an event document (e.g. a discount, service charge or fee) — a fixed " +
      "amount like '668.13' or a percentage like '10%'. Creates the billing item on the document if it is missing. " +
      "Get document and billing item IDs from get_event with include_financials. Cannot add menu or rental items or record payments.",
    inputSchema: {
      type: "object",
      properties: {
        document_id: { type: "string", description: "The event document ID" },
        billing_id: { type: "string", description: "The billing item ID to update" },
        value: { type: "string", description: "Amount (e.g. '100.50') or percentage (e.g. '10%')" },
        create_if_missing: { type: "boolean", description: "Create the billing item if missing (default true)" },
        dry_run: dryRunProp,
      },
      required: ["document_id", "billing_id", "value"],
    },
  },
  {
    name: "create_event_task",
    description: "Create a task on an event in Tripleseat.",
    inputSchema: {
      type: "object",
      properties: {
        event_id: { type: "string" },
        body: { type: "string", description: "Task description" },
        due_date: { type: "string", description: "Due date/time in ISO 8601 format" },
        priority: { type: "number", enum: [1, 2, 3], description: "1=Low, 2=Medium, 3=High" },
        task_type_id: { type: "number" },
        assignee_ids: { type: "array", items: { type: "number" } },
        site_id: { type: "number" },
      },
      required: ["event_id", "body", "due_date", "priority", "task_type_id", "assignee_ids", "site_id"],
    },
  },
  {
    name: "create_account_task",
    description: "Create a task on an account in Tripleseat.",
    inputSchema: {
      type: "object",
      properties: {
        account_id: { type: "string" },
        body: { type: "string", description: "Task description" },
        due_date: { type: "string", description: "Due date/time in ISO 8601 format" },
        priority: { type: "number", enum: [1, 2, 3] },
        task_type_id: { type: "number" },
        assignee_ids: { type: "array", items: { type: "number" } },
        site_id: { type: "number" },
      },
      required: ["account_id", "body", "due_date", "priority", "task_type_id", "assignee_ids", "site_id"],
    },
  },
  {
    name: "payment_transaction_report",
    description:
      "Read-only Tripleseat payments transaction report (payments taken through Tripleseat). Use for reconciliation " +
      "against bank deposits and Toast. Pass the date range and any other filters the report accepts.",
    inputSchema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "Start date (MM/DD/YYYY or YYYY-MM-DD)" },
        end_date: { type: "string", description: "End date" },
        location_id: { type: "string" },
        extra_params: { type: "object", description: "Any additional query parameters, as key/value strings" },
      },
    },
  },
  {
    name: "payment_refund_report",
    description: "Read-only Tripleseat payments refund report.",
    inputSchema: {
      type: "object",
      properties: {
        start_date: { type: "string" },
        end_date: { type: "string" },
        location_id: { type: "string" },
        extra_params: { type: "object" },
      },
    },
  },
  {
    name: "tripleseat_api_request",
    description:
      "Advanced, admin only: send a request to a documented Tripleseat v1 endpoint the named tools don't cover " +
      "(e.g. a field on a lead or event update). Methods GET, POST, PUT, PATCH only — no DELETE. " +
      "Defaults to dry_run=true; set dry_run=false only after the user approves the exact request.",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH"] },
        path: { type: "string", description: "Path after /v1, without extension, e.g. '/leads/123'" },
        params: { type: "object", description: "Query parameters" },
        body: { type: "object", description: "JSON body" },
        dry_run: { type: "boolean", description: "Default true" },
      },
      required: ["method", "path"],
    },
  },
];

// ── Helpers ──

function recordPath(type: string, id: string): string {
  if (!RECORD_TYPES.includes(type as RecordType)) {
    throw new Error(`record_type must be one of: ${RECORD_TYPES.join(", ")}`);
  }
  if (!/^\d+$/.test(String(id))) throw new Error("record_id must be numeric");
  return `/${RECORD_PATH[type as RecordType]}/${id}`;
}

function dry(method: string, path: string, body?: any, params?: any): string {
  return JSON.stringify({ dry_run: true, would_send: { method, path: `/v1${path}`, params, body } }, null, 2);
}

/** Tripleseat's note schema isn't public in full; try the common shapes in order. */
async function writeNote(method: "POST" | "PUT", path: string, text: string): Promise<{ data: any; shape: string }> {
  const shapes: Array<[string, any]> = [
    ["note.body", { note: { body: text } }],
    ["note.content", { note: { content: text } }],
    ["note.note", { note: { note: text } }],
  ];
  let lastErr: any;
  for (const [label, body] of shapes) {
    try {
      const { data } = await tripleseatRequest(path, { method, body });
      return { data, shape: label };
    } catch (e: any) {
      lastErr = e;
      // Only fall through on validation-type errors
      if (!/\((400|422)\b/.test(String(e.message))) throw e;
    }
  }
  throw lastErr;
}

function reportParams(args: any): Record<string, string> {
  const p: Record<string, string> = {};
  if (args.start_date) p.start_date = String(args.start_date);
  if (args.end_date) p.end_date = String(args.end_date);
  if (args.location_id) p.location_id = String(args.location_id);
  if (args.extra_params && typeof args.extra_params === "object") {
    for (const [k, v] of Object.entries(args.extra_params)) p[k] = String(v);
  }
  return p;
}

const RAW_ALLOWED_PREFIXES = [
  "/leads", "/events", "/bookings", "/contacts", "/accounts", "/documents",
  "/sites", "/locations", "/rooms", "/users", "/lead_forms", "/payments", "/credit_cards",
];

// ── Executor ──

export async function executeExtraTool(name: string, args: any, roleName?: string): Promise<string | null> {
  switch (name) {
    case "list_lead_sources": {
      const { data } = await tripleseatGet("/sites");
      const sites: any[] = Array.isArray(data) ? data : (data as any)?.results || (data as any)?.sites || [data];
      const out = sites
        .filter((s: any) => !args.site_id || Number(s?.id) === Number(args.site_id))
        .map((s: any) => ({
          site_id: s?.id,
          site_name: s?.name,
          lead_sources: s?.lead_sources ?? s?.lead_source_types ?? null,
          referral_sources: s?.referral_sources ?? null,
        }));
      return JSON.stringify(out, null, 2);
    }

    case "set_lead_source": {
      const ids: number[] = (args.lead_source_ids || []).map(Number).filter((n: number) => Number.isFinite(n));
      if (!ids.length) throw new Error("lead_source_ids must contain at least one numeric ID");
      const path = `/leads/${args.lead_id}`;
      const body = {
        lead: {
          lead_source_id: ids[0],
          selected_lead_sources_attributes: ids.map((id) => ({ lead_source_id: id })),
        },
      };
      const noteText = args.origin_note ? `ORIGIN: ${String(args.origin_note).replace(/^ORIGIN:\s*/i, "")}` : null;
      if (args.dry_run) return dry("PUT", path, body) + (noteText ? `\n\nPlus note on lead: ${noteText}` : "");
      const { data } = await tripleseatRequest(path, { method: "PUT", body });
      const lead = (data as any)?.lead ?? data;
      const result: any = {
        lead_id: lead?.id ?? args.lead_id,
        lead_sources_now: lead?.lead_sources ?? lead?.selected_lead_sources ?? null,
      };
      if (noteText) {
        try {
          const note = await writeNote("POST", `${path}/notes`, noteText);
          result.origin_note = { saved: true, shape: note.shape, note: note.data };
        } catch (e: any) {
          result.origin_note = { saved: false, error: e.message };
        }
      }
      return JSON.stringify(result, null, 2);
    }

    case "list_notes": {
      const { data } = await tripleseatGet(`${recordPath(args.record_type, args.record_id)}/notes`);
      return JSON.stringify(data, null, 2);
    }

    case "add_note": {
      const path = `${recordPath(args.record_type, args.record_id)}/notes`;
      if (args.dry_run) return dry("POST", path, { note: { body: args.text } });
      const { data, shape } = await writeNote("POST", path, String(args.text));
      return JSON.stringify({ saved: true, body_shape: shape, note: data }, null, 2);
    }

    case "update_note": {
      if (!/^\d+$/.test(String(args.note_id))) throw new Error("note_id must be numeric");
      const path = `${recordPath(args.record_type, args.record_id)}/notes/${args.note_id}`;
      if (args.dry_run) return dry("PUT", path, { note: { body: args.text } });
      const { data, shape } = await writeNote("PUT", path, String(args.text));
      return JSON.stringify({ saved: true, body_shape: shape, note: data }, null, 2);
    }

    case "delete_note": {
      if (!/^\d+$/.test(String(args.note_id))) throw new Error("note_id must be numeric");
      const path = `${recordPath(args.record_type, args.record_id)}/notes/${args.note_id}`;
      if (args.dry_run) return dry("DELETE", path);
      const { data } = await tripleseatRequest(path, { method: "DELETE" });
      return JSON.stringify({ deleted: true, response: data }, null, 2);
    }

    case "update_billing_amount": {
      if (!/^\d+$/.test(String(args.document_id))) throw new Error("document_id must be numeric");
      const path = `/documents/${args.document_id}/billing_amount`;
      const params: Record<string, string> = {
        billing_id: String(args.billing_id),
        value: String(args.value),
      };
      if (args.create_if_missing !== undefined) params.create_if_missing = String(!!args.create_if_missing);
      if (args.dry_run) return dry("PATCH", path, undefined, params);
      const { data } = await tripleseatRequest(path, { method: "PATCH", params });
      return JSON.stringify(data, null, 2);
    }

    case "create_event_task": {
      const { event_id, ...task } = args;
      const { data } = await tripleseatRequest(`/events/${event_id}/tasks`, { method: "POST", body: task });
      return JSON.stringify(data, null, 2);
    }

    case "create_account_task": {
      const { account_id, ...task } = args;
      const { data } = await tripleseatRequest(`/accounts/${account_id}/tasks`, { method: "POST", body: task });
      return JSON.stringify(data, null, 2);
    }

    case "payment_transaction_report": {
      const { data } = await tripleseatGet("/payments/transaction_report", reportParams(args));
      return JSON.stringify(data, null, 2);
    }

    case "payment_refund_report": {
      const { data } = await tripleseatGet("/payments/refund_report", reportParams(args));
      return JSON.stringify(data, null, 2);
    }

    case "tripleseat_api_request": {
      if (roleName && roleName !== "admin") throw new Error("tripleseat_api_request is limited to the admin role");
      const method = String(args.method || "").toUpperCase();
      if (!["GET", "POST", "PUT", "PATCH"].includes(method)) throw new Error("method must be GET, POST, PUT or PATCH");
      let path = String(args.path || "").trim().replace(/^\/?v1/, "").replace(/\.(json|xml|js)$/, "");
      if (!path.startsWith("/")) path = "/" + path;
      if (path.includes("..") || !RAW_ALLOWED_PREFIXES.some((p) => path === p || path.startsWith(p + "/"))) {
        throw new Error(`path must start with one of: ${RAW_ALLOWED_PREFIXES.join(", ")}`);
      }
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(args.params || {})) params[k] = String(v);
      const isWrite = method !== "GET";
      if (isWrite && args.dry_run !== false) return dry(method, path, args.body, params);
      const { data } = await tripleseatRequest(path, { method, params, body: args.body });
      return JSON.stringify(data, null, 2);
    }

    default:
      return null;
  }
}
