-- Canvas layout persistence for the IVR flow editor. NULL means "never positioned" --
-- every existing node starts NULL and is client-side auto-laid-out on first render; a
-- position is only written once a node is actually dragged.
ALTER TABLE ivr_nodes ADD COLUMN position_x INTEGER;
ALTER TABLE ivr_nodes ADD COLUMN position_y INTEGER;
