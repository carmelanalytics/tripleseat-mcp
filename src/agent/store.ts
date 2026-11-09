/**
 * Database tables for the inquiry agent. Idempotent, additive migrations.
 */

import { query, queryOne } from "../db.js";

export async function migrateAgent(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS agent_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Approved FAQ answers, synced from the FAQ Google Sheet (Answer column only)
  await query(`
    CREATE TABLE IF NOT EXISTS agent_kb (
      id SERIAL PRIMARY KEY,
      department TEXT NOT NULL DEFAULT '',
      topic TEXT NOT NULL DEFAULT '',
      question TEXT NOT NULL,
      answer TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      usable BOOLEAN NOT NULL DEFAULT false,
      synced_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // One row per inbound message the agent looked at
  await query(`
    CREATE TABLE IF NOT EXISTS agent_messages (
      id SERIAL PRIMARY KEY,
      mailbox TEXT NOT NULL,
      graph_message_id TEXT NOT NULL,
      internet_message_id TEXT,
      conversation_id TEXT,
      received_at TIMESTAMPTZ,
      source TEXT NOT NULL,
      from_address TEXT,
      guest_name TEXT,
      guest_email TEXT,
      subject TEXT,
      inbound_text TEXT,
      department TEXT,
      topics TEXT[] DEFAULT '{}',
      action TEXT NOT NULL DEFAULT 'pending',
      reply_text TEXT,
      reply_subject TEXT,
      open_questions TEXT[] DEFAULT '{}',
      review_notes TEXT,
      tripleseat_lead_id TEXT,
      tripleseat_event_id TEXT,
      send_transport TEXT,
      sent_at TIMESTAMPTZ,
      error TEXT,
      corrected_reply TEXT,
      correction_note TEXT,
      corrected_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (mailbox, graph_message_id)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS agent_messages_created ON agent_messages (created_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS agent_messages_conv ON agent_messages (conversation_id)`);

  // Corrections Patrick makes; fed back into every future prompt
  await query(`
    CREATE TABLE IF NOT EXISTS agent_voice_rules (
      id SERIAL PRIMARY KEY,
      rule TEXT NOT NULL,
      example_before TEXT,
      example_after TEXT,
      source_message_id INTEGER REFERENCES agent_messages(id),
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Graph delta links per mailbox
  await query(`
    CREATE TABLE IF NOT EXISTS agent_cursors (
      mailbox TEXT PRIMARY KEY,
      delta_link TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

export async function getSetting(key: string, fallback = ""): Promise<string> {
  const row = await queryOne<{ value: string }>(`SELECT value FROM agent_settings WHERE key = $1`, [key]);
  return row?.value ?? fallback;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await query(
    `INSERT INTO agent_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, value]
  );
}

export interface AgentMessageRow {
  id: number;
  mailbox: string;
  graph_message_id: string;
  conversation_id: string | null;
  received_at: string | null;
  source: string;
  from_address: string | null;
  guest_name: string | null;
  guest_email: string | null;
  subject: string | null;
  inbound_text: string | null;
  department: string | null;
  topics: string[];
  action: string;
  reply_text: string | null;
  reply_subject: string | null;
  open_questions: string[];
  review_notes: string | null;
  tripleseat_lead_id: string | null;
  tripleseat_event_id: string | null;
  send_transport: string | null;
  sent_at: string | null;
  error: string | null;
  corrected_reply: string | null;
  correction_note: string | null;
  corrected_at: string | null;
  created_at: string;
}
