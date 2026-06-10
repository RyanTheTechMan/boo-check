import { DEFAULT_SETTINGS, loadSettings, normalizeSettings, saveSettings } from "./settings";
import type { AppSettings } from "./types";

const fields = {
  status: document.getElementById("status") as HTMLDivElement,
  baseUrl: document.getElementById("baseUrlSetting") as HTMLInputElement,
  apiKey: document.getElementById("apiKeySetting") as HTMLInputElement,
  defaultRating: document.getElementById("defaultRatingSetting") as HTMLSelectElement,
  aiModel: document.getElementById("aiModelSetting") as HTMLInputElement,
  generalThreshold: document.getElementById("generalThresholdSetting") as HTMLInputElement,
  characterThreshold: document.getElementById("characterThresholdSetting") as HTMLInputElement,
  hideRatingTags: document.getElementById("hideRatingTagsSetting") as HTMLInputElement,
  includePostHashtagsDefault: document.getElementById("includePostHashtagsDefaultSetting") as HTMLInputElement,
  closeAfterImport: document.getElementById("closeAfterImportSetting") as HTMLInputElement,
  clearPanelAfterImportDefault: document.getElementById("clearPanelAfterImportDefaultSetting") as HTMLInputElement,
  misskeyArtistMode: document.getElementById("misskeyArtistModeSetting") as HTMLSelectElement,
  sidePanelImageBlurMode: document.getElementById("sidePanelImageBlurModeSetting") as HTMLSelectElement,
  multiAddCaptureLeftClick: document.getElementById("multiAddCaptureLeftClickSetting") as HTMLInputElement,
  multiAddCaptureRightClick: document.getElementById("multiAddCaptureRightClickSetting") as HTMLInputElement,
  debugMode: document.getElementById("debugModeSetting") as HTMLInputElement,
  save: document.getElementById("saveSettingsButton") as HTMLButtonElement,
  saveFeedback: document.getElementById("settingsSaveFeedback") as HTMLSpanElement
};

void init();

async function init(): Promise<void> {
  renderSettings(await loadSettings());
  fields.save.addEventListener("click", () => void persistSettings());
}

function renderSettings(settings: AppSettings): void {
  fields.baseUrl.value = settings.baseUrl;
  fields.apiKey.value = settings.apiKey;
  fields.defaultRating.value = settings.defaultRating;
  fields.aiModel.value = settings.aiModelName || DEFAULT_SETTINGS.aiModelName;
  fields.generalThreshold.value = String(settings.aiAutoGeneralThreshold);
  fields.characterThreshold.value = String(settings.aiAutoCharacterThreshold);
  fields.hideRatingTags.checked = settings.hideRatingTags;
  fields.includePostHashtagsDefault.checked = settings.includePostHashtagsDefault;
  fields.closeAfterImport.checked = settings.closeAfterImport;
  fields.clearPanelAfterImportDefault.checked = settings.clearPanelAfterImportDefault;
  fields.misskeyArtistMode.value = settings.misskeyArtistMode;
  fields.sidePanelImageBlurMode.value = settings.sidePanelImageBlurMode;
  fields.multiAddCaptureLeftClick.checked = settings.multiAddCaptureLeftClick;
  fields.multiAddCaptureRightClick.checked = settings.multiAddCaptureRightClick;
  fields.debugMode.checked = settings.debugMode;
}

async function persistSettings(): Promise<void> {
  const settings = normalizeSettings({
    baseUrl: fields.baseUrl.value,
    apiKey: fields.apiKey.value,
    defaultRating: fields.defaultRating.value as AppSettings["defaultRating"],
    aiModelName: fields.aiModel.value,
    aiAutoGeneralThreshold: Number(fields.generalThreshold.value),
    aiAutoCharacterThreshold: Number(fields.characterThreshold.value),
    hideRatingTags: fields.hideRatingTags.checked,
    includePostHashtagsDefault: fields.includePostHashtagsDefault.checked,
    closeAfterImport: fields.closeAfterImport.checked,
    clearPanelAfterImportDefault: fields.clearPanelAfterImportDefault.checked,
    misskeyArtistMode: fields.misskeyArtistMode.value as AppSettings["misskeyArtistMode"],
    sidePanelImageBlurMode: fields.sidePanelImageBlurMode.value as AppSettings["sidePanelImageBlurMode"],
    multiAddCaptureLeftClick: fields.multiAddCaptureLeftClick.checked,
    multiAddCaptureRightClick: fields.multiAddCaptureRightClick.checked,
    debugMode: fields.debugMode.checked
  });

  await saveSettings(settings);
  renderSettings(settings);
  showSavedFeedback();
  setStatus("Settings saved.", "success");
}

function setStatus(message: string, tone: "success" | "error" | "info" = "info"): void {
  fields.status.textContent = message;
  fields.status.className = `status visible ${tone === "info" ? "" : tone}`;
}

function showSavedFeedback(): void {
  const originalText = fields.save.textContent ?? "Save Settings";
  fields.save.textContent = "Saved";
  fields.saveFeedback.textContent = "Settings saved";
  window.setTimeout(() => {
    fields.save.textContent = originalText;
    fields.saveFeedback.textContent = "";
  }, 1800);
}
