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

  // One verdict per check per attempt for every reply the agent wrote
  await query(`
    CREATE TABLE IF NOT EXISTS agent_check_results (
      message_id INTEGER NOT NULL REFERENCES agent_messages(id) ON DELETE CASCADE,
      attempt INTEGER NOT NULL DEFAULT 1,
      check_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      mode TEXT NOT NULL,
      pass BOOLEAN NOT NULL,
      evidence TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (message_id, attempt, check_id)
    )
  `);

  // Patrick's own pass/fail label for a check on a reply; used to validate each automated check
  await query(`
    CREATE TABLE IF NOT EXISTS agent_check_labels (
      message_id INTEGER NOT NULL REFERENCES agent_messages(id) ON DELETE CASCADE,
      check_id TEXT NOT NULL,
      owner_pass BOOLEAN NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (message_id, check_id)
    )
  `);

  // Patrick's own replies, used as the reference for voice
  await query(`
    CREATE TABLE IF NOT EXISTS agent_exemplars (
      id SERIAL PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'outlook',
      source_ref TEXT,
      sent_at TIMESTAMPTZ,
      recipient_type TEXT,
      event_type TEXT,
      situation_tags TEXT[] DEFAULT '{}',
      inquiry_text TEXT,
      reply_text TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (source, source_ref)
    )
  `);

  // Second draft and voice comparison; owner review fields
  for (const col of [
    "alt_reply_text TEXT",
    "voice_pick_reason TEXT",
    "voice_exemplar_ids INTEGER[]",
    "owner_voice_pick TEXT",
    "owner_sent_unchanged BOOLEAN",
    "owner_critique TEXT",
    "owner_labelled_at TIMESTAMPTZ",
    "check_attempts INTEGER DEFAULT 0",
    "recipient_type TEXT",
    "situation_tags TEXT[] DEFAULT '{}'",
    "compose_exemplar_ids INTEGER[]",
    "model_reply_text TEXT",
    "form_invited_at TIMESTAMPTZ",
    "origin_noted_at TIMESTAMPTZ",
  ]) {
    await query(`ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS ${col}`);
  }
  for (const col of ["guest_name TEXT", "reply_neutral TEXT"]) {
    await query(`ALTER TABLE agent_exemplars ADD COLUMN IF NOT EXISTS ${col}`);
  }

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
  alt_reply_text: string | null;
  voice_pick_reason: string | null;
  owner_voice_pick: string | null;
  owner_sent_unchanged: boolean | null;
  owner_critique: string | null;
  owner_labelled_at: string | null;
  created_at: string;
}
