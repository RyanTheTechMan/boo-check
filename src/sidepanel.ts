import {
  BlombooruApi,
  BlombooruApiError,
  BlombooruAuthError,
  BlombooruDuplicateError,
  type BooruImportPost,
  type UploadMediaResult
} from "./api/blombooru";
import {
  EXTRACT_PAGE_CONTEXT_MESSAGE,
  FETCH_PAGE_BOORU_POST_MESSAGE,
  FETCH_PAGE_MEDIA_MESSAGE,
  IMPORT_QUEUE_STORE_KEY,
  PENDING_IMPORT_KEY,
  SET_MULTI_ADD_AUTO_COLLECT_MESSAGE,
  SET_MULTI_ADD_CAPTURE_MESSAGE,
  SIDE_PANEL_STATE_KEY
} from "./constants";
import { DEFAULT_SETTINGS, loadSettings, normalizeSettings, saveSettings } from "./settings";
import type {
  AiTagPrediction,
  AppSettings,
  ImportDebugSnapshot,
  ImportDraft,
  ImportFormState,
  ImportMediaMetadata,
  ImportQueueItem,
  ImportQueueState,
  ImportQueueStore,
  PendingImport,
  Rating,
  SavedSidePanelState,
  TagSuggestion
} from "./types";
import { fetchMediaAsStableFile, stableFileFromBlob, type StableFileResult } from "./utils/hash";
import {
  commaTagText,
  currentToken,
  isRatingTag,
  mergeTags,
  normalizeCategory,
  normalizePrediction,
  normalizeSuggestion,
  normalizeTag,
  parseCommaSeparatedTags,
  parseTagsWithHints,
  replaceCurrentToken,
  tagText
} from "./utils/tags";

type StatusTone = "info" | "success" | "error";

type ManualState = {
  mediaId: string;
  link?: string;
  predictions: AiTagPrediction[];
  baseTags: string[];
  appliedNames: string[];
};

type UploadedState = {
  mediaId?: string;
  link?: string;
  finalSaved?: boolean;
};

type MediaMetadata = ImportMediaMetadata;

const els = {
  status: byId<HTMLDivElement>("status"),
  clearState: byId<HTMLButtonElement>("clearStateButton"),
  queuePanel: byId<HTMLElement>("queuePanel"),
  queueSummary: byId<HTMLParagraphElement>("queueSummary"),
  multiAddToggle: byId<HTMLButtonElement>("multiAddToggleButton"),
  autoCollectToggle: byId<HTMLButtonElement>("autoCollectToggleButton"),
  importQueue: byId<HTMLButtonElement>("importQueueButton"),
  importQueueAuto: byId<HTMLButtonElement>("importQueueAutoButton"),
  clearQueue: byId<HTMLButtonElement>("clearQueueButton"),
  queueList: byId<HTMLDivElement>("queueList"),
  preview: byId<HTMLDivElement>("preview"),
  mediaMetadata: byId<HTMLDivElement>("mediaMetadata"),
  source: byId<HTMLInputElement>("sourceInput"),
  artist: byId<HTMLInputElement>("artistInput"),
  artistStatus: byId<HTMLDivElement>("artistStatus"),
  artistAutocomplete: byId<HTMLDivElement>("artistAutocomplete"),
  rating: byId<HTMLDivElement>("ratingInput"),
  tags: byId<HTMLTextAreaElement>("tagsInput"),
  includeHashtags: byId<HTMLInputElement>("includeHashtagsInput"),
  chips: byId<HTMLDivElement>("tagChips"),
  autocomplete: byId<HTMLDivElement>("autocomplete"),
  importActions: byId<HTMLElement>("importActions"),
  import: byId<HTMLButtonElement>("importButton"),
  importAuto: byId<HTMLButtonElement>("importAutoButton"),
  importManual: byId<HTMLButtonElement>("importManualButton"),
  manualPanel: byId<HTMLElement>("manualAiPanel"),
  manualSummary: byId<HTMLParagraphElement>("manualAiSummary"),
  manualList: byId<HTMLDivElement>("manualAiList"),
  saveFinal: byId<HTMLButtonElement>("saveFinalButton"),
  settingsPanel: byId<HTMLDetailsElement>("settingsPanel"),
  baseUrl: byId<HTMLInputElement>("baseUrlSetting"),
  apiKey: byId<HTMLInputElement>("apiKeySetting"),
  defaultRating: byId<HTMLSelectElement>("defaultRatingSetting"),
  aiModel: byId<HTMLInputElement>("aiModelSetting"),
  generalThreshold: byId<HTMLInputElement>("generalThresholdSetting"),
  characterThreshold: byId<HTMLInputElement>("characterThresholdSetting"),
  hideRatingTags: byId<HTMLInputElement>("hideRatingTagsSetting"),
  includePostHashtagsDefault: byId<HTMLInputElement>("includePostHashtagsDefaultSetting"),
  closeAfterImport: byId<HTMLInputElement>("closeAfterImportSetting"),
  clearPanelAfterImportDefault: byId<HTMLInputElement>("clearPanelAfterImportDefaultSetting"),
  misskeyArtistMode: byId<HTMLSelectElement>("misskeyArtistModeSetting"),
  fourChanTagMode: byId<HTMLSelectElement>("fourChanTagModeSetting"),
  sidePanelImageBlurMode: byId<HTMLSelectElement>("sidePanelImageBlurModeSetting"),
  multiAddCaptureLeftClick: byId<HTMLInputElement>("multiAddCaptureLeftClickSetting"),
  multiAddCaptureRightClick: byId<HTMLInputElement>("multiAddCaptureRightClickSetting"),
  saveSettings: byId<HTMLButtonElement>("saveSettingsButton"),
  settingsSaveFeedback: byId<HTMLSpanElement>("settingsSaveFeedback"),
  successPopup: byId<HTMLElement>("successPopup"),
  successTitle: byId<HTMLHeadingElement>("successTitle"),
  successMessage: byId<HTMLParagraphElement>("successMessage"),
  successCountdown: byId<HTMLParagraphElement>("successCountdown"),
  successClearPanel: byId<HTMLInputElement>("successClearPanel"),
  successOpenLink: byId<HTMLAnchorElement>("successOpenLink"),
  successStay: byId<HTMLButtonElement>("successStayButton"),
  successClose: byId<HTMLButtonElement>("successCloseButton"),
  debugPanel: byId<HTMLElement>("debugPanel"),
  debugMode: byId<HTMLInputElement>("debugModeSetting"),
  copyDebug: byId<HTMLButtonElement>("copyDebugButton"),
  debugCopyFeedback: byId<HTMLSpanElement>("debugCopyFeedback"),
  debugSummary: byId<HTMLDivElement>("debugSummary"),
  debugPreview: byId<HTMLPreElement>("debugPreview")
};

let settings: AppSettings = DEFAULT_SETTINGS;
let draft: ImportDraft = {};
let pendingTabId: number | undefined;
let manualState: ManualState | undefined;
let uploadedState: UploadedState | undefined;
let busy = false;
let autocompleteTimer: number | undefined;
let autocompleteItems: TagSuggestion[] = [];
let autocompleteIndex = -1;
let artistAutocompleteTimer: number | undefined;
let artistAutocompleteItems: TagSuggestion[] = [];
let artistAutocompleteIndex = -1;
let artistStatusTimer: number | undefined;
let artistStatusRequest = 0;
let closeCountdownTimer: number | undefined;
let settingsFeedbackTimer: number | undefined;
let stateSaveTimer: number | undefined;
let queueSaveTimer: number | undefined;
let pendingCreatedAt = 0;
let latestDebugSnapshot: ImportDebugSnapshot | undefined;
let currentStatusState: SavedSidePanelState["status"] | undefined;
let currentSuccessState: SavedSidePanelState["success"] | undefined;
let mediaMetadata: MediaMetadata | undefined;
let mediaMetadataRequest = 0;
let currentQueue: ImportQueueState | undefined;
let selectedQueueItemId: string | undefined;
let previewObjectUrl: string | undefined;
let previewFailedUrls = new Set<string>();

type BooruImportFetchFailure = {
  status?: number;
  error: string;
  failedAt: number;
};

type PreviewFailureDetail = {
  url: string;
  error: string;
  status?: number;
  contentType?: string;
  responseUrl?: string;
  bodyPreview?: string;
  authAttempted?: boolean;
};

type PageMediaFetchResponse = {
  ok?: boolean;
  url?: string;
  contentType?: string;
  bytes?: number;
  base64?: string;
  error?: string;
};

type PageBooruPostFetchResponse = {
  ok?: boolean;
  url?: string;
  responseUrl?: string;
  contentType?: string;
  bytes?: number;
  tagCount?: number;
  mediaUrl?: string;
  previewUrl?: string;
  draft?: ImportDraft;
  error?: string;
};

type PageContextFetchDetail = {
  url: string;
  responseUrl?: string;
  bytes?: number;
  contentType?: string;
  error?: string;
};

type BooruEnrichmentResult = {
  fetchedWithBlombooru: boolean;
  fetchedWithPageBooruPost: boolean;
  startedPageSessionPostFetch?: boolean;
};

type BooruImportEnrichOptions = {
  timeoutMs?: number;
  cacheFailures?: boolean;
  strategy?: string;
};

type BooruMediaStrategy = "blombooru-native" | "page-session" | "generic-booru";

type ArtistLookupCacheEntry = {
  exists: boolean;
  category?: string;
};

type ArtistStatusResult = ArtistLookupCacheEntry & {
  name: string;
};

class PreviewResponseError extends Error {
  readonly detail: Omit<PreviewFailureDetail, "url" | "error">;

  constructor(message: string, detail: Omit<PreviewFailureDetail, "url" | "error">) {
    super(message);
    this.name = "PreviewResponseError";
    this.detail = detail;
  }
}

let previewFailureDetails: PreviewFailureDetail[] = [];
let pageContextFetchDetails: PageContextFetchDetail[] = [];
const pageContextMediaRequests = new Map<string, Promise<{ url: string; blob: Blob; contentType: string; bytes: number }>>();
const pageContextMediaCache = new Map<string, { url: string; blob: Blob; contentType: string; bytes: number; cachedAt: number }>();
const pageBooruPostEnrichmentRequests = new Map<string, Promise<boolean>>();

const autocompleteCache = new Map<string, TagSuggestion[]>();
const artistAutocompleteCache = new Map<string, TagSuggestion[]>();
const categoryCache = new Map<string, string>();
const artistLookupCache = new Map<string, ArtistLookupCacheEntry>();
const queueMetadataRequests = new Set<string>();
const removedQueueItemIds = new Set<string>();
const queueClearCutoffs = new Map<number, number>();
const booruImportFetchFailures = new Map<string, BooruImportFetchFailure>();
const booruImportFetchRequests = new Map<string, Promise<BooruImportPost>>();
const RATING_VALUES: readonly Rating[] = ["safe", "questionable", "explicit"];
const SIDE_PANEL_DEBUG_BUILD = "booru-strategy-page-session-2026-06-25.10";
const BOORU_IMPORT_FETCH_FAILURE_TTL_MS = 60_000;
const BOORU_IMPORT_FETCH_TIMEOUT_MS = 8000;
const MEDIA_METADATA_FETCH_TIMEOUT_MS = 8000;
const PREVIEW_LOAD_TIMEOUT_MS = 15000;
const BOORU_IMPORT_NO_MEDIA_ID_AI_MESSAGE =
  "Imported, but AI tagging cannot run because Blombooru did not return a media id.";

void init();

async function init(): Promise<void> {
  bindEvents();
  settings = await loadSettings();
  renderSettings(settings);
  els.includeHashtags.checked = settings.includePostHashtagsDefault;
  const restored = await restoreInitialState();
  await loadQueueForCurrentTab();
  const restoredQueueItem = await restoreSelectedQueueItemFromQueue();

  if (!restored && !restoredQueueItem) {
    applyDraftToForm();
    await enrichFromActiveTab();
    applyDraftToForm({ preserveEditedTags: true });
    renderAll();
    const { fetchedWithBlombooru, fetchedWithPageBooruPost } = await enrichFromBooruSources();
    if (!fetchedWithBlombooru && !fetchedWithPageBooruPost) applyFallbackBooruProxyMedia();
    applyDraftToForm({ preserveEditedTags: !(fetchedWithBlombooru || fetchedWithPageBooruPost) });
    renderAll();
  } else {
    renderQueue();
  }

  if (!settings.baseUrl || (!settings.apiKey && !draft.blombooruBooruImport)) {
    els.settingsPanel.open = true;
    setStatus(
      settings.baseUrl
        ? "Add your Blombooru API key before importing unsupported URLs or using AI."
        : "Add your Blombooru base URL and API key before importing.",
      "info"
    );
  }

  renderDebugPanel();
  persistSidePanelStateDebounced();
}

function bindEvents(): void {
  els.saveSettings.addEventListener("click", () => void persistSettings());
  els.clearState.addEventListener("click", () => void clearSidePanelState());
  els.multiAddToggle.addEventListener("click", () => void toggleMultiAddCapture());
  els.autoCollectToggle.addEventListener("click", () => void toggleAutoCollect());
  els.importQueue.addEventListener("click", () => void importQueueNoAi());
  els.importQueueAuto.addEventListener("click", () => void importQueueAiAuto());
  els.clearQueue.addEventListener("click", () => void clearQueue());
  els.import.addEventListener("click", () => void importNoAi());
  els.importAuto.addEventListener("click", () => void importAiAuto());
  els.importManual.addEventListener("click", () => void importAiManual());
  els.saveFinal.addEventListener("click", () => void saveManualFinalTags());
  els.artist.addEventListener("input", () => {
    renderChips();
    scheduleArtistAutocomplete();
    scheduleArtistStatus();
    persistSidePanelStateDebounced();
  });
  els.artist.addEventListener("keydown", handleArtistKeydown);
  els.successStay.addEventListener("click", () => void stayOpenFromSuccessPopup());
  els.successClose.addEventListener("click", () => void dismissSuccessPopup());
  els.successClearPanel.addEventListener("change", persistSuccessClearChoice);
  els.successPopup.addEventListener("click", (event) => {
    if (event.target === els.successPopup) void dismissSuccessPopup();
  });
  els.copyDebug.addEventListener("click", () => void copyDebugReport());
  for (const element of [els.source, els.rating]) {
    element.addEventListener("change", persistSidePanelStateDebounced);
    element.addEventListener("input", persistSidePanelStateDebounced);
  }
  els.tags.addEventListener("input", () => {
    renderChips();
    scheduleAutocomplete();
    persistSidePanelStateDebounced();
  });
  els.tags.addEventListener("keydown", handleTagKeydown);
  els.includeHashtags.addEventListener("change", () => {
    syncHashtagTagsWithToggle();
    renderChips();
    persistSidePanelStateDebounced();
  });
  els.manualList.addEventListener("change", syncManualSelectedTagsToTextbox);
  els.preview.addEventListener("click", handleBlurredImageClick, { capture: true });
  els.queueList.addEventListener("click", handleBlurredImageClick, { capture: true });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !els.successPopup.hidden) void dismissSuccessPopup();
  });
  window.addEventListener("pagehide", () => {
    void persistSelectedQueueItemEditsNow();
    void persistSidePanelStateNow();
  });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "session") return;

    if (changes[IMPORT_QUEUE_STORE_KEY]) {
      void handleQueueStoreChanged(changes[IMPORT_QUEUE_STORE_KEY].newValue as ImportQueueStore | undefined);
    }

    if (changes[PENDING_IMPORT_KEY]) {
      const nextPending = changes[PENDING_IMPORT_KEY].newValue as PendingImport | undefined;
      if (!nextPending?.draft) return;
      const isNewPending = nextPending.createdAt !== pendingCreatedAt || nextPending.tabId !== pendingTabId;
      if (!isNewPending && shouldIgnoreSamePendingDraftUpdate(nextPending.draft)) return;
      selectedQueueItemId = undefined;
      draft = nextPending.draft;
      pendingTabId = nextPending.tabId;
      pendingCreatedAt = nextPending.createdAt;
      if (isNewPending) els.includeHashtags.checked = settings.includePostHashtagsDefault;
      manualState = undefined;
      uploadedState = undefined;
      els.manualPanel.classList.add("hidden");
      renderWorkflowState();
      renderQueue();
      hideSuccessPopup();
      void enrichFromActiveTab().then(async () => {
        applyDraftToForm({ preserveEditedTags: !isNewPending });
        renderAll();
        const { fetchedWithBlombooru, fetchedWithPageBooruPost } = await enrichFromBooruSources();
        if (!fetchedWithBlombooru && !fetchedWithPageBooruPost) applyFallbackBooruProxyMedia();
        applyDraftToForm({ preserveEditedTags: !isNewPending && !(fetchedWithBlombooru || fetchedWithPageBooruPost) });
        renderAll();
        renderDebugPanel();
        if (!fetchedWithBlombooru && !fetchedWithPageBooruPost) setStatus("Loaded new context-menu draft.", "info");
        persistSidePanelStateDebounced();
      });
    }
  });
  document.addEventListener("click", (event) => {
    if (!els.autocomplete.contains(event.target as Node) && event.target !== els.tags) hideAutocomplete();
    if (!els.artistAutocomplete.contains(event.target as Node) && event.target !== els.artist) hideArtistAutocomplete();
  });
}

function getRating(): Rating {
  const selected = els.rating.querySelector<HTMLInputElement>('input[name="rating"]:checked');
  return isRatingValue(selected?.value) ? selected.value : settings.defaultRating;
}

function setRating(value: Rating): void {
  const selected = els.rating.querySelector<HTMLInputElement>(`input[name="rating"][value="${value}"]`);
  if (selected) selected.checked = true;
}

function isRatingValue(value: string | undefined): value is Rating {
  return RATING_VALUES.includes(value as Rating);
}

async function restoreInitialState(): Promise<boolean> {
  const [pending, saved] = await Promise.all([readPendingImport(), readSavedSidePanelState()]);

  if (pending?.draft) {
    if (saved && saved.pendingCreatedAt === pending.createdAt && saved.tabId === pending.tabId) {
      restoreSavedSidePanelState(saved);
      return true;
    }

    draft = pending.draft;
    pendingTabId = pending.tabId;
    pendingCreatedAt = pending.createdAt;
    return false;
  }

  if (saved) {
    restoreSavedSidePanelState(saved);
    return true;
  }

  return false;
}

async function readPendingImport(): Promise<PendingImport | undefined> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const result = await chrome.storage.session.get(PENDING_IMPORT_KEY);
    const pending = result[PENDING_IMPORT_KEY] as PendingImport | undefined;
    if (pending?.draft) {
      return pending;
    }
    await sleep(75);
  }

  return undefined;
}

async function readSavedSidePanelState(): Promise<SavedSidePanelState | undefined> {
  const result = await chrome.storage.session.get(SIDE_PANEL_STATE_KEY);
  return result[SIDE_PANEL_STATE_KEY] as SavedSidePanelState | undefined;
}

function restoreSavedSidePanelState(saved: SavedSidePanelState): void {
  draft = saved.draft ?? {};
  pendingTabId = saved.tabId;
  pendingCreatedAt = saved.pendingCreatedAt ?? 0;
  latestDebugSnapshot = saved.debug;
  applyFallbackBooruProxyMedia();
  uploadedState = saved.uploaded;

  els.source.value = saved.form?.source ?? draft.sourceUrl ?? draft.pageUrl ?? "";
  els.artist.value = saved.form?.artist ?? commaTagText(draftArtistTags(draft));
  setRating(saved.form?.rating ?? draft.rating ?? settings.defaultRating);
  els.includeHashtags.checked = saved.form?.includePostHashtags ?? settings.includePostHashtagsDefault;
  els.tags.value = saved.form?.tags ?? "";
  scheduleArtistStatus();

  if (saved.manual) {
    manualState = {
      mediaId: saved.manual.mediaId,
      link: saved.manual.link,
      predictions: saved.manual.predictions,
      baseTags: saved.manual.baseTags ?? [],
      appliedNames: saved.manual.appliedNames ?? saved.manual.selectedNames ?? []
    };
    renderManualPredictions(saved.manual.predictions, saved.manual.selectedNames);
  }

  renderAll();

  if (saved.status) {
    renderStatus(saved.status);
  }

  if (saved.success?.visible) {
    showSuccessPopup(saved.success.message, saved.success.link, false, {
      clearPanelChecked: saved.success.clearPanelChecked
    });
    els.successTitle.textContent = saved.success.title;
  }
}

function shouldIgnoreSamePendingDraftUpdate(nextDraft: ImportDraft): boolean {
  if (nextDraft.blombooruBooruImport) return false;
  const currentPostUrl = firstBooruPostFetchUrl(draft);
  const nextPostUrl = firstBooruPostFetchUrl(nextDraft);
  if (currentPostUrl && nextPostUrl && normalizedQueueUrlKey(currentPostUrl) !== normalizedQueueUrlKey(nextPostUrl)) {
    return false;
  }

  updateBooruImportDebug({
    delegated: false,
    fetchStrategy: latestDebugSnapshot?.booruImport?.fetchStrategy,
    ignoredPendingUpdateReason: "same-pending-background-enrichment-ignored"
  });
  renderDebugPanel();
  return true;
}

function firstBooruPostFetchUrl(nextDraft: ImportDraft): string | undefined {
  return [
    nextDraft.sourceUrl,
    ...rawBooruImportCandidateUrls(nextDraft.raw),
    nextDraft.pageUrl
  ]
    .map(canonicalBooruImportFetchUrl)
    .find((url): url is string => Boolean(url && looksLikeBooruPostFetchUrl(url)));
}

function buildSavedSidePanelState(): SavedSidePanelState {
  return {
    savedAt: Date.now(),
    tabId: pendingTabId,
    pendingCreatedAt,
    draft,
    form: {
      source: els.source.value,
      artist: els.artist.value,
      rating: getRating(),
      tags: els.tags.value,
      includePostHashtags: els.includeHashtags.checked
    },
    manual: manualState
      ? {
          mediaId: manualState.mediaId,
          link: manualState.link,
          predictions: manualState.predictions,
          baseTags: manualState.baseTags,
          appliedNames: manualState.appliedNames,
          selectedNames: selectedManualPredictionNames()
        }
      : undefined,
    uploaded: uploadedState,
    status: currentStatusState,
    success: currentSuccessState,
    debug: latestDebugSnapshot
  };
}

function persistSidePanelStateDebounced(): void {
  persistSelectedQueueItemEditsDebounced();
  if (stateSaveTimer) window.clearTimeout(stateSaveTimer);
  stateSaveTimer = window.setTimeout(() => void persistSidePanelStateNow(), 180);
}

async function persistSidePanelStateNow(): Promise<void> {
  if (stateSaveTimer) {
    window.clearTimeout(stateSaveTimer);
    stateSaveTimer = undefined;
  }
  await chrome.storage.session.set({ [SIDE_PANEL_STATE_KEY]: buildSavedSidePanelState() });
}

async function clearSidePanelState(options: { showStatus?: boolean } = {}): Promise<void> {
  const showStatus = options.showStatus ?? true;
  if (stateSaveTimer) {
    window.clearTimeout(stateSaveTimer);
    stateSaveTimer = undefined;
  }
  if (queueSaveTimer) {
    window.clearTimeout(queueSaveTimer);
    queueSaveTimer = undefined;
  }

  clearCloseCountdown();
  await chrome.storage.session.remove(PENDING_IMPORT_KEY);
  selectedQueueItemId = undefined;
  if (currentQueue) {
    const clearedAt = Date.now();
    for (const item of currentQueue.items) {
      removedQueueItemIds.add(item.id);
    }
    queueClearCutoffs.set(currentQueue.tabId, clearedAt);
    queueMetadataRequests.clear();
    currentQueue = {
      ...currentQueue,
      selectedItemId: undefined,
      items: [],
      updatedAt: clearedAt
    };
    await persistQueueStateNow();
  }

  draft = {};
  pendingTabId = undefined;
  pendingCreatedAt = 0;
  manualState = undefined;
  uploadedState = undefined;
  latestDebugSnapshot = undefined;
  currentStatusState = undefined;
  currentSuccessState = undefined;

  els.source.value = "";
  els.artist.value = "";
  clearArtistStatus();
  hideArtistAutocomplete();
  setRating(settings.defaultRating);
  els.includeHashtags.checked = settings.includePostHashtagsDefault;
  els.tags.value = "";
  els.manualPanel.classList.add("hidden");
  els.manualList.replaceChildren();
  renderWorkflowState();
  renderQueue();
  hideSuccessPopup({ persist: false });
  clearRenderedStatus();
  renderAll();
  renderDebugPanel();
  if (showStatus) {
    renderStatus({ message: "Side panel cleared.", tone: "success" });
  }
  await chrome.storage.session.set({ [SIDE_PANEL_STATE_KEY]: buildSavedSidePanelState() });
}

async function enrichFromActiveTab(): Promise<void> {
  const tabId = pendingTabId ?? (await currentTabId());
  if (typeof tabId !== "number") return;

  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: EXTRACT_PAGE_CONTEXT_MESSAGE,
      draft
    });

    if (response?.ok && response.draft) {
      draft = mergeDrafts(draft, response.draft as ImportDraft);
      latestDebugSnapshot = response.debug as ImportDebugSnapshot | undefined;
    }
  } catch {
    // Some pages cannot run content scripts. Generic context-menu data is enough for MVP import.
  }
}

async function enrichFromBooruSources(): Promise<BooruEnrichmentResult> {
  const mediaStrategy = booruMediaStrategy(draft);
  if (mediaStrategy === "page-session") {
    const started = startPageSessionBooruPostEnrichment("page-session-background");
    updateBooruImportDebug({
      delegated: false,
      mediaStrategy,
      fetchStrategy: "page-session-background",
      blombooruFetchSkippedReason: "page-session-media-strategy",
      proxySkippedReason: "page-session-media-strategy",
      fallbackProxyApplied: false,
      fallbackProxyReason: "page-session-media-strategy"
    });
    return {
      fetchedWithBlombooru: false,
      fetchedWithPageBooruPost: false,
      startedPageSessionPostFetch: started
    };
  }

  const fetchedWithBlombooru = await enrichFromBlombooruBooruImport({
    timeoutMs: BOORU_IMPORT_FETCH_TIMEOUT_MS,
    cacheFailures: true,
    strategy: "normal"
  });
  const fetchedWithPageBooruPost = !fetchedWithBlombooru && await enrichFromPageBooruPostFallback("normal-fallback");
  return { fetchedWithBlombooru, fetchedWithPageBooruPost };
}

function startPageSessionBooruPostEnrichment(strategy = "page-session-background"): boolean {
  if (booruMediaStrategy(draft) !== "page-session") return false;

  const candidate = pageBooruPostFallbackCandidates()[0];
  if (!candidate) return false;

  const requestKey = normalizedQueueUrlKey(candidate) || candidate;
  if (pageBooruPostEnrichmentRequests.has(requestKey)) return true;

  const startedForm = currentFormState();
  const startedPreviewUrl = previewUrlCandidates()[0];
  const request = enrichFromPageBooruPostFallback(strategy)
    .then(async (fetched) => {
      if (!fetched) return false;
      const nextPreviewUrl = previewUrlCandidates()[0];
      if (nextPreviewUrl && nextPreviewUrl !== startedPreviewUrl) {
        await preloadPageSessionPreview(nextPreviewUrl);
      }
      const tagsWereEdited = els.tags.value.trim() !== startedForm.tags.trim();
      applyDraftToForm({ preserveEditedTags: tagsWereEdited });
      renderAll();
      persistSidePanelStateDebounced();
      return true;
    })
    .finally(() => {
      pageBooruPostEnrichmentRequests.delete(requestKey);
    });

  pageBooruPostEnrichmentRequests.set(requestKey, request);
  void request;
  return true;
}

async function preloadPageSessionPreview(url: string): Promise<void> {
  if (!shouldPreferPageContextMediaFetch(url)) return;
  const rawUrl = pageMediaUrlForCandidate(url);
  if (!rawUrl) return;

  try {
    await fetchPageContextMediaBlob(rawUrl);
  } catch {
    // Preview rendering will report the failure if this candidate is still selected.
  }
}

function booruMediaStrategy(nextDraft: ImportDraft): BooruMediaStrategy | undefined {
  if (nextDraft.blombooruBooruImport) return "blombooru-native";
  if (nextDraft.site !== "booru") return undefined;
  return hasPageSessionBooruEvidence(nextDraft) ? "page-session" : "generic-booru";
}

function hasPageSessionBooruEvidence(nextDraft: ImportDraft): boolean {
  return isPageSessionBooruDraft(nextDraft) ||
    Boolean(firstBooruPostFetchUrl(nextDraft)) ||
    rawFallbackBooruMediaCandidates(nextDraft).length > 0;
}

async function enrichFromBlombooruBooruImport(options: BooruImportEnrichOptions = {}): Promise<boolean> {
  if (!settings.baseUrl) return false;
  const mediaStrategy = booruMediaStrategy(draft);
  if (mediaStrategy === "page-session") {
    updateBooruImportDebug({
      delegated: false,
      mediaStrategy,
      fetchStrategy: options.strategy,
      blombooruFetchSkippedReason: "page-session-media-strategy",
      error: undefined
    });
    return false;
  }

  const candidates = await booruImportUrlCandidates();
  if (!candidates.length) return false;

  const existingOriginal = draft.blombooruBooruImport?.originalUrl;
  if (existingOriginal && candidates.some((candidate) => normalizedQueueUrlKey(candidate) === normalizedQueueUrlKey(existingOriginal))) {
    return false;
  }

  const api = new BlombooruApi(settings);
  let lastError: unknown;

  for (const candidate of candidates) {
    const cachedFailure = booruImportFetchFailure(candidate);
    if (cachedFailure) {
      lastError = new BlombooruApiError(cachedFailure.error, cachedFailure.status);
      updateBooruImportDebug({
        endpoint: "/api/booru-import/fetch",
        sourceUrl: candidate,
        status: cachedFailure.status,
        delegated: false,
        fetchStrategy: options.strategy,
        blombooruFetchTimeoutMs: options.timeoutMs,
        tagCount: undefined,
        proxyFileUrl: undefined,
        proxyPreviewUrl: undefined,
        selectedPreviewUrl: undefined,
        mediaValidationRejectedUrl: undefined,
        mediaValidationError: undefined,
        error: cachedFailure.error
      });
      continue;
    }

    try {
      const post = await fetchBooruImportWithDedupe(api, candidate, options);
      draft = mergeDrafts(draft, draftFromBlombooruBooruPost(candidate, post, api));
      rememberBooruImportCategories(post);
      updateBooruImportDebug({
        endpoint: "/api/booru-import/fetch",
        sourceUrl: candidate,
        status: undefined,
        delegated: true,
        fetchStrategy: options.strategy,
        blombooruFetchTimeoutMs: options.timeoutMs,
        blombooruFetchFallbackReason: undefined,
        tagCount: post.tags.length,
        proxyFileUrl: draft.blombooruBooruImport?.proxyFileUrl,
        proxyPreviewUrl: draft.blombooruBooruImport?.proxyPreviewUrl,
        mediaValidationRejectedUrl: undefined,
        mediaValidationError: undefined,
        error: undefined
      });
      setStatus("Fetched with Blombooru booru import.", "success");
      return true;
    } catch (error) {
      lastError = error;
      updateBooruImportDebug({
        endpoint: "/api/booru-import/fetch",
        sourceUrl: candidate,
        status: error instanceof BlombooruApiError ? error.status : undefined,
        delegated: false,
        fetchStrategy: options.strategy,
        blombooruFetchTimeoutMs: options.timeoutMs,
        tagCount: undefined,
        proxyFileUrl: undefined,
        proxyPreviewUrl: undefined,
        selectedPreviewUrl: undefined,
        mediaValidationRejectedUrl: undefined,
        mediaValidationError: undefined,
        error: error instanceof Error ? error.message : "Booru fetch failed."
      });
      if (error instanceof BlombooruAuthError) break;
    }
  }

  if (lastError) renderDebugPanel();
  return false;
}

function booruImportFetchFailure(candidate: string): BooruImportFetchFailure | undefined {
  const failure = booruImportFetchFailures.get(candidate);
  if (!failure) return undefined;

  if (Date.now() - failure.failedAt > BOORU_IMPORT_FETCH_FAILURE_TTL_MS) {
    booruImportFetchFailures.delete(candidate);
    return undefined;
  }

  return failure;
}

async function fetchBooruImportWithDedupe(
  api: BlombooruApi,
  candidate: string,
  options: BooruImportEnrichOptions = {}
): Promise<BooruImportPost> {
  const requestKey = `${candidate}::${options.timeoutMs ?? BOORU_IMPORT_FETCH_TIMEOUT_MS}`;
  const inFlight = booruImportFetchRequests.get(requestKey);
  if (inFlight) return inFlight;

  const request = api.fetchBooruImport(candidate, { timeoutMs: options.timeoutMs ?? BOORU_IMPORT_FETCH_TIMEOUT_MS })
    .then((post) => {
      booruImportFetchFailures.delete(candidate);
      return post;
    })
    .catch((error) => {
      if (options.cacheFailures !== false) {
        booruImportFetchFailures.set(candidate, {
          status: error instanceof BlombooruApiError ? error.status : undefined,
          error: error instanceof Error ? error.message : "Booru fetch failed.",
          failedAt: Date.now()
        });
      }
      throw error;
    })
    .finally(() => {
      booruImportFetchRequests.delete(requestKey);
    });

  booruImportFetchRequests.set(requestKey, request);
  return request;
}

async function booruImportUrlCandidates(): Promise<string[]> {
  const candidates: string[] = [];
  const add = (value: string | undefined | null): void => {
    const url = canonicalBooruImportFetchUrl(value);
    if (url) candidates.push(url);
  };

  add(draft.sourceUrl);
  add(draft.pageUrl);
  for (const url of rawBooruImportCandidateUrls(draft.raw)) add(url);
  add((await activeTabUrl()) ?? undefined);

  const unique = uniqueUrls(candidates);
  const postCandidates = unique.filter(looksLikeBooruPostFetchUrl);
  return postCandidates.length ? postCandidates : unique;
}

async function enrichFromPageBooruPostFallback(strategy = "normal-fallback"): Promise<boolean> {
  if (draft.site !== "booru" || draft.blombooruBooruImport) return false;

  const candidates = pageBooruPostFallbackCandidates();
  if (!candidates.length) return false;

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const post = await fetchPageBooruPost(candidate);
      if (!post.draft) throw new Error("Page booru post fetch returned no draft.");
      if (!post.draft.mediaUrl && !post.draft.previewUrl && !post.draft.seedTags?.length) {
        throw new Error("Page booru post fetch returned no media or tags.");
      }
      draft = mergeDrafts(draft, post.draft);
      updateBooruImportDebug({
        delegated: false,
        mediaStrategy: booruMediaStrategy(draft),
        fetchStrategy: strategy,
        pagePostFetchUrl: candidate,
        pagePostFetchResponseUrl: post.responseUrl,
        pagePostFetchBytes: post.bytes,
        pagePostFetchContentType: post.contentType,
        pagePostFetchTagCount: post.tagCount ?? post.draft.seedTags?.length,
        pagePostFetchMediaUrl: post.mediaUrl ?? post.draft.mediaUrl,
        pagePostFetchPreviewUrl: post.previewUrl ?? post.draft.previewUrl,
        pagePostFetchSourceUrl: post.draft.sourceUrl,
        pagePostFetchArtistTag: post.draft.artistTag,
        pagePostFetchArtistTags: post.draft.artistTags,
        pagePostFetchError: undefined,
        fallbackProxyApplied: false,
        fallbackProxyReason: "page-session-post-fallback-used",
        mediaValidationRejectedUrl: undefined,
        mediaValidationError: undefined
      });
      setStatus("Fetched booru post through page session.", "success");
      return true;
    } catch (error) {
      lastError = error;
      updateBooruImportDebug({
        delegated: false,
        mediaStrategy: booruMediaStrategy(draft),
        fetchStrategy: strategy,
        pagePostFetchUrl: candidate,
        pagePostFetchError: error instanceof Error ? error.message : "Page booru post fetch failed."
      });
    }
  }

  if (lastError) renderDebugPanel();
  return false;
}

function pageBooruPostFallbackCandidates(): string[] {
  return pageBooruPostFallbackCandidatesForDraft(draft);
}

function pageBooruPostFallbackCandidatesForDraft(nextDraft: ImportDraft): string[] {
  const candidates = [
    nextDraft.sourceUrl,
    ...rawBooruImportCandidateUrls(nextDraft.raw),
    nextDraft.pageUrl
  ]
    .map(canonicalBooruImportFetchUrl)
    .filter((url): url is string => Boolean(url && looksLikeBooruPostFetchUrl(url)));

  return uniqueUrls(candidates);
}

async function fetchPageBooruPost(url: string): Promise<PageBooruPostFetchResponse> {
  const tabId = pendingTabId ?? (await currentTabId());
  if (typeof tabId !== "number") throw new Error("No page tab available for booru post fetch.");

  let response: PageBooruPostFetchResponse | undefined;
  try {
    response = await chrome.tabs.sendMessage(tabId, {
      type: FETCH_PAGE_BOORU_POST_MESSAGE,
      url
    }) as PageBooruPostFetchResponse | undefined;
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "Page booru post fetch message failed.");
  }

  if (!response?.ok) throw new Error(response?.error || "Page booru post fetch failed.");
  return response;
}

function canonicalBooruImportFetchUrl(value: string | undefined | null): string | undefined {
  const normalized = normalizedHttpUrl(value);
  if (!normalized) return undefined;

  try {
    const url = new URL(normalized);
    if (/\/posts?\/\d+\/?$/i.test(url.pathname) || /\/post\/show\/\d+\/?$/i.test(url.pathname)) {
      url.search = "";
      return url.href;
    }

    const id = url.searchParams.get("id");
    if (id && /^\d+$/.test(id)) {
      const canonical = new URL(`${url.origin}${url.pathname}`);
      for (const key of ["page", "s", "id"]) {
        const param = url.searchParams.get(key);
        if (param) canonical.searchParams.set(key, param);
      }
      return canonical.href;
    }

    return normalized;
  } catch {
    return normalized;
  }
}

function looksLikeBooruPostFetchUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return /\/posts?\/\d+\/?$/i.test(url.pathname) ||
      /\/post\/show\/\d+\/?$/i.test(url.pathname) ||
      Boolean(url.searchParams.get("id")?.match(/^\d+$/));
  } catch {
    return false;
  }
}

async function activeTabUrl(): Promise<string | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.url;
}

function rawBooruImportCandidateUrls(raw: unknown): string[] {
  const urls: string[] = [];
  const seenObjects = new Set<object>();

  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object" || seenObjects.has(value)) return;
    seenObjects.add(value);

    const record = value as Record<string, unknown>;
    for (const key of ["sourceUrl", "pageUrl", "linkUrl", "booruUrl"]) {
      const url = typeof record[key] === "string" ? normalizedHttpUrl(record[key]) : undefined;
      if (url) urls.push(url);
    }

    for (const child of Object.values(record)) visit(child);
  };

  visit(raw);
  return uniqueUrls(urls);
}

function draftFromBlombooruBooruPost(originalUrl: string, post: BooruImportPost, api: BlombooruApi): ImportDraft {
  const tags = post.tags.map((tag) => normalizeTag(tag.name)).filter(Boolean);
  const artistTags = mergeTags(post.tags
    .filter((tag) => normalizeCategory(tag.category) === "artist")
    .map((tag) => tag.name));
  const sourceUrl = booruImportSourceUrl(originalUrl, post);
  const previewUrl = post.previewUrl || post.fileUrl;
  const proxyPreviewUrl = api.booruImportProxyImageUrl(previewUrl);
  const proxyFileUrl = api.booruImportProxyImageUrl(post.fileUrl);

  return {
    site: "booru",
    pageUrl: post.booruUrl || originalUrl,
    sourceUrl,
    mediaUrl: post.fileUrl || draft.mediaUrl,
    previewUrl: proxyFileUrl || proxyPreviewUrl || post.fileUrl || previewUrl || draft.previewUrl,
    artistTag: artistTags[0],
    artistTags,
    seedTags: tags,
    rating: post.rating,
    blombooruBooruImport: {
      originalUrl,
      booruUrl: post.booruUrl,
      fileUrl: post.fileUrl,
      previewUrl: post.previewUrl,
      proxyFileUrl,
      proxyPreviewUrl,
      filename: post.filename,
      width: post.width,
      height: post.height,
      fileSize: post.fileSize,
      source: post.source,
      tags: post.tags.map((tag) => ({
        name: normalizeTag(tag.name),
        category: normalizeCategory(tag.category),
        isNew: tag.isNew,
        userAssigned: tag.userAssigned
      })).filter((tag) => tag.name),
      fetchedAt: Date.now()
    },
    raw: {
      blombooruBooruImport: {
        originalUrl,
        booruUrl: post.booruUrl,
        mediaUrl: post.fileUrl,
        previewUrl: proxyFileUrl || proxyPreviewUrl || post.fileUrl || post.previewUrl,
        proxyFileUrl,
        proxyPreviewUrl,
        source: post.source
      }
    }
  };
}

function applyFallbackBooruProxyMedia(): boolean {
  if (draft.site !== "booru") {
    recordFallbackBooruProxyDecision(false, "not-booru");
    return false;
  }
  const mediaStrategy = booruMediaStrategy(draft);
  if (mediaStrategy === "blombooru-native") {
    recordFallbackBooruProxyDecision(false, "already-delegated");
    return false;
  }
  recordFallbackBooruProxyDecision(false, "proxy-only-for-delegated-native");
  return false;
}

function recordFallbackBooruProxyDecision(
  applied: boolean,
  reason: string,
  rawCandidates: string[] = [],
  proxyCandidates: string[] = [],
  proxyFileUrl?: string,
  proxyPreviewUrl?: string,
  selectedPreviewUrl?: string
): void {
  if (draft.site !== "booru" && !draft.blombooruBooruImport && reason === "not-booru") return;

  updateBooruImportDebug({
    delegated: Boolean(draft.blombooruBooruImport),
    mediaStrategy: booruMediaStrategy(draft),
    fallbackProxyApplied: applied,
    fallbackProxyReason: reason,
    proxySkippedReason: applied ? undefined : reason,
    fallbackProxyRawCandidates: rawCandidates,
    fallbackProxyCandidates: proxyCandidates,
    proxyFileUrl,
    proxyPreviewUrl,
    selectedPreviewUrl,
    mediaValidationRejectedUrl: applied ? undefined : latestDebugSnapshot?.booruImport?.mediaValidationRejectedUrl,
    mediaValidationError: applied ? undefined : latestDebugSnapshot?.booruImport?.mediaValidationError
  });
}

function booruImportSourceUrl(originalUrl: string, post: BooruImportPost): string {
  return normalizedHttpUrl(post.source) || post.booruUrl || originalUrl;
}

function rememberBooruImportCategories(post: BooruImportPost): void {
  for (const tag of post.tags) {
    const name = normalizeTag(tag.name);
    const category = normalizeCategory(tag.category);
    if (name && category) categoryCache.set(name, category);
  }
}

function updateBooruImportDebug(next: NonNullable<ImportDebugSnapshot["booruImport"]>): void {
  latestDebugSnapshot = {
    capturedAt: latestDebugSnapshot?.capturedAt ?? Date.now(),
    pageUrl: latestDebugSnapshot?.pageUrl ?? draft.pageUrl,
    selectedAdapter: latestDebugSnapshot?.selectedAdapter ?? draft.site,
    pendingDraft: latestDebugSnapshot?.pendingDraft,
    enrichedDraft: latestDebugSnapshot?.enrichedDraft,
    rightClickTarget: latestDebugSnapshot?.rightClickTarget,
    nearestPostContainer: latestDebugSnapshot?.nearestPostContainer,
    candidateMediaUrls: latestDebugSnapshot?.candidateMediaUrls ?? [],
    candidateSourceUrls: latestDebugSnapshot?.candidateSourceUrls ?? [],
    mediaCandidates: latestDebugSnapshot?.mediaCandidates,
    sourceCandidatesDetailed: latestDebugSnapshot?.sourceCandidatesDetailed,
    selectionNotes: latestDebugSnapshot?.selectionNotes,
    x: latestDebugSnapshot?.x,
    misskey: latestDebugSnapshot?.misskey,
    booruImport: { ...latestDebugSnapshot?.booruImport, ...next },
    metaImageUrls: latestDebugSnapshot?.metaImageUrls ?? [],
    visibleTags: latestDebugSnapshot?.visibleTags ?? [],
    hashtags: latestDebugSnapshot?.hashtags ?? [],
    errors: latestDebugSnapshot?.errors ?? []
  };
}

function normalizedHttpUrl(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

async function currentTabId(): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.id;
}

async function loadQueueForCurrentTab(): Promise<void> {
  const tabId = pendingTabId ?? (await currentTabId());
  if (typeof tabId !== "number") {
    currentQueue = undefined;
    selectedQueueItemId = undefined;
    renderQueue();
    return;
  }

  currentQueue = await readQueueState(tabId);
  renderQueue();
}

async function restoreSelectedQueueItemFromQueue(): Promise<boolean> {
  if (!currentQueue?.items.length || pendingCreatedAt) return false;
  const item = queueItemById(currentQueue.selectedItemId) ?? currentQueue.items[0];
  if (!item) return false;
  await loadQueueItem(item.id, { skipSave: true, quiet: true });
  return true;
}

async function handleQueueStoreChanged(store: ImportQueueStore | undefined): Promise<void> {
  const tabId = currentQueue?.tabId ?? pendingTabId ?? (await currentTabId());
  if (typeof tabId !== "number") return;

  const previousHadItems = Boolean(currentQueue?.items.length);
  const previousSelectedItemId = selectedQueueItemId;
  const nextQueue = normalizeQueueState(tabId, store?.[String(tabId)]);
  const requestedSelectedItemId = nextQueue.selectedItemId;
  currentQueue = nextQueue;
  const selectedStillExists = selectedQueueItemId ? Boolean(queueItemById(selectedQueueItemId)) : false;
  if (selectedQueueItemId && !selectedStillExists) selectedQueueItemId = undefined;

  if (
    previousSelectedItemId &&
    requestedSelectedItemId &&
    requestedSelectedItemId !== previousSelectedItemId &&
    queueItemById(previousSelectedItemId) &&
    queueItemById(requestedSelectedItemId)
  ) {
    currentQueue = applyCurrentImportEditsToQueue(currentQueue, previousSelectedItemId);
    await persistQueueStateNow();
    await loadQueueItem(requestedSelectedItemId, { skipSave: true, quiet: true, updateStore: false });
    return;
  }

  if (!selectedQueueItemId && !pendingCreatedAt && !hasActiveImportView() && currentQueue.selectedItemId) {
    await loadQueueItem(currentQueue.selectedItemId, { skipSave: true, quiet: true, updateStore: false });
    return;
  }

  if (!previousHadItems && currentQueue.items.length && !selectedQueueItemId && !pendingCreatedAt && currentQueue.selectedItemId) {
    await loadQueueItem(currentQueue.selectedItemId, { skipSave: true, quiet: true, updateStore: false });
    return;
  }

  renderQueue();
}

function applyCurrentImportEditsToQueue(queue: ImportQueueState, itemId: string): ImportQueueState {
  const now = Date.now();
  return {
    ...queue,
    items: queue.items.map((item) =>
      item.id === itemId
        ? {
            ...item,
            draft,
            form: currentFormState(),
            debug: latestDebugSnapshot,
            mediaMetadata,
            manual: currentManualQueueState(),
            uploaded: uploadedState,
            updatedAt: now
          }
        : item
    ),
    updatedAt: now
  };
}

function hasActiveImportView(): boolean {
  return Boolean(draft.mediaUrl || draft.previewUrl || els.source.value || els.artist.value || els.tags.value);
}

async function readQueueStore(): Promise<ImportQueueStore> {
  const result = await chrome.storage.session.get(IMPORT_QUEUE_STORE_KEY);
  return (result[IMPORT_QUEUE_STORE_KEY] ?? {}) as ImportQueueStore;
}

async function writeQueueStore(store: ImportQueueStore): Promise<void> {
  await chrome.storage.session.set({ [IMPORT_QUEUE_STORE_KEY]: store });
}

async function readQueueState(tabId: number): Promise<ImportQueueState> {
  const store = await readQueueStore();
  return normalizeQueueState(tabId, store[String(tabId)]);
}

function normalizeQueueState(tabId: number, state: ImportQueueState | undefined): ImportQueueState {
  const cutoff = queueClearCutoffs.get(tabId) ?? 0;
  const items = (Array.isArray(state?.items) ? state.items : []).filter((item) => {
    if (removedQueueItemIds.has(item.id)) return false;
    return !cutoff || (item.createdAt ?? 0) > cutoff;
  });
  const selectedItemId = items.some((item) => item.id === state?.selectedItemId) ? state?.selectedItemId : undefined;

  return {
    tabId,
    captureEnabled: Boolean(state?.captureEnabled),
    autoCollectEnabled: Boolean(state?.captureEnabled && state.autoCollectEnabled),
    selectedItemId,
    items,
    updatedAt: state?.updatedAt ?? Date.now()
  };
}

async function persistQueueStateNow(options: { preserveExternalItems?: boolean } = {}): Promise<void> {
  const queue = currentQueue;
  if (!queue) return;
  const store = await readQueueStore();
  let nextQueue = normalizeQueueState(queue.tabId, queue);

  if (options.preserveExternalItems) {
    const latest = normalizeQueueState(nextQueue.tabId, store[String(nextQueue.tabId)]);
    const currentIds = new Set(nextQueue.items.map((item) => item.id));
    const externalItems = latest.items.filter((item) => !currentIds.has(item.id));
    if (externalItems.length) {
      nextQueue = {
        ...nextQueue,
        selectedItemId: nextQueue.selectedItemId ?? latest.selectedItemId,
        items: [...nextQueue.items, ...externalItems],
        updatedAt: Date.now()
      };
    }
  }

  if (currentQueue?.tabId === nextQueue.tabId) {
    currentQueue = nextQueue;
  }

  await writeQueueStore({
    ...store,
    [String(nextQueue.tabId)]: nextQueue
  });
}

async function updateCurrentQueue(update: (queue: ImportQueueState) => ImportQueueState): Promise<void> {
  if (!currentQueue) await loadQueueForCurrentTab();
  if (!currentQueue) return;
  currentQueue = update(currentQueue);
  await persistQueueStateNow({ preserveExternalItems: true });
  renderQueue();
}

function queueItemById(itemId: string | undefined): ImportQueueItem | undefined {
  if (!itemId) return undefined;
  return currentQueue?.items.find((item) => item.id === itemId);
}

function persistSelectedQueueItemEditsDebounced(): void {
  if (!selectedQueueItemId || !currentQueue) return;
  if (queueSaveTimer) window.clearTimeout(queueSaveTimer);
  queueSaveTimer = window.setTimeout(() => void persistSelectedQueueItemEditsNow(), 180);
}

async function persistSelectedQueueItemEditsNow(): Promise<void> {
  if (queueSaveTimer) {
    window.clearTimeout(queueSaveTimer);
    queueSaveTimer = undefined;
  }
  if (!selectedQueueItemId || !currentQueue || !queueItemById(selectedQueueItemId)) return;

  const now = Date.now();
  const manual = manualState
    ? {
        mediaId: manualState.mediaId,
        link: manualState.link,
        predictions: manualState.predictions,
        baseTags: manualState.baseTags,
        appliedNames: manualState.appliedNames,
        selectedNames: selectedManualPredictionNames()
      }
    : undefined;

  currentQueue = {
    ...currentQueue,
    selectedItemId: selectedQueueItemId,
    items: currentQueue.items.map((item) =>
      item.id === selectedQueueItemId
        ? {
            ...item,
            draft,
            form: currentFormState(),
            debug: latestDebugSnapshot,
            mediaMetadata,
            manual,
            uploaded: uploadedState,
            updatedAt: now
          }
        : item
    ),
    updatedAt: now
  };
  await persistQueueStateNow({ preserveExternalItems: true });
  renderQueue();
}

async function loadQueueItem(
  itemId: string,
  options: { skipSave?: boolean; quiet?: boolean; updateStore?: boolean } = {}
): Promise<void> {
  const item = queueItemById(itemId);
  if (!item || !currentQueue) return;

  if (!options.skipSave) await persistSelectedQueueItemEditsNow();

  selectedQueueItemId = item.id;
  currentQueue = {
    ...currentQueue,
    selectedItemId: item.id,
    updatedAt: Date.now()
  };
  if (options.updateStore ?? true) await persistQueueStateNow({ preserveExternalItems: true });

  draft = item.draft;
  pendingTabId = currentQueue.tabId;
  pendingCreatedAt = 0;
  latestDebugSnapshot = item.debug;
  applyFallbackBooruProxyMedia();
  uploadedState = item.uploaded;
  mediaMetadata = item.mediaMetadata;
  if (mediaMetadata?.url && !previewUrlCandidatesForDraft(draft).includes(mediaMetadata.url)) {
    mediaMetadata = undefined;
  }
  mediaMetadataRequest += 1;
  applyFormState(item.form ?? defaultFormForDraft(item.draft));

  if (item.manual) {
    manualState = {
      mediaId: item.manual.mediaId,
      link: item.manual.link,
      predictions: item.manual.predictions,
      baseTags: item.manual.baseTags ?? [],
      appliedNames: item.manual.appliedNames ?? item.manual.selectedNames ?? []
    };
    renderManualPredictions(item.manual.predictions, item.manual.selectedNames);
  } else {
    manualState = undefined;
    els.manualPanel.classList.add("hidden");
    els.manualList.replaceChildren();
  }

  hideSuccessPopup({ persist: false });
  if (item.statusMessage) {
    renderStatus({
      message: item.statusMessage,
      tone: queueStatusTone(item.status),
      link: item.statusLink
    });
  } else if (!options.quiet) {
    clearRenderedStatus();
  }

  renderAll();
  renderQueue();
  scrollSelectedQueueItemIntoView();
  renderDebugPanel();
  persistSidePanelStateDebounced();
}

function queueStatusTone(status: ImportQueueItem["status"]): StatusTone {
  return status === "error" ? "error" : status === "queued" || status === "importing" ? "info" : "success";
}

async function removeQueueItem(itemId: string): Promise<void> {
  if (!currentQueue) return;
  removedQueueItemIds.add(itemId);
  queueMetadataRequests.delete(itemId);
  const wasSelected = selectedQueueItemId === itemId;
  const remaining = currentQueue.items.filter((item) => item.id !== itemId);
  const nextSelected = wasSelected ? remaining[0]?.id : currentQueue.selectedItemId;
  currentQueue = {
    ...currentQueue,
    selectedItemId: nextSelected,
    items: remaining,
    updatedAt: Date.now()
  };
  selectedQueueItemId = wasSelected ? undefined : selectedQueueItemId;
  await persistQueueStateNow();

  if (wasSelected && nextSelected) {
    await loadQueueItem(nextSelected, { skipSave: true, quiet: true });
  } else if (wasSelected) {
    resetImportView();
  }

  renderQueue();
}

async function clearQueue(): Promise<void> {
  if (!currentQueue) return;
  const clearedAt = Date.now();
  for (const item of currentQueue.items) {
    removedQueueItemIds.add(item.id);
  }
  queueClearCutoffs.set(currentQueue.tabId, clearedAt);
  queueMetadataRequests.clear();
  selectedQueueItemId = undefined;
  currentQueue = {
    ...currentQueue,
    selectedItemId: undefined,
    items: [],
    updatedAt: clearedAt
  };
  await persistQueueStateNow();
  resetImportView();
  renderQueue();
  setStatus("Queue cleared.", "success");
}

function resetImportView(): void {
  draft = {};
  pendingCreatedAt = 0;
  manualState = undefined;
  uploadedState = undefined;
  latestDebugSnapshot = undefined;
  mediaMetadata = undefined;
  applyFormState({
    source: "",
    artist: "",
    rating: settings.defaultRating,
    tags: "",
    includePostHashtags: settings.includePostHashtagsDefault
  });
  els.manualPanel.classList.add("hidden");
  els.manualList.replaceChildren();
  hideSuccessPopup({ persist: false });
  clearRenderedStatus();
  renderAll();
}

async function toggleMultiAddCapture(): Promise<void> {
  if (!currentQueue) await loadQueueForCurrentTab();
  if (!currentQueue) {
    setStatus("No active tab available for multi-add capture.", "error");
    return;
  }

  const captureEnabled = !currentQueue.captureEnabled;
  if (captureEnabled) {
    await queueCurrentStandaloneImportIfNeeded();
  }

  await setMultiAddCapture(captureEnabled);
}

async function queueCurrentStandaloneImportIfNeeded(): Promise<void> {
  if (!currentQueue || !hasStandaloneImportDraft()) return;

  const now = Date.now();
  const key = queueDraftKey(draft);
  const existing = key ? currentQueue.items.find((item) => queueDraftKey(item.draft) === key) : undefined;
  const manual = currentManualQueueState();

  if (existing) {
    selectedQueueItemId = existing.id;
    currentQueue = {
      ...currentQueue,
      selectedItemId: existing.id,
      items: currentQueue.items.map((item) =>
        item.id === existing.id
          ? {
              ...item,
              draft,
              form: currentFormState(),
              debug: latestDebugSnapshot ?? item.debug,
              mediaMetadata: mediaMetadata ?? item.mediaMetadata,
              manual: manual ?? item.manual,
              uploaded: uploadedState ?? item.uploaded,
              updatedAt: now
            }
          : item
      ),
      updatedAt: now
    };
  } else {
    const itemId = createQueueItemId();
    selectedQueueItemId = itemId;
    currentQueue = {
      ...currentQueue,
      selectedItemId: itemId,
      items: [
        ...currentQueue.items,
        {
          id: itemId,
          createdAt: now,
          updatedAt: now,
          draft,
          form: currentFormState(),
          debug: latestDebugSnapshot,
          mediaMetadata,
          manual,
          uploaded: uploadedState,
          status: "queued"
        }
      ],
      updatedAt: now
    };
  }

  pendingTabId = currentQueue.tabId;
  pendingCreatedAt = 0;
  await chrome.storage.session.remove(PENDING_IMPORT_KEY);
  await persistQueueStateNow({ preserveExternalItems: true });
  renderQueue();
  persistSidePanelStateDebounced();
}

function hasStandaloneImportDraft(): boolean {
  return !selectedQueueItemId && Boolean(draft.mediaUrl || draft.previewUrl);
}

function currentManualQueueState(): ImportQueueItem["manual"] | undefined {
  if (!manualState) return undefined;
  return {
    mediaId: manualState.mediaId,
    link: manualState.link,
    predictions: manualState.predictions,
    baseTags: manualState.baseTags,
    appliedNames: manualState.appliedNames,
    selectedNames: selectedManualPredictionNames()
  };
}

function createQueueItemId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function queueDraftKey(nextDraft: ImportDraft): string | undefined {
  return normalizedQueueUrlKey(nextDraft.mediaUrl) ||
    normalizedQueueUrlKey(nextDraft.previewUrl) ||
    normalizedQueueUrlKey(nextDraft.sourceUrl) ||
    normalizedQueueUrlKey(nextDraft.pageUrl);
}

function normalizedQueueUrlKey(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return value.trim() || undefined;
  }
}

async function setMultiAddCapture(captureEnabled: boolean): Promise<void> {
  if (!currentQueue) return;
  try {
    const response = await chrome.runtime.sendMessage({
      type: SET_MULTI_ADD_CAPTURE_MESSAGE,
      tabId: currentQueue.tabId,
      captureEnabled
    });
    if (response?.ok && response.queue) {
      currentQueue = response.queue as ImportQueueState;
    } else {
      currentQueue = { ...currentQueue, captureEnabled, updatedAt: Date.now() };
      await persistQueueStateNow();
    }
    renderQueue();
    setStatus(captureEnabled ? "Multi-add capture enabled for this tab." : "Multi-add capture disabled.", "info");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Could not update multi-add capture.", "error");
  }
}

async function toggleAutoCollect(): Promise<void> {
  if (!currentQueue) await loadQueueForCurrentTab();
  if (!currentQueue) {
    setStatus("No active tab available for auto collect.", "error");
    return;
  }
  if (!currentQueue.captureEnabled) {
    setStatus("Enable multi-add before auto collect.", "info");
    return;
  }

  await setAutoCollect(!currentQueue.autoCollectEnabled);
}

async function setAutoCollect(autoCollectEnabled: boolean): Promise<void> {
  if (!currentQueue) return;
  try {
    const response = await chrome.runtime.sendMessage({
      type: SET_MULTI_ADD_AUTO_COLLECT_MESSAGE,
      tabId: currentQueue.tabId,
      autoCollectEnabled
    });
    if (response?.ok && response.queue) {
      currentQueue = response.queue as ImportQueueState;
    } else {
      currentQueue = {
        ...currentQueue,
        autoCollectEnabled: autoCollectEnabled && currentQueue.captureEnabled,
        updatedAt: Date.now()
      };
      await persistQueueStateNow();
    }
    renderQueue();
    setStatus(
      currentQueue.autoCollectEnabled
        ? "Auto collect is watching visible posts in this tab."
        : "Auto collect stopped.",
      "info"
    );
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Could not update auto collect.", "error");
  }
}

async function syncCaptureStateToActiveTab(): Promise<void> {
  if (!currentQueue?.captureEnabled) return;
  await setMultiAddCapture(true);
}

function renderQueue(): void {
  const queue = currentQueue;
  const items = queue?.items ?? [];
  const captureEnabled = Boolean(queue?.captureEnabled);
  const autoCollectEnabled = Boolean(captureEnabled && queue?.autoCollectEnabled);
  els.queuePanel.hidden = !captureEnabled && items.length <= 1;
  els.multiAddToggle.textContent = captureEnabled ? "Disable multi-add" : "Enable multi-add";
  els.multiAddToggle.dataset.active = String(captureEnabled);
  els.autoCollectToggle.textContent = autoCollectEnabled ? "Stop auto collect" : "Auto collect visible";
  els.autoCollectToggle.dataset.active = String(autoCollectEnabled);
  els.queueSummary.textContent = queueSummaryText(items.length, captureEnabled, autoCollectEnabled);
  els.autoCollectToggle.disabled = busy || !captureEnabled;
  els.importQueue.disabled = busy || !items.length;
  els.importQueueAuto.disabled = busy || !items.length;
  els.clearQueue.disabled = busy || !items.length;
  els.queueList.replaceChildren();

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "queue-empty";
    empty.textContent = captureEnabled ? "Click posts or images on the page to add them here." : "Enable multi-add to collect posts from the active tab.";
    els.queueList.append(empty);
    return;
  }

  for (const item of items) {
    els.queueList.append(queueRow(item));
  }

  scheduleQueueMetadataHydration(items);
}

function queueSummaryText(count: number, captureEnabled: boolean, autoCollectEnabled: boolean): string {
  const itemText = `${count} queued item${count === 1 ? "" : "s"}`;
  if (autoCollectEnabled) return `${itemText} - auto collect is on`;
  return captureEnabled ? `${itemText} - capture is on` : itemText;
}

function queueRow(item: ImportQueueItem): HTMLElement {
  const row = document.createElement("div");
  row.className = "queue-row";
  row.dataset.itemId = item.id;
  row.dataset.selected = String(item.id === selectedQueueItemId);

  const select = document.createElement("button");
  select.type = "button";
  select.className = "queue-select";
  select.addEventListener("click", () => void loadQueueItem(item.id));

  const thumb = queueThumb(item);
  const body = document.createElement("span");
  body.className = "queue-body";

  const title = document.createElement("span");
  title.className = "queue-title";
  title.textContent = queueItemTitle(item);

  const meta = document.createElement("span");
  meta.className = "queue-meta";
  meta.textContent = queueItemMeta(item);

  const badge = document.createElement("span");
  badge.className = "queue-badge";
  badge.dataset.status = item.status;
  badge.textContent = item.status;

  body.append(title, meta);
  select.append(thumb, body, badge);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "queue-remove";
  remove.setAttribute("aria-label", "Remove queued item");
  remove.textContent = "x";
  remove.addEventListener("click", (event) => {
    event.stopPropagation();
    void removeQueueItem(item.id);
  });

  row.append(select, remove);
  return row;
}

function scrollSelectedQueueItemIntoView(): void {
  const itemId = selectedQueueItemId;
  if (!itemId || els.queuePanel.hidden) return;

  window.requestAnimationFrame(() => {
    const row = Array.from(els.queueList.querySelectorAll<HTMLElement>(".queue-row"))
      .find((element) => element.dataset.itemId === itemId);
    row?.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
}

function queueThumb(item: ImportQueueItem): HTMLElement {
  const url = previewUrlCandidatesForDraft(item.draft)[0];
  const thumb = document.createElement("span");
  thumb.className = "queue-thumb";

  if (!url) {
    thumb.textContent = "?";
    return thumb;
  }

  if (isVideoUrl(url)) {
    thumb.textContent = "Video";
    return thumb;
  }

  const image = document.createElement("img");
  image.src = url;
  image.alt = "";
  markBlurSensitiveImage(image);
  thumb.append(image);
  return thumb;
}

function queueItemTitle(item: ImportQueueItem): string {
  const source = item.form?.source || item.draft.sourceUrl || item.draft.pageUrl || item.draft.mediaUrl || "Queued item";
  try {
    const url = new URL(source);
    return url.hostname.replace(/^www\./, "") || source;
  } catch {
    return source;
  }
}

function queueItemMeta(item: ImportQueueItem): string {
  const tags = item.form?.tags ? parseTagsWithHints(item.form.tags).tags.length : 0;
  const dimensions = item.mediaMetadata?.width && item.mediaMetadata.height
    ? `${item.mediaMetadata.width} x ${item.mediaMetadata.height}`
    : undefined;
  const size = item.mediaMetadata?.bytes ? formatBytes(item.mediaMetadata.bytes) : undefined;
  const media = [dimensions, size].filter(Boolean).join(" / ");
  return [item.draft.site ?? "generic", media || undefined, tags ? `${tags} tags` : undefined, item.statusMessage].filter(Boolean).join(" - ");
}

function scheduleQueueMetadataHydration(items: ImportQueueItem[]): void {
  for (const item of items) {
    if (!shouldHydrateQueueItemMetadata(item) || queueMetadataRequests.has(item.id)) continue;
    queueMetadataRequests.add(item.id);
    void hydrateQueueItemMetadata(item.id).finally(() => {
      queueMetadataRequests.delete(item.id);
    });
  }
}

function shouldHydrateQueueItemMetadata(item: ImportQueueItem): boolean {
  if (!metadataUrlCandidatesForItem(item).length) return false;
  if (!item.mediaMetadata) return true;
  if (item.mediaMetadata.error) return false;
  return !item.mediaMetadata.width || !item.mediaMetadata.height || (!item.mediaMetadata.bytes && !item.mediaMetadata.sizeProbeFailed);
}

async function hydrateQueueItemMetadata(itemId: string): Promise<void> {
  const item = queueItemById(itemId);
  if (!item || !currentQueue) return;

  let metadata: MediaMetadata | undefined;
  let lastError: unknown;

  for (const url of metadataUrlCandidatesForItem(item)) {
    try {
      metadata = await probeMediaMetadata(url);
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (!currentQueue || !queueItemById(itemId)) return;
  const nextMetadata = metadata ?? {
    url: metadataUrlCandidatesForItem(item)[0] ?? "",
    loading: false,
    error: lastError instanceof Error ? lastError.message : "Could not load media metadata."
  };

  currentQueue = {
    ...currentQueue,
    items: currentQueue.items.map((queueItem) =>
      queueItem.id === itemId
        ? {
            ...queueItem,
            mediaMetadata: nextMetadata,
            updatedAt: Date.now()
          }
        : queueItem
    ),
    updatedAt: Date.now()
  };

  if (selectedQueueItemId === itemId && mediaMetadata?.url === nextMetadata.url) {
    mediaMetadata = nextMetadata;
    renderMediaMetadata();
  }

  await persistQueueStateNow({ preserveExternalItems: true });
  renderQueue();
}

function metadataUrlCandidatesForItem(item: ImportQueueItem): string[] {
  return previewUrlCandidatesForDraft(item.draft);
}

async function probeMediaMetadata(url: string): Promise<MediaMetadata> {
  const metadata: MediaMetadata = { url, loading: false };
  let blockedMimeType: string | undefined;

  try {
    const response = await fetchWithTimeout(url, {
      method: "HEAD",
      credentials: "include",
      referrerPolicy: "no-referrer"
    }, MEDIA_METADATA_FETCH_TIMEOUT_MS);
    if (!response.ok) throw new Error(`HEAD ${response.status}`);
    const contentLength = response.headers.get("content-length");
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim();
    metadata.bytes = contentLength ? Number(contentLength) || undefined : undefined;
    metadata.mimeType = contentType || undefined;
    blockedMimeType = contentType && isClearlyNonMediaMime(contentType) ? contentType : undefined;
    metadata.sizeSource = contentLength ? "head" : undefined;
  } catch {
    // Some hosts do not support HEAD. Image/video probing below can still succeed.
  }
  if (blockedMimeType) throw new Error(`Media URL returned ${blockedMimeType}.`);

  try {
    const dimensions = isVideoUrl(url) ? await loadVideoDimensions(url) : await loadImageDimensions(url);
    metadata.width = dimensions.width;
    metadata.height = dimensions.height;
  } catch {
    // Fall through to blob probing for hosts that block direct extension-page media loads.
  }

  if (isVideoUrl(url)) return metadata.width || metadata.height || metadata.bytes ? metadata : Promise.reject(new Error("Could not load video metadata."));
  if (metadata.width && metadata.height && metadata.bytes) return metadata;

  try {
    const response = await fetchWithTimeout(url, {
      credentials: "include",
      referrerPolicy: "no-referrer"
    }, MEDIA_METADATA_FETCH_TIMEOUT_MS);
    if (!response.ok) throw new Error(`Metadata fetch failed (${response.status}).`);
    const blob = await response.blob();
    const contentType = normalizedMimeType(blob.type || response.headers.get("content-type") || metadata.mimeType);
    if (contentType && isClearlyNonMediaMime(contentType)) {
      blockedMimeType = contentType;
      throw new Error(`Media URL returned ${contentType}.`);
    }
    metadata.bytes = blob.size || metadata.bytes;
    metadata.mimeType = contentType || metadata.mimeType;
    metadata.sizeSource = "blob";

    if (contentType.startsWith("image/")) {
      const objectUrl = URL.createObjectURL(blob);
      try {
        const dimensions = await loadImageDimensions(objectUrl);
        metadata.width = dimensions.width;
        metadata.height = dimensions.height;
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    }
  } catch (error) {
    if (blockedMimeType) throw error;
    if (metadata.width || metadata.height || metadata.bytes) {
      metadata.sizeProbeFailed = !metadata.bytes;
      return metadata;
    }
    throw error;
  }

  if (!metadata.width || !metadata.height) metadata.error = "Could not load dimensions.";
  return metadata;
}

function loadImageDimensions(url: string): Promise<{ width?: number; height?: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const timeout = window.setTimeout(() => {
      image.src = "";
      reject(new Error("Image metadata timed out."));
    }, MEDIA_METADATA_FETCH_TIMEOUT_MS);
    image.onload = () => {
      window.clearTimeout(timeout);
      resolve({
        width: image.naturalWidth || undefined,
        height: image.naturalHeight || undefined
      });
    };
    image.onerror = () => {
      window.clearTimeout(timeout);
      reject(new Error("Image metadata failed."));
    };
    image.src = url;
  });
}

function loadVideoDimensions(url: string): Promise<{ width?: number; height?: number }> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    const timeout = window.setTimeout(() => {
      video.src = "";
      reject(new Error("Video metadata timed out."));
    }, MEDIA_METADATA_FETCH_TIMEOUT_MS);
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      window.clearTimeout(timeout);
      resolve({
        width: video.videoWidth || undefined,
        height: video.videoHeight || undefined
      });
    };
    video.onerror = () => {
      window.clearTimeout(timeout);
      reject(new Error("Video metadata failed."));
    };
    video.src = url;
  });
}

async function importQueueNoAi(): Promise<void> {
  await importQueueItems({ aiAuto: false });
}

async function importQueueAiAuto(): Promise<void> {
  await importQueueItems({ aiAuto: true });
}

async function importQueueItems(options: { aiAuto: boolean }): Promise<void> {
  if (!currentQueue?.items.length) {
    setStatus("Queue is empty.", "info");
    return;
  }

  await persistSelectedQueueItemEditsNow();

  await runImport(async () => {
    const targets = (currentQueue?.items ?? []).filter(isQueueItemImportable);
    if (!targets.length) {
      setStatus("No queued items need importing.", "info");
      return;
    }
    const api = requireConfiguredApi({
      allowSessionAuth: !options.aiAuto && targets.every((item) => Boolean(item.draft.blombooruBooruImport))
    });

    let imported = 0;
    let duplicates = 0;
    let failed = 0;

    for (const target of targets) {
      if (!queueItemById(target.id)) continue;
      await loadQueueItem(target.id, { quiet: true });
      await setQueueItemStatus(target.id, "importing", options.aiAuto ? "Importing with AI auto..." : "Importing...");

      try {
        if (options.aiAuto) {
          await importCurrentQueueItemAiAuto(api);
        } else {
          await importCurrentQueueItemNoAi(api);
        }
        imported += 1;
      } catch (error) {
        if (error instanceof BlombooruDuplicateError) {
          duplicates += 1;
          markUploaded(error.result ?? { raw: undefined }, { finalSaved: true });
          await persistSelectedQueueItemEditsNow();
          await setQueueItemStatus(target.id, "duplicate", "Already imported.", error.result?.link);
          continue;
        }

        failed += 1;
        await persistSelectedQueueItemEditsNow();
        await setQueueItemStatus(target.id, "error", queueImportErrorMessage(error), undefined, queueImportErrorMessage(error));
      }
    }

    const parts = [
      `${imported} imported`,
      duplicates ? `${duplicates} duplicate${duplicates === 1 ? "" : "s"}` : undefined,
      failed ? `${failed} failed` : undefined
    ].filter(Boolean);
    setStatus(`Queue finished: ${parts.join(", ")}.`, failed ? "error" : "success");
  });
}

function isQueueItemImportable(item: ImportQueueItem): boolean {
  return item.status !== "imported" && item.status !== "duplicate" && item.status !== "importing";
}

async function importCurrentQueueItemNoAi(api: BlombooruApi): Promise<void> {
  const payload = buildFinalPayload();
  const upload = draft.blombooruBooruImport
    ? await downloadCurrentBooruImport(api, payload)
    : await uploadCurrentMedia(api, payload);
  markUploaded(upload, { finalSaved: true });
  await persistSelectedQueueItemEditsNow();
  await setQueueItemStatus(requireSelectedQueueItemId(), "imported", "Imported.", upload.link);
}

async function importCurrentQueueItemAiAuto(api: BlombooruApi): Promise<void> {
  const initialPayload = buildFinalPayload();
  const initialImport = await importCurrentMediaForAi(api, initialPayload);
  const upload = initialImport.upload;
  const mediaId = initialImport.mediaId;
  markUploaded(upload, { mediaId, finalSaved: initialImport.delegated && !mediaId });

  if (!mediaId) {
    await persistSelectedQueueItemEditsNow();
    await setQueueItemStatus(requireSelectedQueueItemId(), "imported", BOORU_IMPORT_NO_MEDIA_ID_AI_MESSAGE, upload.link);
    return;
  }

  let predictions: AiTagPrediction[];
  try {
    predictions = (await api.predict(mediaId)).map(normalizePrediction).filter((item): item is AiTagPrediction => Boolean(item));
  } catch {
    await persistSelectedQueueItemEditsNow();
    throw new Error("Imported, but AI tagging failed.");
  }

  const selected = selectAutoPredictions(predictions);
  rememberPredictionCategories(selected);
  const nextTags = mergeTags(nonRatingTags(parseTagsWithHints(els.tags.value).tags), selected.map((tag) => tag.name));
  els.tags.value = tagText(nextTags);
  renderChips();

  const finalPayload = buildFinalPayload(selected);
  try {
    await api.ensureTagsWithCategories(finalPayload.categoryHints);
    const patched = await api.patchMedia(mediaId, {
      tags: finalPayload.tags,
      rating: finalPayload.rating,
      source: finalPayload.source,
      categoryHints: finalPayload.categoryHints
    });
    manualState = undefined;
    markUploaded(patched.link ? patched : upload, { mediaId, finalSaved: true });
    renderWorkflowState();
    await persistSelectedQueueItemEditsNow();
    await setQueueItemStatus(requireSelectedQueueItemId(), "imported", `Imported with ${selected.length} AI tags.`, patched.link || upload.link);
  } catch {
    await persistSelectedQueueItemEditsNow();
    throw new Error("Imported and AI predicted, but saving final tags failed.");
  }
}

function requireSelectedQueueItemId(): string {
  if (!selectedQueueItemId) throw new Error("No selected queue item.");
  return selectedQueueItemId;
}

async function setQueueItemStatus(
  itemId: string,
  status: ImportQueueItem["status"],
  message: string,
  link?: string,
  error?: string
): Promise<void> {
  await updateCurrentQueue((queue) => ({
    ...queue,
    items: queue.items.map((item) =>
      item.id === itemId
        ? {
            ...item,
            status,
            statusMessage: message,
            statusLink: link,
            error,
            updatedAt: Date.now()
          }
        : item
    ),
    updatedAt: Date.now()
  }));

  if (itemId === selectedQueueItemId) {
    renderStatus({
      message,
      tone: queueStatusTone(status),
      link
    });
  }
}

function queueImportErrorMessage(error: unknown): string {
  if (error instanceof BlombooruAuthError) return "Blombooru rejected the API key.";
  if (error instanceof BlombooruApiError) return error.message;
  return error instanceof Error ? error.message : "Import failed.";
}

function mergeDrafts(base: ImportDraft, extracted: ImportDraft): ImportDraft {
  const artistTags = draftArtistTags(base, extracted);
  return {
    ...base,
    ...definedOnly(extracted),
    artistTags: artistTags.length ? artistTags : undefined,
    artistTag: artistTags[0] || extracted.artistTag || base.artistTag,
    seedTags: mergeTags(base.seedTags, extracted.seedTags),
    hashtags: mergeTags(base.hashtags, extracted.hashtags),
    raw: { base: base.raw, extracted: extracted.raw }
  };
}

function definedOnly(value: ImportDraft): ImportDraft {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== "")) as ImportDraft;
}

function applyDraftToForm(options: { preserveEditedTags?: boolean } = {}): void {
  const form = defaultFormForDraft(draft, els.includeHashtags.checked);
  els.source.value = form.source;
  els.artist.value = form.artist;
  setRating(form.rating);

  if (!options.preserveEditedTags || !els.tags.value.trim()) {
    els.tags.value = form.tags;
  } else {
    syncHashtagTagsWithToggle();
  }
  scheduleArtistStatus();
  persistSidePanelStateDebounced();
}

function defaultFormForDraft(nextDraft: ImportDraft, includeHashtags = settings.includePostHashtagsDefault): ImportFormState {
  const misskeyArtist = misskeyArtistFormValues(nextDraft);
  const artists = misskeyArtist.artist ? [misskeyArtist.artist] : draftArtistTags(nextDraft);
  return {
    source: nextDraft.sourceUrl || nextDraft.pageUrl || "",
    artist: commaTagText(artists),
    rating: nextDraft.rating ?? settings.defaultRating,
    tags: tagText(nonRatingTags(defaultTagListForDraft(nextDraft, includeHashtags, misskeyArtist.domainTag))),
    includePostHashtags: includeHashtags
  };
}

function currentFormState(): ImportFormState {
  return {
    source: els.source.value,
    artist: els.artist.value,
    rating: getRating(),
    tags: els.tags.value,
    includePostHashtags: els.includeHashtags.checked
  };
}

function applyFormState(form: ImportFormState): void {
  els.source.value = form.source;
  els.artist.value = form.artist;
  setRating(form.rating);
  els.tags.value = form.tags;
  els.includeHashtags.checked = form.includePostHashtags ?? settings.includePostHashtagsDefault;
  scheduleArtistStatus();
}

function defaultTagListForDraft(nextDraft: ImportDraft, includeHashtags: boolean, domainTag: string | undefined): string[] {
  return mergeTags(
    nonHashtagSeedTags(nextDraft),
    includeHashtags ? nextDraft.hashtags : undefined,
    domainTag ? [domainTag] : [],
    fourChanTagsForDraft(nextDraft)
  );
}

function nonHashtagSeedTags(nextDraft = draft): string[] {
  const hashtags = new Set(normalizedDraftHashtags(nextDraft));
  const artists = new Set(draftArtistTags(nextDraft));
  return (nextDraft.seedTags ?? []).filter((tag) => {
    const normalized = normalizeTag(tag);
    return !hashtags.has(normalized) && !artists.has(normalized);
  });
}

function normalizedDraftHashtags(nextDraft = draft): string[] {
  return mergeTags(nextDraft.hashtags).map(normalizeTag).filter(Boolean);
}

function syncHashtagTagsWithToggle(): void {
  const hashtags = normalizedDraftHashtags();
  if (!hashtags.length) return;

  const parsed = parseTagsWithHints(els.tags.value);
  const hashtagSet = new Set(hashtags);
  const baseTags = parsed.tags.filter((tag) => !hashtagSet.has(tag));
  els.tags.value = tagText(els.includeHashtags.checked ? mergeTags(baseTags, hashtags) : baseTags);
}

function misskeyArtistFormValues(nextDraft: ImportDraft): { artist?: string; domainTag?: string } {
  if (nextDraft.site !== "misskey") return { artist: undefined };

  const rawArtist = (nextDraft.posterName || nextDraft.artistTag || "").trim().replace(/^@+/, "");
  if (!rawArtist) return {};

  const { username, domain } = splitMisskeyHandle(rawArtist);
  const fullArtist = normalizeTag(rawArtist);
  const artistOnly = normalizeTag(username);
  const domainTag = normalizeMisskeyDomainTag(domain);

  if (settings.misskeyArtistMode === "username-only") {
    return { artist: artistOnly || fullArtist };
  }

  if (settings.misskeyArtistMode === "domain-tag") {
    return {
      artist: artistOnly || fullArtist,
      domainTag
    };
  }

  return { artist: fullArtist || artistOnly };
}

function draftArtistTags(...drafts: ImportDraft[]): string[] {
  return mergeTags(...drafts.map((nextDraft) => [
    ...(nextDraft.artistTags ?? []),
    nextDraft.artistTag
  ]));
}

function splitMisskeyHandle(value: string): { username: string; domain?: string } {
  const trimmed = value.trim().replace(/^@+/, "");
  const atIndex = trimmed.indexOf("@");
  if (atIndex <= 0) return { username: trimmed };
  return {
    username: trimmed.slice(0, atIndex),
    domain: trimmed.slice(atIndex + 1)
  };
}

function normalizeMisskeyDomainTag(domain: string | undefined): string | undefined {
  if (!domain) return undefined;
  return normalizeTag(domain.replace(/\./g, "_"));
}

function fourChanTagsForDraft(nextDraft: ImportDraft): string[] {
  if (nextDraft.site !== "4chan" || settings.fourChanTagMode === "none") return [];

  const boardTag = fourChanBoardTag(nextDraft.sourceUrl || nextDraft.pageUrl);
  if (settings.fourChanTagMode === "site") return ["4chan"];
  if (settings.fourChanTagMode === "board") return boardTag ? [boardTag] : [];
  return boardTag ? ["4chan", boardTag] : ["4chan"];
}

function fourChanBoardTag(value: string | undefined): string | undefined {
  const board = fourChanBoardCode(value);
  return board ? normalizeTag(`4chan_${board}`) : undefined;
}

function fourChanBoardCode(value: string | undefined): string | undefined {
  if (!value) return undefined;

  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/([A-Za-z0-9]+)\/thread\/\d+/);
    return match?.[1]?.toLowerCase();
  } catch {
    return undefined;
  }
}

function renderAll(): void {
  renderPreview();
  renderChips();
  renderWorkflowState();
  renderDebugPanel();
}

function renderWorkflowState(): void {
  els.importActions.hidden = Boolean(uploadedState || manualState);
  els.manualPanel.classList.toggle("hidden", !manualState);
}

function renderPreview(): void {
  const candidates = previewUrlCandidates();
  const url = candidates[0];
  const requestId = ++mediaMetadataRequest;
  if (url && canReuseRenderedPreview(url)) {
    recordSelectedBooruPreviewUrl(url, true);
    return;
  }

  previewFailedUrls = new Set();
  previewFailureDetails = [];
  pageContextFetchDetails = [];
  revokePreviewObjectUrl();
  els.preview.replaceChildren();
  recordPreviewCandidateDebug(candidates, url);

  if (!url) {
    mediaMetadata = undefined;
    renderMediaMetadata();
    const empty = document.createElement("div");
    empty.className = "preview-empty";
    empty.textContent = "No media preview found";
    els.preview.append(empty);
    return;
  }

  const cached = queueItemById(selectedQueueItemId)?.mediaMetadata;
  if (cached?.url === url) {
    mediaMetadata = cached;
    renderMediaMetadata();
  } else {
    resetMediaMetadata(url);
  }
  recordSelectedBooruPreviewUrl(url);
  if (!shouldPreferPageContextMediaFetch(url)) {
    void fetchHeadMediaMetadata(url, requestId);
  }

  renderPreviewUrl(url, requestId);
}

function canReuseRenderedPreview(url: string): boolean {
  if (mediaMetadata?.url !== url || mediaMetadata.loading || mediaMetadata.error) return false;

  const image = els.preview.querySelector<HTMLImageElement>("img");
  if (image && previewObjectUrl && image.src === previewObjectUrl) return true;
  if (image?.src === url) return true;

  const video = els.preview.querySelector<HTMLVideoElement>("video");
  return Boolean(video && (video.currentSrc === url || video.src === url));
}

function recordPreviewCandidateDebug(candidates: string[], selectedUrl: string | undefined): void {
  if (draft.site !== "booru" && !draft.blombooruBooruImport) return;

  updateBooruImportDebug({
    delegated: Boolean(draft.blombooruBooruImport),
    mediaStrategy: booruMediaStrategy(draft),
    previewCandidates: candidates,
    selectedPreviewUrl: selectedUrl,
    previewReused: false,
    previewFailures: [],
    pageContextFetchUrl: undefined,
    pageContextFetchResponseUrl: undefined,
    pageContextFetchBytes: undefined,
    pageContextFetchContentType: undefined,
    pageContextFetchError: undefined,
    pageContextFetches: []
  });
  renderDebugPanel();
}

function renderPreviewUrl(url: string, requestId: number): void {
  if (shouldUsePageSessionBooruMedia(draft) && !isBooruProxyImageUrl(url)) {
    void renderPageContextPreviewFirst(url, requestId);
    return;
  }

  if (isVideoUrl(url)) {
    const video = document.createElement("video");
    const timeout = window.setTimeout(() => {
      if (requestId !== mediaMetadataRequest || mediaMetadata?.url !== url) return;
      if (tryFallbackPreviewUrl(url, requestId, "Video preview timed out.")) return;
      reportPreviewFailure(url, requestId, "Video preview timed out.");
    }, PREVIEW_LOAD_TIMEOUT_MS);
    video.src = url;
    video.controls = true;
    video.muted = true;
    video.playsInline = true;
    video.addEventListener("loadedmetadata", () => {
      window.clearTimeout(timeout);
      updateMediaMetadata(url, requestId, {
        width: video.videoWidth || undefined,
        height: video.videoHeight || undefined
      });
    });
    video.addEventListener("error", () => {
      window.clearTimeout(timeout);
      if (requestId !== mediaMetadataRequest) return;
      if (tryFallbackPreviewUrl(url, requestId, "Video preview failed to load.")) return;
      reportPreviewFailure(url, requestId, "Video preview failed to load.");
    }, { once: true });
    els.preview.append(video);
    return;
  }

  if (isBlombooruApiUrl(url)) {
    void renderImageBlobPreview(url, requestId);
    return;
  }

  renderPreviewUrlDirect(url, requestId);
}

async function renderPageContextPreviewFirst(url: string, requestId: number): Promise<void> {
  const loading = document.createElement("div");
  loading.className = "preview-empty";
  loading.textContent = "Loading preview...";
  els.preview.replaceChildren(loading);

  if (await tryPageContextBlobPreview(url, requestId)) return;
  if (requestId !== mediaMetadataRequest || mediaMetadata?.url !== url) return;
  renderPreviewUrlDirect(url, requestId);
}

function renderPreviewUrlDirect(url: string, requestId: number): void {
  if (isVideoUrl(url)) {
    const video = document.createElement("video");
    const timeout = window.setTimeout(() => {
      if (requestId !== mediaMetadataRequest || mediaMetadata?.url !== url) return;
      if (tryFallbackPreviewUrl(url, requestId, "Video preview timed out.")) return;
      reportPreviewFailure(url, requestId, "Video preview timed out.");
    }, PREVIEW_LOAD_TIMEOUT_MS);
    video.src = url;
    video.controls = true;
    video.muted = true;
    video.playsInline = true;
    video.addEventListener("loadedmetadata", () => {
      window.clearTimeout(timeout);
      updateMediaMetadata(url, requestId, {
        width: video.videoWidth || undefined,
        height: video.videoHeight || undefined
      });
    });
    video.addEventListener("error", () => {
      window.clearTimeout(timeout);
      if (requestId !== mediaMetadataRequest) return;
      if (tryFallbackPreviewUrl(url, requestId, "Video preview failed to load.")) return;
      reportPreviewFailure(url, requestId, "Video preview failed to load.");
    }, { once: true });
    els.preview.append(video);
    return;
  }

  const image = document.createElement("img");
  const timeout = window.setTimeout(() => {
    if (requestId !== mediaMetadataRequest || mediaMetadata?.url !== url) return;
    if (tryFallbackPreviewUrl(url, requestId, "Preview timed out.")) return;
    reportPreviewFailure(url, requestId, "Preview timed out.");
  }, PREVIEW_LOAD_TIMEOUT_MS);
  image.src = url;
  image.alt = "";
  markBlurSensitiveImage(image);
  image.addEventListener("load", () => {
    window.clearTimeout(timeout);
    updateMediaMetadata(url, requestId, {
      width: image.naturalWidth || undefined,
      height: image.naturalHeight || undefined
    });
  });
  image.addEventListener("error", () => {
    window.clearTimeout(timeout);
    if (requestId !== mediaMetadataRequest) return;
    void renderImageBlobPreview(url, requestId);
  }, { once: true });
  els.preview.append(image);
}

async function renderImageBlobPreview(url: string, requestId: number): Promise<void> {
  const loading = document.createElement("div");
  loading.className = "preview-empty";
  loading.textContent = "Loading preview...";
  els.preview.replaceChildren(loading);

  try {
    const response = await fetchWithTimeout(url, {
      credentials: "include",
      referrerPolicy: "no-referrer"
    }, PREVIEW_LOAD_TIMEOUT_MS);

    if (requestId !== mediaMetadataRequest || mediaMetadata?.url !== url) return;
    const responseContentType = normalizedMimeType(response.headers.get("content-type"));
    if (!response.ok) {
      throw new PreviewResponseError(`Preview fetch failed (${response.status}).`, {
        status: response.status,
        contentType: responseContentType || undefined,
        responseUrl: response.url || undefined,
        bodyPreview: await responseTextPreview(response),
        authAttempted: authAttemptedForUrl(url)
      });
    }

    const blob = await response.blob();
    const contentType = normalizedMimeType(blob.type || responseContentType);
    if (contentType && isClearlyNonMediaMime(contentType)) {
      throw new PreviewResponseError(`Preview URL returned ${contentType}.`, {
        status: response.status,
        contentType,
        responseUrl: response.url || undefined,
        bodyPreview: await blobTextPreview(blob),
        authAttempted: authAttemptedForUrl(url)
      });
    }
    if (contentType && !contentType.startsWith("image/")) {
      throw new PreviewResponseError(`Preview is ${contentType}.`, {
        status: response.status,
        contentType,
        responseUrl: response.url || undefined,
        bodyPreview: await blobTextPreview(blob),
        authAttempted: authAttemptedForUrl(url)
      });
    }

    revokePreviewObjectUrl();
    previewObjectUrl = URL.createObjectURL(blob);
    updateMediaMetadata(url, requestId, {
      bytes: blob.size || mediaMetadata?.bytes,
      mimeType: contentType || mediaMetadata?.mimeType,
      sizeSource: "blob",
      loading: false
    });

    const image = document.createElement("img");
    image.src = previewObjectUrl;
    image.alt = "";
    markBlurSensitiveImage(image);
    image.addEventListener("load", () => {
      updateMediaMetadata(url, requestId, {
        width: image.naturalWidth || undefined,
        height: image.naturalHeight || undefined,
        loading: false
      });
    });
    image.addEventListener("error", () => {
      if (requestId !== mediaMetadataRequest) return;
      if (tryFallbackPreviewUrl(url, requestId, "Preview blob could not be displayed.")) return;
      reportPreviewFailure(url, requestId, "Preview blob could not be displayed.");
    }, { once: true });
    els.preview.replaceChildren(image);
  } catch (error) {
    if (requestId !== mediaMetadataRequest || mediaMetadata?.url !== url) return;
    const message = error instanceof Error ? error.message : "Preview failed to load.";
    const detail = error instanceof PreviewResponseError ? error.detail : undefined;
    recordPreviewCandidateFailure(url, message, detail);
    previewFailedUrls.add(url);
    if (await tryPageContextBlobPreview(url, requestId)) return;
    if (tryFallbackPreviewUrl(url, requestId, message, detail)) return;
    reportPreviewFailure(url, requestId, message, detail);
  }
}

async function tryPageContextBlobPreview(url: string, requestId: number): Promise<boolean> {
  const rawUrl = pageMediaUrlForCandidate(url);
  if (!rawUrl) return false;

  try {
    const fetched = await fetchPageContextMediaBlob(rawUrl);
    if (requestId !== mediaMetadataRequest || mediaMetadata?.url !== url) return true;

    const contentType = normalizedMimeType(fetched.contentType || fetched.blob.type);
    if (contentType && isClearlyNonMediaMime(contentType)) {
      throw new Error(`Page media returned ${contentType}.`);
    }
    if (contentType && !contentType.startsWith("image/")) {
      throw new Error(`Page media is ${contentType}.`);
    }

    revokePreviewObjectUrl();
    previewObjectUrl = URL.createObjectURL(fetched.blob);
    updateMediaMetadata(url, requestId, {
      bytes: fetched.blob.size || mediaMetadata?.bytes,
      mimeType: contentType || mediaMetadata?.mimeType,
      sizeSource: "blob",
      loading: false,
      error: undefined
    });

    const image = document.createElement("img");
    image.src = previewObjectUrl;
    image.alt = "";
    markBlurSensitiveImage(image);
    image.addEventListener("load", () => {
      updateMediaMetadata(url, requestId, {
        width: image.naturalWidth || undefined,
        height: image.naturalHeight || undefined,
        loading: false,
        error: undefined
      });
    });
    image.addEventListener("error", () => {
      if (requestId !== mediaMetadataRequest) return;
      const message = "Page media blob could not be displayed.";
      recordPageContextFetchDetail({ url: rawUrl, error: message });
      if (tryFallbackPreviewUrl(url, requestId, message)) return;
      reportPreviewFailure(url, requestId, message);
    }, { once: true });
    els.preview.replaceChildren(image);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Page media fetch failed.";
    recordPageContextFetchDetail({ url: rawUrl, error: message });
    return false;
  }
}

async function fetchPageContextMediaBlob(rawUrl: string): Promise<{ url: string; blob: Blob; contentType: string; bytes: number }> {
  const requestKey = normalizedHttpUrl(rawUrl) || rawUrl;
  const cached = pageContextMediaCache.get(requestKey);
  if (cached && Date.now() - cached.cachedAt < 60_000) {
    return cached;
  }

  const inFlight = pageContextMediaRequests.get(requestKey);
  if (inFlight) return inFlight;

  const request = fetchPageContextMediaBlobUncached(rawUrl)
    .then((result) => {
      pageContextMediaCache.set(requestKey, { ...result, cachedAt: Date.now() });
      prunePageContextMediaCache();
      return result;
    })
    .finally(() => {
      pageContextMediaRequests.delete(requestKey);
    });
  pageContextMediaRequests.set(requestKey, request);
  return request;
}

function prunePageContextMediaCache(): void {
  const entries = Array.from(pageContextMediaCache.entries());
  if (entries.length <= 10) return;
  for (const [key] of entries.sort((a, b) => a[1].cachedAt - b[1].cachedAt).slice(0, entries.length - 10)) {
    pageContextMediaCache.delete(key);
  }
}

async function fetchPageContextMediaBlobUncached(rawUrl: string): Promise<{ url: string; blob: Blob; contentType: string; bytes: number }> {
  const tabId = pendingTabId ?? (await currentTabId());
  if (typeof tabId !== "number") throw new Error("No page tab available for media fetch.");

  let response: PageMediaFetchResponse | undefined;
  try {
    response = await chrome.tabs.sendMessage(tabId, {
      type: FETCH_PAGE_MEDIA_MESSAGE,
      url: rawUrl
    }) as PageMediaFetchResponse | undefined;
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "Page media fetch message failed.");
  }

  if (!response?.ok || !response.base64) {
    throw new Error(response?.error || "Page media fetch failed.");
  }

  const bytes = base64ToUint8Array(response.base64);
  const contentType = normalizedMimeType(response.contentType);
  const blobPart = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const blob = new Blob([blobPart], {
    type: contentType || "application/octet-stream"
  });
  const fetchedUrl = normalizedHttpUrl(response.url) || rawUrl;
  recordPageContextFetchDetail({
    url: rawUrl,
    responseUrl: fetchedUrl,
    bytes: response.bytes ?? blob.size,
    contentType
  });

  return {
    url: fetchedUrl,
    blob,
    contentType,
    bytes: response.bytes ?? blob.size
  };
}

function pageMediaUrlForCandidate(candidateUrl: string): string | undefined {
  if (draft.site !== "booru" && !draft.blombooruBooruImport) return undefined;

  const rawUrl = normalizedHttpUrl(unproxiedBooruProxyImageUrl(candidateUrl));
  if (!rawUrl || isBlombooruApiUrl(rawUrl)) return undefined;
  return rawUrl;
}

function recordPageContextFetchDetail(detail: PageContextFetchDetail): void {
  if (draft.site !== "booru" && !draft.blombooruBooruImport) return;

  pageContextFetchDetails = [...pageContextFetchDetails, detail];
  updateBooruImportDebug({
    delegated: Boolean(draft.blombooruBooruImport),
    mediaStrategy: booruMediaStrategy(draft),
    pageContextFetchUrl: detail.url,
    pageContextFetchResponseUrl: detail.responseUrl,
    pageContextFetchBytes: detail.bytes,
    pageContextFetchContentType: detail.contentType,
    pageContextFetchError: detail.error,
    pageContextFetches: pageContextFetchDetails
  });
  renderDebugPanel();
}

function base64ToUint8Array(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function previewUrlCandidates(): string[] {
  return previewUrlCandidatesForDraft(draft);
}

function previewUrlCandidatesForDraft(nextDraft: ImportDraft): string[] {
  const delegated = nextDraft.blombooruBooruImport;
  if (delegated) {
    return delegatedBooruMediaCandidates(nextDraft);
  }
  if (nextDraft.site === "booru") {
    if (shouldUsePageSessionBooruMedia(nextDraft)) return rawFallbackBooruMediaCandidates(nextDraft);
    return fallbackBooruMediaCandidates(nextDraft);
  }

  return fullQualityUrlCandidates([nextDraft.mediaUrl, nextDraft.previewUrl, ...rawMediaUrls(nextDraft.raw)]);
}

function fallbackBooruMediaCandidates(nextDraft: ImportDraft): string[] {
  return rawFallbackBooruMediaCandidates(nextDraft);
}

function rawFallbackBooruMediaCandidates(nextDraft: ImportDraft): string[] {
  return fullQualityUrlCandidates(
    [nextDraft.mediaUrl, nextDraft.previewUrl, ...rawMediaUrls(nextDraft.raw)]
      .map((url) => unproxiedBooruProxyImageUrl(url))
  ).filter((url) => !isBooruProxyImageUrl(url));
}

function delegatedBooruMediaCandidates(nextDraft: ImportDraft): string[] {
  const delegated = nextDraft.blombooruBooruImport;
  if (!delegated) return [];

  return uniqueUrls([
    ...proxiedDelegatedBooruMediaCandidates(nextDraft),
    ...rawDelegatedBooruMediaCandidates(nextDraft)
  ]);
}

function proxiedDelegatedBooruMediaCandidates(nextDraft: ImportDraft): string[] {
  const delegated = nextDraft.blombooruBooruImport;
  if (!delegated) return [];
  return fullQualityUrlCandidates([delegated.proxyFileUrl, delegated.proxyPreviewUrl]);
}

function rawDelegatedBooruMediaCandidates(nextDraft: ImportDraft): string[] {
  const delegated = nextDraft.blombooruBooruImport;
  if (!delegated) return [];
  const proxied = new Set(proxiedDelegatedBooruMediaCandidates(nextDraft));

  return fullQualityUrlCandidates([
    delegated.fileUrl,
    delegated.previewUrl,
    nextDraft.mediaUrl,
    nextDraft.previewUrl,
    ...rawMediaUrls(nextDraft.raw)
  ]).filter((url) => !proxied.has(url));
}

function recordSelectedBooruPreviewUrl(url: string, previewReused = false): void {
  const delegated = draft.blombooruBooruImport;
  if (draft.site !== "booru" && !delegated) return;

  updateBooruImportDebug({
    delegated: Boolean(delegated),
    mediaStrategy: booruMediaStrategy(draft),
    selectedPreviewUrl: url,
    previewReused,
    proxyFileUrl: delegated?.proxyFileUrl,
    proxyPreviewUrl: delegated?.proxyPreviewUrl
  });
}

function nextPreviewFallbackUrl(): string | undefined {
  if (!draft.blombooruBooruImport) {
    return previewUrlCandidates().find((candidate) => !previewFailedUrls.has(candidate));
  }

  const proxied = proxiedDelegatedBooruMediaCandidates(draft);
  const proxyFallback = proxied.find((candidate) => !previewFailedUrls.has(candidate));
  if (proxyFallback) return proxyFallback;

  return rawDelegatedBooruMediaCandidates(draft).find((candidate) => !previewFailedUrls.has(candidate));
}

function reportPreviewFailure(
  url: string,
  requestId: number,
  message: string,
  detail: Omit<PreviewFailureDetail, "url" | "error"> = {}
): void {
  if (requestId !== mediaMetadataRequest) return;
  recordPreviewCandidateFailure(url, message, detail);
  showPreviewLoadFailure(url, requestId, message);
  if (draft.site !== "booru" && !draft.blombooruBooruImport) return;

  updateBooruImportDebug({
    mediaValidationRejectedUrl: url,
    mediaValidationError: message,
    previewFailures: previewFailureDetails
  });
  renderDebugPanel();
}

function tryFallbackPreviewUrl(
  failedUrl: string,
  requestId: number,
  message = "Preview candidate failed.",
  detail: Omit<PreviewFailureDetail, "url" | "error"> = {}
): boolean {
  recordPreviewCandidateFailure(failedUrl, message, detail);
  previewFailedUrls.add(failedUrl);
  const fallback = nextPreviewFallbackUrl();
  if (!fallback) return false;
  revokePreviewObjectUrl();
  els.preview.replaceChildren();
  resetMediaMetadata(fallback);
  recordSelectedBooruPreviewUrl(fallback);
  renderDebugPanel();
  void fetchHeadMediaMetadata(fallback, requestId);
  renderPreviewUrl(fallback, requestId);
  return true;
}

function recordPreviewCandidateFailure(
  url: string,
  error: string,
  detail: Omit<PreviewFailureDetail, "url" | "error"> = {}
): void {
  const next: PreviewFailureDetail = { url, error, ...detail };
  if (previewFailureDetails.some((item) => item.url === url && item.error === error)) return;
  previewFailureDetails = [...previewFailureDetails, next];
  if (draft.site !== "booru" && !draft.blombooruBooruImport) return;

  updateBooruImportDebug({
    delegated: Boolean(draft.blombooruBooruImport),
    previewFailures: previewFailureDetails
  });
}

function showPreviewLoadFailure(url: string, requestId: number, message: string): void {
  updateMediaMetadata(url, requestId, {
    loading: false,
    error: message
  });
  const empty = document.createElement("div");
  empty.className = "preview-empty";
  empty.textContent = "Preview failed to load";
  els.preview.replaceChildren(empty);
}

function markBlurSensitiveImage(image: HTMLImageElement): void {
  image.classList.add("blur-sensitive-media");
}

function handleBlurredImageClick(event: MouseEvent): void {
  if (settings.sidePanelImageBlurMode !== "click") return;
  const target = event.target instanceof Element ? event.target : undefined;
  const image = target?.closest<HTMLImageElement>("img.blur-sensitive-media");
  if (!image || image.dataset.blurRevealed === "true") return;

  image.dataset.blurRevealed = "true";
  event.preventDefault();
  event.stopPropagation();
}

function revokePreviewObjectUrl(): void {
  if (!previewObjectUrl) return;
  URL.revokeObjectURL(previewObjectUrl);
  previewObjectUrl = undefined;
}

function resetMediaMetadata(url: string): void {
  mediaMetadata = { url, loading: true };
  renderMediaMetadata();
}

async function fetchHeadMediaMetadata(url: string, requestId: number): Promise<void> {
  try {
    const metadata = await probeMediaMetadata(url);
    updateMediaMetadata(url, requestId, {
      ...metadata,
      loading: false
    });
  } catch (error) {
    updateMediaMetadata(url, requestId, {
      loading: false,
      error: error instanceof Error ? error.message : "Metadata failed"
    });
  }
}

function updateMediaMetadata(url: string, requestId: number, next: Partial<MediaMetadata>): void {
  if (requestId !== mediaMetadataRequest || mediaMetadata?.url !== url) return;
  mediaMetadata = {
    ...mediaMetadata,
    ...next,
    url
  };
  renderMediaMetadata();
  renderDebugPanel();
  persistSelectedQueueItemEditsDebounced();
}

function renderMediaMetadata(): void {
  if (!mediaMetadata) {
    els.mediaMetadata.textContent = "";
    return;
  }

  const parts = [
    mediaMetadata.width && mediaMetadata.height ? `${mediaMetadata.width} x ${mediaMetadata.height}` : undefined,
    mediaMetadata.bytes ? formatBytes(mediaMetadata.bytes) : undefined,
    mediaMetadata.mimeType
  ].filter((part): part is string => Boolean(part));

  if (parts.length) {
    els.mediaMetadata.textContent = mediaMetadata.error ? `${parts.join(" • ")} • ${mediaMetadata.error}` : parts.join(" • ");
    return;
  }

  if (mediaMetadata.error) {
    els.mediaMetadata.textContent = mediaMetadata.error;
    return;
  }

  els.mediaMetadata.textContent = mediaMetadata.loading ? "Loading media details..." : "";
}

function renderChips(): void {
  const parsed = parseTagsWithHints(els.tags.value);
  const artists = artistInputTags();
  const artistSet = new Set(artists);
  const hints = { ...booruImportCategoryHints(parsed.tags), ...parsed.categoryHints };
  const normalTags = nonRatingTags(parsed.tags);
  const tags = artists.length ? mergeTags(normalTags.filter((tag) => !artistSet.has(tag)), artists) : normalTags;

  for (const artist of artists) hints[artist] = "artist";

  els.chips.replaceChildren(...tags.map((tag) => chipForTag(tag, hints[tag])));
}

function nonRatingTags(tags: string[]): string[] {
  return tags.filter((tag) => !isRatingTag(tag));
}

function chipForTag(tag: string, hint?: string): HTMLElement {
  const chip = document.createElement("span");
  const category = normalizeCategory(hint || categoryCache.get(tag));
  chip.className = "tag-chip";
  chip.dataset.category = knownChipCategory(category);
  chip.textContent = tag;
  return chip;
}

function knownChipCategory(category: string): string {
  return ["general", "artist", "character", "copyright", "meta"].includes(category) ? category : "unknown";
}

async function persistSettings(): Promise<void> {
  const previousBaseUrl = settings.baseUrl;
  const previousApiKey = settings.apiKey;
  settings = normalizeSettings({
    baseUrl: els.baseUrl.value,
    apiKey: els.apiKey.value,
    defaultRating: els.defaultRating.value as Rating,
    aiModelName: els.aiModel.value,
    aiAutoGeneralThreshold: Number(els.generalThreshold.value),
    aiAutoCharacterThreshold: Number(els.characterThreshold.value),
    hideRatingTags: els.hideRatingTags.checked,
    includePostHashtagsDefault: els.includePostHashtagsDefault.checked,
    closeAfterImport: els.closeAfterImport.checked,
    clearPanelAfterImportDefault: els.clearPanelAfterImportDefault.checked,
    misskeyArtistMode: els.misskeyArtistMode.value as AppSettings["misskeyArtistMode"],
    fourChanTagMode: els.fourChanTagMode.value as AppSettings["fourChanTagMode"],
    sidePanelImageBlurMode: els.sidePanelImageBlurMode.value as AppSettings["sidePanelImageBlurMode"],
    multiAddCaptureLeftClick: els.multiAddCaptureLeftClick.checked,
    multiAddCaptureRightClick: els.multiAddCaptureRightClick.checked,
    debugMode: els.debugMode.checked
  });
  if (settings.baseUrl !== previousBaseUrl || settings.apiKey !== previousApiKey) {
    artistLookupCache.clear();
  }
  await saveSettings(settings);
  renderSettings(settings);
  renderDebugPanel();
  await syncCaptureStateToActiveTab();
  showSettingsSavedFeedback();
  setStatus("Settings saved.", "success");
}

function renderSettings(nextSettings: AppSettings): void {
  els.baseUrl.value = nextSettings.baseUrl;
  els.apiKey.value = nextSettings.apiKey;
  els.defaultRating.value = nextSettings.defaultRating;
  els.aiModel.value = nextSettings.aiModelName || DEFAULT_SETTINGS.aiModelName;
  els.generalThreshold.value = String(nextSettings.aiAutoGeneralThreshold);
  els.characterThreshold.value = String(nextSettings.aiAutoCharacterThreshold);
  els.hideRatingTags.checked = nextSettings.hideRatingTags;
  els.includePostHashtagsDefault.checked = nextSettings.includePostHashtagsDefault;
  els.closeAfterImport.checked = nextSettings.closeAfterImport;
  els.clearPanelAfterImportDefault.checked = nextSettings.clearPanelAfterImportDefault;
  els.misskeyArtistMode.value = nextSettings.misskeyArtistMode;
  els.fourChanTagMode.value = nextSettings.fourChanTagMode;
  els.sidePanelImageBlurMode.value = nextSettings.sidePanelImageBlurMode;
  els.multiAddCaptureLeftClick.checked = nextSettings.multiAddCaptureLeftClick;
  els.multiAddCaptureRightClick.checked = nextSettings.multiAddCaptureRightClick;
  els.debugMode.checked = nextSettings.debugMode;
  document.documentElement.dataset.sidePanelImageBlurMode = nextSettings.sidePanelImageBlurMode;
}

async function importNoAi(): Promise<void> {
  await runImport(async () => {
    const api = requireConfiguredApi({ allowSessionAuth: Boolean(draft.blombooruBooruImport) });
    const payload = buildFinalPayload();
    const upload = draft.blombooruBooruImport
      ? await downloadCurrentBooruImport(api, payload)
      : await uploadCurrentMedia(api, payload);
    markUploaded(upload, { finalSaved: true });
    if (selectedQueueItemId) await setQueueItemStatus(selectedQueueItemId, "imported", "Imported.", upload.link);
    setSuccess("Imported.", upload.link);
  });
}

async function importAiAuto(): Promise<void> {
  await runImport(async () => {
    const api = requireConfiguredApi();
    const initialPayload = buildFinalPayload();
    const initialImport = await importCurrentMediaForAi(api, initialPayload);
    const upload = initialImport.upload;
    const mediaId = initialImport.mediaId;
    markUploaded(upload, { mediaId, finalSaved: initialImport.delegated && !mediaId });

    if (!mediaId) {
      if (selectedQueueItemId) await setQueueItemStatus(selectedQueueItemId, "imported", BOORU_IMPORT_NO_MEDIA_ID_AI_MESSAGE, upload.link);
      setLinkedStatus(BOORU_IMPORT_NO_MEDIA_ID_AI_MESSAGE, upload.link);
      return;
    }

    let predictions: AiTagPrediction[];
    try {
      predictions = (await api.predict(mediaId)).map(normalizePrediction).filter((item): item is AiTagPrediction => Boolean(item));
    } catch {
      if (selectedQueueItemId) await setQueueItemStatus(selectedQueueItemId, "error", "Imported, but AI tagging failed.", upload.link, "AI tagging failed.");
      setLinkedStatus("Imported, but AI tagging failed.", upload.link);
      return;
    }

    const selected = selectAutoPredictions(predictions);
    rememberPredictionCategories(selected);
    const nextTags = mergeTags(nonRatingTags(parseTagsWithHints(els.tags.value).tags), selected.map((tag) => tag.name));
    els.tags.value = tagText(nextTags);
    renderChips();

    const finalPayload = buildFinalPayload(selected);
    try {
      await api.ensureTagsWithCategories(finalPayload.categoryHints);
      const patched = await api.patchMedia(mediaId, {
        tags: finalPayload.tags,
        rating: finalPayload.rating,
        source: finalPayload.source,
        categoryHints: finalPayload.categoryHints
      });
      manualState = undefined;
      markUploaded(patched.link ? patched : upload, { mediaId, finalSaved: true });
      renderWorkflowState();
      if (selectedQueueItemId) await setQueueItemStatus(selectedQueueItemId, "imported", `Imported with ${selected.length} AI tags.`, patched.link || upload.link);
      setSuccess(`Imported with ${selected.length} AI tags.`, patched.link || upload.link);
    } catch {
      manualState = {
        mediaId,
        link: upload.link,
        predictions,
        baseTags: initialPayload.tags,
        appliedNames: selected.map((prediction) => prediction.name)
      };
      renderManualPredictions(predictions, selected.map((prediction) => prediction.name));
      renderWorkflowState();
      if (selectedQueueItemId) await setQueueItemStatus(selectedQueueItemId, "error", "Imported and AI predicted, but saving final tags failed.", upload.link, "Saving final tags failed.");
      setLinkedStatus("Imported and AI predicted, but saving final tags failed. Review the tags and click Save Final Tags.", upload.link, "error");
    }
  });
}

async function importAiManual(): Promise<void> {
  await runImport(async () => {
    const api = requireConfiguredApi();
    const initialPayload = buildFinalPayload();
    const initialImport = await importCurrentMediaForAi(api, initialPayload);
    const upload = initialImport.upload;
    const mediaId = initialImport.mediaId;
    markUploaded(upload, { mediaId, finalSaved: initialImport.delegated && !mediaId });

    if (!mediaId) {
      if (selectedQueueItemId) await setQueueItemStatus(selectedQueueItemId, "imported", BOORU_IMPORT_NO_MEDIA_ID_AI_MESSAGE, upload.link);
      setLinkedStatus(BOORU_IMPORT_NO_MEDIA_ID_AI_MESSAGE, upload.link);
      return;
    }

    let predictions: AiTagPrediction[];
    try {
      predictions = (await api.predict(mediaId)).map(normalizePrediction).filter((item): item is AiTagPrediction => Boolean(item));
    } catch {
      if (selectedQueueItemId) await setQueueItemStatus(selectedQueueItemId, "error", "Imported, but AI tagging failed.", upload.link, "AI tagging failed.");
      setLinkedStatus("Imported, but AI tagging failed.", upload.link);
      return;
    }

    rememberPredictionCategories(predictions);
    manualState = {
      mediaId,
      link: upload.link,
      predictions,
      baseTags: nonRatingTags(parseTagsWithHints(els.tags.value).tags),
      appliedNames: []
    };
    renderManualPredictions(predictions);
    syncManualSelectedTagsToTextbox();
    renderWorkflowState();
    setLinkedStatus("Uploaded. Review AI suggestions, then save final tags.", upload.link);
  });
}

async function importCurrentMediaForAi(
  api: BlombooruApi,
  payload: ReturnType<typeof buildFinalPayload>
): Promise<{ upload: UploadMediaResult; mediaId?: string; delegated: boolean }> {
  const delegated = Boolean(draft.blombooruBooruImport);
  const upload = delegated
    ? await downloadCurrentBooruImport(api, payload)
    : await uploadCurrentMedia(api, payload);
  const mediaId = upload.id;

  if (!mediaId && !delegated) {
    throw new Error("Upload succeeded, but Blombooru did not return a media id.");
  }

  return { upload, mediaId, delegated };
}

async function uploadCurrentMedia(
  api: BlombooruApi,
  payload: ReturnType<typeof buildFinalPayload>
): Promise<UploadMediaResult> {
  const mediaUrls = mediaFetchCandidates();
  if (!mediaUrls.length) throw new Error(missingMediaUrlMessage());

  setStatus("Fetching and hashing media...", "info");
  const fetched = await fetchCurrentMediaAsStableFile(mediaUrls);
  updateMediaMetadataAfterBlob(fetched.url, fetched.stable.file.size, fetched.stable.mimeType);

  setStatus("Uploading to Blombooru...", "info");
  return api.uploadMedia({
    file: fetched.stable.file,
    rating: payload.rating,
    source: payload.source,
    tags: payload.tags,
    categoryHints: payload.categoryHints
  });
}

async function downloadCurrentBooruImport(
  api: BlombooruApi,
  payload: ReturnType<typeof buildFinalPayload>
): Promise<UploadMediaResult> {
  const state = draft.blombooruBooruImport;
  if (!state?.originalUrl) throw new Error("No Blombooru booru import source URL found.");

  setStatus("Importing with Blombooru booru import...", "info");
  const result = await api.downloadBooruImport({
    url: state.originalUrl,
    tags: payload.tags,
    rating: payload.rating,
    source: payload.source || state.source || state.booruUrl || state.originalUrl,
    autoCreateTags: true,
    categoryHints: payload.categoryHints
  });

  if (!result.id && !result.link) {
    throw new Error("Blombooru booru import finished, but did not return an imported media id or link.");
  }

  return result;
}

async function fetchCurrentMediaAsStableFile(mediaUrls: string[]): Promise<{ url: string; stable: Awaited<ReturnType<typeof fetchMediaAsStableFile>> }> {
  let lastError: unknown;

  for (const url of mediaUrls) {
    const preferPageContext = shouldPreferPageContextMediaFetch(url);
    if (preferPageContext) {
      const pageFetched = await fetchPageContextStableFile(url);
      if (pageFetched) return pageFetched;
    }

    try {
      return {
        url,
        stable: await fetchMediaAsStableFile(url, authenticatedRequestInit(url))
      };
    } catch (error) {
      lastError = error;
      recordMediaValidationFailure(url, error);
      if (!preferPageContext) {
        const pageFetched = await fetchPageContextStableFile(url);
        if (pageFetched) return pageFetched;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Media fetch failed.");
}

function shouldPreferPageContextMediaFetch(candidateUrl: string): boolean {
  return shouldUsePageSessionBooruMedia(draft) && Boolean(pageMediaUrlForCandidate(candidateUrl));
}

async function fetchPageContextStableFile(candidateUrl: string): Promise<{ url: string; stable: StableFileResult } | undefined> {
  const rawUrl = pageMediaUrlForCandidate(candidateUrl);
  if (!rawUrl) return undefined;

  try {
    const fetched = await fetchPageContextMediaBlob(rawUrl);
    return {
      url: candidateUrl,
      stable: await stableFileFromBlob(fetched.url, fetched.blob, fetched.contentType)
    };
  } catch (error) {
    recordPageContextFetchDetail({
      url: rawUrl,
      error: error instanceof Error ? error.message : "Page media fetch failed."
    });
    recordMediaValidationFailure(rawUrl, error);
    return undefined;
  }
}

function mediaFetchCandidates(): string[] {
  let candidates: string[];
  if (isFourChanCatalogueDraft(draft)) {
    candidates = fullQualityUrlCandidates([draft.mediaUrl]);
  } else if (shouldUsePageSessionBooruMedia(draft)) {
    candidates = rawFallbackBooruMediaCandidates(draft);
  } else if (draft.site === "booru" && !draft.blombooruBooruImport) {
    candidates = fallbackBooruMediaCandidates(draft);
  } else {
    candidates = fullQualityUrlCandidates([draft.mediaUrl, draft.previewUrl, ...rawMediaUrls(draft.raw)]);
  }

  if (draft.site === "booru" || draft.blombooruBooruImport) {
    updateBooruImportDebug({
      delegated: Boolean(draft.blombooruBooruImport),
      mediaStrategy: booruMediaStrategy(draft),
      mediaFetchCandidates: candidates
    });
    renderDebugPanel();
  }

  return candidates;
}

function recordMediaValidationFailure(url: string, error: unknown): void {
  if (draft.site !== "booru" && !draft.blombooruBooruImport) return;

  updateBooruImportDebug({
    delegated: Boolean(draft.blombooruBooruImport),
    mediaStrategy: booruMediaStrategy(draft),
    mediaValidationRejectedUrl: url,
    mediaValidationError: error instanceof Error ? error.message : "Media validation failed."
  });
  renderDebugPanel();
}

function markUploaded(upload: UploadMediaResult, options: { mediaId?: string; finalSaved?: boolean } = {}): void {
  uploadedState = {
    mediaId: options.mediaId ?? upload.id ?? uploadedState?.mediaId,
    link: upload.link ?? uploadedState?.link,
    finalSaved: options.finalSaved ?? uploadedState?.finalSaved
  };
  renderWorkflowState();
  persistSidePanelStateDebounced();
}

function missingMediaUrlMessage(): string {
  const sawXVideo = draft.site === "x" && latestDebugSnapshot?.mediaCandidates?.some((candidate) => {
    const kind = String(candidate.twimgKind ?? "");
    const source = String(candidate.source ?? "");
    const reason = String(candidate.rejectionReason ?? "");
    return kind.includes("video") || source.toLowerCase().includes("video") || reason.toLowerCase().includes("video");
  });

  if (sawXVideo) {
    return "No importable X video URL found. X exposed only a blob, HLS playlist, segment, or thumbnail in this page snapshot. Open or play the video once, reopen Boo Check from the context menu, and try again; if it still fails, copy the debug report.";
  }

  if (isFourChanCatalogueDraft(draft)) {
    return "No importable 4chan original URL found. The catalogue thumbnail was ignored; open the thread or retry after the catalogue API updates.";
  }

  return "No media URL found. Try right-clicking directly on the image or video.";
}

function updateMediaMetadataAfterBlob(url: string, bytes: number, mimeType: string): void {
  if (mediaMetadata?.url !== url) return;
  mediaMetadata = {
    ...mediaMetadata,
    bytes,
    mimeType: mimeType || mediaMetadata.mimeType,
    sizeSource: "blob",
    loading: false
  };
  renderMediaMetadata();
  renderDebugPanel();
  persistSelectedQueueItemEditsDebounced();
}

function buildFinalPayload(extraPredictions: AiTagPrediction[] = []): {
  tags: string[];
  categoryHints: Record<string, string>;
  rating: Rating;
  source: string;
} {
  const parsed = parseTagsWithHints(els.tags.value);
  const categoryHints = { ...booruImportCategoryHints(parsed.tags), ...parsed.categoryHints };
  const extraTags = extraPredictions.map((prediction) => prediction.name);
  const artists = artistInputTags();

  for (const artist of artists) categoryHints[artist] = "artist";

  for (const prediction of extraPredictions) {
    const name = normalizeTag(prediction.name);
    const category = normalizeCategory(prediction.category);
    if (name && category && category !== "unknown") {
      categoryHints[name] = category;
    }
  }

  const tags = mergeTags(nonRatingTags(parsed.tags), nonRatingTags(extraTags), artists);
  const tagSet = new Set(tags);
  for (const name of Object.keys(categoryHints)) {
    if (!tagSet.has(name)) delete categoryHints[name];
  }

  return {
    tags,
    categoryHints,
    rating: getRating(),
    source: els.source.value.trim()
  };
}

function artistInputTags(): string[] {
  return parseCommaSeparatedTags(els.artist.value);
}

function booruImportCategoryHints(currentTags: string[]): Record<string, string> {
  const tagSet = new Set(currentTags.map(normalizeTag).filter(Boolean));
  const hints: Record<string, string> = {};

  for (const tag of draft.blombooruBooruImport?.tags ?? []) {
    const name = normalizeTag(tag.name);
    const category = normalizeCategory(tag.category);
    if (!name || !tagSet.has(name) || !category || category === "unknown") continue;
    hints[name] = category;
  }

  return hints;
}

function selectAutoPredictions(predictions: AiTagPrediction[]): AiTagPrediction[] {
  return predictions.filter((prediction) => {
    const category = normalizeCategory(prediction.category);
    const confidence = prediction.confidence ?? 0;
    if (shouldIgnoreAiPrediction(prediction)) return false;
    const threshold = category === "character" ? settings.aiAutoCharacterThreshold : settings.aiAutoGeneralThreshold;
    return confidence >= threshold;
  });
}

function shouldIgnoreAiPrediction(prediction: AiTagPrediction): boolean {
  return isRatingTag(prediction.name, prediction.category);
}

function renderManualPredictions(predictions: AiTagPrediction[], selectedNames?: string[]): void {
  const selected = selectedNames ? new Set(selectedNames.map(normalizeTag).filter(Boolean)) : undefined;
  const visiblePredictions = predictions.filter((prediction) => !shouldIgnoreAiPrediction(prediction));
  const sorted = [...visiblePredictions].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  els.manualPanel.classList.remove("hidden");
  els.manualSummary.textContent = `${sorted.length} suggestions`;
  els.manualList.replaceChildren();

  for (const prediction of sorted) {
    const row = document.createElement("label");
    row.className = "ai-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = prediction.name;
    checkbox.checked = selected ? selected.has(normalizeTag(prediction.name)) : selectAutoPredictions([prediction]).length > 0;
    checkbox.dataset.category = normalizeCategory(prediction.category);

    const name = document.createElement("span");
    name.className = "ai-name";
    name.textContent = prediction.name;

    const meta = document.createElement("span");
    meta.className = "ai-meta";
    meta.textContent = `${normalizeCategory(prediction.category)} ${formatPercent(prediction.confidence)}`;

    row.append(checkbox, name, meta);
    els.manualList.append(row);
  }
}

function syncManualSelectedTagsToTextbox(): void {
  if (!manualState) return;
  const selected = selectedManualPredictions();
  const selectedNames = selected.map((prediction) => normalizeTag(prediction.name)).filter(Boolean);
  const selectedSet = new Set(selectedNames);
  const appliedSet = new Set(manualState.appliedNames);
  const baseSet = new Set(manualState.baseTags);
  const currentTags = nonRatingTags(parseTagsWithHints(els.tags.value).tags);

  rememberPredictionCategories(selected);
  const keptTags = currentTags.filter((tag) => !appliedSet.has(tag) || selectedSet.has(tag) || baseSet.has(tag));
  els.tags.value = tagText(mergeTags(keptTags, selectedNames));
  manualState.appliedNames = selectedNames;
  renderChips();
  persistSidePanelStateDebounced();
}

async function saveManualFinalTags(): Promise<void> {
  if (!manualState) {
    setStatus("Run Import + AI Manual first.", "error");
    return;
  }
  const state = manualState;

  await runImport(async () => {
    const api = requireConfiguredApi();
    const selected = selectedManualPredictions();
    rememberPredictionCategories(selected);

    const payload = buildFinalPayload(selected);
    await api.ensureTagsWithCategories(payload.categoryHints);
    const patched = await api.patchMedia(state.mediaId, {
      tags: payload.tags,
      rating: payload.rating,
      source: payload.source,
      categoryHints: payload.categoryHints
    });
    manualState = undefined;
    els.manualList.replaceChildren();
    markUploaded(patched.link ? patched : { ...patched, link: state.link }, { mediaId: state.mediaId, finalSaved: true });
    renderWorkflowState();
    if (selectedQueueItemId) await setQueueItemStatus(selectedQueueItemId, "imported", "Final tags saved.", patched.link || state.link);
    setSuccess("Final tags saved.", patched.link || state.link);
  });
}

function selectedManualPredictions(): AiTagPrediction[] {
  const byName = new Map((manualState?.predictions ?? []).map((prediction) => [prediction.name, prediction]));
  return Array.from(els.manualList.querySelectorAll<HTMLInputElement>("input[type='checkbox']:checked"))
    .map((checkbox) => byName.get(checkbox.value))
    .filter((prediction): prediction is AiTagPrediction => Boolean(prediction));
}

function selectedManualPredictionNames(): string[] {
  return Array.from(els.manualList.querySelectorAll<HTMLInputElement>("input[type='checkbox']:checked")).map((checkbox) => checkbox.value);
}

function rememberPredictionCategories(predictions: AiTagPrediction[]): void {
  for (const prediction of predictions) {
    const name = normalizeTag(prediction.name);
    const category = normalizeCategory(prediction.category);
    if (name && category) categoryCache.set(name, category);
  }
}

function requireConfiguredApi(options: { allowSessionAuth?: boolean } = {}): BlombooruApi {
  settings = normalizeSettings({
    ...settings,
    baseUrl: els.baseUrl.value,
    apiKey: els.apiKey.value,
    defaultRating: els.defaultRating.value as Rating,
    aiModelName: els.aiModel.value,
    aiAutoGeneralThreshold: Number(els.generalThreshold.value),
    aiAutoCharacterThreshold: Number(els.characterThreshold.value),
    hideRatingTags: els.hideRatingTags.checked,
    includePostHashtagsDefault: els.includePostHashtagsDefault.checked,
    closeAfterImport: els.closeAfterImport.checked,
    clearPanelAfterImportDefault: els.clearPanelAfterImportDefault.checked,
    misskeyArtistMode: els.misskeyArtistMode.value as AppSettings["misskeyArtistMode"],
    fourChanTagMode: els.fourChanTagMode.value as AppSettings["fourChanTagMode"],
    sidePanelImageBlurMode: els.sidePanelImageBlurMode.value as AppSettings["sidePanelImageBlurMode"],
    multiAddCaptureLeftClick: els.multiAddCaptureLeftClick.checked,
    multiAddCaptureRightClick: els.multiAddCaptureRightClick.checked,
    debugMode: els.debugMode.checked
  });

  if (!settings.baseUrl || (!settings.apiKey && !options.allowSessionAuth)) {
    els.settingsPanel.open = true;
    throw new BlombooruApiError(options.allowSessionAuth ? "Missing Blombooru base URL." : "Missing Blombooru base URL or API key.");
  }

  return new BlombooruApi(settings);
}

async function runImport(work: () => Promise<void>): Promise<void> {
  if (busy) return;
  hideSuccessPopup();
  setBusy(true);
  try {
    await work();
  } catch (error) {
    handleError(error);
  } finally {
    setBusy(false);
  }
}

function handleError(error: unknown): void {
  if (error instanceof BlombooruDuplicateError) {
    if (selectedQueueItemId) void setQueueItemStatus(selectedQueueItemId, "duplicate", "Already imported.", error.result?.link);
    setLinkedStatus("Already imported.", error.result?.link);
    return;
  }

  if (error instanceof BlombooruAuthError) {
    if (selectedQueueItemId) void setQueueItemStatus(selectedQueueItemId, "error", "Blombooru rejected the API key.", undefined, error.message);
    setStatus("Blombooru rejected the API key. Check settings and try again.", "error");
    return;
  }

  if (error instanceof BlombooruApiError) {
    if (selectedQueueItemId) void setQueueItemStatus(selectedQueueItemId, "error", error.message, undefined, error.message);
    setStatus(error.message, "error");
    return;
  }

  if (selectedQueueItemId) {
    const message = error instanceof Error ? error.message : "Import failed.";
    void setQueueItemStatus(selectedQueueItemId, "error", message, undefined, message);
  }
  setStatus(error instanceof Error ? error.message : "Import failed.", "error");
}

function setBusy(nextBusy: boolean): void {
  busy = nextBusy;
  for (const button of [
    els.import,
    els.importAuto,
    els.importManual,
    els.saveFinal,
    els.importQueue,
    els.importQueueAuto,
    els.clearQueue,
    els.multiAddToggle,
    els.autoCollectToggle
  ]) {
    button.disabled = nextBusy;
  }
}

function setSuccess(message: string, link?: string, options: { allowClose?: boolean } = {}): void {
  const allowClose = options.allowClose ?? true;
  clearCloseCountdown();

  if (link) {
    renderStatus({ message, tone: "success", link });
  } else {
    setStatus(message, "success");
  }

  showSuccessPopup(message, link, allowClose && settings.closeAfterImport);
  void persistSidePanelStateNow();
}

function setStatus(message: string, tone: StatusTone = "info"): void {
  renderStatus({ message, tone });
  persistSidePanelStateDebounced();
}

function setLinkedStatus(message: string, link: string | undefined, tone: StatusTone = "success"): void {
  renderStatus({ message, tone, link });
  persistSidePanelStateDebounced();
}

function renderStatus(status: NonNullable<SavedSidePanelState["status"]>): void {
  currentStatusState = status;
  if (status.link) {
    els.status.replaceChildren(document.createTextNode(`${status.message} `), linkElement(status.link));
  } else {
    els.status.textContent = status.message;
  }
  els.status.className = `status visible ${status.tone === "info" ? "" : status.tone}`;
}

function clearRenderedStatus(): void {
  currentStatusState = undefined;
  els.status.textContent = "";
  els.status.className = "status";
}

function linkElement(url: string): HTMLAnchorElement {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.target = "_blank";
  anchor.rel = "noreferrer";
  anchor.textContent = "Open media";
  return anchor;
}

function showSuccessPopup(
  message: string,
  link: string | undefined,
  shouldClose: boolean,
  options: { clearPanelChecked?: boolean } = {}
): void {
  els.successTitle.textContent = message.startsWith("Already") ? "Already imported" : "Import complete";
  els.successMessage.textContent = message;
  els.successClearPanel.checked = options.clearPanelChecked ?? settings.clearPanelAfterImportDefault;
  els.successPopup.hidden = false;
  currentSuccessState = {
    visible: true,
    title: els.successTitle.textContent,
    message,
    link,
    clearPanelChecked: els.successClearPanel.checked
  };

  if (link) {
    els.successOpenLink.href = link;
    els.successOpenLink.hidden = false;
  } else {
    els.successOpenLink.removeAttribute("href");
    els.successOpenLink.hidden = true;
  }

  if (!shouldClose) {
    els.successCountdown.hidden = true;
    els.successStay.hidden = true;
    return;
  }

  els.successCountdown.hidden = false;
  els.successStay.hidden = false;
  startCloseCountdown(10);
}

function startCloseCountdown(seconds: number): void {
  let remaining = seconds;
  const render = () => {
    els.successCountdown.textContent = `Closing in ${remaining} second${remaining === 1 ? "" : "s"}.`;
  };

  render();
  closeCountdownTimer = window.setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearCloseCountdown();
      void closePanelAfterSuccess();
      return;
    }
    render();
  }, 1000);
}

async function closePanelAfterSuccess(): Promise<void> {
  if (els.successClearPanel.checked) {
    await clearSidePanelState({ showStatus: false });
  }
  window.close();
}

async function stayOpenFromSuccessPopup(): Promise<void> {
  clearCloseCountdown();
  await dismissSuccessPopup();
}

function clearCloseCountdown(): void {
  if (closeCountdownTimer) {
    window.clearInterval(closeCountdownTimer);
    closeCountdownTimer = undefined;
  }
}

function hideSuccessPopup(options: { persist?: boolean } = {}): void {
  clearCloseCountdown();
  els.successPopup.hidden = true;
  els.successCountdown.hidden = true;
  els.successStay.hidden = true;
  currentSuccessState = undefined;
  if (options.persist ?? true) persistSidePanelStateDebounced();
}

async function dismissSuccessPopup(): Promise<void> {
  const shouldClear = els.successClearPanel.checked;
  hideSuccessPopup({ persist: false });

  if (shouldClear) {
    await clearSidePanelState();
    return;
  }

  persistSidePanelStateDebounced();
}

function persistSuccessClearChoice(): void {
  if (!currentSuccessState) return;
  currentSuccessState = {
    ...currentSuccessState,
    clearPanelChecked: els.successClearPanel.checked
  };
  persistSidePanelStateDebounced();
}

function showSettingsSavedFeedback(): void {
  if (settingsFeedbackTimer) window.clearTimeout(settingsFeedbackTimer);
  const originalText = els.saveSettings.textContent ?? "Save Settings";
  els.saveSettings.textContent = "Saved";
  els.settingsSaveFeedback.textContent = "Settings saved";
  settingsFeedbackTimer = window.setTimeout(() => {
    els.saveSettings.textContent = originalText;
    els.settingsSaveFeedback.textContent = "";
  }, 1800);
}

function renderDebugPanel(): void {
  els.debugPanel.hidden = !settings.debugMode;
  if (!settings.debugMode) {
    els.debugSummary.textContent = "";
    els.debugPreview.textContent = "";
    return;
  }

  els.debugSummary.textContent = buildDebugSummary();
  els.debugPreview.textContent = JSON.stringify(buildDebugReport(), null, 2);
}

async function copyDebugReport(): Promise<void> {
  const report = JSON.stringify(buildDebugReport(), null, 2);
  await copyText(report);
  els.debugCopyFeedback.textContent = "Copied";
  window.setTimeout(() => {
    els.debugCopyFeedback.textContent = "";
  }, 1600);
}

function buildDebugReport(): Record<string, unknown> {
  return {
    note: "Boo Check debug report. Contains page/source/media URLs, but excludes API keys, auth headers, cookies, and fetched media data.",
    generatedAt: new Date().toISOString(),
    extension: {
      version: chrome.runtime.getManifest().version,
      sidePanelDebugBuild: SIDE_PANEL_DEBUG_BUILD
    },
    settings: {
      baseUrl: settings.baseUrl,
      defaultRating: settings.defaultRating,
      aiModelName: settings.aiModelName,
      aiAutoGeneralThreshold: settings.aiAutoGeneralThreshold,
      aiAutoCharacterThreshold: settings.aiAutoCharacterThreshold,
      hideRatingTags: settings.hideRatingTags,
      includePostHashtagsDefault: settings.includePostHashtagsDefault,
      closeAfterImport: settings.closeAfterImport,
      clearPanelAfterImportDefault: settings.clearPanelAfterImportDefault,
      misskeyArtistMode: settings.misskeyArtistMode,
      fourChanTagMode: settings.fourChanTagMode,
      sidePanelImageBlurMode: settings.sidePanelImageBlurMode,
      debugMode: settings.debugMode,
      apiKeyConfigured: Boolean(settings.apiKey)
    },
    form: {
      source: els.source.value,
      artist: els.artist.value,
      rating: getRating(),
      includePostHashtags: els.includeHashtags.checked,
      tags: els.tags.value,
      parsedTags: parseTagsWithHints(els.tags.value).tags
    },
    draft,
    mediaMetadata,
    pendingTabId,
    pendingCreatedAt,
    queue: currentQueue
      ? {
          tabId: currentQueue.tabId,
          captureEnabled: currentQueue.captureEnabled,
          selectedItemId: selectedQueueItemId,
          itemCount: currentQueue.items.length,
          statuses: currentQueue.items.map((item) => ({ id: item.id, status: item.status, message: item.statusMessage }))
        }
      : undefined,
    manual: manualState
      ? {
          mediaId: manualState.mediaId,
          link: manualState.link,
          predictionCount: manualState.predictions.length,
          selectedNames: selectedManualPredictionNames()
        }
      : undefined,
    status: currentStatusState,
    success: currentSuccessState,
    extraction: latestDebugSnapshot
  };
}

function buildDebugSummary(): string {
  const extraction = latestDebugSnapshot;
  if (!extraction) return "No extraction snapshot captured yet.";

  const candidateCount = extraction.mediaCandidates?.length ?? extraction.candidateMediaUrls.length;
  const rejectedCount = extraction.mediaCandidates?.filter((candidate) => candidate.accepted === false).length ?? 0;
  const selected = extraction.x?.selectedMediaUrl || extraction.misskey?.selectedMediaUrl || draft.mediaUrl || draft.previewUrl;
  const source = extraction.x?.selectedMediaSource ? ` from ${extraction.x.selectedMediaSource}` : "";
  const selectedText = selected ? `Selected media: ${selected}${source}.` : "Selected media: none.";
  return `${selectedText} Candidates: ${candidateCount}. Rejected: ${rejectedCount}.`;
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function scheduleArtistAutocomplete(): void {
  if (artistAutocompleteTimer) window.clearTimeout(artistAutocompleteTimer);
  artistAutocompleteTimer = window.setTimeout(() => void refreshArtistAutocomplete(), 180);
}

async function refreshArtistAutocomplete(): Promise<void> {
  const query = normalizeTag(currentArtistInputSegment().token);
  if (!query) {
    hideArtistAutocomplete();
    return;
  }

  const cacheKey = query;
  if (artistAutocompleteCache.has(cacheKey)) {
    renderArtistAutocomplete(artistAutocompleteCache.get(cacheKey) ?? []);
    return;
  }

  try {
    const suggestions = (await requireConfiguredApi().autocomplete(query))
      .map(normalizeSuggestion)
      .filter((item): item is TagSuggestion => Boolean(item))
      .sort((a, b) => artistSuggestionRank(b) - artistSuggestionRank(a));
    artistAutocompleteCache.set(cacheKey, suggestions);
    for (const suggestion of suggestions) {
      if (suggestion.category) categoryCache.set(suggestion.name, normalizeCategory(suggestion.category));
    }
    renderArtistAutocomplete(suggestions);
  } catch {
    hideArtistAutocomplete();
  }
}

function artistSuggestionRank(suggestion: TagSuggestion): number {
  const category = normalizeCategory(suggestion.category);
  return (category === "artist" ? 100000 : 0) + (suggestion.postCount ?? 0);
}

function renderArtistAutocomplete(items: TagSuggestion[]): void {
  artistAutocompleteItems = items.slice(0, 12);
  artistAutocompleteIndex = artistAutocompleteItems.length ? 0 : -1;

  if (!artistAutocompleteItems.length) {
    hideArtistAutocomplete();
    return;
  }

  els.artistAutocomplete.replaceChildren(
    ...artistAutocompleteItems.map((item, index) => suggestionButton(item, index, artistAutocompleteIndex, () => selectArtistAutocomplete(index)))
  );
  els.artistAutocomplete.classList.remove("hidden");
}

function handleArtistKeydown(event: KeyboardEvent): void {
  if (els.artistAutocomplete.classList.contains("hidden")) return;

  if (event.key === "ArrowDown") {
    event.preventDefault();
    moveArtistAutocomplete(1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    moveArtistAutocomplete(-1);
  } else if (event.key === "Enter" || event.key === "Tab") {
    if (artistAutocompleteIndex >= 0) {
      event.preventDefault();
      selectArtistAutocomplete(artistAutocompleteIndex);
    }
  } else if (event.key === "Escape") {
    event.preventDefault();
    hideArtistAutocomplete();
  }
}

function moveArtistAutocomplete(delta: number): void {
  if (!artistAutocompleteItems.length) return;
  artistAutocompleteIndex = (artistAutocompleteIndex + delta + artistAutocompleteItems.length) % artistAutocompleteItems.length;
  for (const [index, child] of Array.from(els.artistAutocomplete.children).entries()) {
    child.setAttribute("aria-selected", String(index === artistAutocompleteIndex));
  }
}

function selectArtistAutocomplete(index: number): void {
  const item = artistAutocompleteItems[index];
  if (!item) return;
  const replaced = replaceCurrentArtistInputSegment(item.name);
  els.artist.value = replaced.text;
  els.artist.focus();
  els.artist.setSelectionRange(replaced.cursor, replaced.cursor);
  categoryCache.set(item.name, normalizeCategory(item.category || "artist"));
  hideArtistAutocomplete();
  renderChips();
  scheduleArtistStatus();
  persistSidePanelStateDebounced();
}

function hideArtistAutocomplete(): void {
  artistAutocompleteItems = [];
  artistAutocompleteIndex = -1;
  els.artistAutocomplete.classList.add("hidden");
  els.artistAutocomplete.replaceChildren();
}

function scheduleArtistStatus(): void {
  if (artistStatusTimer) window.clearTimeout(artistStatusTimer);
  artistStatusTimer = window.setTimeout(() => void refreshArtistStatus(), 220);
}

async function refreshArtistStatus(): Promise<void> {
  const requestId = ++artistStatusRequest;
  const artists = artistInputTags();

  if (!artists.length) {
    renderArtistStatus("No artist tag will be sent.", "info");
    return;
  }

  const cachedResults = artists
    .map((artist) => {
      const cached = artistLookupCache.get(artist);
      return cached ? { name: artist, ...cached } : undefined;
    })
    .filter((item): item is ArtistStatusResult => Boolean(item));
  if (cachedResults.length === artists.length) {
    renderArtistSummary(cachedResults);
    return;
  }

  renderArtistStatus(artists.length === 1 ? "Checking artist tag..." : `Checking ${artists.length} artist tags...`, "info");
  const artistKey = artists.join(",");

  try {
    const api = requireConfiguredApi();
    const results = await Promise.all(artists.map(async (artist) => {
      const cached = artistLookupCache.get(artist);
      if (cached) return { name: artist, ...cached };

      const tag = await api.lookupTag(artist);
      const category = tag?.category ? normalizeCategory(tag.category) : undefined;
      if (category && category !== "unknown") categoryCache.set(artist, category);
      const result: ArtistLookupCacheEntry = {
        exists: Boolean(tag),
        category
      };
      artistLookupCache.set(artist, result);
      return { name: artist, ...result };
    }));
    if (requestId !== artistStatusRequest || artistInputTags().join(",") !== artistKey) return;
    renderArtistSummary(results);
  } catch {
    if (requestId !== artistStatusRequest) return;
    renderArtistStatus("Could not check artist tags. They will be sent as artist tags on import.", "warning");
  }
}

function currentArtistInputSegment(): { token: string; rawStart: number; rawEnd: number } {
  const value = els.artist.value;
  const cursor = els.artist.selectionStart ?? value.length;
  const rawStart = cursor > 0 ? value.lastIndexOf(",", cursor - 1) + 1 : 0;
  const nextComma = value.indexOf(",", cursor);
  const rawEnd = nextComma === -1 ? value.length : nextComma;
  const queryStart = Math.min(rawEnd, Math.max(rawStart, cursor));
  return {
    token: value.slice(rawStart, queryStart).trim(),
    rawStart,
    rawEnd
  };
}

function replaceCurrentArtistInputSegment(replacement: string): { text: string; cursor: number } {
  const segment = currentArtistInputSegment();
  const normalized = normalizeTag(replacement);
  let prefix = els.artist.value.slice(0, segment.rawStart).replace(/[ \t]*$/, "");
  const suffix = els.artist.value.slice(segment.rawEnd);
  if (prefix.endsWith(",")) prefix += " ";
  const text = `${prefix}${normalized}${suffix}`;
  return {
    text,
    cursor: prefix.length + normalized.length
  };
}

function renderArtistSummary(results: ArtistStatusResult[]): void {
  const total = results.length;
  const existing = results.filter((item) => item.exists);
  const artistCount = existing.filter((item) => normalizeCategory(item.category) === "artist").length;
  const unconfirmedArtistCount = existing.length - artistCount;
  const newCount = total - existing.length;

  if (unconfirmedArtistCount) {
    renderArtistStatus(total === 1 ? "Existing tag is not confirmed as an artist tag. Blombooru may keep its category." : `${unconfirmedArtistCount} existing artist entries are not confirmed artist tags. Blombooru may keep those categories.`, "warning");
    return;
  }

  if (newCount && artistCount) {
    renderArtistStatus(`${artistCount} existing artist ${pluralNoun(artistCount, "tag")}; ${newCount} new ${pluralNoun(newCount, "artist tag")} will be added.`, "new");
    return;
  }

  if (newCount) {
    renderArtistStatus(total === 1 ? "New artist tag will be added." : `${newCount} new artist tags will be added.`, "new");
    return;
  }

  renderArtistStatus(total === 1 ? "Existing artist tag." : `${total} existing artist tags.`, "success");
}

function pluralNoun(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

function renderArtistStatus(message: string, tone: "info" | "success" | "new" | "warning"): void {
  els.artistStatus.textContent = message;
  els.artistStatus.dataset.tone = tone;
}

function clearArtistStatus(): void {
  if (artistStatusTimer) {
    window.clearTimeout(artistStatusTimer);
    artistStatusTimer = undefined;
  }
  artistStatusRequest += 1;
  els.artistStatus.textContent = "";
  delete els.artistStatus.dataset.tone;
}

function scheduleAutocomplete(): void {
  if (autocompleteTimer) window.clearTimeout(autocompleteTimer);
  autocompleteTimer = window.setTimeout(() => void refreshAutocomplete(), 180);
}

async function refreshAutocomplete(): Promise<void> {
  const token = currentToken(els.tags.value, els.tags.selectionStart ?? els.tags.value.length);
  const query = normalizeTag(token.token);
  if (!query) {
    hideAutocomplete();
    return;
  }

  const cacheKey = query;
  if (autocompleteCache.has(cacheKey)) {
    renderAutocomplete(autocompleteCache.get(cacheKey) ?? []);
    return;
  }

  try {
    const suggestions = (await requireConfiguredApi().autocomplete(query))
      .map(normalizeSuggestion)
      .filter((item): item is TagSuggestion => Boolean(item));
    autocompleteCache.set(cacheKey, suggestions);
    for (const suggestion of suggestions) {
      if (suggestion.category) categoryCache.set(suggestion.name, normalizeCategory(suggestion.category));
    }
    renderAutocomplete(suggestions);
  } catch {
    hideAutocomplete();
  }
}

function renderAutocomplete(items: TagSuggestion[]): void {
  autocompleteItems = items.slice(0, 12);
  autocompleteIndex = autocompleteItems.length ? 0 : -1;

  if (!autocompleteItems.length) {
    hideAutocomplete();
    return;
  }

  els.autocomplete.replaceChildren(
    ...autocompleteItems.map((item, index) => {
      return suggestionButton(item, index, autocompleteIndex, () => selectAutocomplete(index));
    })
  );
  els.autocomplete.classList.remove("hidden");
}

function suggestionButton(item: TagSuggestion, index: number, selectedIndex: number, onSelect: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "autocomplete-item";
  button.setAttribute("role", "option");
  button.setAttribute("aria-selected", String(index === selectedIndex));
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", onSelect);

  const name = document.createElement("span");
  name.className = "autocomplete-name";
  name.textContent = item.name;

  const meta = document.createElement("span");
  meta.className = "autocomplete-meta";
  meta.textContent = [normalizeCategory(item.category), item.postCount === undefined ? undefined : String(item.postCount)]
    .filter(Boolean)
    .join(" / ");

  button.append(name, meta);
  return button;
}

function handleTagKeydown(event: KeyboardEvent): void {
  if (els.autocomplete.classList.contains("hidden")) return;

  if (event.key === "ArrowDown") {
    event.preventDefault();
    moveAutocomplete(1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    moveAutocomplete(-1);
  } else if (event.key === "Enter" || event.key === "Tab") {
    if (autocompleteIndex >= 0) {
      event.preventDefault();
      selectAutocomplete(autocompleteIndex);
    }
  } else if (event.key === "Escape") {
    event.preventDefault();
    hideAutocomplete();
  }
}

function moveAutocomplete(delta: number): void {
  if (!autocompleteItems.length) return;
  autocompleteIndex = (autocompleteIndex + delta + autocompleteItems.length) % autocompleteItems.length;
  for (const [index, child] of Array.from(els.autocomplete.children).entries()) {
    child.setAttribute("aria-selected", String(index === autocompleteIndex));
  }
}

function selectAutocomplete(index: number): void {
  const item = autocompleteItems[index];
  if (!item) return;
  const replaced = replaceCurrentToken(els.tags.value, els.tags.selectionStart ?? els.tags.value.length, item.name);
  els.tags.value = replaced.text;
  els.tags.focus();
  els.tags.setSelectionRange(replaced.cursor, replaced.cursor);
  if (item.category) categoryCache.set(item.name, normalizeCategory(item.category));
  hideAutocomplete();
  renderChips();
}

function hideAutocomplete(): void {
  autocompleteItems = [];
  autocompleteIndex = -1;
  els.autocomplete.classList.add("hidden");
  els.autocomplete.replaceChildren();
}

function isVideoUrl(url: string): boolean {
  return /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(mediaUrlForExtensionCheck(url));
}

function mediaUrlForExtensionCheck(value: string): string {
  try {
    const url = new URL(value);
    return url.searchParams.get("url") || value;
  } catch {
    return value;
  }
}

function unproxiedBooruProxyImageUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!isBooruProxyImageUrl(value)) return value;

  try {
    return new URL(value).searchParams.get("url") || value;
  } catch {
    return value;
  }
}

function isBooruProxyImageUrl(value: string | undefined): boolean {
  if (!value) return false;

  try {
    const url = new URL(value);
    return url.pathname.includes("/api/booru-import/proxy-image") && url.searchParams.has("url");
  } catch {
    return false;
  }
}

function normalizedMimeType(value: string | undefined | null): string {
  return value?.split(";")[0]?.trim().toLowerCase() ?? "";
}

function isClearlyNonMediaMime(value: string | undefined): boolean {
  const mimeType = normalizedMimeType(value);
  return mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/xml" ||
    mimeType === "application/xhtml+xml";
}

async function responseTextPreview(response: Response): Promise<string | undefined> {
  const contentType = normalizedMimeType(response.headers.get("content-type"));
  if (!isTextLikeMime(contentType)) return undefined;

  try {
    return textPreview(await response.clone().text());
  } catch {
    return undefined;
  }
}

async function blobTextPreview(blob: Blob): Promise<string | undefined> {
  try {
    return textPreview(await blob.text());
  } catch {
    return undefined;
  }
}

function isTextLikeMime(mimeType: string): boolean {
  return mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/xml" ||
    mimeType === "application/xhtml+xml";
}

function textPreview(value: string): string | undefined {
  const preview = value.replace(/\s+/g, " ").trim().slice(0, 240);
  return preview || undefined;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...authenticatedRequestInit(url, init),
      signal: controller.signal
    });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s.`);
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function authenticatedRequestInit(url: string, init: RequestInit = {}): RequestInit {
  if (!settings.apiKey || !isBlombooruApiUrl(url)) return init;

  const headers = new Headers(init.headers);
  if (!headers.has("Authorization")) headers.set("Authorization", `Bearer ${settings.apiKey}`);
  return {
    ...init,
    headers
  };
}

function authAttemptedForUrl(url: string): boolean {
  return Boolean(settings.apiKey && isBlombooruApiUrl(url));
}

function isBlombooruApiUrl(value: string): boolean {
  if (!settings.baseUrl) return false;

  try {
    const url = new URL(value);
    const baseUrl = new URL(settings.baseUrl);
    return url.origin === baseUrl.origin && url.pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

function uniqueUrls(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    if (!value) continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }

  return result;
}

function preferOriginalUrls(urls: string[]): string[] {
  const originals = urls.filter((url) => !isProbableThumbnailUrl(url));
  const thumbnails = urls.filter((url) => isProbableThumbnailUrl(url));
  return originals.length ? [...originals, ...thumbnails] : urls;
}

function fullQualityUrlCandidates(values: Array<string | undefined>): string[] {
  const promotedUrls = values.flatMap((value) => {
    const urls = [fullQualityProxyUrl(value), fullQualityRawBooruMediaUrl(value)];
    return urls.filter((url): url is string => Boolean(url));
  });
  const originalUrls = values.filter((value): value is string => Boolean(value));

  return preferOriginalUrls(uniqueUrls([...promotedUrls, ...originalUrls]));
}

function fullQualityRawBooruMediaUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;

  try {
    const url = new URL(value);
    const before = url.href;
    url.pathname = url.pathname.replace(/\/data\/sample\/(.+\/)?sample-([^/]+)$/i, (_match, dirs: string | undefined, filename: string) =>
      `/data/original/${dirs ?? ""}${filename}`
    );
    return url.href !== before ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function fullQualityProxyUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;

  try {
    const url = new URL(value);
    if (!url.searchParams.has("url")) return undefined;

    const before = url.href;
    url.searchParams.delete("thumbnail");
    url.searchParams.delete("fallback");
    url.searchParams.delete("preview");
    const size = url.searchParams.get("size");
    if (size && /^(?:thumb|thumbnail|preview|small)$/i.test(size)) url.searchParams.delete("size");

    url.pathname = url.pathname
      .replace(/\/thumbnail(?:\.[^/?#]+)?$/i, "/image.webp")
      .replace(/\/preview(?:\.[^/?#]+)?$/i, "/image.webp")
      .replace(/\/static(?:\.[^/?#]+)?$/i, "/image.webp");
    url.searchParams.delete("static");

    return url.href !== before || isProbableThumbnailUrl(value) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function rawMediaUrls(raw: unknown): string[] {
  const urls: string[] = [];
  const seenObjects = new Set<object>();

  const visit = (value: unknown) => {
    if (!value || typeof value !== "object" || seenObjects.has(value)) return;
    seenObjects.add(value);

    const record = value as Record<string, unknown>;
    for (const key of ["linkUrl", "srcUrl", "mediaUrl", "previewUrl"]) {
      const url = typeof record[key] === "string" ? record[key] : undefined;
      if (url && isLikelyMediaCandidateUrl(url)) urls.push(url);
    }

    for (const child of Object.values(record)) {
      visit(child);
    }
  };

  visit(raw);
  return uniqueUrls(urls);
}

function isPageSessionBooruDraft(nextDraft: ImportDraft): boolean {
  if (nextDraft.site !== "booru" || nextDraft.blombooruBooruImport) return false;
  return Boolean(findRawRecord(nextDraft.raw, "pageBooruPostFetch"));
}

function shouldUsePageSessionBooruMedia(nextDraft: ImportDraft): boolean {
  return booruMediaStrategy(nextDraft) === "page-session";
}

function findRawRecord(raw: unknown, key: string): Record<string, unknown> | undefined {
  const seenObjects = new Set<object>();

  const visit = (value: unknown): Record<string, unknown> | undefined => {
    if (!value || typeof value !== "object" || seenObjects.has(value)) return undefined;
    seenObjects.add(value);

    const record = value as Record<string, unknown>;
    const match = record[key];
    if (match && typeof match === "object") return match as Record<string, unknown>;

    for (const child of Object.values(record)) {
      const found = visit(child);
      if (found) return found;
    }

    return undefined;
  };

  return visit(raw);
}

function isLikelyMediaCandidateUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return /\.(jpe?g|png|webp|gif|avif|mp4|webm|mov|m4v)(\?|#|$)/i.test(url.pathname) ||
      url.pathname.includes("/files/") ||
      (url.pathname.includes("/proxy/") && url.searchParams.has("url"));
  } catch {
    return false;
  }
}

function isProbableThumbnailUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const path = url.pathname.toLowerCase();
    return (
      /\/thumbnail(?:[-/]|$)/i.test(path) ||
      (/\.4cdn\.org$/i.test(url.hostname) && /\/\d+s\.jpe?g$/i.test(path)) ||
      path.includes("thumbnail.webp") ||
      path.includes("preview.webp") ||
      path.includes("static.webp") ||
      path.includes("/data/sample/") ||
      url.searchParams.get("thumbnail") === "1" ||
      url.searchParams.get("preview") === "1" ||
      url.searchParams.get("static") === "1" ||
      url.searchParams.get("fallback") === "1" ||
      /^(?:thumb|thumbnail|preview|small)$/i.test(url.searchParams.get("size") ?? "")
    );
  } catch {
    return /thumbnail|preview|static/i.test(value);
  }
}

function isFourChanCatalogueDraft(nextDraft: ImportDraft): boolean {
  return nextDraft.site === "4chan" && fourChanRawContexts(nextDraft.raw).some((context) => context.catalogue === true);
}

function fourChanRawContexts(raw: unknown): Array<{ catalogue?: boolean }> {
  const contexts: Array<{ catalogue?: boolean }> = [];
  const seen = new Set<object>();

  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);

    const record = value as Record<string, unknown>;
    const context = record.fourChan;
    if (context && typeof context === "object") {
      contexts.push(context as { catalogue?: boolean });
    }

    for (const child of Object.values(record)) {
      visit(child);
    }
  };

  visit(raw);
  return contexts;
}

function formatPercent(value: number | undefined): string {
  if (typeof value !== "number") return "";
  return `${Math.round(value * 100)}%`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = unitIndex === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
