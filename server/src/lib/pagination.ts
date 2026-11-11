import { AppError } from "./errors.js";

export type Cursor = { at: string; id: string };

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(value: string | undefined): Cursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<Cursor>;
    if (typeof parsed.at !== "string" || typeof parsed.id !== "string" || Number.isNaN(Date.parse(parsed.at))) {
      throw new Error("invalid cursor");
    }
    return { at: parsed.at, id: parsed.id };
  } catch {
    throw new AppError(400, "INVALID_CURSOR", "The pagination cursor is invalid");
  }
}
