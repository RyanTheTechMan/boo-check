import type { AiTagPrediction, AppSettings, Rating, TagSuggestion } from "../types";
import { normalizeCategory, normalizeTag } from "../utils/tags";

export const BLOMBOORU_ENDPOINTS = {
  uploadMedia: "/api/media/",
  media: (mediaId: string | number) => `/api/media/${encodeURIComponent(String(mediaId))}`,
  aiPredict: (mediaId: string | number) => `/api/ai-tagger/predict/${encodeURIComponent(String(mediaId))}`,
  tagAutocomplete: "/api/tags/autocomplete",
  tag: (name: string) => `/api/tags/${encodeURIComponent(name)}`,
  tags: "/api/tags/",
  booruImportFetch: "/api/booru-import/fetch",
  booruImportDownload: "/api/booru-import/download",
  booruImportProxyImage: "/api/booru-import/proxy-image"
};

export type UploadMediaInput = {
  file: File;
  rating: Rating;
  source: string;
  tags: string[];
  categoryHints: Record<string, string>;
};

export type UploadMediaResult = {
  id?: string;
  link?: string;
  raw: unknown;
};

export type PatchMediaInput = {
  tags: string[];
  rating: Rating;
  source: string;
  categoryHints?: Record<string, string>;
};

export type BooruImportTag = {
  name: string;
  category?: string;
  isNew?: boolean;
  userAssigned?: boolean;
};

export type BooruImportPost = {
  fileUrl?: string;
  previewUrl?: string;
  filename?: string;
  rating: Rating;
  source?: string;
  booruUrl?: string;
  width?: number;
  height?: number;
  fileSize?: number;
  tags: BooruImportTag[];
  raw: unknown;
};

export type DownloadBooruImportInput = {
  url: string;
  tags: string[];
  rating: Rating;
  source: string;
  autoCreateTags: boolean;
  categoryHints: Record<string, string>;
};

export class BlombooruApiError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "BlombooruApiError";
    this.status = status;
  }
}

export class BlombooruDuplicateError extends BlombooruApiError {
  readonly result?: UploadMediaResult;

  constructor(result?: UploadMediaResult) {
    super("Already imported", 409);
    this.name = "BlombooruDuplicateError";
    this.result = result;
  }
}

export class BlombooruAuthError extends BlombooruApiError {
  constructor(status: number) {
    super("Blombooru rejected the API key or authorization.", status);
    this.name = "BlombooruAuthError";
  }
}

export class BlombooruApi {
  private tagCreationUnsupported = false;

  constructor(private readonly settings: AppSettings) {}

  booruImportProxyImageUrl(imageUrl: string | undefined): string | undefined {
    if (!imageUrl || !this.settings.baseUrl) return undefined;

    try {
      const url = new URL(BLOMBOORU_ENDPOINTS.booruImportProxyImage, `${this.settings.baseUrl}/`);
      url.searchParams.set("url", imageUrl);
      return url.href;
    } catch {
      return undefined;
    }
  }

  async fetchBooruImport(url: string): Promise<BooruImportPost> {
    const response = await this.fetchRaw(BLOMBOORU_ENDPOINTS.booruImportFetch, {
      method: "POST",
      json: { url },
      authRequired: false,
      credentials: "include"
    });

    const raw = await readJsonSafely(response);
    if (response.status === 401 || response.status === 403) throw new BlombooruAuthError(response.status);
    if (!response.ok) throw new BlombooruApiError(errorMessageFromRaw(raw, `Booru fetch failed (${response.status}).`), response.status);
    return normalizeBooruImportPost(raw);
  }

  async downloadBooruImport(input: DownloadBooruImportInput): Promise<UploadMediaResult> {
    const response = await this.fetchRaw(BLOMBOORU_ENDPOINTS.booruImportDownload, {
      method: "POST",
      json: {
        url: input.url,
        tags: input.tags,
        rating: input.rating,
        source: input.source,
        auto_create_tags: input.autoCreateTags,
        category_hints: input.categoryHints
      },
      authRequired: false,
      credentials: "include"
    });

    const raw = await readJsonSafely(response);
    const result = normalizeUploadResult(raw, this.settings.baseUrl);
    const errorMessage = errorMessageFromRaw(raw, `Booru import failed (${response.status}).`);

    if (response.status === 409 || /duplicate|already exists|already imported/i.test(errorMessage)) {
      throw new BlombooruDuplicateError(result);
    }
    if (response.status === 401 || response.status === 403) throw new BlombooruAuthError(response.status);
    if (!response.ok) throw new BlombooruApiError(errorMessage, response.status);

    return result;
  }

  async autocomplete(query: string): Promise<TagSuggestion[]> {
    const q = query.trim();
    if (!q) return [];

    const first = await this.fetchRaw(BLOMBOORU_ENDPOINTS.tagAutocomplete, {
      method: "GET",
      searchParams: { q }
    });

    if (first.ok) return parseAutocomplete(await readJsonSafely(first));
    if (first.status === 401 || first.status === 403) throw new BlombooruAuthError(first.status);

    const second = await this.fetchRaw(BLOMBOORU_ENDPOINTS.tagAutocomplete, {
      method: "GET",
      searchParams: { query: q }
    });

    if (second.ok) return parseAutocomplete(await readJsonSafely(second));
    if (second.status === 401 || second.status === 403) throw new BlombooruAuthError(second.status);
    return [];
  }

  async lookupTag(name: string): Promise<TagSuggestion | undefined> {
    const normalized = normalizeTag(name);
    if (!normalized) return undefined;

    const response = await this.fetchRaw(BLOMBOORU_ENDPOINTS.tag(normalized), {
      method: "GET"
    });

    if (response.status === 404) return undefined;
    if (response.status === 401 || response.status === 403) throw new BlombooruAuthError(response.status);
    if (!response.ok) return undefined;
    return parseTagSuggestion(await readJsonSafely(response));
  }

  async uploadMedia(input: UploadMediaInput): Promise<UploadMediaResult> {
    const form = new FormData();
    form.append("file", input.file);
    form.append("rating", input.rating);
    form.append("source", input.source);
    form.append("tags", input.tags.join(" "));
    form.append("category_hints", JSON.stringify(input.categoryHints));

    const response = await this.fetchRaw(BLOMBOORU_ENDPOINTS.uploadMedia, {
      method: "POST",
      body: form
    });

    const raw = await readJsonSafely(response);
    const result = normalizeUploadResult(raw, this.settings.baseUrl);

    if (response.status === 409) throw new BlombooruDuplicateError(result);
    if (response.status === 401 || response.status === 403) throw new BlombooruAuthError(response.status);
    if (!response.ok) throw new BlombooruApiError(`Upload failed (${response.status}).`, response.status);

    return result;
  }

  async predict(mediaId: string): Promise<AiTagPrediction[]> {
    const body = {
      model_name: this.settings.aiModelName || "wd-eva02-large-tagger-v3",
      general_threshold: 0.35,
      character_threshold: this.settings.aiAutoCharacterThreshold || 0.85,
      hide_rating_tags: this.settings.hideRatingTags ?? false,
      character_tags_first: true
    };

    let response = await this.fetchRaw(BLOMBOORU_ENDPOINTS.aiPredict(mediaId), {
      method: "POST",
      json: body
    });

    if (response.status === 400 || response.status === 422) {
      response = await this.fetchRaw(BLOMBOORU_ENDPOINTS.aiPredict(mediaId), {
        method: "POST",
        json: { model_name: body.model_name }
      });
    }

    const raw = await readJsonSafely(response);
    if (response.status === 401 || response.status === 403) throw new BlombooruAuthError(response.status);
    if (!response.ok) throw new BlombooruApiError(`AI prediction failed (${response.status}).`, response.status);
    return parseAiPredictions(raw);
  }

  async patchMedia(mediaId: string, input: PatchMediaInput): Promise<UploadMediaResult> {
    const nativeBody: Record<string, unknown> = {
      tags: input.tags,
      rating: input.rating,
      source: input.source
    };

    let response = await this.fetchRaw(BLOMBOORU_ENDPOINTS.media(mediaId), {
      method: "PATCH",
      json: nativeBody
    });

    if (response.status === 400 || response.status === 422) {
      const legacyBody: Record<string, unknown> = {
        tags: input.tags.join(" "),
        rating: input.rating,
        source: input.source
      };

      if (input.categoryHints && Object.keys(input.categoryHints).length > 0) {
        legacyBody.category_hints = input.categoryHints;
      }

      response = await this.fetchRaw(BLOMBOORU_ENDPOINTS.media(mediaId), {
        method: "PATCH",
        json: legacyBody
      });
    }

    const raw = await readJsonSafely(response);
    if (response.status === 401 || response.status === 403) throw new BlombooruAuthError(response.status);
    if (!response.ok) throw new BlombooruApiError(`Saving final tags failed (${response.status}).`, response.status);
    return normalizeUploadResult(raw, this.settings.baseUrl);
  }

  async ensureTagsWithCategories(categoryHints: Record<string, string>): Promise<void> {
    if (this.tagCreationUnsupported) return;

    for (const [rawName, rawCategory] of Object.entries(categoryHints)) {
      const name = normalizeTag(rawName);
      const category = normalizeCategory(rawCategory);
      if (!name || !isWritableTagCategory(category)) continue;

      const response = await this.fetchRaw(BLOMBOORU_ENDPOINTS.tags, {
        method: "POST",
        json: { name, category }
      });

      if (response.ok || response.status === 409) continue;
      if (response.status === 404 || response.status === 405) {
        this.tagCreationUnsupported = true;
        return;
      }
      if (response.status === 401 || response.status === 403) throw new BlombooruAuthError(response.status);
    }
  }

  private async fetchRaw(
    path: string,
    options: {
      method: "GET" | "POST" | "PATCH";
      searchParams?: Record<string, string>;
      json?: unknown;
      body?: BodyInit;
      authRequired?: boolean;
      credentials?: RequestCredentials;
    }
  ): Promise<Response> {
    if (!this.settings.baseUrl) throw new BlombooruApiError("Missing Blombooru base URL.");
    if (options.authRequired !== false && !this.settings.apiKey) throw new BlombooruApiError("Missing Blombooru API key.");

    const url = new URL(path, `${this.settings.baseUrl}/`);
    for (const [key, value] of Object.entries(options.searchParams ?? {})) {
      url.searchParams.set(key, value);
    }

    const headers = new Headers();
    if (this.settings.apiKey) {
      headers.set("Authorization", `Bearer ${this.settings.apiKey}`);
    }
    if (options.json !== undefined) {
      headers.set("Content-Type", "application/json");
    }

    return fetch(url.href, {
      method: options.method,
      headers,
      body: options.json !== undefined ? JSON.stringify(options.json) : options.body,
      credentials: options.credentials
    });
  }
}

function isWritableTagCategory(category: string): boolean {
  return ["general", "artist", "character", "copyright", "meta"].includes(category);
}

export function extractMediaId(raw: unknown): string | undefined {
  const value = raw as Record<string, unknown> | undefined;
  const candidates = [
    value?.id,
    value?.media_id,
    nested(value, ["media", "id"]),
    nested(value, ["item", "id"]),
    nested(value, ["data", "id"]),
    nested(value, ["data", "media", "id"])
  ];

  const candidate = candidates.find((item) => typeof item === "string" || typeof item === "number");
  return candidate === undefined ? undefined : String(candidate);
}

function normalizeUploadResult(raw: unknown, baseUrl: string): UploadMediaResult {
  const id = extractMediaId(raw);
  return {
    id,
    link: extractMediaLink(raw, baseUrl, id),
    raw
  };
}

function normalizeBooruImportPost(raw: unknown): BooruImportPost {
  const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    fileUrl: stringValue(value.file_url) || stringValue(value.fileUrl),
    previewUrl: stringValue(value.preview_url) || stringValue(value.previewUrl),
    filename: stringValue(value.filename) || stringValue(value.file_name) || stringValue(value.fileName),
    rating: normalizeBooruImportRating(value.rating),
    source: stringValue(value.source),
    booruUrl: stringValue(value.booru_url) || stringValue(value.booruUrl) || stringValue(value.post_url) || stringValue(value.postUrl),
    width: numberValue(value.width),
    height: numberValue(value.height),
    fileSize: numberValue(value.file_size) ?? numberValue(value.fileSize),
    tags: firstArray(value.tags, []).map(parseBooruImportTag).filter((tag): tag is BooruImportTag => Boolean(tag)),
    raw
  };
}

function parseBooruImportTag(item: unknown): BooruImportTag | undefined {
  if (typeof item === "string") {
    const name = normalizeTag(item);
    return name ? { name } : undefined;
  }
  if (!item || typeof item !== "object") return undefined;

  const record = item as Record<string, unknown>;
  const name = normalizeTag(stringValue(record.name) || stringValue(record.tag) || stringValue(record.value));
  if (!name) return undefined;

  return {
    name,
    category: normalizeCategory(stringValue(record.category) || stringValue(record.type)),
    isNew: booleanValue(record.is_new) ?? booleanValue(record.isNew),
    userAssigned: booleanValue(record.user_assigned) ?? booleanValue(record.userAssigned)
  };
}

function normalizeBooruImportRating(value: unknown): Rating {
  const normalized = stringValue(value)?.toLowerCase();
  if (normalized === "explicit" || normalized === "e") return "explicit";
  if (normalized === "questionable" || normalized === "q" || normalized === "sensitive") return "questionable";
  return "safe";
}

function errorMessageFromRaw(raw: unknown, fallback: string): string {
  const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : undefined;
  return stringValue(record?.detail) || stringValue(record?.message) || stringValue(record?.error) || fallback;
}

function extractMediaLink(raw: unknown, baseUrl: string, id?: string): string | undefined {
  const value = raw as Record<string, unknown> | undefined;
  const candidates = [
    value?.url,
    value?.link,
    value?.view_url,
    value?.media_url,
    nested(value, ["media", "url"]),
    nested(value, ["media", "link"]),
    nested(value, ["media", "view_url"]),
    nested(value, ["item", "url"]),
    nested(value, ["data", "url"])
  ];

  const candidate = candidates.find((item) => typeof item === "string");
  if (typeof candidate === "string") {
    try {
      return new URL(candidate, `${baseUrl}/`).href;
    } catch {
      return candidate;
    }
  }

  if (!id) return undefined;
  try {
    return new URL(`/media/${encodeURIComponent(id)}`, `${baseUrl}/`).href;
  } catch {
    return undefined;
  }
}

function parseAutocomplete(raw: unknown): TagSuggestion[] {
  const values = firstArray(raw, ["tags", "results", "suggestions", "items", "data"]);
  return values
    .map(parseTagSuggestion)
    .filter((item): item is TagSuggestion => Boolean(item));
}

function parseTagSuggestion(item: unknown): TagSuggestion | undefined {
  if (typeof item === "string") return { name: item };
  if (!item || typeof item !== "object") return undefined;
  const record = item as Record<string, unknown>;
  const name = stringValue(record.name) || stringValue(record.tag) || stringValue(record.value) || stringValue(record.label);
  if (!name) return undefined;
  const category = stringValue(record.category) || stringValue(record.type);
  const postCount = numberValue(record.post_count) ?? numberValue(record.postCount) ?? numberValue(record.count);
  return { name, category, postCount };
}

function parseAiPredictions(raw: unknown): AiTagPrediction[] {
  const container = (raw as Record<string, unknown> | undefined) ?? {};
  const candidate =
    container.tags ??
    container.predictions ??
    container.results ??
    nested(container, ["data", "tags"]) ??
    nested(container, ["data", "predictions"]) ??
    raw;

  return flattenPredictionValue(candidate).filter((tag) => normalizeTag(tag.name));
}

function flattenPredictionValue(value: unknown, category?: string): AiTagPrediction[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => flattenPredictionValue(item, category));
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  const directName = stringValue(record.name) || stringValue(record.tag) || stringValue(record.label) || stringValue(record.value);
  if (directName) {
    return [
      {
        name: directName,
        category: stringValue(record.category) || stringValue(record.type) || category,
        confidence:
          numberValue(record.confidence) ??
          numberValue(record.score) ??
          numberValue(record.probability) ??
          numberValue(record.prob)
      }
    ];
  }

  return Object.entries(record).flatMap(([key, nestedValue]) => {
    if (typeof nestedValue === "number") {
      return [{ name: key, category, confidence: nestedValue }];
    }
    if (Array.isArray(nestedValue)) {
      return nestedValue.flatMap((item) => flattenPredictionValue(item, key));
    }
    if (nestedValue && typeof nestedValue === "object") {
      const nestedRecord = nestedValue as Record<string, unknown>;
      if ("confidence" in nestedRecord || "score" in nestedRecord || "probability" in nestedRecord) {
        return [
          {
            name: key,
            category: stringValue(nestedRecord.category) || category,
            confidence:
              numberValue(nestedRecord.confidence) ??
              numberValue(nestedRecord.score) ??
              numberValue(nestedRecord.probability) ??
              numberValue(nestedRecord.prob)
          }
        ];
      }
      return flattenPredictionValue(nestedValue, key);
    }
    return [];
  });
}

function firstArray(raw: unknown, keys: string[]): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return [];

  const record = raw as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }

  return [];
}

async function readJsonSafely(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function nested(record: Record<string, unknown> | undefined, path: string[]): unknown {
  let value: unknown = record;
  for (const part of path) {
    if (!value || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) ? number : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes"].includes(normalized)) return true;
  if (["false", "0", "no"].includes(normalized)) return false;
  return undefined;
}
