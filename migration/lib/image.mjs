import { createHash } from 'node:crypto';
import sharp from 'sharp';

export async function processMigrationImage(input, { maxBytes = 50 * 1024 * 1024, maxPixels = 40_000_000 } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 64 * 1024 || maxBytes > 50 * 1024 * 1024) {
    throw new Error('maxBytes is outside the server-supported range');
  }
  if (!Number.isSafeInteger(maxPixels) || maxPixels < 1_000_000 || maxPixels > 100_000_000) {
    throw new Error('maxPixels is outside the server-supported range');
  }
  if (!Buffer.isBuffer(input) || input.length === 0 || input.length > maxBytes) {
    throw new Error(`image must contain 1 byte to ${maxBytes} bytes`);
  }
  let pipeline = sharp(input, {
    failOn: 'warning',
    limitInputPixels: maxPixels,
    animated: false,
  }).rotate();
  const metadata = await pipeline.metadata();
  if (!metadata.width || !metadata.height || (metadata.pages ?? 1) > 1) {
    throw new Error('image dimensions/pages are invalid');
  }
  let contentType;
  let extension;
  if (metadata.format === 'jpeg') {
    pipeline = pipeline.jpeg({ quality: 85, mozjpeg: true });
    contentType = 'image/jpeg';
    extension = '.jpg';
  } else if (metadata.format === 'png') {
    pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: true });
    contentType = 'image/png';
    extension = '.png';
  } else if (metadata.format === 'webp') {
    pipeline = pipeline.webp({ quality: 85 });
    contentType = 'image/webp';
    extension = '.webp';
  } else {
    throw new Error('only JPEG, PNG and WebP are supported');
  }
  const result = await pipeline.toBuffer({ resolveWithObject: true });
  if (result.data.length === 0 || result.data.length > maxBytes) {
    throw new Error('processed image exceeds the migration ceiling');
  }
  return {
    bytes: result.data,
    contentType,
    extension,
    width: result.info.width,
    height: result.info.height,
    sha256: createHash('sha256').update(result.data).digest('hex'),
  };
}
