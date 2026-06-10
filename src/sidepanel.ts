import {
  BlombooruApi,
  BlombooruApiError,
  BlombooruAuthError,
  BlombooruDuplicateError,
  type UploadMediaResult
} from "./api/blombooru";
import {
  EXTRACT_PAGE_CONTEXT_MESSAGE,
  IMPORT_QUEUE_STORE_KEY,
  PENDING_IMPORT_KEY,
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
import { fetchMediaAsStableFile } from "./utils/hash";
import {
  currentToken,
  isRatingTag,
  mergeTags,
  normalizeCategory,
  normalizePrediction,
  normalizeSuggestion,
  normalizeTag,
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
  rating: byId<HTMLSelectElement>("ratingInput"),
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

const autocompleteCache = new Map<string, TagSuggestion[]>();
const artistAutocompleteCache = new Map<string, TagSuggestion[]>();
const categoryCache = new Map<string, string>();
const queueMetadataRequests = new Set<string>();
const removedQueueItemIds = new Set<string>();
const queueClearCutoffs = new Map<number, number>();

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
    renderAll();
    await enrichFromActiveTab();
    applyDraftToForm({ preserveEditedTags: true });
    renderAll();
  } else {
    renderQueue();
  }

  if (!settings.baseUrl || !settings.apiKey) {
    els.settingsPanel.open = true;
    setStatus("Add your Blombooru base URL and API key before importing.", "info");
  }

  renderDebugPanel();
  persistSidePanelStateDebounced();
}

function bindEvents(): void {
  els.saveSettings.addEventListener("click", () => void persistSettings());
  els.clearState.addEventListener("click", () => void clearSidePanelState());
  els.multiAddToggle.addEventListener("click", () => void toggleMultiAddCapture());
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
      void enrichFromActiveTab().then(() => {
        applyDraftToForm();
        renderAll();
        renderDebugPanel();
        setStatus("Loaded new context-menu draft.", "info");
        persistSidePanelStateDebounced();
      });
    }
  });
  document.addEventListener("click", (event) => {
    if (!els.autocomplete.contains(event.target as Node) && event.target !== els.tags) hideAutocomplete();
    if (!els.artistAutocomplete.contains(event.target as Node) && event.target !== els.artist) hideArtistAutocomplete();
  });
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
  uploadedState = saved.uploaded;

  els.source.value = saved.form?.source ?? draft.sourceUrl ?? draft.pageUrl ?? "";
  els.artist.value = saved.form?.artist ?? draft.artistTag ?? "";
  els.rating.value = saved.form?.rating ?? draft.rating ?? settings.defaultRating;
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

function buildSavedSidePanelState(): SavedSidePanelState {
  return {
    savedAt: Date.now(),
    tabId: pendingTabId,
    pendingCreatedAt,
    draft,
    form: {
      source: els.source.value,
      artist: els.artist.value,
      rating: els.rating.value as Rating,
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
  els.rating.value = settings.defaultRating;
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
  uploadedState = item.uploaded;
  mediaMetadata = item.mediaMetadata;
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

async function syncCaptureStateToActiveTab(): Promise<void> {
  if (!currentQueue?.captureEnabled) return;
  await setMultiAddCapture(true);
}

function renderQueue(): void {
  const queue = currentQueue;
  const items = queue?.items ?? [];
  const captureEnabled = Boolean(queue?.captureEnabled);
  els.queuePanel.hidden = !captureEnabled && items.length <= 1;
  els.multiAddToggle.textContent = captureEnabled ? "Disable multi-add" : "Enable multi-add";
  els.multiAddToggle.dataset.active = String(captureEnabled);
  els.queueSummary.textContent = queueSummaryText(items.length, captureEnabled);
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

function queueSummaryText(count: number, captureEnabled: boolean): string {
  const itemText = `${count} queued item${count === 1 ? "" : "s"}`;
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
  const url = item.draft.previewUrl || item.draft.mediaUrl;
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
  return fullQualityUrlCandidates([item.draft.mediaUrl, item.draft.previewUrl, ...rawMediaUrls(item.draft.raw)]);
}

async function probeMediaMetadata(url: string): Promise<MediaMetadata> {
  const metadata: MediaMetadata = { url, loading: false };

  try {
    const response = await fetch(url, {
      method: "HEAD",
      credentials: "include",
      referrerPolicy: "no-referrer"
    });
    if (!response.ok) throw new Error(`HEAD ${response.status}`);
    const contentLength = response.headers.get("content-length");
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim();
    metadata.bytes = contentLength ? Number(contentLength) || undefined : undefined;
    metadata.mimeType = contentType || undefined;
    metadata.sizeSource = contentLength ? "head" : undefined;
  } catch {
    // Some hosts do not support HEAD. Image/video probing below can still succeed.
  }

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
    const response = await fetch(url, {
      credentials: "include",
      referrerPolicy: "no-referrer"
    });
    if (!response.ok) throw new Error(`Metadata fetch failed (${response.status}).`);
    const blob = await response.blob();
    metadata.bytes = blob.size || metadata.bytes;
    metadata.mimeType = blob.type || metadata.mimeType;
    metadata.sizeSource = "blob";

    if (blob.type.startsWith("image/")) {
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
    image.onload = () => resolve({
      width: image.naturalWidth || undefined,
      height: image.naturalHeight || undefined
    });
    image.onerror = () => reject(new Error("Image metadata failed."));
    image.src = url;
  });
}

function loadVideoDimensions(url: string): Promise<{ width?: number; height?: number }> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => resolve({
      width: video.videoWidth || undefined,
      height: video.videoHeight || undefined
    });
    video.onerror = () => reject(new Error("Video metadata failed."));
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
    const api = requireConfiguredApi();
    const targets = (currentQueue?.items ?? []).filter(isQueueItemImportable);
    if (!targets.length) {
      setStatus("No queued items need importing.", "info");
      return;
    }

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
  const upload = await uploadCurrentMedia(api, payload);
  markUploaded(upload, { finalSaved: true });
  await persistSelectedQueueItemEditsNow();
  await setQueueItemStatus(requireSelectedQueueItemId(), "imported", "Imported.", upload.link);
}

async function importCurrentQueueItemAiAuto(api: BlombooruApi): Promise<void> {
  const initialPayload = buildFinalPayload();
  const upload = await uploadCurrentMedia(api, initialPayload);
  const mediaId = requireMediaId(upload);
  markUploaded(upload);

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
  return {
    ...base,
    ...definedOnly(extracted),
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
  els.rating.value = form.rating;

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
  return {
    source: nextDraft.sourceUrl || nextDraft.pageUrl || "",
    artist: misskeyArtist.artist || nextDraft.artistTag || "",
    rating: nextDraft.rating ?? settings.defaultRating,
    tags: tagText(nonRatingTags(defaultTagListForDraft(nextDraft, includeHashtags, misskeyArtist.domainTag))),
    includePostHashtags: includeHashtags
  };
}

function currentFormState(): ImportFormState {
  return {
    source: els.source.value,
    artist: els.artist.value,
    rating: els.rating.value as Rating,
    tags: els.tags.value,
    includePostHashtags: els.includeHashtags.checked
  };
}

function applyFormState(form: ImportFormState): void {
  els.source.value = form.source;
  els.artist.value = form.artist;
  els.rating.value = form.rating;
  els.tags.value = form.tags;
  els.includeHashtags.checked = form.includePostHashtags ?? settings.includePostHashtagsDefault;
  scheduleArtistStatus();
}

function defaultTagListForDraft(nextDraft: ImportDraft, includeHashtags: boolean, domainTag: string | undefined): string[] {
  return mergeTags(nonHashtagSeedTags(nextDraft), includeHashtags ? nextDraft.hashtags : undefined, domainTag ? [domainTag] : []);
}

function nonHashtagSeedTags(nextDraft = draft): string[] {
  const hashtags = new Set(normalizedDraftHashtags(nextDraft));
  return (nextDraft.seedTags ?? []).filter((tag) => !hashtags.has(normalizeTag(tag)));
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
  if (nextDraft.site !== "misskey") return { artist: nextDraft.artistTag };

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
  const url = previewUrlCandidates()[0];
  const requestId = ++mediaMetadataRequest;
  revokePreviewObjectUrl();
  els.preview.replaceChildren();

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
  void fetchHeadMediaMetadata(url, requestId);

  renderPreviewUrl(url, requestId);
}

function renderPreviewUrl(url: string, requestId: number): void {
  if (isVideoUrl(url)) {
    const video = document.createElement("video");
    video.src = url;
    video.controls = true;
    video.muted = true;
    video.playsInline = true;
    video.addEventListener("loadedmetadata", () => {
      updateMediaMetadata(url, requestId, {
        width: video.videoWidth || undefined,
        height: video.videoHeight || undefined
      });
    });
    els.preview.append(video);
    return;
  }

  const image = document.createElement("img");
  image.src = url;
  image.alt = "";
  markBlurSensitiveImage(image);
  image.addEventListener("load", () => {
    updateMediaMetadata(url, requestId, {
      width: image.naturalWidth || undefined,
      height: image.naturalHeight || undefined
    });
  });
  image.addEventListener("error", () => {
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
    const response = await fetch(url, {
      credentials: "include",
      referrerPolicy: "no-referrer"
    });

    if (requestId !== mediaMetadataRequest || mediaMetadata?.url !== url) return;
    if (!response.ok) throw new Error(`Preview fetch failed (${response.status}).`);

    const blob = await response.blob();
    if (!blob.type.startsWith("image/")) throw new Error(blob.type ? `Preview is ${blob.type}.` : "Preview is not an image.");

    revokePreviewObjectUrl();
    previewObjectUrl = URL.createObjectURL(blob);
    updateMediaMetadata(url, requestId, {
      bytes: blob.size || mediaMetadata?.bytes,
      mimeType: blob.type || mediaMetadata?.mimeType,
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
      showPreviewLoadFailure(url, requestId, "Preview blob could not be displayed.");
    }, { once: true });
    els.preview.replaceChildren(image);
  } catch (error) {
    if (requestId !== mediaMetadataRequest || mediaMetadata?.url !== url) return;
    if (tryFallbackPreviewUrl(url, requestId)) return;
    showPreviewLoadFailure(url, requestId, error instanceof Error ? error.message : "Preview failed to load.");
  }
}

function previewUrlCandidates(): string[] {
  return fullQualityUrlCandidates([draft.mediaUrl, draft.previewUrl, ...rawMediaUrls(draft.raw)]);
}

function tryFallbackPreviewUrl(failedUrl: string, requestId: number): boolean {
  const fallback = previewUrlCandidates().find((candidate) => candidate !== failedUrl);
  if (!fallback) return false;
  revokePreviewObjectUrl();
  els.preview.replaceChildren();
  resetMediaMetadata(fallback);
  void fetchHeadMediaMetadata(fallback, requestId);
  renderPreviewUrl(fallback, requestId);
  return true;
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
  const artist = normalizeTag(els.artist.value);
  const hints = { ...parsed.categoryHints };
  const normalTags = nonRatingTags(parsed.tags);
  const tags = artist ? mergeTags(normalTags.filter((tag) => tag !== artist), [artist]) : normalTags;

  if (artist) hints[artist] = "artist";

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
    sidePanelImageBlurMode: els.sidePanelImageBlurMode.value as AppSettings["sidePanelImageBlurMode"],
    multiAddCaptureLeftClick: els.multiAddCaptureLeftClick.checked,
    multiAddCaptureRightClick: els.multiAddCaptureRightClick.checked,
    debugMode: els.debugMode.checked
  });
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
  els.sidePanelImageBlurMode.value = nextSettings.sidePanelImageBlurMode;
  els.multiAddCaptureLeftClick.checked = nextSettings.multiAddCaptureLeftClick;
  els.multiAddCaptureRightClick.checked = nextSettings.multiAddCaptureRightClick;
  els.debugMode.checked = nextSettings.debugMode;
  document.documentElement.dataset.sidePanelImageBlurMode = nextSettings.sidePanelImageBlurMode;
}

async function importNoAi(): Promise<void> {
  await runImport(async () => {
    const api = requireConfiguredApi();
    const payload = buildFinalPayload();
    const upload = await uploadCurrentMedia(api, payload);
    markUploaded(upload, { finalSaved: true });
    if (selectedQueueItemId) await setQueueItemStatus(selectedQueueItemId, "imported", "Imported.", upload.link);
    setSuccess("Imported.", upload.link);
  });
}

async function importAiAuto(): Promise<void> {
  await runImport(async () => {
    const api = requireConfiguredApi();
    const initialPayload = buildFinalPayload();
    const upload = await uploadCurrentMedia(api, initialPayload);
    const mediaId = requireMediaId(upload);
    markUploaded(upload);

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
    const upload = await uploadCurrentMedia(api, initialPayload);
    const mediaId = requireMediaId(upload);
    markUploaded(upload);

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

async function fetchCurrentMediaAsStableFile(mediaUrls: string[]): Promise<{ url: string; stable: Awaited<ReturnType<typeof fetchMediaAsStableFile>> }> {
  let lastError: unknown;

  for (const url of mediaUrls) {
    try {
      return {
        url,
        stable: await fetchMediaAsStableFile(url)
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Media fetch failed.");
}

function mediaFetchCandidates(): string[] {
  return fullQualityUrlCandidates([draft.mediaUrl, draft.previewUrl, ...rawMediaUrls(draft.raw)]);
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
  const categoryHints = { ...parsed.categoryHints };
  const extraTags = extraPredictions.map((prediction) => prediction.name);
  const artist = normalizeTag(els.artist.value);

  if (artist) categoryHints[artist] = "artist";

  for (const prediction of extraPredictions) {
    const name = normalizeTag(prediction.name);
    const category = normalizeCategory(prediction.category);
    if (name && category && category !== "unknown") {
      categoryHints[name] = category;
    }
  }

  const tags = mergeTags(nonRatingTags(parsed.tags), nonRatingTags(extraTags), artist ? [artist] : []);
  const tagSet = new Set(tags);
  for (const name of Object.keys(categoryHints)) {
    if (!tagSet.has(name)) delete categoryHints[name];
  }

  return {
    tags,
    categoryHints,
    rating: els.rating.value as Rating,
    source: els.source.value.trim()
  };
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

function requireConfiguredApi(): BlombooruApi {
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
    sidePanelImageBlurMode: els.sidePanelImageBlurMode.value as AppSettings["sidePanelImageBlurMode"],
    multiAddCaptureLeftClick: els.multiAddCaptureLeftClick.checked,
    multiAddCaptureRightClick: els.multiAddCaptureRightClick.checked,
    debugMode: els.debugMode.checked
  });

  if (!settings.baseUrl || !settings.apiKey) {
    els.settingsPanel.open = true;
    throw new BlombooruApiError("Missing Blombooru base URL or API key.");
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
  for (const button of [els.import, els.importAuto, els.importManual, els.saveFinal, els.importQueue, els.importQueueAuto, els.clearQueue, els.multiAddToggle]) {
    button.disabled = nextBusy;
  }
}

function requireMediaId(upload: UploadMediaResult): string {
  if (!upload.id) throw new Error("Upload succeeded, but Blombooru did not return a media id.");
  return upload.id;
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
      version: chrome.runtime.getManifest().version
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
      sidePanelImageBlurMode: settings.sidePanelImageBlurMode,
      debugMode: settings.debugMode,
      apiKeyConfigured: Boolean(settings.apiKey)
    },
    form: {
      source: els.source.value,
      artist: els.artist.value,
      rating: els.rating.value,
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
  const query = normalizeTag(els.artist.value);
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
  els.artist.value = item.name;
  els.artist.focus();
  els.artist.setSelectionRange(item.name.length, item.name.length);
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
  const artist = normalizeTag(els.artist.value);

  if (!artist) {
    renderArtistStatus("No artist tag will be sent.", "info");
    return;
  }

  const cachedCategory = categoryCache.get(artist);
  if (cachedCategory) {
    renderExistingArtistStatus(cachedCategory);
    return;
  }

  renderArtistStatus("Checking artist tag...", "info");

  try {
    const tag = await requireConfiguredApi().lookupTag(artist);
    if (requestId !== artistStatusRequest || normalizeTag(els.artist.value) !== artist) return;

    if (!tag) {
      renderArtistStatus("New artist tag will be added.", "new");
      return;
    }

    if (tag.category) categoryCache.set(artist, normalizeCategory(tag.category));
    renderExistingArtistStatus(tag.category);
  } catch {
    if (requestId !== artistStatusRequest) return;
    renderArtistStatus("Could not check artist tag. It will be sent as an artist tag on import.", "warning");
  }
}

function renderExistingArtistStatus(category: string | undefined): void {
  const normalized = normalizeCategory(category);
  if (normalized === "artist") {
    renderArtistStatus("Existing artist tag.", "success");
    return;
  }

  if (normalized && normalized !== "unknown") {
    renderArtistStatus(`Existing ${normalized} tag. Blombooru may keep that category.`, "warning");
    return;
  }

  renderArtistStatus("New artist tag will be added.", "new");
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
  return /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(url);
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
    const fullUrl = fullQualityProxyUrl(value);
    return fullUrl ? [fullUrl] : [];
  });
  const originalUrls = values.filter((value): value is string => Boolean(value));

  return preferOriginalUrls(uniqueUrls([...promotedUrls, ...originalUrls]));
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
      path.includes("thumbnail.webp") ||
      path.includes("preview.webp") ||
      path.includes("static.webp") ||
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
