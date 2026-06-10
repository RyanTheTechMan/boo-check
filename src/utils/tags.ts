import type { AiTagPrediction, TagCategory, TagSuggestion } from "../types";

const CATEGORY_PREFIXES = new Set(["artist", "character", "copyright", "meta", "general"]);
const RATING_TAGS = new Set(["safe", "questionable", "explicit", "rating_safe", "rating_questionable", "rating_explicit"]);

export type ParsedTags = {
  tags: string[];
  categoryHints: Record<string, string>;
};

export function normalizeTag(value: string | undefined | null): string {
  if (!value) return "";
  return value
    .trim()
    .replace(/^#+/, "")
    .replace(/^[\s"'`.,;!?()[\]{}<>]+|[\s"'`.,;!?()[\]{}<>]+$/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

export function normalizeCategory(value: string | undefined | null): TagCategory {
  if (!value) return "unknown";
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "_");
  if (normalized === "copy" || normalized === "copyrights") return "copyright";
  if (normalized === "characters") return "character";
  if (normalized === "artists") return "artist";
  if (normalized === "metadata") return "meta";
  return normalized || "unknown";
}

export function parseTagsWithHints(text: string): ParsedTags {
  const categoryHints: Record<string, string> = {};
  const tags: string[] = [];

  for (const rawToken of text.split(/\s+/)) {
    const token = rawToken.trim();
    if (!token) continue;

    const prefixed = token.match(/^([A-Za-z]+):(.+)$/);
    const category = prefixed && CATEGORY_PREFIXES.has(prefixed[1].toLowerCase())
      ? normalizeCategory(prefixed[1])
      : undefined;
    const name = normalizeTag(category ? prefixed?.[2] : token);
    if (!name) continue;

    tags.push(name);
    if (category && category !== "general") {
      categoryHints[name] = category;
    }
  }

  return {
    tags: dedupeTags(tags),
    categoryHints
  };
}

export function dedupeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of tags.map(normalizeTag).filter(Boolean)) {
    if (seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
  }
  return result;
}

export function mergeTags(...groups: Array<Array<string | undefined | null> | undefined>): string[] {
  return dedupeTags(groups.flatMap((group) => group ?? []).filter((value): value is string => Boolean(value)));
}

export function tagText(tags: string[]): string {
  return tags.length ? `${dedupeTags(tags).join(" ")} ` : "";
}

export function isRatingTag(name: string, category?: string): boolean {
  const tag = normalizeTag(name);
  return normalizeCategory(category) === "rating" || RATING_TAGS.has(tag) || tag.startsWith("rating:");
}

export function currentToken(text: string, cursor: number): { token: string; start: number; end: number } {
  let start = cursor;
  while (start > 0 && !/\s/.test(text[start - 1])) start -= 1;
  let end = cursor;
  while (end < text.length && !/\s/.test(text[end])) end += 1;
  return { token: text.slice(start, cursor), start, end };
}

export function replaceCurrentToken(text: string, cursor: number, replacement: string): { text: string; cursor: number } {
  const token = currentToken(text, cursor);
  const normalized = normalizeTag(replacement);
  const prefix = text.slice(0, token.start);
  const suffix = text.slice(token.end).replace(/^\s*/, "");
  const nextText = `${prefix}${normalized} ${suffix}`;
  const nextCursor = prefix.length + normalized.length + 1;
  return { text: nextText, cursor: nextCursor };
}

export function normalizePrediction(prediction: AiTagPrediction): AiTagPrediction | undefined {
  const name = normalizeTag(prediction.name);
  if (!name) return undefined;
  return {
    name,
    category: normalizeCategory(prediction.category),
    confidence: normalizeConfidence(prediction.confidence)
  };
}

export function normalizeSuggestion(suggestion: TagSuggestion): TagSuggestion | undefined {
  const name = normalizeTag(suggestion.name);
  if (!name) return undefined;
  return {
    name,
    category: normalizeCategory(suggestion.category),
    postCount: typeof suggestion.postCount === "number" ? suggestion.postCount : undefined
  };
}

function normalizeConfidence(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value > 1 && value <= 100) return value / 100;
  return Math.max(0, Math.min(1, value));
}
