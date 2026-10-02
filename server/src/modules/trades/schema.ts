import { z } from "zod";
import { assertJsonSize } from "../../lib/json.js";
import { calendarDateSchema } from "../../lib/date.js";

const timeString = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/, "Expected HH:MM or HH:MM:SS");
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

export const tradeCreateSchema = z
  .object({
    id: z.union([z.string().min(1).max(512), z.number().finite()]).optional(),
    legacyFirebaseDocId: z.string().min(1).max(512).optional(),
    accountId: z.string().min(1).max(512).nullable().optional(),
    internalAccountId: z.string().uuid().nullable().optional(),
    brokerConnectionId: z.string().uuid().nullable().optional(),
    source: z.string().trim().min(1).max(64).optional(),
    sourceSystem: z.string().trim().min(1).max(64).optional(),
    ingestionMethod: z.enum(["manual", "api", "csv", "migration", "webhook"]).optional(),
    externalTradeKey: optionalText(512),
    brokerTradeId: optionalText(512),
    symbol: z.string().trim().min(1).max(128),
    asset: optionalText(64),
    instrument: optionalText(128),
    optionType: optionalText(16),
    strike: z.number().finite().nullable().optional(),
    expiry: calendarDateSchema.nullable().optional(),
    exchange: optionalText(64),
    product: optionalText(64),
    direction: z.enum(["Long", "Short"]),
    entry: z.number().finite(),
    exit: z.number().finite().nullable().optional(),
    size: z.number().finite().nonnegative(),
    pnl: z.number().finite().nullable().optional(),
    sl: z.number().finite().nullable().optional(),
    tp: z.number().finite().nullable().optional(),
    isOpen: z.boolean().nullable().optional(),
    date: calendarDateSchema,
    entryAt: z.string().datetime({ offset: true }).nullable().optional(),
    exitAt: z.string().datetime({ offset: true }).nullable().optional(),
    entryTime: timeString.nullable().optional(),
    exitTime: timeString.nullable().optional(),
    strategy: optionalText(2_000),
    emotion: optionalText(512),
    notes: optionalText(50_000),
    tags: z.array(z.string().trim().min(1).max(128)).max(100).optional(),
    psychology: z.record(z.string(), z.unknown()).optional(),
    custom: z.record(z.string(), z.unknown()).optional(),
    brokerData: z.record(z.string(), z.unknown()).optional(),
    calculationVersion: z.number().int().min(1).max(1_000).optional(),
    version: z.number().int().min(1).optional(),
  })
  .passthrough();

export const tradePatchSchema = tradeCreateSchema.partial();

export type NormalizedTrade = {
  legacyId: string | null;
  accountId: string | null;
  internalAccountId: string | null;
  brokerConnectionId: string | null;
  sourceSystem: string;
  ingestionMethod: string;
  externalTradeKey: string | null;
  brokerTradeId: string | null;
  symbol: string;
  asset: string | null;
  instrument: string | null;
  optionType: string | null;
  strike: number | null;
  expiry: string | null;
  exchange: string | null;
  product: string | null;
  direction: "Long" | "Short";
  entry: number;
  exit: number | null;
  size: number;
  pnl: number | null;
  sl: number | null;
  tp: number | null;
  isOpen: boolean | null;
  date: string;
  entryAt: string | null;
  exitAt: string | null;
  entryTime: string | null;
  exitTime: string | null;
  strategy: string | null;
  emotion: string | null;
  notes: string | null;
  tags: string[];
  psychology: Record<string, unknown>;
  custom: Record<string, unknown>;
  brokerData: Record<string, unknown>;
  calculationVersion: number;
  legacyDocument: Record<string, unknown>;
};

export function normalizeTrade(input: unknown): NormalizedTrade {
  const parsed = tradeCreateSchema.parse(input);
  assertJsonSize(parsed);
  const suppliedId = parsed.legacyFirebaseDocId ?? parsed.id;
  const sourceSystem = parsed.sourceSystem ?? parsed.source ?? "manual";
  const ingestionMethod = parsed.ingestionMethod ?? (sourceSystem === "csv" ? "csv" : sourceSystem === "manual" ? "manual" : "api");
  return {
    legacyId: suppliedId === undefined ? null : String(suppliedId),
    accountId: parsed.accountId ?? null,
    internalAccountId: parsed.internalAccountId ?? null,
    brokerConnectionId: parsed.brokerConnectionId ?? null,
    sourceSystem,
    ingestionMethod,
    externalTradeKey: parsed.externalTradeKey ?? null,
    brokerTradeId: parsed.brokerTradeId ?? null,
    symbol: parsed.symbol,
    asset: parsed.asset ?? null,
    instrument: parsed.instrument ?? null,
    optionType: parsed.optionType ?? null,
    strike: parsed.strike ?? null,
    expiry: parsed.expiry ?? null,
    exchange: parsed.exchange ?? null,
    product: parsed.product ?? null,
    direction: parsed.direction,
    entry: parsed.entry,
    exit: parsed.exit ?? null,
    size: parsed.size,
    pnl: parsed.pnl ?? null,
    sl: parsed.sl ?? null,
    tp: parsed.tp ?? null,
    isOpen: parsed.isOpen ?? null,
    date: parsed.date,
    entryAt: parsed.entryAt ?? null,
    exitAt: parsed.exitAt ?? null,
    entryTime: parsed.entryTime ?? null,
    exitTime: parsed.exitTime ?? null,
    strategy: parsed.strategy ?? null,
    emotion: parsed.emotion ?? null,
    notes: parsed.notes ?? null,
    tags: parsed.tags ?? [],
    psychology: parsed.psychology ?? {},
    custom: parsed.custom ?? {},
    brokerData: parsed.brokerData ?? {},
    calculationVersion: parsed.calculationVersion ?? 1,
    legacyDocument: parsed,
  };
}

export function unwrapTradeBody(body: unknown): unknown {
  if (body && typeof body === "object" && "trade" in body) return (body as { trade: unknown }).trade;
  return body;
}
