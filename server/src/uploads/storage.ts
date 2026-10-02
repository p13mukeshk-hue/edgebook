import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, statfs } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { ScreenshotStorageConfig } from "../config.js";
import { AppError } from "../lib/errors.js";

export type ProcessedScreenshot = {
  bytes: Buffer;
  contentType: "image/jpeg" | "image/png" | "image/webp";
  extension: "jpg" | "png" | "webp";
  sha256: Buffer;
  width: number;
  height: number;
};

export interface ScreenshotStorage {
  ensureRoot(): Promise<void>;
  process(input: Buffer): Promise<ProcessedScreenshot>;
  save(userId: string, tradeId: string, fileId: string, image: ProcessedScreenshot): Promise<string>;
  open(storageKey: string): NodeJS.ReadableStream;
  remove(storageKey: string): Promise<void>;
  assertDiskCapacity(bytesToAdd: number): Promise<void>;
}

export class LocalScreenshotStorage implements ScreenshotStorage {
  public constructor(private readonly config: ScreenshotStorageConfig) {}

  public async ensureRoot(): Promise<void> {
    await mkdir(this.config.uploadRoot, { recursive: true, mode: 0o700 });
  }

  public async assertDiskCapacity(bytesToAdd: number): Promise<void> {
    const stats = await statfs(this.config.uploadRoot, { bigint: true });
    const available = stats.bavail * stats.bsize;
    if (available - BigInt(bytesToAdd) < BigInt(this.config.minDiskFreeBytes)) {
      const minimumGiB = Math.ceil(this.config.minDiskFreeBytes / (1024 * 1024 * 1024));
      throw new AppError(
        507,
        "VPS_STORAGE_LIMIT",
        `VPS storage limit reached. The screenshot was not saved because the server must keep at least ${minimumGiB} GiB free.`,
      );
    }
  }

  public async process(input: Buffer): Promise<ProcessedScreenshot> {
    if (input.length === 0 || input.length > this.config.maxUploadBytes) {
      throw new AppError(413, "FILE_TOO_LARGE", `Screenshot must be at most ${this.config.maxUploadBytes} bytes`);
    }
    let pipeline = sharp(input, {
      failOn: "warning",
      limitInputPixels: this.config.maxImagePixels,
      animated: false,
    }).rotate();
    const metadata = await pipeline.metadata();
    if (!metadata.width || !metadata.height || (metadata.pages ?? 1) > 1) {
      throw new AppError(415, "IMAGE_INVALID", "Only single-frame JPEG, PNG, and WebP screenshots are supported");
    }

    let contentType: ProcessedScreenshot["contentType"];
    let extension: ProcessedScreenshot["extension"];
    if (metadata.format === "jpeg") {
      pipeline = pipeline.jpeg({ quality: 85, mozjpeg: true });
      contentType = "image/jpeg";
      extension = "jpg";
    } else if (metadata.format === "png") {
      pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: true });
      contentType = "image/png";
      extension = "png";
    } else if (metadata.format === "webp") {
      pipeline = pipeline.webp({ quality: 85 });
      contentType = "image/webp";
      extension = "webp";
    } else {
      throw new AppError(415, "IMAGE_TYPE_UNSUPPORTED", "Only JPEG, PNG, and WebP screenshots are supported");
    }

    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    if (data.length > this.config.maxUploadBytes) {
      throw new AppError(413, "FILE_TOO_LARGE", "The validated screenshot exceeds the upload limit");
    }
    return {
      bytes: data,
      contentType,
      extension,
      sha256: createHash("sha256").update(data).digest(),
      width: info.width,
      height: info.height,
    };
  }

  public async save(userId: string, tradeId: string, fileId: string, image: ProcessedScreenshot): Promise<string> {
    const shard = userId.replaceAll("-", "").slice(0, 2);
    const storageKey = path.posix.join(shard, userId, tradeId, `${fileId}.${image.extension}`);
    const target = this.resolve(storageKey);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(image.bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    return storageKey;
  }

  public open(storageKey: string): NodeJS.ReadableStream {
    return createReadStream(this.resolve(storageKey));
  }

  public async remove(storageKey: string): Promise<void> {
    await rm(this.resolve(storageKey), { force: true });
  }

  private resolve(storageKey: string): string {
    if (storageKey.includes("\\") || storageKey.startsWith("/") || storageKey.includes("..")) {
      throw new AppError(400, "STORAGE_KEY_INVALID", "Invalid storage key");
    }
    const target = path.resolve(this.config.uploadRoot, storageKey);
    const rootPrefix = `${path.resolve(this.config.uploadRoot)}${path.sep}`;
    if (!target.startsWith(rootPrefix)) throw new AppError(400, "STORAGE_KEY_INVALID", "Invalid storage key");
    return target;
  }
}
