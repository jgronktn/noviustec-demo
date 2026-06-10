// Image compression for the Anthropic vision API.
//
// Anthropic enforces a hard 5 MiB per-image limit. Real-world receipt
// photos from phone cameras routinely run 5-12 MB. Rather than rejecting
// the user, we compress oversized images before the API call:
//
//   - resize the long edge to 2400px (max)
//   - re-encode as JPEG quality 80 with mozjpeg
//
// This keeps plenty of detail for OCR-style text reading (Haiku's vision
// can read text at that resolution easily) while bringing a 10 MB phone
// photo down to ~500-800 KB.
//
// Original (uncompressed) bytes still land in inbound-log/upload-*.json
// and in the document archive, so the user's audit trail keeps the
// full-quality file.

import sharp from "sharp";

// Anthropic's "5 MB per image" limit is enforced against the
// BASE64-ENCODED length of the `data` field, not the decoded image
// bytes. Empirically confirmed by a real 400 response:
//   "image.source.base64: image exceeds 5 MB maximum:
//    5268360 bytes > 5242880 bytes"
// where 5,268,360 is the base64 char count, not the JPEG's decoded
// byte count (which was ~3.95 MB).
//
// Base64 inflates by exactly 4/3. So the maximum DECODED size that
// will survive base64 encoding under the cap is roughly 5MiB * 3/4 =
// 3.93 MB. We aim for 85% of that as a comfortable margin (compressed
// JPEGs can sometimes round up slightly), giving us ~3.34 MB decoded
// as the trigger threshold.
const ANTHROPIC_BASE64_LIMIT = 5 * 1024 * 1024; // bytes of base64 text
const MAX_SAFE_DECODED_BYTES = Math.floor((ANTHROPIC_BASE64_LIMIT * 3) / 4); // 3,932,160
const COMPRESS_THRESHOLD = Math.floor(MAX_SAFE_DECODED_BYTES * 0.85); // ~3,342,336

const MAX_DIMENSION_PX = 2400;
const JPEG_QUALITY = 80;

const COMPRESSIBLE_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

/**
 * If an image attachment is over the threshold, return a compressed
 * version (as { data, media_type } ready for an Anthropic image block).
 * Otherwise return the original. PDFs and other non-image MIME types
 * pass through unchanged.
 *
 * @param {string} b64Content - base64-encoded original bytes
 * @param {string} mediaType  - canonical MIME like "image/jpeg"
 * @returns {Promise<{data: string, media_type: string, compressed: boolean, original_bytes: number, output_bytes: number}>}
 */
export async function maybeCompressForVision(b64Content, mediaType) {
  if (!COMPRESSIBLE_MIMES.has(mediaType)) {
    return {
      data: b64Content,
      media_type: mediaType,
      compressed: false,
      original_bytes: 0,
      output_bytes: 0,
    };
  }

  // Decode once to measure + (maybe) re-encode.
  const buf = Buffer.from(b64Content, "base64");
  const originalBytes = buf.length;

  if (originalBytes <= COMPRESS_THRESHOLD) {
    return {
      data: b64Content,
      media_type: mediaType,
      compressed: false,
      original_bytes: originalBytes,
      output_bytes: originalBytes,
    };
  }

  // Compress: respect EXIF orientation (so portrait phone photos stay
  // portrait), cap long edge at MAX_DIMENSION_PX, encode mozjpeg q80.
  let pipeline = sharp(buf, { failOn: "none" }).rotate();
  const meta = await pipeline.metadata();
  const longEdge = Math.max(meta.width ?? 0, meta.height ?? 0);
  if (longEdge > MAX_DIMENSION_PX) {
    pipeline = pipeline.resize({
      width: MAX_DIMENSION_PX,
      height: MAX_DIMENSION_PX,
      fit: "inside",
      withoutEnlargement: true,
    });
  }
  const output = await pipeline.jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toBuffer();

  return {
    data: output.toString("base64"),
    media_type: "image/jpeg", // mozjpeg output, regardless of input format
    compressed: true,
    original_bytes: originalBytes,
    output_bytes: output.length,
  };
}
