const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/avif": ".avif",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "video/x-m4v": ".m4v"
};

export type StableFileResult = {
  file: File;
  sha256: string;
  mimeType: string;
};

export async function fetchMediaAsStableFile(url: string, init: RequestInit = {}): Promise<StableFileResult> {
  const response = await fetch(url, {
    credentials: "include",
    referrerPolicy: "no-referrer",
    ...init
  });

  if (!response.ok) {
    throw new Error(`Media fetch failed (${response.status}) for ${url}`);
  }

  const blob = await response.blob();
  const responseMimeType = response.headers.get("content-type")?.split(";")[0]?.trim() || "";
  return stableFileFromBlob(url, blob, responseMimeType);
}

export async function stableFileFromBlob(url: string, blob: Blob, responseMimeType = ""): Promise<StableFileResult> {
  const detectedMimeType = await validateMediaBlob(blob, responseMimeType, url);
  const sha256 = await sha256Blob(blob);
  const mimeType = detectedMimeType || blob.type || responseMimeType;
  const extension = extensionFromMime(mimeType) || extensionFromUrl(url) || ".bin";
  const file = new File([blob], `${sha256}${extension}`, {
    type: mimeType || blob.type || "application/octet-stream"
  });

  return { file, sha256, mimeType };
}

export async function sha256Blob(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function extensionFromMime(mimeType: string): string | undefined {
  return MIME_EXTENSIONS[mimeType.toLowerCase()];
}

async function validateMediaBlob(blob: Blob, responseMimeType: string, url: string): Promise<string | undefined> {
  const mimeType = normalizeMimeType(blob.type || responseMimeType);
  if (mimeType && extensionFromMime(mimeType)) return mimeType;
  if (mimeType && isClearlyNonMediaMime(mimeType)) {
    throw new Error(`Media URL returned ${mimeType} for ${url}`);
  }

  const signatureMimeType = await mediaMimeTypeFromSignature(blob);
  if (signatureMimeType) return signatureMimeType;

  throw new Error(
    mimeType
      ? `Media URL returned unsupported content type ${mimeType} for ${url}`
      : `Media URL did not return a recognizable media file for ${url}`
  );
}

function normalizeMimeType(value: string | undefined): string {
  return value?.split(";")[0]?.trim().toLowerCase() ?? "";
}

function isClearlyNonMediaMime(mimeType: string): boolean {
  return mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/xml" ||
    mimeType === "application/xhtml+xml";
}

async function mediaMimeTypeFromSignature(blob: Blob): Promise<string | undefined> {
  const bytes = new Uint8Array(await blob.slice(0, 32).arrayBuffer());
  if (bytes.length < 4) return undefined;

  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (matchesBytes(bytes, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (matchesAscii(bytes, 0, "GIF87a") || matchesAscii(bytes, 0, "GIF89a")) return "image/gif";
  if (matchesAscii(bytes, 0, "RIFF") && matchesAscii(bytes, 8, "WEBP")) return "image/webp";
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    if (matchesAscii(bytes, 8, "avif") || matchesAscii(bytes, 8, "avis")) return "image/avif";
    if (matchesAscii(bytes, 8, "qt  ")) return "video/quicktime";
    return "video/mp4";
  }
  if (matchesBytes(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm";

  return undefined;
}

function matchesBytes(bytes: Uint8Array, expected: number[]): boolean {
  if (bytes.length < expected.length) return false;
  return expected.every((byte, index) => bytes[index] === byte);
}

function matchesAscii(bytes: Uint8Array, offset: number, expected: string): boolean {
  if (bytes.length < offset + expected.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[offset + index] !== expected.charCodeAt(index)) return false;
  }
  return true;
}

function extensionFromUrl(url: string): string | undefined {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.(jpe?g|png|webp|gif|mp4|webm)$/i);
    return match ? `.${match[1].toLowerCase().replace("jpeg", "jpg")}` : undefined;
  } catch {
    return undefined;
  }
}
