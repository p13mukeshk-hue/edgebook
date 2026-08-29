import { AppError } from "./errors.js";

export function assertJsonSize(value: unknown, maxBytes = 512 * 1024): void {
  const size = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (size > maxBytes) {
    throw new AppError(413, "JSON_TOO_LARGE", `JSON payload exceeds ${maxBytes} bytes`);
  }
}

export function asIsoString(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
