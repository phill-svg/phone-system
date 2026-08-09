export type AudioAsset = {
  id: string;
  label: string;
  r2Key: string;
  contentType: string;
  uploadedAt: number;
};

export async function createAudioAsset(
  db: D1Database,
  asset: { id: string; label: string; r2Key: string; contentType: string }
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO ivr_audio_assets (id, label, r2_key, content_type, uploaded_at) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(asset.id, asset.label, asset.r2Key, asset.contentType, Date.now())
    .run();
}

export async function listAudioAssets(db: D1Database): Promise<AudioAsset[]> {
  const result = await db
    .prepare("SELECT id, label, r2_key, content_type, uploaded_at FROM ivr_audio_assets ORDER BY uploaded_at DESC")
    .all<{ id: string; label: string; r2_key: string; content_type: string; uploaded_at: number }>();
  return result.results.map((row) => ({
    id: row.id,
    label: row.label,
    r2Key: row.r2_key,
    contentType: row.content_type,
    uploadedAt: row.uploaded_at,
  }));
}

export async function getAudioAsset(db: D1Database, id: string): Promise<AudioAsset | null> {
  const row = await db
    .prepare("SELECT id, label, r2_key, content_type, uploaded_at FROM ivr_audio_assets WHERE id = ?")
    .bind(id)
    .first<{ id: string; label: string; r2_key: string; content_type: string; uploaded_at: number }>();
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    r2Key: row.r2_key,
    contentType: row.content_type,
    uploadedAt: row.uploaded_at,
  };
}
