import { jsonResponse } from "./respond";
import { createAudioAsset, listAudioAssets } from "../db/audioAssets";

type AudioEnv = {
  DB: D1Database;
  AUDIO_ASSETS: R2Bucket;
};

export async function handleUploadAudioAsset(request: Request, env: AudioEnv): Promise<Response> {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return new Response("invalid request body", { status: 400 });
  }

  // The installed @cloudflare/workers-types version types FormData.get() as
  // returning only `string | null`, but the Workers runtime actually returns a
  // File for multipart file fields (this is a known gap in that package's root
  // type declarations, not a runtime limitation) -- cast to the real shape.
  const file = formData.get("file") as File | string | null;
  // A plain string means no real file was sent under this field (e.g. a text
  // field named "file" by mistake).
  if (file === null || typeof file === "string") {
    return new Response("missing file field", { status: 400 });
  }

  const labelField = formData.get("label");
  const label = typeof labelField === "string" && labelField.length > 0 ? labelField : file.name || "untitled";
  const contentType = file.type || "application/octet-stream";

  const id = crypto.randomUUID();
  const r2Key = `ivr-audio/${id}`;

  await env.AUDIO_ASSETS.put(r2Key, file.stream(), { httpMetadata: { contentType } });
  await createAudioAsset(env.DB, { id, label, r2Key, contentType });

  return jsonResponse({ id }, 201);
}

export async function handleListAudioAssets(db: D1Database): Promise<Response> {
  return jsonResponse(await listAudioAssets(db));
}
