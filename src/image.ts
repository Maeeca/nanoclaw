import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

const MAX_DIMENSION = 1024;
const IMAGE_REF_PATTERN = /\[Image: (attachments\/[^\]]+)\]/g;

/**
 * When the orchestrator runs as root but the agent container runs as uid 1000,
 * files written by the orchestrator end up root-owned and the container can't
 * modify/delete them. On root, chown new group files to uid 1000 so the
 * container user can manage them. No-op otherwise.
 */
function chownToContainerUser(targetPath: string): void {
  if (process.getuid?.() !== 0) return;
  try {
    fs.chownSync(targetPath, 1000, 1000);
  } catch {
    // Best effort — skip silently if chown fails (non-Linux, etc.)
  }
}

export interface ProcessedImage {
  content: string;
  relativePath: string;
}

export interface ImageAttachment {
  relativePath: string;
  mediaType: string;
}

/**
 * Resize, re-encode as JPEG, and save an image buffer into the group's
 * attachments directory. Returns the in-chat content string that encodes
 * the image reference, plus the relative path under the group folder.
 */
export async function processImage(
  buffer: Buffer,
  groupDir: string,
  caption: string,
): Promise<ProcessedImage | null> {
  if (!buffer || buffer.length === 0) return null;

  const resized = await sharp(buffer)
    .resize(MAX_DIMENSION, MAX_DIMENSION, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 85 })
    .toBuffer();

  const attachDir = path.join(groupDir, 'attachments');
  const attachDirExisted = fs.existsSync(attachDir);
  fs.mkdirSync(attachDir, { recursive: true });
  if (!attachDirExisted) chownToContainerUser(attachDir);

  const filename = `img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jpg`;
  const filePath = path.join(attachDir, filename);
  fs.writeFileSync(filePath, resized);
  chownToContainerUser(filePath);

  const relativePath = `attachments/${filename}`;
  const content = caption
    ? `[Image: ${relativePath}] ${caption}`
    : `[Image: ${relativePath}]`;

  return { content, relativePath };
}

/**
 * Scan message contents for `[Image: attachments/...]` references produced
 * by processImage(). Returns the list of attachments to feed into the agent
 * as multimodal content blocks.
 */
export function parseImageReferences(
  messages: Array<{ content: string }>,
): ImageAttachment[] {
  const refs: ImageAttachment[] = [];
  for (const msg of messages) {
    let match: RegExpExecArray | null;
    IMAGE_REF_PATTERN.lastIndex = 0;
    while ((match = IMAGE_REF_PATTERN.exec(msg.content)) !== null) {
      // Always JPEG — processImage() normalizes all images to .jpg
      refs.push({ relativePath: match[1], mediaType: 'image/jpeg' });
    }
  }
  return refs;
}
