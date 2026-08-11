-- Task 3 of the softphone plan made "on_call_only" an invalid ring-node target value
-- (targets are now "all" or a JSON array of staff emails). Migration 0004 seeded the
-- after-hours emergency ring node with target "on_call_only" -- editing that historical
-- migration file only fixes freshly-provisioned databases, not ones (including production)
-- where 0004 already ran. This corrects any existing row left with the stale value.
UPDATE ivr_nodes
SET config = json_set(config, '$.target', 'all')
WHERE type = 'ring' AND json_extract(config, '$.target') = 'on_call_only';
