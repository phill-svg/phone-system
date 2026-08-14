-- migrations/0015_ivr_node_types.sql
-- Expand the ivr_nodes.type CHECK to allow the new call-flow node types: date_rule (branch on
-- closed dates / holidays), input (collect multi-digit input then continue), and redirect
-- (forward the call to an external number). SQLite can't ALTER a CHECK constraint, so rebuild the
-- table (standard table-recreate), preserving all columns including the 0007 canvas positions.
CREATE TABLE ivr_nodes_new (
  id TEXT PRIMARY KEY,
  flow TEXT NOT NULL,
  is_entry INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL CHECK (type IN ('business_hours', 'play', 'gather', 'ring', 'wait', 'voicemail', 'date_rule', 'input', 'redirect')),
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
