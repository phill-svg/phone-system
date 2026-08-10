export type IvrNode = { id: string; flow: string; isEntry: boolean; type: string; config: Record<string, unknown> };

type IvrNodeRow = { id: string; flow: string; is_entry: number; type: string; config: string };

export async function listNodesForFlow(db: D1Database, flow: string): Promise<IvrNode[]> {
  const result = await db.prepare("SELECT * FROM ivr_nodes WHERE flow = ?").bind(flow).all<IvrNodeRow>();
  return result.results.map((row) => ({
    id: row.id,
    flow: row.flow,
    isEntry: row.is_entry === 1,
    type: row.type,
    config: JSON.parse(row.config) as Record<string, unknown>,
  }));
}

export async function nodeExists(db: D1Database, id: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 FROM ivr_nodes WHERE id = ? LIMIT 1").bind(id).first();
  return row !== null;
}

// Like nodeExists, but excludes rows belonging to `excludeFlow`. Used by handlePutFlow so
// cross-reference/duplicate-id validation reflects what the DB will look like AFTER this save
// (the flow currently being replaced is about to be wiped and re-inserted from the payload, so
// its current rows shouldn't count as "still existing" for validation purposes).
export async function nodeExistsInOtherFlow(db: D1Database, id: string, excludeFlow: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 FROM ivr_nodes WHERE id = ? AND flow != ? LIMIT 1").bind(id, excludeFlow).first();
  return row !== null;
}

export async function replaceFlowNodes(
  db: D1Database,
  flow: string,
  entryNodeId: string,
  nodes: { id: string; type: string; config: Record<string, unknown> }[]
): Promise<void> {
  const now = Date.now();
  // Full delete-then-reinsert, run atomically via D1's batch(). This is an internal admin
  // tool for a handful of nodes per flow, so it's not worth the complexity of an
  // upsert-preserving-created_at approach -- every save just re-creates created_at/updated_at.
  const statements = [
    db.prepare("DELETE FROM ivr_nodes WHERE flow = ?").bind(flow),
    ...nodes.map((node) =>
      db
        .prepare(
          "INSERT INTO ivr_nodes (id, flow, is_entry, type, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(node.id, flow, node.id === entryNodeId ? 1 : 0, node.type, JSON.stringify(node.config), now, now)
    ),
  ];
  await db.batch(statements);
}
