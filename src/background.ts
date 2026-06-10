import {
  CONTEXT_MENU_ADD,
  EXTRACT_PAGE_CONTEXT_MESSAGE,
  PENDING_IMPORT_KEY
} from "./constants";
import type { ImportDraft, PendingImport } from "./types";

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

function registerContextMenus(): void {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ADD,
      title: "Add to Blombooru",
      contexts: ["image", "video", "page", "link"]
    });
  });
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

  const pendingWrite = chrome.storage.session.set({ [PENDING_IMPORT_KEY]: pending });

  if (typeof tabId !== "number") {
    await pendingWrite;
    return;
  }

  try {
    await openSidePanelForTab(tabId);
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
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: EXTRACT_PAGE_CONTEXT_MESSAGE,
      draft
    });
    if (response?.ok && response.draft) {
      return mergeDrafts(draft, response.draft as ImportDraft);
    }
  } catch {
    // Content scripts are not available on every page. The generic context-menu draft is enough as a fallback.
  }

  return draft;
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
