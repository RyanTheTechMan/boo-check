import {
  CONTEXT_MENU_ADD,
  EXTRACT_PAGE_CONTEXT_MESSAGE,
  GET_MULTI_ADD_CAPTURE_STATE_MESSAGE,
  IMPORT_QUEUE_STORE_KEY,
  MULTI_ADD_CAPTURED_DRAFT_MESSAGE,
  SET_MULTI_ADD_CAPTURE_MESSAGE,
  PENDING_IMPORT_KEY
} from "./constants";
import { loadSettings } from "./settings";
import type { ImportDebugSnapshot, ImportDraft, ImportQueueItem, ImportQueueState, ImportQueueStore, PendingImport } from "./types";

chrome.runtime.onInstalled.addListener(() => {
  registerContextMenus();
});

chrome.runtime.onStartup.addListener(() => {
  registerContextMenus();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  void handleContextMenuClick(info, tab);
});

chrome.action.onClicked.addListener((tab) => {
  void openSidePanelForTab(tab.id);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === GET_MULTI_ADD_CAPTURE_STATE_MESSAGE) {
    void handleGetMultiAddCaptureState(sender, sendResponse);
    return true;
  }

  if (message?.type === SET_MULTI_ADD_CAPTURE_MESSAGE) {
    void handleSetMultiAddCapture(message, sender, sendResponse);
    return true;
  }

  if (message?.type === MULTI_ADD_CAPTURED_DRAFT_MESSAGE) {
    void handleCapturedQueueDraft(message, sender, sendResponse);
    return true;
  }

  return false;
});

function registerContextMenus(): void {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ADD,
      title: "Add to Blombooru",
      contexts: ["image", "video", "page", "link"]
    });
  });
}

async function handleGetMultiAddCaptureState(
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void
): Promise<void> {
  const tabId = sender.tab?.id;
  if (typeof tabId !== "number") {
    sendResponse({ ok: false, error: "No tab id." });
    return;
  }

  const queue = await readQueueState(tabId);
  const settings = await loadSettings();
  sendResponse({
    ok: true,
    captureEnabled: queue.captureEnabled,
    captureLeftClick: settings.multiAddCaptureLeftClick,
    captureRightClick: settings.multiAddCaptureRightClick
  });
}

async function handleSetMultiAddCapture(
  message: { tabId?: number; captureEnabled?: boolean },
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void
): Promise<void> {
  const tabId = typeof message.tabId === "number" ? message.tabId : sender.tab?.id;
  if (typeof tabId !== "number") {
    sendResponse({ ok: false, error: "No tab id." });
    return;
  }

  const captureEnabled = Boolean(message.captureEnabled);
  const queue = await updateQueueState(tabId, (state) => ({
    ...state,
    captureEnabled,
    updatedAt: Date.now()
  }));

  await sendCaptureStateToTab(tabId, captureEnabled);
  sendResponse({ ok: true, queue });
}

async function handleCapturedQueueDraft(
  message: { draft?: ImportDraft; debug?: ImportDebugSnapshot },
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void
): Promise<void> {
  const tabId = sender.tab?.id;
  if (typeof tabId !== "number" || !message.draft) {
    sendResponse({ ok: false, error: "No captured draft." });
    return;
  }

  const result = await appendQueueDraft(tabId, message.draft, message.debug);
  sendResponse({ ok: true, ...result });
}

async function sendCaptureStateToTab(tabId: number, captureEnabled: boolean): Promise<void> {
  const settings = await loadSettings();
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: SET_MULTI_ADD_CAPTURE_MESSAGE,
      captureEnabled,
      captureLeftClick: settings.multiAddCaptureLeftClick,
      captureRightClick: settings.multiAddCaptureRightClick
    });
  } catch {
    // The tab may not have a content script, such as extension and browser pages.
  }
}

async function handleContextMenuClick(
  info: chrome.contextMenus.OnClickData,
  tab?: chrome.tabs.Tab
): Promise<void> {
  const tabId = tab?.id;
  const baseDraft: ImportDraft = {
    pageUrl: info.pageUrl,
    sourceUrl: info.linkUrl || info.pageUrl,
    mediaUrl: info.srcUrl,
    previewUrl: info.srcUrl,
    site: "generic",
    raw: {
      menuItemId: info.menuItemId,
      mediaType: info.mediaType,
      linkUrl: info.linkUrl,
      srcUrl: info.srcUrl
    }
  };
  const pending: PendingImport = {
    draft: baseDraft,
    tabId,
    createdAt: Date.now()
  };

  if (typeof tabId !== "number") {
    await chrome.storage.session.set({ [PENDING_IMPORT_KEY]: pending });
    return;
  }

  const sidePanelOpen = openSidePanelForTab(tabId).catch(() => undefined);
  const queue = await readQueueState(tabId);
  if (queue.captureEnabled) {
    const enriched = await enrichDraftFromTabWithDebug(tabId, baseDraft);
    await appendQueueDraft(tabId, enriched.draft, enriched.debug);
    await sidePanelOpen;
    return;
  }

  const pendingWrite = chrome.storage.session.set({ [PENDING_IMPORT_KEY]: pending });

  try {
    await sidePanelOpen;
  } finally {
    await pendingWrite;
  }

  void enrichPendingImportFromTab(tabId, pending);
}

async function openSidePanelForTab(tabId: number | undefined): Promise<void> {
  if (typeof tabId !== "number") return;

  void chrome.sidePanel.setOptions({
    tabId,
    path: "src/sidepanel.html",
    enabled: true
  }).catch(() => undefined);

  await chrome.sidePanel.open({ tabId });
}

async function enrichDraftFromTab(tabId: number, draft: ImportDraft): Promise<ImportDraft> {
  return (await enrichDraftFromTabWithDebug(tabId, draft)).draft;
}

async function enrichDraftFromTabWithDebug(
  tabId: number,
  draft: ImportDraft
): Promise<{ draft: ImportDraft; debug?: ImportDebugSnapshot }> {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: EXTRACT_PAGE_CONTEXT_MESSAGE,
      draft
    });
    if (response?.ok && response.draft) {
      return {
        draft: mergeDrafts(draft, response.draft as ImportDraft),
        debug: response.debug as ImportDebugSnapshot | undefined
      };
    }
  } catch {
    // Content scripts are not available on every page. The generic context-menu draft is enough as a fallback.
  }

  return { draft };
}

async function enrichPendingImportFromTab(tabId: number, pending: PendingImport): Promise<void> {
  const enrichedDraft = await enrichDraftFromTab(tabId, pending.draft);
  if (enrichedDraft === pending.draft) return;

  const result = await chrome.storage.session.get(PENDING_IMPORT_KEY);
  const current = result[PENDING_IMPORT_KEY] as PendingImport | undefined;
  if (current?.createdAt !== pending.createdAt || current.tabId !== pending.tabId) return;

  await chrome.storage.session.set({
    [PENDING_IMPORT_KEY]: {
      ...pending,
      draft: enrichedDraft
    }
  });
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

function mergeTags(...groups: Array<string[] | undefined>): string[] | undefined {
  const merged = Array.from(new Set(groups.flatMap((group) => group ?? []).filter(Boolean)));
  return merged.length ? merged : undefined;
}

async function appendQueueDraft(
  tabId: number,
  draft: ImportDraft,
  debug: ImportDebugSnapshot | undefined
): Promise<{ itemId: string; duplicate: boolean; queue: ImportQueueState }> {
  let itemId = "";
  let duplicate = false;
  const queue = await updateQueueState(tabId, (state) => {
    const now = Date.now();
    const key = draftQueueKey(draft);
    const existing = key ? state.items.find((item) => draftQueueKey(item.draft) === key) : undefined;

    if (existing) {
      itemId = existing.id;
      duplicate = true;
      return {
        ...state,
        selectedItemId: existing.id,
        items: state.items.map((item) =>
          item.id === existing.id
            ? {
                ...item,
                updatedAt: now,
                statusMessage: item.status === "queued" ? "Already in queue." : item.statusMessage
              }
            : item
        ),
        updatedAt: now
      };
    }

    itemId = createQueueItemId();
    const item: ImportQueueItem = {
      id: itemId,
      createdAt: now,
      updatedAt: now,
      draft,
      debug,
      status: "queued"
    };

    return {
      ...state,
      selectedItemId: itemId,
      items: [...state.items, item],
      updatedAt: now
    };
  });

  return { itemId, duplicate, queue };
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

async function updateQueueState(tabId: number, update: (state: ImportQueueState) => ImportQueueState): Promise<ImportQueueState> {
  const store = await readQueueStore();
  const next = update(normalizeQueueState(tabId, store[String(tabId)]));
  await writeQueueStore({
    ...store,
    [String(tabId)]: next
  });
  return next;
}

function normalizeQueueState(tabId: number, state: ImportQueueState | undefined): ImportQueueState {
  return {
    tabId,
    captureEnabled: Boolean(state?.captureEnabled),
    selectedItemId: state?.selectedItemId,
    items: Array.isArray(state?.items) ? state.items : [],
    updatedAt: state?.updatedAt ?? Date.now()
  };
}

function createQueueItemId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function draftQueueKey(draft: ImportDraft): string | undefined {
  return normalizedUrlKey(draft.mediaUrl) || normalizedUrlKey(draft.previewUrl) || normalizedUrlKey(draft.sourceUrl) || normalizedUrlKey(draft.pageUrl);
}

function normalizedUrlKey(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return value.trim() || undefined;
  }
}
