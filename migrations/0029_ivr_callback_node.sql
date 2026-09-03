-- migrations/0029_ivr_callback_node.sql
-- Expand the ivr_nodes.type CHECK to allow the new 'callback' node type: takes the caller's number
-- as a callback request (callback_requests row, surfaced on /admin/callbacks) and hangs up, instead
-- of recording them like 'voicemail' does. Until now the callback feature was only reachable by
-- pressing * while held in a wait node, which the live flow never uses -- so it was unreachable.
--
-- SQLite can't ALTER a CHECK constraint, so rebuild the table (standard table-recreate), exactly as
-- 0015 did when it added date_rule/input/redirect. Column list is unchanged from 0015 (verified
-- against the live schema); ivr_nodes carries no explicit indexes, only the implicit PK one.
CREATE TABLE ivr_nodes_new (
  id TEXT PRIMARY KEY,
  flow TEXT NOT NULL,
  is_entry INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL CHECK (type IN ('business_hours', 'play', 'gather', 'ring', 'wait', 'voicemail', 'date_rule', 'input', 'redirect', 'callback')),
  config TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  position_x INTEGER,
  position_y INTEGER
);
INSERT INTO ivr_nodes_new (id, flow, is_entry, type, config, created_at, updated_at, position_x, position_y)
  SELECT id, flow, is_entry, type, config, created_at, updated_at, position_x, position_y FROM ivr_nodes;
DROP TABLE ivr_nodes;
ALTER TABLE ivr_nodes_new RENAME TO ivr_nodes;
