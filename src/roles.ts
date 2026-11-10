/**
 * Role management — CRUD and seeding default roles.
 */

import { query, queryOne } from "./db.js";

export interface Role {
  id: string;
  name: string;
  description: string;
  allowed_tools: string[];
  created_at: string;
  updated_at: string;
}

const ALL_TOOLS = [
  // Read tools
  "get_event",
  "search_events",
  "list_upcoming_events",
  "check_availability",
  "get_lead",
  "search_leads",
  "list_recent_leads",
  "get_booking",
  "search_bookings",
  "get_contact",
  "search_contacts",
  "get_account",
  "search_accounts",
  "list_sites",
  "list_locations",
  "get_location",
  "list_users",
  // Write tools
  "create_lead",
  "update_lead",
  "create_booking",
  "update_booking",
  "create_event",
  "update_event",
  "create_contact",
  "update_contact",
  "create_account",
  "update_account",
  "create_lead_task",
  "create_booking_task",
  "create_contact_task",
  // Added 2026-11-09 (extra-tools.ts)
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

export { ALL_TOOLS };

/**
 * List all roles.
 */
export async function listRoles(): Promise<Role[]> {
  return query<Role>(`SELECT * FROM mcp_roles ORDER BY created_at`);
}

/**
 * Get a single role by ID.
 */
export async function getRole(id: string): Promise<Role | null> {
  return queryOne<Role>(`SELECT * FROM mcp_roles WHERE id = $1`, [id]);
}

/**
 * Create a new role.
 */
export async function createRole(
  name: string,
  description: string,
  allowedTools: string[]
): Promise<Role> {
  const row = await queryOne<Role>(
    `INSERT INTO mcp_roles (name, description, allowed_tools)
     VALUES ($1, $2, $3::text[])
     RETURNING *`,
    [name, description, allowedTools]
  );

  if (!row) throw new Error("Failed to create role");
  return row;
}

/**
 * Update an existing role.
 */
export async function updateRole(
  id: string,
  updates: Partial<Pick<Role, "name" | "description" | "allowed_tools">>
): Promise<Role> {
  const setClauses: string[] = [];
  const params: any[] = [];
  let paramIndex = 1;

  if (updates.name !== undefined) {
    setClauses.push(`name = $${paramIndex++}`);
    params.push(updates.name);
  }
  if (updates.description !== undefined) {
    setClauses.push(`description = $${paramIndex++}`);
    params.push(updates.description);
  }
  if (updates.allowed_tools !== undefined) {
    setClauses.push(`allowed_tools = $${paramIndex++}::text[]`);
    params.push(updates.allowed_tools);
  }

  setClauses.push(`updated_at = NOW()`);
  params.push(id);

  const row = await queryOne<Role>(
    `UPDATE mcp_roles SET ${setClauses.join(", ")} WHERE id = $${paramIndex} RETURNING *`,
    params
  );

  if (!row) throw new Error("Failed to update role");
  return row;
}

/**
 * Seed default roles (uses ON CONFLICT to skip existing).
 */
export async function seedDefaultRoles(): Promise<{ created: string[]; updated: string[]; skipped: boolean }> {
  const defaults = [
    {
      name: "admin",
      description: "Full access to all tools (read + write)",
      allowed_tools: [...ALL_TOOLS],
    },
    {
      name: "manager",
      description: "All tools except user management",
      allowed_tools: ALL_TOOLS.filter((t) => t !== "list_users" && t !== "tripleseat_api_request"),
    },
    {
      name: "coordinator",
      description: "Events, leads, contacts, locations, availability — read + write but no financials or booking writes",
      allowed_tools: [
        "get_event",
        "search_events",
        "list_upcoming_events",
        "check_availability",
        "get_lead",
        "search_leads",
        "list_recent_leads",
        "get_contact",
        "search_contacts",
        "get_account",
        "search_accounts",
        "list_sites",
        "list_locations",
        "get_location",
        "create_lead",
        "update_lead",
        "create_event",
        "update_event",
        "create_contact",
        "update_contact",
        "create_account",
        "update_account",
        "create_lead_task",
        "create_contact_task",
        "list_lead_sources",
        "set_lead_source",
        "list_notes",
        "add_note",
        "update_note",
        "create_event_task",
      ],
    },
    {
      name: "viewer",
      description: "Read-only access to individual records — no write access",
      allowed_tools: [
        "get_event",
        "get_lead",
        "get_booking",
        "get_contact",
        "get_account",
        "get_location",
      ],
    },
  ];

  const created: string[] = [];
  const updated: string[] = [];

  for (const role of defaults) {
    const row = await queryOne<{ name: string; xmax: string }>(
      `INSERT INTO mcp_roles (name, description, allowed_tools)
       VALUES ($1, $2, $3::text[])
       ON CONFLICT (name) DO UPDATE
         SET description = EXCLUDED.description,
             allowed_tools = EXCLUDED.allowed_tools,
             updated_at = NOW()
       RETURNING name, xmax::text`,
      [role.name, role.description, role.allowed_tools]
    );
    if (row) {
      // xmax = '0' means INSERT, otherwise UPDATE
      if (row.xmax === "0") {
        created.push(row.name);
      } else {
        updated.push(row.name);
      }
    }
  }

  return { created, updated, skipped: created.length === 0 && updated.length === 0 };
}
