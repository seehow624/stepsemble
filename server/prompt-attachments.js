"use strict";
/**
 * Shared validation for image attachments sent with a prompt.
 *
 * Every connector receives the same browser payload — `[{ data, mimeType }]`
 * where `data` may still carry a `data:` URL prefix — and each vendor wants a
 * different shape. Normalizing once here keeps the validation identical across
 * agents; only the count and total-size budget differ per connector.
 */

// Anthropic's Messages API accepts up to 100 images per request, which is the
// largest documented per-prompt allowance among the connected agents. No
// connector may exceed it; the others use DEFAULT_IMAGE_LIMIT because their
// vendors publish no per-prompt number.
const MAX_IMAGES = 100;
const DEFAULT_IMAGE_LIMIT = 20;
const IMAGE_LIMITS = Object.freeze({ claude: MAX_IMAGES, codex: DEFAULT_IMAGE_LIMIT, pi: DEFAULT_IMAGE_LIMIT,
  opencode: DEFAULT_IMAGE_LIMIT, acp: DEFAULT_IMAGE_LIMIT });
// Base64 expands bytes by about 4/3, so this admits roughly a 6 MB source
// image. The browser already downscales to 1800px before upload.
const MAX_BASE64_BYTES = 8 * 1024 * 1024;
// One prompt carries at most this much image data. It keeps a Claude request
// below the API's 32 MB body limit, and every transport frame is sized to
// carry it plus the 1 MiB text allowance. ACP agents read their prompt as a
// single stdin line of unknown capacity, so they get a smaller budget.
const MAX_TOTAL_BASE64_BYTES = 24 * 1024 * 1024;
const ACP_TOTAL_BASE64_BYTES = 10 * 1024 * 1024;
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
 * text message must not be lost because one attachment was malformed. Images
 * keep their order; the first one that would exceed the count or total-size
 * budget ends the list, so the result is always a prefix of what was sent.
 */
function normalizeImages(images, { limit = DEFAULT_IMAGE_LIMIT, totalBytes = MAX_TOTAL_BASE64_BYTES } = {}) {
  if (!Array.isArray(images) || !images.length) return [];
  const maxImages = Math.max(0, Math.min(MAX_IMAGES, Math.floor(Number(limit) || 0)));
  const budget = Math.max(0, Math.min(MAX_TOTAL_BASE64_BYTES, Math.floor(Number(totalBytes) || 0)));
  const result = [];
  let used = 0;
  // Bound the scan so a huge array cannot cost unbounded work, but count the
  // limit against accepted images. Otherwise a few malformed leading entries
  // would silently discard the valid attachments behind them.
  for (const image of images.slice(0, MAX_IMAGES * 2)) {
    if (result.length >= maxImages) break;
    if (!image || typeof image !== "object") continue;
    const data = base64Payload(image.data);
    if (!data) continue;
    if (used + data.length > budget) break;
    used += data.length;
    const mimeType = typeof image.mimeType === "string" && ALLOWED_MIME.test(image.mimeType)
      ? image.mimeType.toLowerCase() : "image/jpeg";
    result.push({ data, mimeType });
  }
  return result;
}

/** Agent Client Protocol content blocks (Cline, Kilo, Hermes, Grok). */
function acpImageBlocks(images) {
  return normalizeImages(images, { limit: IMAGE_LIMITS.acp, totalBytes: ACP_TOTAL_BASE64_BYTES })
    .map(({ data, mimeType }) => ({ type: "image", data, mimeType }));
}

/** Anthropic message content blocks (Claude Code stream-json). */
function claudeImageBlocks(images) {
  return normalizeImages(images, { limit: IMAGE_LIMITS.claude }).map(({ data, mimeType }) => ({
    type: "image",
    source: { type: "base64", media_type: mimeType, data },
  }));
}

/** OpenCode message parts. */
function openCodeImageParts(images) {
  return normalizeImages(images, { limit: IMAGE_LIMITS.opencode }).map(({ data, mimeType }) => ({
    type: "file",
    mime: mimeType,
    url: `data:${mimeType};base64,${data}`,
  }));
}

/** Codex app-server user input image blocks. */
function codexImageInputs(images) {
  return normalizeImages(images, { limit: IMAGE_LIMITS.codex }).map(({ data, mimeType }) => ({
    type: "image",
    url: `data:${mimeType};base64,${data}`,
  }));
}

/** Pi RPC prompt images. */
function piImageInputs(images) {
  return normalizeImages(images, { limit: IMAGE_LIMITS.pi }).map(({ data, mimeType }) => ({ type: "image", data, mimeType }));
}

module.exports = {
  MAX_IMAGES,
  DEFAULT_IMAGE_LIMIT,
  IMAGE_LIMITS,
  MAX_BASE64_BYTES,
  MAX_TOTAL_BASE64_BYTES,
  ACP_TOTAL_BASE64_BYTES,
  normalizeImages,
  acpImageBlocks,
  claudeImageBlocks,
  openCodeImageParts,
  codexImageInputs,
  piImageInputs,
};
