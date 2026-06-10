import type { AppSettings } from "./types";

const SETTINGS_KEY = "booCheckSettings";

export const DEFAULT_SETTINGS: AppSettings = {
  baseUrl: "",
  apiKey: "",
  defaultRating: "safe",
  aiModelName: "wd-eva02-large-tagger-v3",
  aiAutoGeneralThreshold: 0.6,
  aiAutoCharacterThreshold: 0.85,
  hideRatingTags: false,
  includePostHashtagsDefault: false,
  closeAfterImport: false,
  clearPanelAfterImportDefault: false,
  misskeyArtistMode: "username-only",
  multiAddCaptureLeftClick: false,
  multiAddCaptureRightClick: true,
  debugMode: false
};

export async function loadSettings(): Promise<AppSettings> {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(result[SETTINGS_KEY]);
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await chrome.storage.local.set({
    [SETTINGS_KEY]: normalizeSettings(settings)
  });
}

export function normalizeSettings(value: Partial<AppSettings> | undefined): AppSettings {
  const legacyValue = value as (Partial<AppSettings> & { closeAfterAiAuto?: boolean }) | undefined;
  const settings = { ...DEFAULT_SETTINGS, ...(value ?? {}) };
  return {
    baseUrl: String(settings.baseUrl ?? "").trim().replace(/\/+$/, ""),
    apiKey: String(settings.apiKey ?? ""),
    defaultRating: isRating(settings.defaultRating) ? settings.defaultRating : DEFAULT_SETTINGS.defaultRating,
    aiModelName: String(settings.aiModelName ?? DEFAULT_SETTINGS.aiModelName).trim() || DEFAULT_SETTINGS.aiModelName,
    aiAutoGeneralThreshold: clampNumber(settings.aiAutoGeneralThreshold, 0, 1, DEFAULT_SETTINGS.aiAutoGeneralThreshold),
    aiAutoCharacterThreshold: clampNumber(settings.aiAutoCharacterThreshold, 0, 1, DEFAULT_SETTINGS.aiAutoCharacterThreshold),
    hideRatingTags: Boolean(settings.hideRatingTags),
    includePostHashtagsDefault: Boolean(settings.includePostHashtagsDefault),
    closeAfterImport: Boolean(legacyValue?.closeAfterImport ?? legacyValue?.closeAfterAiAuto ?? DEFAULT_SETTINGS.closeAfterImport),
    clearPanelAfterImportDefault: Boolean(settings.clearPanelAfterImportDefault),
    misskeyArtistMode: isMisskeyArtistMode(settings.misskeyArtistMode) ? settings.misskeyArtistMode : DEFAULT_SETTINGS.misskeyArtistMode,
    multiAddCaptureLeftClick: settingBoolean(settings.multiAddCaptureLeftClick, DEFAULT_SETTINGS.multiAddCaptureLeftClick),
    multiAddCaptureRightClick: settingBoolean(settings.multiAddCaptureRightClick, DEFAULT_SETTINGS.multiAddCaptureRightClick),
    debugMode: Boolean(settings.debugMode)
  };
}

function isRating(value: unknown): value is AppSettings["defaultRating"] {
  return value === "safe" || value === "questionable" || value === "explicit";
}

function isMisskeyArtistMode(value: unknown): value is AppSettings["misskeyArtistMode"] {
  return value === "append-domain" || value === "username-only" || value === "domain-tag";
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

function settingBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}
