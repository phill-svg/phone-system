-- migrations/0004_ivr_flow.sql
-- IVR flow nodes and audio asset storage

CREATE TABLE ivr_audio_assets (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  uploaded_at INTEGER NOT NULL
);

CREATE TABLE ivr_nodes (
  id TEXT PRIMARY KEY,
  flow TEXT NOT NULL,
  is_entry INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL CHECK (type IN ('business_hours', 'play', 'gather', 'ring', 'wait', 'voicemail')),
  config TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Seed data: main (business hours) flow
-- The main flow consists of:
-- 1. Entry gather node prompting for 1/2/3/0
-- 2. Four ring nodes for new_booking/existing_job/emergency/operator
-- 3. Shared voicemail node for all no-answer paths
-- All four main-flow ring nodes (including emergency) use target:"all" —
-- on-call-only targeting is reserved for the after-hours emergency ring node below.

-- Shared voicemail node (reused by both main and after-hours flows)
-- NOTE: Node lookups by later code (e.g., flow-walking engine) MUST be global-by-id (SELECT * FROM ivr_nodes WHERE id = ?),
-- NOT scoped by the flow column, because this node is tagged flow='main' but referenced by after_hours flow nodes.
INSERT INTO ivr_nodes (id, flow, is_entry, type, config, created_at, updated_at)
VALUES (
  'shared_voicemail',
  'main',
  0,
  'voicemail',
  json('{"ttsText": "Sorry we''re unable to take your call right now. Please leave a message after the tone, including your name and number.", "mailboxLabel": "default", "audioAssetId": null}'),
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
);

-- Main flow entry gather node
INSERT INTO ivr_nodes (id, flow, is_entry, type, config, created_at, updated_at)
VALUES (
  'main_entry_gather',
  'main',
  1,
  'gather',
  json('{"ttsText": "Press 1 for a new booking or enquiry. Press 2 for an existing job. Press 3 for an urgent pest emergency. Or press 0 to speak to someone.", "options": [{"digit": "1", "nextNodeId": "main_ring_new_booking"}, {"digit": "2", "nextNodeId": "main_ring_existing_job"}, {"digit": "3", "nextNodeId": "main_ring_emergency"}, {"digit": "0", "nextNodeId": "main_ring_operator"}], "defaultNextNodeId": "shared_voicemail", "audioAssetId": null, "retryLimit": 3}'),
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
);

-- New booking ring node (target all staff)
INSERT INTO ivr_nodes (id, flow, is_entry, type, config, created_at, updated_at)
VALUES (
  'main_ring_new_booking',
  'main',
  0,
  'ring',
  json('{"target": "all", "strategy": "cascade", "timeoutSeconds": 20, "noAnswerNextNodeId": "shared_voicemail"}'),
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
);

-- Existing job ring node (target all staff)
INSERT INTO ivr_nodes (id, flow, is_entry, type, config, created_at, updated_at)
VALUES (
  'main_ring_existing_job',
  'main',
  0,
  'ring',
  json('{"target": "all", "strategy": "cascade", "timeoutSeconds": 20, "noAnswerNextNodeId": "shared_voicemail"}'),
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
);

-- Emergency ring node (target all staff for main/business-hours flow)
INSERT INTO ivr_nodes (id, flow, is_entry, type, config, created_at, updated_at)
VALUES (
  'main_ring_emergency',
  'main',
  0,
  'ring',
  json('{"target": "all", "strategy": "cascade", "timeoutSeconds": 20, "noAnswerNextNodeId": "shared_voicemail"}'),
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
);

-- Operator ring node (target all staff)
INSERT INTO ivr_nodes (id, flow, is_entry, type, config, created_at, updated_at)
VALUES (
  'main_ring_operator',
  'main',
  0,
  'ring',
  json('{"target": "all", "strategy": "cascade", "timeoutSeconds": 20, "noAnswerNextNodeId": "shared_voicemail"}'),
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
);

-- After-hours flow: simpler single-option gather that routes 1 to emergency or defaults to voicemail
INSERT INTO ivr_nodes (id, flow, is_entry, type, config, created_at, updated_at)
VALUES (
  'after_hours_entry_gather',
  'after_hours',
  1,
  'gather',
  json('{"ttsText": "For a pest emergency, press 1. Otherwise, please leave a message after the tone.", "options": [{"digit": "1", "nextNodeId": "after_hours_ring_emergency"}], "defaultNextNodeId": "shared_voicemail", "audioAssetId": null, "retryLimit": 1}'),
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
);

-- After-hours emergency ring node (ring whoever currently resolves as available)
INSERT INTO ivr_nodes (id, flow, is_entry, type, config, created_at, updated_at)
VALUES (
  'after_hours_ring_emergency',
  'after_hours',
  0,
  'ring',
  json('{"target": "all", "strategy": "cascade", "timeoutSeconds": 20, "noAnswerNextNodeId": "shared_voicemail"}'),
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
);
