"use strict";
/**
 * Shared validation for image attachments sent with a prompt.
 *
 * Every connector receives the same browser payload — `[{ data, mimeType }]`
 * where `data` may still carry a `data:` URL prefix — and each vendor wants a
 * different shape. Normalizing once here keeps the size, count and MIME limits
 * identical across agents instead of letting each adapter drift.
 */

const MAX_IMAGES = 4;
// Base64 expands bytes by about 4/3, so this admits roughly a 6 MB source
// image. The browser already downscales to 1800px before upload.
const MAX_BASE64_BYTES = 8 * 1024 * 1024;
const ALLOWED_MIME = /^image\/(jpeg|png|webp|gif)$/i;

/** Strips an optional `data:` URL prefix and rejects non-base64 payloads. */
function base64Payload(value) {
  const raw = String(value ?? "").replace(/^data:[^,]*,/, "").trim();
  if (!raw || raw.length > MAX_BASE64_BYTES) return null;
  // A stray quote or angle bracket means this is not a base64 body; refuse it
  // rather than forwarding something a vendor CLI might interpret.
  return /^[A-Za-z0-9+/=\r\n]+$/.test(raw) ? raw.replace(/[\r\n]/g, "") : null;
}

/**
 * @returns {{ data: string, mimeType: string }[]} bounded, validated images.
 * Invalid entries are dropped rather than failing the whole prompt: a usable
 * text message must not be lost because one attachment was malformed.
 */
function normalizeImages(images) {
  if (!Array.isArray(images) || !images.length) return [];
  const result = [];
  // Bound the scan so a huge array cannot cost unbounded work, but count the
  // limit against accepted images. Otherwise a few malformed leading entries
  // would silently discard the valid attachments behind them.
  for (const image of images.slice(0, MAX_IMAGES * 8)) {
    if (result.length >= MAX_IMAGES) break;
    if (!image || typeof image !== "object") continue;
    const data = base64Payload(image.data);
    if (!data) continue;
    const mimeType = typeof image.mimeType === "string" && ALLOWED_MIME.test(image.mimeType)
      ? image.mimeType.toLowerCase() : "image/jpeg";
    result.push({ data, mimeType });
  }
  return result;
}

/** Agent Client Protocol content blocks (Cline, Kilo, Hermes, Grok). */
function acpImageBlocks(images) {
  return normalizeImages(images).map(({ data, mimeType }) => ({ type: "image", data, mimeType }));
}

/** Anthropic message content blocks (Claude Code stream-json). */
function claudeImageBlocks(images) {
  return normalizeImages(images).map(({ data, mimeType }) => ({
    type: "image",
    source: { type: "base64", media_type: mimeType, data },
  }));
}

/** OpenCode message parts. */
function openCodeImageParts(images) {
  return normalizeImages(images).map(({ data, mimeType }) => ({
    type: "file",
    mime: mimeType,
    url: `data:${mimeType};base64,${data}`,
  }));
}

module.exports = {
  MAX_IMAGES,
  MAX_BASE64_BYTES,
  normalizeImages,
  acpImageBlocks,
  claudeImageBlocks,
  openCodeImageParts,
};
