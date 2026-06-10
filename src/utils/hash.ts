const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "video/webm": ".webm"
};

export type StableFileResult = {
  file: File;
  sha256: string;
  mimeType: string;
};

export async function fetchMediaAsStableFile(url: string): Promise<StableFileResult> {
  const response = await fetch(url, {
    credentials: "include",
    referrerPolicy: "no-referrer"
  });

  if (!response.ok) {
    throw new Error(`Media fetch failed (${response.status}) for ${url}`);
  }

  const blob = await response.blob();
  const sha256 = await sha256Blob(blob);
  const mimeType = blob.type || response.headers.get("content-type")?.split(";")[0]?.trim() || "";
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

function extensionFromUrl(url: string): string | undefined {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.(jpe?g|png|webp|gif|mp4|webm)$/i);
    return match ? `.${match[1].toLowerCase().replace("jpeg", "jpg")}` : undefined;
  } catch {
    return undefined;
  }
}
