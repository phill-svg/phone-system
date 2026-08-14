import { jsonResponse } from "./respond";
import {
  createContact,
  deleteContact,
  importContacts,
  listContacts,
  updateContact,
  type ContactInput,
} from "../db/contacts";

export async function handleListContacts(db: D1Database): Promise<Response> {
  return jsonResponse(await listContacts(db));
}

export async function handleCreateContact(request: Request, db: D1Database): Promise<Response> {
  const body = (await request.json().catch(() => null)) as ContactInput | null;
  if (!body || typeof body.name !== "string" || typeof body.phone !== "string" || !body.name.trim() || !body.phone.trim()) {
    return jsonResponse({ error: "name and phone are required" }, 400);
  }
  const contact = await createContact(db, {
    name: body.name,
    phone: body.phone,
    company: typeof body.company === "string" ? body.company : null,
  });
  return jsonResponse(contact, 201);
}

export async function handleUpdateContact(
  request: Request,
  db: D1Database,
  id: number
): Promise<Response> {
  const body = (await request.json().catch(() => null)) as ContactInput | null;
  if (!body || typeof body.name !== "string" || typeof body.phone !== "string" || !body.name.trim() || !body.phone.trim()) {
    return jsonResponse({ error: "name and phone are required" }, 400);
  }
  const ok = await updateContact(db, id, {
    name: body.name,
    phone: body.phone,
    company: typeof body.company === "string" ? body.company : null,
  });
  return ok ? jsonResponse({ ok: true }) : jsonResponse({ error: "not found" }, 404);
}

export async function handleDeleteContact(db: D1Database, id: number): Promise<Response> {
  await deleteContact(db, id);
  return jsonResponse({ ok: true });
}

export async function handleImportContacts(request: Request, db: D1Database): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { contacts?: ContactInput[] } | null;
  if (!body || !Array.isArray(body.contacts)) {
    return jsonResponse({ error: "contacts array is required" }, 400);
  }
  if (body.contacts.length > 5000) {
    return jsonResponse({ error: "too many contacts in one import (max 5000)" }, 400);
  }
  const result = await importContacts(db, body.contacts);
  return jsonResponse(result);
}
