// Turn classified Postmark attachments into Anthropic content blocks.
//
// Postmark base64-encodes the file in `Content`; `ContentLength` is the
// decoded byte count.
//
// PDFs pass through as-is. Images larger than ~4.5 MB get compressed in
// memory (resize + JPEG re-encode) so they slip under Anthropic's 5 MiB
// per-image hard limit. The compressed version is sent to the model
// only — the original is still preserved in inbound-log and in the
// archived documents folder. See parser/compress.js.

import { maybeCompressForVision } from "./compress.js";

// Hard ceiling well above what phone photos produce. Above this we still
// reject as "oversize" — we trust the upload/triage stages caught it,
// this is a defense-in-depth backstop.
const HARD_LIMIT_BYTES = 30 * 1024 * 1024;

export async function buildContentBlocks(attachments) {
  const blocks = [];
  const oversize = [];
  const compressed = [];

  for (const att of attachments) {
    if (typeof att.Content !== "string" || att.Content.length === 0) continue;
    if (typeof att.ContentLength === "number" && att.ContentLength > HARD_LIMIT_BYTES) {
      oversize.push({ name: att.Name, bytes: att.ContentLength });
      continue;
    }

    if (att._kind === "pdf") {
      blocks.push({
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: att.Content,
        },
      });
    } else if (att._kind === "image") {
      const sourceMediaType = att.ContentType.split(";")[0].trim().toLowerCase();
      try {
        const result = await maybeCompressForVision(att.Content, sourceMediaType);
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: result.media_type,
            data: result.data,
          },
        });
        if (result.compressed) {
          compressed.push({
            name: att.Name,
            original_bytes: result.original_bytes,
            output_bytes: result.output_bytes,
            source_media_type: sourceMediaType,
            output_media_type: result.media_type,
          });
        }
      } catch (err) {
        // If compression fails (corrupt image, sharp can't decode, etc.),
        // skip the attachment rather than blowing up the whole parse.
        oversize.push({ name: att.Name, bytes: att.ContentLength, error: err.message });
      }
    }
  }
  return { blocks, oversize, compressed };
}
