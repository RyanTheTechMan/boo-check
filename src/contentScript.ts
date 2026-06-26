import { extractImportDraft } from "./adapters";
import { fourChanThreadInfo, fourChanThreadUrl, type FourChanContext } from "./adapters/fourChan";
import {
  activeMisskeyPhotoSwipeImage,
  attachMisskeyRememberedContext,
  isUsableMisskeyContext,
  isMisskeyPhotoSwipeTarget,
  misskeyMediaUrlsMatch,
  rememberMisskeyContextFromTarget
} from "./adapters/misskey";
import { findXPostContainer, parseTwitterStatusUrl, selectXMedia } from "./adapters/x";
import type { DebugElementSummary, DebugMediaCandidate, DebugSourceCandidate, ImportDebugSnapshot, ImportDraft } from "./types";
import {
  absoluteUrl,
  closestPostContainer,
  elementUrls,
  extractHashtags,
  mediaUrlFromElement,
  normalizeAdapterTag
} from "./utils/domExtract";

const EXTRACT_PAGE_CONTEXT_MESSAGE = "boo-check:extract-page-context";
const FETCH_PAGE_MEDIA_MESSAGE = "boo-check:fetch-page-media";
const FETCH_PAGE_BOORU_POST_MESSAGE = "boo-check:fetch-page-booru-post";
const GET_MULTI_ADD_CAPTURE_STATE_MESSAGE = "boo-check:get-multi-add-capture-state";
const SET_MULTI_ADD_CAPTURE_MESSAGE = "boo-check:set-multi-add-capture";
const MULTI_ADD_CAPTURED_DRAFT_MESSAGE = "boo-check:multi-add-captured-draft";

const TWITTER_WEB_BEARER_FALLBACK =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

const TWEET_RESULT_QUERY_ID_FALLBACK = "qtXMy1p5Y62uCskc_NUPJw";

const TWEET_RESULT_FEATURES_FALLBACK = [
  "creator_subscriptions_tweet_preview_api_enabled",
  "premium_content_api_read_enabled",
  "communities_web_enable_tweet_community_results_fetch",
  "c9s_tweet_anatomy_moderator_badge_enabled",
  "responsive_web_grok_analyze_button_fetch_trends_enabled",
  "responsive_web_grok_analyze_post_followups_enabled",
  "rweb_cashtags_composer_attachment_enabled",
  "responsive_web_jetfuel_frame",
  "responsive_web_grok_share_attachment_enabled",
  "responsive_web_grok_annotations_enabled",
  "articles_preview_enabled",
  "responsive_web_edit_tweet_api_enabled",
  "rweb_conversational_replies_downvote_enabled",
  "graphql_is_translatable_rweb_tweet_is_translatable_enabled",
  "view_counts_everywhere_api_enabled",
  "longform_notetweets_consumption_enabled",
  "responsive_web_twitter_article_tweet_consumption_enabled",
  "content_disclosure_indicator_enabled",
  "content_disclosure_ai_generated_indicator_enabled",
  "responsive_web_grok_show_grok_translated_post",
  "responsive_web_grok_analysis_button_from_backend",
  "post_ctas_fetch_enabled",
  "rweb_cashtags_enabled",
  "freedom_of_speech_not_reach_fetch_enabled",
  "standardized_nudges_misinfo",
  "tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled",
  "longform_notetweets_rich_text_read_enabled",
  "longform_notetweets_inline_media_enabled",
  "profile_label_improvements_pcf_label_in_post_enabled",
  "responsive_web_profile_redirect_enabled",
  "rweb_tipjar_consumption_enabled",
  "verified_phone_label_enabled",
  "responsive_web_grok_image_annotation_enabled",
  "responsive_web_grok_imagine_annotation_enabled",
  "responsive_web_grok_community_note_auto_translation_is_enabled",
  "responsive_web_graphql_skip_user_profile_image_extensions_enabled",
  "responsive_web_graphql_timeline_navigation_enabled"
];

const TWEET_RESULT_FIELD_TOGGLES_FALLBACK = [
  "withArticleRichContentState",
  "withArticlePlainText",
  "withArticleSummaryText",
  "withArticleVoiceOver",
  "withGrokAnalyze",
  "withDisallowedReplyControls",
  "withPayments",
  "withAuxiliaryUserLabels"
];

const AUTO_COLLECT_SCAN_DELAY_MS = 250;
const AUTO_COLLECT_ROOT_MARGIN = "700px 0px";
const MAX_AUTO_COLLECT_TARGETS_PER_POST = 12;
const PAGE_MEDIA_FETCH_MAX_BYTES = 50 * 1024 * 1024;

type TwitterApiMetadata = {
  bearerToken: string;
  queryId: string;
  featureSwitches: string[];
  fieldToggles: string[];
};

type XGraphqlVideoEnrichment = {
  draft: ImportDraft;
  mediaCandidates: DebugMediaCandidate[];
  notes: string[];
  errors: string[];
};

type FourChanApiPost = {
  no?: number | string;
  tim?: number | string;
  ext?: string;
};

type MisskeyMediaContext = {
  draft: ImportDraft;
  capturedAt: number;
  mediaUrls: string[];
};

const MISSKEY_CONTEXT_MAX_AGE_MS = 10 * 60 * 1000;
const FOUR_CHAN_API_MIN_INTERVAL_MS = 1100;
const FOUR_CHAN_CATALOG_CACHE_MS = 30 * 1000;

let lastContextMenuTarget: Element | undefined;
let lastContextMenuPoint: { clientX: number; clientY: number } | undefined;
let lastMisskeyMediaContext: MisskeyMediaContext | undefined;
let twitterApiMetadataPromise: Promise<TwitterApiMetadata | undefined> | undefined;
let fourChanLastApiFetchAt = 0;
let fourChanApiQueue: Promise<unknown> = Promise.resolve();
const fourChanCatalogCache = new Map<string, { fetchedAt: number; posts: FourChanApiPost[] }>();
const fourChanCatalogPromises = new Map<string, Promise<FourChanApiPost[]>>();
let multiAddCaptureEnabled = false;
let multiAddCaptureLeftClick = false;
let multiAddCaptureRightClick = true;
let multiAddAutoCollectEnabled = false;
let lastCaptureSignature = "";
let lastCaptureAt = 0;
let autoCollectObserver: IntersectionObserver | undefined;
let autoCollectMutationObserver: MutationObserver | undefined;
let autoCollectScanTimer: number | undefined;
let autoCollectObservedElements = new WeakSet<Element>();
let autoCollectSeenKeys = new Set<string>();
let autoCollectPendingKeys = new Set<string>();

void refreshMultiAddCaptureState();

document.addEventListener(
  "contextmenu",
  (event) => {
    const target = eventTargetElement(event.target);
    lastContextMenuPoint = { clientX: event.clientX, clientY: event.clientY };
    lastContextMenuTarget = resolveContextMenuTarget(event, target);
    rememberMisskeyMediaContext(lastContextMenuTarget);
    if (shouldCaptureContextMenu(event, lastContextMenuTarget)) {
      blockPageEvent(event);
      void captureQueueDraftFromEvent(event, lastContextMenuTarget, "contextmenu");
    }
  },
  { capture: true }
);

document.addEventListener(
  "pointerdown",
  (event) => {
    const target = eventTargetElement(event.target);
    rememberMisskeyMediaContext(target);
    if (shouldBlockPointerDown(event, target)) blockPageEvent(event);
  },
  { capture: true }
);

document.addEventListener(
  "mousedown",
  (event) => {
    const target = eventTargetElement(event.target);
    if (shouldBlockMouseDown(event, target)) blockPageEvent(event);
  },
  { capture: true }
);

document.addEventListener(
  "click",
  (event) => {
    const target = eventTargetElement(event.target);
    rememberMisskeyMediaContext(target);
    if (shouldCaptureClick(event, target)) {
      blockPageEvent(event);
      void captureQueueDraftFromEvent(event, target, "click");
    }
  },
  { capture: true }
);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === SET_MULTI_ADD_CAPTURE_MESSAGE) {
    applyMultiAddCaptureState(message);
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === FETCH_PAGE_MEDIA_MESSAGE) {
    void handleFetchPageMedia(message, sendResponse);
    return true;
  }

  if (message?.type === FETCH_PAGE_BOORU_POST_MESSAGE) {
    void handleFetchPageBooruPost(message, sendResponse);
    return true;
  }

  if (message?.type !== EXTRACT_PAGE_CONTEXT_MESSAGE) return false;

  void handleExtractPageContext(message, sendResponse);
  return true;
});

async function handleFetchPageMedia(message: { url?: string }, sendResponse: (response?: unknown) => void): Promise<void> {
  const url = absoluteUrl(message.url);
  if (!url) {
    sendResponse({ ok: false, error: "No page media URL." });
    return;
  }

  try {
    const response = await fetch(url, {
      credentials: "include",
      referrer: location.href
    });
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() || "";
    const contentLength = Number(response.headers.get("content-length") || "0");
    if (!response.ok) throw new Error(`Page media fetch failed (${response.status}).`);
    if (contentLength > PAGE_MEDIA_FETCH_MAX_BYTES) {
      throw new Error(`Page media is too large (${formatDebugBytes(contentLength)}).`);
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > PAGE_MEDIA_FETCH_MAX_BYTES) {
      throw new Error(`Page media is too large (${formatDebugBytes(buffer.byteLength)}).`);
    }

    sendResponse({
      ok: true,
      url: response.url || url,
      contentType,
      bytes: buffer.byteLength,
      base64: arrayBufferToBase64(buffer)
    });
  } catch (error) {
    sendResponse({
      ok: false,
      url,
      error: error instanceof Error ? error.message : "Page media fetch failed."
    });
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function formatDebugBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

async function handleFetchPageBooruPost(message: { url?: string }, sendResponse: (response?: unknown) => void): Promise<void> {
  const url = absoluteUrl(message.url);
  if (!url) {
    sendResponse({ ok: false, error: "No booru post URL." });
    return;
  }
  if (!sameOriginUrl(url)) {
    sendResponse({ ok: false, url, error: "Booru post fallback only supports the current site." });
    return;
  }

  try {
    const response = await fetch(url, {
      credentials: "include",
      referrer: location.href
    });
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() || "";
    if (!response.ok) throw new Error(`Booru post fetch failed (${response.status}).`);
    if (contentType && !/^(?:text\/html|application\/xhtml\+xml)$/i.test(contentType)) {
      throw new Error(`Booru post fetch returned ${contentType}.`);
    }

    const html = await response.text();
    const responseUrl = response.url || url;
    const draft = extractBooruPostDraftFromHtml(responseUrl, html);
    sendResponse({
      ok: true,
      url,
      responseUrl,
      contentType,
      bytes: html.length,
      tagCount: draft.seedTags?.length ?? 0,
      mediaUrl: draft.mediaUrl,
      previewUrl: draft.previewUrl,
      draft
    });
  } catch (error) {
    sendResponse({
      ok: false,
      url,
      error: error instanceof Error ? error.message : "Booru post fetch failed."
    });
  }
}

function sameOriginUrl(value: string): boolean {
  try {
    return new URL(value).origin === location.origin;
  } catch {
    return false;
  }
}

function extractBooruPostDraftFromHtml(pageUrl: string, html: string): ImportDraft {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const postUrl = booruDocumentPostUrl(doc, pageUrl) || pageUrl;
  const externalSourceUrl = booruDocumentExternalSourceUrl(doc, postUrl);
  const mediaUrl = booruDocumentOriginalMediaUrl(doc, postUrl);
  const previewUrl = booruDocumentPreviewUrl(doc, postUrl) || mediaUrl;
  const tagData = booruDocumentTagData(doc);
  const rating = booruDocumentRating(doc);

  return {
    site: "booru",
    pageUrl: postUrl,
    sourceUrl: externalSourceUrl || postUrl,
    mediaUrl,
    previewUrl,
    artistTag: tagData.artistTag,
    artistTags: tagData.artistTags,
    seedTags: tagData.tags,
    rating,
    raw: {
      pageBooruPostFetch: {
        pageUrl,
        postUrl,
        sourceUrl: externalSourceUrl || postUrl,
        externalSourceUrl,
        artistTag: tagData.artistTag,
        artistTags: tagData.artistTags,
        mediaUrl,
        previewUrl,
        tagCount: tagData.tags.length
      }
    }
  };
}

function booruDocumentPostUrl(doc: Document, pageUrl: string): string | undefined {
  const candidates = [
    absoluteUrlWithBase(doc.querySelector<HTMLLinkElement>("link[rel='canonical']")?.href, pageUrl),
    absoluteUrlWithBase(doc.querySelector<HTMLMetaElement>("meta[property='og:url']")?.content, pageUrl),
    pageUrl
  ];

  return candidates.find((candidate): candidate is string => Boolean(candidate && looksLikeBooruPostUrl(candidate)));
}

function booruDocumentExternalSourceUrl(doc: Document, pageUrl: string): string | undefined {
  const sourceContainers = Array.from(doc.querySelectorAll<HTMLElement>(
    "#post-info-source, .post-info-source, [data-source], [data-source-url], li[id*='source'], section[id*='source']"
  ));

  for (const container of sourceContainers) {
    const dataSource = container.getAttribute("data-source-url") || container.getAttribute("data-source");
    const dataUrl = usableExternalSourceUrl(dataSource, pageUrl);
    if (dataUrl) return dataUrl;

    for (const anchor of Array.from(container.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
      const url = usableExternalSourceUrl(anchor.href || anchor.getAttribute("href"), pageUrl);
      if (url) return url;
    }

    const textUrl = firstUrlInText(container.textContent);
    const url = usableExternalSourceUrl(textUrl, pageUrl);
    if (url) return url;
  }

  return undefined;
}

function usableExternalSourceUrl(value: string | undefined | null, pageUrl: string): string | undefined {
  const url = absoluteUrlWithBase(value, pageUrl);
  if (!url || looksLikeBooruPostUrl(url)) return undefined;

  try {
    return new URL(url).origin === new URL(pageUrl).origin ? undefined : url;
  } catch {
    return undefined;
  }
}

function firstUrlInText(value: string | undefined | null): string | undefined {
  return value?.match(/https?:\/\/[^\s<>"')]+/i)?.[0];
}

function looksLikeBooruPostUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return /\/posts?\/\d+\/?$|\/post\/show\/\d+\/?$|(?:^|[?&])id=\d+(?:&|$)/i.test(`${url.pathname}${url.search}`);
  } catch {
    return false;
  }
}

function booruDocumentOriginalMediaUrl(doc: Document, pageUrl: string): string | undefined {
  const selectors = [
    "a#image-download-link[href]",
    "a#highres[href]",
    "a.original-file[href]",
    "a[href*='/original/'][href]",
    "a[href*='/data/original/'][href]",
    "video source[src]",
    "video[src]",
    "img#image[src]",
    "#image-container img[src]",
    ".image-container img[src]"
  ];

  for (const selector of selectors) {
    const element = doc.querySelector<HTMLElement>(selector);
    const value = mediaLikeUrlFromFetchedElement(element);
    const url = absoluteUrlWithBase(value, pageUrl);
    if (url) return url;
  }

  return undefined;
}

function booruDocumentPreviewUrl(doc: Document, pageUrl: string): string | undefined {
  const selectors = [
    "meta[property='og:image']",
    "meta[property='og:image:url']",
    "meta[name='twitter:image']",
    "meta[name='twitter:image:src']",
    "img#image[src]",
    "#image-container img[src]",
    ".image-container img[src]"
  ];

  for (const selector of selectors) {
    const element = doc.querySelector<HTMLElement>(selector);
    const value = element instanceof HTMLMetaElement ? element.content : mediaLikeUrlFromFetchedElement(element);
    const url = absoluteUrlWithBase(value, pageUrl);
    if (url) return url;
  }

  return undefined;
}

function mediaLikeUrlFromFetchedElement(element: Element | undefined | null): string | undefined {
  if (!element) return undefined;
  if (element instanceof HTMLAnchorElement) return element.getAttribute("href") || element.href;
  if (element instanceof HTMLSourceElement) return element.getAttribute("src") || element.src || firstSrcsetUrl(element.getAttribute("srcset"));
  if (element instanceof HTMLVideoElement) return element.getAttribute("src") || element.src;
  if (element instanceof HTMLImageElement) {
    return element.getAttribute("data-original") ||
      element.getAttribute("data-file-url") ||
      element.getAttribute("data-src") ||
      element.getAttribute("src") ||
      element.src ||
      firstSrcsetUrl(element.getAttribute("srcset"));
  }
  return element.getAttribute("href") || element.getAttribute("src") || element.getAttribute("data-src") || undefined;
}

function firstSrcsetUrl(value: string | undefined | null): string | undefined {
  return value?.split(",")[0]?.trim().split(/\s+/)[0];
}

function booruDocumentTagData(doc: Document): { tags: string[]; artistTag?: string; artistTags: string[] } {
  const selectors = [
    ".tag-type-general a.search-tag",
    ".tag-type-artist a.search-tag",
    ".tag-type-character a.search-tag",
    ".tag-type-copyright a.search-tag",
    ".tag-type-meta a.search-tag",
    ".tag-type-1 a.search-tag",
    ".category-1 a.search-tag",
    "[data-category] a.search-tag",
    "[data-tag-category] a.search-tag",
    "#tag-list a.search-tag",
    "#tag-list a",
    ".tag-list a.search-tag",
    ".tag-list a",
    "li[class*='tag-type'] a.search-tag",
    "li[class*='tag-type'] a",
    "li[class*='category-'] a.search-tag",
    "li[class*='category-'] a",
    "a[class*='tag-type']",
    "a[class*='category-']",
    ".tag a"
  ];
  const tags: string[] = [];
  const artistTags: string[] = [];

  for (const selector of selectors) {
    for (const element of Array.from(doc.querySelectorAll(selector))) {
      const tag = normalizeAdapterTag(element.textContent);
      if (!tag) continue;
      tags.push(tag);
      if (booruTagElementCategory(element) === "artist") artistTags.push(tag);
    }
  }

  const dedupedArtistTags = Array.from(new Set(artistTags));
  return {
    tags: Array.from(new Set(tags)),
    artistTag: dedupedArtistTags[0],
    artistTags: dedupedArtistTags
  };
}

function booruTagElementCategory(element: Element): string | undefined {
  const candidates = [
    element,
    element.closest("[class*='tag-type'], [class*='category-'], [data-category], [data-tag-category], [data-tag-type], [data-type]")
  ].filter((candidate): candidate is Element => Boolean(candidate));

  for (const candidate of candidates) {
    for (const attribute of ["data-category", "data-tag-category", "data-tag-type", "data-type"]) {
      const category = knownBooruCategory(candidate.getAttribute(attribute));
      if (category) return category;
    }

    for (const className of Array.from(candidate.classList)) {
      const category = knownBooruCategory(className);
      if (category) return category;
    }
  }

  return undefined;
}

function knownBooruCategory(value: string | undefined | null): string | undefined {
  const normalized = normalizeBooruCategoryValue(value);
  return ["general", "artist", "character", "copyright", "meta"].includes(normalized) ? normalized : undefined;
}

function normalizeBooruCategoryValue(value: string | undefined | null): string {
  if (!value) return "unknown";
  const normalized = value.trim().toLowerCase().replace(/-/g, "_").replace(/\s+/g, "_");
  const stripped = normalized
    .replace(/^tag_type_/, "")
    .replace(/^tag_category_/, "")
    .replace(/^type_/, "")
    .replace(/^category_/, "");

  if (stripped === "0" || stripped === "general") return "general";
  if (stripped === "1" || stripped === "artist" || stripped === "artists") return "artist";
  if (stripped === "3" || stripped === "copy" || stripped === "copyright" || stripped === "copyrights") return "copyright";
  if (stripped === "4" || stripped === "character" || stripped === "characters") return "character";
  if (stripped === "5" || stripped === "meta" || stripped === "metadata") return "meta";
  return "unknown";
}

function booruDocumentRating(doc: Document): ImportDraft["rating"] {
  const ratingElement = doc.querySelector("[data-rating], .rating, #rating, li[class*='rating']");
  const dataRating = ratingElement?.getAttribute("data-rating")?.toLowerCase();
  if (dataRating === "s" || dataRating === "safe") return "safe";
  if (dataRating === "q" || dataRating === "questionable") return "questionable";
  if (dataRating === "e" || dataRating === "explicit") return "explicit";
  const text = (ratingElement?.textContent || doc.body.textContent || "").toLowerCase();
  if (/\bexplicit\b|\brating:e\b|\brating_e\b/.test(text)) return "explicit";
  if (/\bquestionable\b|\brating:q\b|\brating_q\b/.test(text)) return "questionable";
  if (/\bsafe\b|\brating:s\b|\brating_s\b/.test(text)) return "safe";
  return undefined;
}

function absoluteUrlWithBase(value: string | undefined | null, base: string): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value, base).href;
  } catch {
    return undefined;
  }
}

async function handleExtractPageContext(message: { draft?: ImportDraft }, sendResponse: (response?: unknown) => void): Promise<void> {
  try {
    const { draft, debug } = await extractDraftWithDebug((message.draft ?? {}) as ImportDraft, lastContextMenuTarget);
    sendResponse({ ok: true, draft, debug });
  } catch (error) {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : "Page extraction failed"
    });
  }
}

async function refreshMultiAddCaptureState(): Promise<void> {
  try {
    const response = await chrome.runtime.sendMessage({ type: GET_MULTI_ADD_CAPTURE_STATE_MESSAGE });
    if (response?.ok) applyMultiAddCaptureState(response);
  } catch {
    // Capture starts disabled if the service worker is unavailable.
  }
}

function applyMultiAddCaptureState(message: {
  captureEnabled?: boolean;
  autoCollectEnabled?: boolean;
  captureLeftClick?: boolean;
  captureRightClick?: boolean;
}): void {
  multiAddCaptureEnabled = Boolean(message.captureEnabled);
  multiAddCaptureLeftClick = message.captureLeftClick !== false;
  multiAddCaptureRightClick = message.captureRightClick !== false;
  multiAddAutoCollectEnabled = multiAddCaptureEnabled && Boolean(message.autoCollectEnabled);
  syncAutoCollectMode();
}

function shouldCaptureContextMenu(event: MouseEvent, target: Element | undefined): boolean {
  return multiAddCaptureEnabled && multiAddCaptureRightClick && !isEditableTarget(target);
}

function shouldCaptureClick(event: MouseEvent, target: Element | undefined): boolean {
  return multiAddCaptureEnabled && multiAddCaptureLeftClick && event.button === 0 && !isEditableTarget(target);
}

function shouldBlockPointerDown(event: PointerEvent, target: Element | undefined): boolean {
  if (!multiAddCaptureEnabled || isEditableTarget(target)) return false;
  if (event.button === 0) return multiAddCaptureLeftClick;
  if (event.button === 2) return multiAddCaptureRightClick;
  return false;
}

function shouldBlockMouseDown(event: MouseEvent, target: Element | undefined): boolean {
  if (!multiAddCaptureEnabled || isEditableTarget(target)) return false;
  if (event.button === 0) return multiAddCaptureLeftClick;
  if (event.button === 2) return multiAddCaptureRightClick;
  return false;
}

function isEditableTarget(target: Element | undefined): boolean {
  return Boolean(target?.closest("input, textarea, select, option, [contenteditable]"));
}

function blockPageEvent(event: Event): void {
  event.preventDefault();
  event.stopImmediatePropagation();
}

async function captureQueueDraftFromEvent(event: MouseEvent, target: Element | undefined, eventType: "click" | "contextmenu"): Promise<void> {
  if (isDuplicateCapture(event, target)) return;

  try {
    const { draft, debug } = await extractDraftWithDebug(baseCaptureDraft(event, target, eventType), target);
    await chrome.runtime.sendMessage({
      type: MULTI_ADD_CAPTURED_DRAFT_MESSAGE,
      draft,
      debug
    });
  } catch {
    // Keep capture mode quiet on pages where extraction or storage is unavailable.
  }
}

function isDuplicateCapture(event: MouseEvent, target: Element | undefined): boolean {
  const now = Date.now();
  const signature = [
    mediaUrlFromElement(target),
    target?.closest<HTMLAnchorElement>("a[href]")?.href,
    Math.round(event.clientX),
    Math.round(event.clientY)
  ].filter(Boolean).join("|");

  if (signature && signature === lastCaptureSignature && now - lastCaptureAt < 450) return true;

  lastCaptureSignature = signature;
  lastCaptureAt = now;
  return false;
}

function baseCaptureDraft(event: MouseEvent, target: Element | undefined, eventType: "click" | "contextmenu"): ImportDraft {
  const mediaUrl = mediaUrlFromElement(target);
  const linkUrl = target?.closest<HTMLAnchorElement>("a[href]")?.href;
  return {
    pageUrl: location.href,
    sourceUrl: linkUrl || location.href,
    mediaUrl,
    previewUrl: mediaUrl,
    site: "generic",
    raw: {
      multiAdd: true,
      eventType,
      button: event.button,
      clientX: event.clientX,
      clientY: event.clientY,
      linkUrl
    }
  };
}

function syncAutoCollectMode(): void {
  if (multiAddAutoCollectEnabled) {
    startAutoCollectMode();
    return;
  }
  stopAutoCollectMode();
}

function startAutoCollectMode(): void {
  if (!document.body) {
    window.setTimeout(syncAutoCollectMode, AUTO_COLLECT_SCAN_DELAY_MS);
    return;
  }

  if (!autoCollectObserver) {
    autoCollectSeenKeys = new Set();
    autoCollectPendingKeys = new Set();
    autoCollectObservedElements = new WeakSet<Element>();
    autoCollectObserver = new IntersectionObserver(handleAutoCollectIntersections, {
      root: null,
      rootMargin: AUTO_COLLECT_ROOT_MARGIN,
      threshold: 0.01
    });
  }

  if (!autoCollectMutationObserver) {
    autoCollectMutationObserver = new MutationObserver(() => scheduleAutoCollectScan());
    autoCollectMutationObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  scheduleAutoCollectScan(0);
}

function stopAutoCollectMode(): void {
  if (autoCollectScanTimer) {
    window.clearTimeout(autoCollectScanTimer);
    autoCollectScanTimer = undefined;
  }
  autoCollectObserver?.disconnect();
  autoCollectMutationObserver?.disconnect();
  autoCollectObserver = undefined;
  autoCollectMutationObserver = undefined;
  autoCollectPendingKeys.clear();
}

function scheduleAutoCollectScan(delay = AUTO_COLLECT_SCAN_DELAY_MS): void {
  if (autoCollectScanTimer) window.clearTimeout(autoCollectScanTimer);
  autoCollectScanTimer = window.setTimeout(() => {
    autoCollectScanTimer = undefined;
    scanAutoCollectCandidates();
  }, delay);
}

function scanAutoCollectCandidates(): void {
  if (!multiAddAutoCollectEnabled || !autoCollectObserver) return;

  for (const container of findAutoCollectContainers()) {
    if (!autoCollectObservedElements.has(container)) {
      autoCollectObservedElements.add(container);
      autoCollectObserver.observe(container);
    }

    if (isElementNearViewport(container)) {
      void collectAutoCollectContainer(container);
    }
  }
}

function handleAutoCollectIntersections(entries: IntersectionObserverEntry[]): void {
  if (!multiAddAutoCollectEnabled) return;
  for (const entry of entries) {
    if (entry.isIntersecting) {
      void collectAutoCollectContainer(entry.target);
    }
  }
}

function findAutoCollectContainers(): Element[] {
  const containers = new Set<Element>();
  const add = (element: Element | undefined | null): void => {
    const container = normalizeAutoCollectContainer(element ?? undefined);
    if (container && isAutoCollectPostContainer(container)) containers.add(container);
  };

  document.querySelectorAll(
    [
      "article[data-testid='tweet']",
      "[data-testid='cellInnerDiv']",
      "article",
      "[role='article']",
      "[data-scroll-anchor]",
      "[class*='SkNote-root']",
      "[class*='MkNote-root']",
      "[class*='Note-root']",
      "._panel",
      "#threads .thread",
      "img.thumb[src]",
      ".opContainer",
      ".replyContainer",
      ".postContainer",
      ".post",
      "a.fileThumb[href]",
      "[to^='/notes/']",
      "[to^='/clips/']",
      "a[href*='/notes/']",
      "a[href*='/clips/']"
    ].join(",")
  ).forEach(add);

  return Array.from(containers).slice(0, 160);
}

function normalizeAutoCollectContainer(element: Element | undefined): Element | undefined {
  if (!element) return undefined;

  const tweet = element.matches("article[data-testid='tweet']")
    ? element
    : element.querySelector("article[data-testid='tweet']") ?? element.closest("article[data-testid='tweet']");
  if (tweet) return tweet;

  const cell = element.closest("[data-testid='cellInnerDiv']") ?? (element.matches("[data-testid='cellInnerDiv']") ? element : undefined);
  if (cell?.querySelector("a[href*='/status/']")) return cell;

  const fourChanCatalogueThread = element.matches("#threads .thread")
    ? element
    : element.closest("#threads .thread");
  if (fourChanCatalogueThread?.querySelector("a[href*='/thread/'] img.thumb[src], img.thumb[src]")) return fourChanCatalogueThread;

  const fourChanPost = element.matches(".post, .opContainer, .replyContainer, .postContainer")
    ? element
    : element.closest(".post, .opContainer, .replyContainer, .postContainer");
  if (fourChanPost?.querySelector("a.fileThumb[href], .fileText a[href]")) return fourChanPost;

  const post = element.closest(
    "article, [role='article'], [data-scroll-anchor], [class*='SkNote-root'], [class*='MkNote-root'], [class*='Note-root'], ._panel, [to^='/notes/'], [to^='/clips/']"
  );
  if (post) return post;

  return element;
}

function isAutoCollectPostContainer(container: Element): boolean {
  return Boolean(autoCollectPostSourceUrl(container) && autoCollectMediaTargets(container).length);
}

function isElementNearViewport(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  return rect.bottom >= -700 && rect.top <= viewportHeight + 700 && rect.right >= 0 && rect.left <= viewportWidth;
}

async function collectAutoCollectContainer(container: Element): Promise<void> {
  if (!multiAddAutoCollectEnabled) return;

  const sourceUrl = autoCollectPostSourceUrl(container);
  if (!sourceUrl) return;

  for (const target of autoCollectMediaTargets(container)) {
    const key = autoCollectQueueKey(container, target, sourceUrl);
    if (!key || autoCollectSeenKeys.has(key) || autoCollectPendingKeys.has(key)) continue;

    autoCollectPendingKeys.add(key);
    autoCollectSeenKeys.add(key);
    void collectAutoCollectTarget(container, target, sourceUrl).finally(() => {
      autoCollectPendingKeys.delete(key);
    });
  }
}

async function collectAutoCollectTarget(container: Element, target: Element, sourceUrl: string): Promise<void> {
  try {
    rememberMisskeyMediaContext(target);
    const { draft, debug } = await extractDraftWithDebug(baseAutoCollectDraft(container, target, sourceUrl), target);
    if (!draft.mediaUrl && !draft.previewUrl) return;
    await chrome.runtime.sendMessage({
      type: MULTI_ADD_CAPTURED_DRAFT_MESSAGE,
      draft,
      debug
    });
  } catch {
    // Auto collect should stay quiet; the next visible post may still extract cleanly.
  }
}

function baseAutoCollectDraft(container: Element, target: Element, sourceUrl: string): ImportDraft {
  const mediaUrl = autoCollectMediaUrl(target);
  const linkUrl = target.closest<HTMLAnchorElement>("a[href]")?.href;
  return {
    pageUrl: location.href,
    sourceUrl: sourceUrl || linkUrl || location.href,
    mediaUrl,
    previewUrl: mediaUrlFromElement(target) || mediaUrl,
    site: "generic",
    raw: {
      multiAdd: true,
      autoCollect: true,
      sourceUrl,
      linkUrl,
      mediaUrl,
      containerSource: autoCollectContainerKind(container)
    }
  };
}

function autoCollectPostSourceUrl(container: Element): string | undefined {
  const candidates: string[] = [];
  const add = (value: string | undefined | null): void => {
    const url = absoluteUrl(value, location.origin);
    if (url) candidates.push(url);
  };

  add(fourChanThreadUrl(location.href));
  add(container.getAttribute("to"));
  container.querySelectorAll<HTMLElement>("[to^='/notes/'], [to^='/clips/']").forEach((element) => add(element.getAttribute("to")));
  container.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((anchor) => {
    const href = absoluteUrl(anchor.getAttribute("href"));
    if (href && looksLikeAutoCollectPostSource(href)) candidates.push(href);
  });

  return candidates.find(looksLikeAutoCollectPostSource);
}

function autoCollectMediaTargets(container: Element): Element[] {
  const targets: Element[] = [];
  const seen = new Set<string>();
  const add = (element: Element | undefined | null): void => {
    if (!element || isAutoCollectExcludedMediaElement(element)) return;
    const url = autoCollectMediaUrl(element) || mediaUrlFromElement(element);
    if (!url || !looksLikeAutoCollectMediaCandidate(url, element)) return;
    const key = autoCollectElementKey(element, url);
    if (seen.has(key)) return;
    seen.add(key);
    targets.push(element);
  };

  if (container instanceof HTMLImageElement || container instanceof HTMLVideoElement || container instanceof HTMLAnchorElement) {
    add(container);
  }

  container.querySelectorAll<HTMLElement>(
    [
      "[data-testid='tweetPhoto'] img",
      "[data-testid='tweetPhoto'] video",
      "[data-testid='videoPlayer'] video",
      "a[href*='/photo/'] img",
      "img.thumb[src]",
      "a[href*='/files/']",
      "a[href*='/proxy/']",
      "a[href*='url=']",
      "a.fileThumb[href]",
      ".fileText a[href]",
      ".image a[href]",
      "[class*='media' i] a[href]",
      "[class*='Media' i] a[href]",
      "img[src]",
      "video[src]",
      "video source[src]"
    ].join(",")
  ).forEach(add);

  return targets.slice(0, MAX_AUTO_COLLECT_TARGETS_PER_POST);
}

function autoCollectMediaUrl(target: Element): string | undefined {
  const mediaLink = target instanceof HTMLAnchorElement ? target : target.closest<HTMLAnchorElement>("a[href]");
  if (mediaLink && looksLikeDirectAutoCollectMediaUrl(mediaLink.href)) return absoluteUrl(mediaLink.href);
  return mediaUrlFromElement(target);
}

function autoCollectQueueKey(container: Element, target: Element, sourceUrl: string): string | undefined {
  const media = autoCollectMediaUrl(target) || mediaUrlFromElement(target);
  const source = sourceUrl || autoCollectPostSourceUrl(container);
  return [normalizedAutoCollectKeyPart(source), normalizedAutoCollectKeyPart(media)].filter(Boolean).join("|") || undefined;
}

function normalizedAutoCollectKeyPart(value: string | undefined): string | undefined {
  const absolute = absoluteUrl(value);
  if (!absolute) return undefined;
  try {
    const url = new URL(absolute);
    url.hash = "";
    return url.href;
  } catch {
    return absolute;
  }
}

function autoCollectElementKey(element: Element, url: string): string {
  const photoLink = element.closest<HTMLAnchorElement>("a[href*='/photo/']")?.href;
  return normalizedAutoCollectKeyPart(photoLink) || normalizedAutoCollectKeyPart(url) || cssPathForElement(element);
}

function autoCollectContainerKind(container: Element): string {
  if (container.matches("article[data-testid='tweet'], [data-testid='cellInnerDiv']")) return "x-timeline-post";
  if (container.matches("#threads .thread")) return "4chan-catalog-thread";
  if (container.matches(".post, .opContainer, .replyContainer, .postContainer")) return "4chan-thread-post";
  if (container.matches("[to^='/notes/'], [to^='/clips/'], ._panel, [data-scroll-anchor]")) return "misskey-timeline-post";
  return "post-container";
}

function isAutoCollectExcludedMediaElement(element: Element): boolean {
  if (element.closest("[data-testid='tweetPhoto'], [data-testid='videoPlayer'], #threads .thread, a.fileThumb, .file, .fileText, [class*='MkMedia'], [class*='media' i], [class*='Media' i]")) {
    return false;
  }

  return Boolean(
    element.closest(
      [
        "nav",
        "aside",
        "header",
        "footer",
        "[data-testid^='UserAvatar']",
        "[data-testid='Tweet-User-Avatar']",
        "[aria-label*='profile picture' i]",
        "[class*='avatar' i]",
        "[class*='reaction' i]",
        "[class*='emoji' i]",
        "[class*='icon' i]",
        "[class*='avadeco' i]"
      ].join(",")
    )
  );
}

function looksLikeAutoCollectPostSource(value: string): boolean {
  try {
    const url = new URL(value, location.href);
    return Boolean(
      looksLikePostSource(url.href) ||
        /\/(?:notes|clips)\/[A-Za-z0-9_-]+/.test(url.pathname) ||
        fourChanThreadUrl(url.href)
    );
  } catch {
    return false;
  }
}

function looksLikeDirectAutoCollectMediaUrl(value: string): boolean {
  try {
    const url = new URL(value, location.href);
    return isLikelyMediaUrl(url.href) || /\/files\/|\/proxy\//.test(url.pathname) || url.searchParams.has("url");
  } catch {
    return false;
  }
}

function looksLikeAutoCollectMediaCandidate(value: string, element: Element): boolean {
  if (element.closest("[data-testid='tweetPhoto'], [data-testid='videoPlayer']")) return true;
  if (looksLikeDirectAutoCollectMediaUrl(value)) return true;
  try {
    const url = new URL(value, location.href);
    return url.hostname === "pbs.twimg.com" || url.hostname === "video.twimg.com" || /\/files\//.test(url.pathname);
  } catch {
    return false;
  }
}

async function extractDraftWithDebug(inputDraft: ImportDraft, target: Element | undefined): Promise<{ draft: ImportDraft; debug: ImportDebugSnapshot }> {
  const messageDraft = applyMisskeyPhotoSwipeMediaToDraft(inputDraft, target);
  const pendingDraft = attachMisskeyRememberedContext(
    messageDraft,
    misskeyContextForExtraction(target)
  );
  let draft = extractImportDraft(pendingDraft, target);
  const xDebug = await enrichXVideoFromGraphqlIfNeeded(pendingDraft, draft, target);
  draft = xDebug.draft;
  const fourChanDebug = await enrichFourChanCatalogueIfNeeded(draft);
  draft = fourChanDebug.draft;
  if (draft.site === "misskey" && isUsableMisskeyContext(draft)) {
    rememberMisskeyMediaContext(target);
  }
  const debug = buildDebugSnapshot(pendingDraft, draft, target, {
    mediaCandidates: [...xDebug.mediaCandidates, ...fourChanDebug.mediaCandidates],
    notes: [...xDebug.notes, ...fourChanDebug.notes],
    errors: [...xDebug.errors, ...fourChanDebug.errors]
  });
  return { draft, debug };
}

function eventTargetElement(target: EventTarget | null): Element | undefined {
  return target instanceof Element ? target : target instanceof Node ? target.parentElement ?? undefined : undefined;
}

function resolveContextMenuTarget(event: MouseEvent, target: Element | undefined): Element | undefined {
  if (!target) return misskeyPhotoSwipeImageFromPoint(event.clientX, event.clientY);
  if (target.closest(".pswp")) {
    return misskeyPhotoSwipeImageFromPoint(event.clientX, event.clientY) ?? target.closest(".pswp__img") ?? target;
  }
  return target;
}

function misskeyPhotoSwipeImageFromPoint(clientX: number, clientY: number): HTMLImageElement | undefined {
  if (!document.querySelector(".pswp.pswp--open")) return undefined;

  for (const element of document.elementsFromPoint(clientX, clientY)) {
    if (element instanceof HTMLImageElement && element.classList.contains("pswp__img")) return element;
    const nested = element.querySelector?.("img.pswp__img");
    if (nested instanceof HTMLImageElement) return nested;
  }

  return activeMisskeyPhotoSwipeImage();
}

function applyMisskeyPhotoSwipeMediaToDraft(draft: ImportDraft, target: Element | undefined): ImportDraft {
  if (!target || !isMisskeyPhotoSwipeTarget(target)) return draft;
  const mediaUrl = mediaUrlFromElement(target) || mediaUrlFromElement(activeMisskeyPhotoSwipeImage());
  if (!mediaUrl) return draft;
  return {
    ...draft,
    mediaUrl,
    previewUrl: mediaUrl,
    raw: {
      ...rawObject(draft.raw),
      misskeyPhotoSwipeContextMenuPoint: lastContextMenuPoint
    }
  };
}

function rawObject(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
}

function rememberMisskeyMediaContext(target: Element | undefined): void {
  if (!target || isMisskeyPhotoSwipeTarget(target)) return;
  const draft = rememberMisskeyContextFromTarget(target);
  if (!isUsableMisskeyContext(draft)) return;
  const mediaUrls = collectMisskeyContextMediaUrls(draft, target);
  if (!mediaUrls.length) return;

  lastMisskeyMediaContext = {
    draft: safeDraft(draft),
    capturedAt: Date.now(),
    mediaUrls
  };
}

function misskeyContextForExtraction(target: Element | undefined): ImportDraft | undefined {
  if (!isMisskeyPhotoSwipeTarget(target)) {
    const direct = rememberMisskeyContextFromTarget(target);
    if (!isUsableMisskeyContext(direct)) return undefined;
    rememberMisskeyMediaContext(target);
    return direct;
  }

  const mediaUrl = mediaUrlFromElement(target) || mediaUrlFromElement(activeMisskeyPhotoSwipeImage());
  if (!mediaUrl || !lastMisskeyMediaContext || !isFreshMisskeyMediaContext(lastMisskeyMediaContext)) return undefined;
  return misskeyContextMatchesMedia(lastMisskeyMediaContext, mediaUrl) ? lastMisskeyMediaContext.draft : undefined;
}

function collectMisskeyContextMediaUrls(draft: ImportDraft, target: Element | undefined): string[] {
  const urls = new Set<string>();
  const add = (value: string | undefined | null) => {
    const url = absoluteUrl(value);
    if (url) urls.add(url);
  };

  add(draft.mediaUrl);
  add(draft.previewUrl);
  add(mediaUrlFromElement(target));
  add(mediaUrlFromElement(activeMisskeyPhotoSwipeImage()));
  add(target?.closest<HTMLAnchorElement>("a[href]")?.href);

  if (target) {
    for (const url of elementUrls(target)) add(url);
    target.querySelectorAll("img, video, source, a[href]").forEach((element) => {
      for (const url of elementUrls(element)) add(url);
      if (element instanceof HTMLAnchorElement) add(element.href);
    });
  }

  return Array.from(urls);
}

function misskeyContextMatchesMedia(context: MisskeyMediaContext, mediaUrl: string): boolean {
  return context.mediaUrls.some((candidate) => misskeyMediaUrlsMatch(candidate, mediaUrl));
}

function isFreshMisskeyMediaContext(context: MisskeyMediaContext): boolean {
  return Date.now() - context.capturedAt < MISSKEY_CONTEXT_MAX_AGE_MS;
}

async function enrichXVideoFromGraphqlIfNeeded(
  pendingDraft: ImportDraft,
  draft: ImportDraft,
  target: Element | undefined
): Promise<XGraphqlVideoEnrichment> {
  const fallback = { draft, mediaCandidates: [], notes: [], errors: [] };
  if (draft.site !== "x") return fallback;

  const container = findXPostContainer(pendingDraft, target);
  const hasVideo = Boolean(container.querySelector("[data-testid='videoPlayer'] video, video"));
  const hasPosterVideo = Boolean(draft.previewUrl && /\/(amplify_video_thumb|ext_tw_video_thumb|tweet_video_thumb)\//.test(draft.previewUrl));
  const isVideoRoute = isXVideoRoute(draft.sourceUrl || draft.pageUrl || location.href);
  const hasResolvedVideo = Boolean(draft.mediaUrl && isTwitterMp4Url(draft.mediaUrl));
  if (hasResolvedVideo || (!hasVideo && !hasPosterVideo && !isVideoRoute)) return fallback;

  const unresolvedVideoDraft: ImportDraft = {
    ...draft,
    mediaUrl: undefined
  };
  const unresolvedFallback = {
    draft: unresolvedVideoDraft,
    mediaCandidates: [] as DebugMediaCandidate[],
    notes: [] as string[],
    errors: [] as string[]
  };

  const status = parseTwitterStatusUrl(draft.sourceUrl || draft.pageUrl || location.href);
  if (!status?.statusId) {
    return {
      ...unresolvedFallback,
      notes: ["X GraphQL video lookup skipped because no status id was found."]
    };
  }

  try {
    const metadata = await getTwitterApiMetadata();
    if (!metadata) {
      return {
        ...unresolvedFallback,
        errors: ["X GraphQL video lookup failed: could not find X web API metadata."]
      };
    }

    const response = await fetchTweetResultByRestId(metadata, status.statusId);
    const candidates = collectGraphqlVideoCandidates(response);
    if (!candidates.length) {
      return {
        ...unresolvedFallback,
        notes: ["X GraphQL video lookup returned no MP4 variants."]
      };
    }

    const ordered = candidates.sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0));
    const selected = ordered[0];
    selected.selected = true;

    return {
      draft: {
        ...draft,
        mediaUrl: selected.canonicalUrl,
        previewUrl: draft.previewUrl
      },
      mediaCandidates: ordered,
      notes: [`Selected X GraphQL MP4 video variant ${selected.canonicalUrl}.`],
      errors: []
    };
  } catch (error) {
    return {
      ...unresolvedFallback,
      errors: [`X GraphQL video lookup failed: ${error instanceof Error ? error.message : "unknown error"}`]
    };
  }
}

async function enrichFourChanCatalogueIfNeeded(draft: ImportDraft): Promise<XGraphqlVideoEnrichment> {
  const fallback = { draft, mediaCandidates: [], notes: [], errors: [] };
  if (draft.site !== "4chan") return fallback;

  const context = fourChanContextFromDraft(draft);
  if (!context?.catalogue) return fallback;

  const unresolvedDraft = {
    ...draft,
    mediaUrl: isFourChanThumbnailUrl(draft.mediaUrl) ? undefined : draft.mediaUrl,
    raw: updateFourChanContext(draft.raw, {
      ...context,
      resolvedOriginal: Boolean(draft.mediaUrl && !isFourChanThumbnailUrl(draft.mediaUrl))
    })
  };
  const unresolvedCandidate = context.previewUrl
    ? [{
        originalUrl: context.previewUrl,
        canonicalUrl: context.previewUrl,
        source: "4chan catalogue thumbnail",
        score: 100,
        accepted: false,
        rejectionReason: "catalogue thumbnail ignored while resolving original media"
      } satisfies DebugMediaCandidate]
    : [];

  if (unresolvedDraft.mediaUrl) return { ...fallback, draft: unresolvedDraft };
  if (!context.board || !context.threadId) {
    return {
      draft: unresolvedDraft,
      mediaCandidates: unresolvedCandidate,
      notes: ["4chan catalogue original lookup skipped because board or thread id was missing."],
      errors: []
    };
  }

  try {
    const post = await findFourChanApiPost(context);
    const mediaUrl = post ? fourChanApiMediaUrl(context.board, post) : undefined;
    if (!mediaUrl) {
      return {
        draft: unresolvedDraft,
        mediaCandidates: unresolvedCandidate,
        notes: ["4chan catalogue lookup did not find an API post with matching tim/ext media metadata."],
        errors: []
      };
    }

    return {
      draft: {
        ...draft,
        mediaUrl,
        previewUrl: context.previewUrl || draft.previewUrl,
        raw: updateFourChanContext(draft.raw, {
          ...context,
          originalUrl: mediaUrl,
          resolvedOriginal: true
        })
      },
      mediaCandidates: [
        ...unresolvedCandidate,
        {
          originalUrl: mediaUrl,
          canonicalUrl: mediaUrl,
          source: "4chan JSON API original media",
          score: 10000,
          accepted: true,
          selected: true
        }
      ],
      notes: [`Selected ${mediaUrl} from 4chan JSON API metadata.`],
      errors: []
    };
  } catch (error) {
    return {
      draft: unresolvedDraft,
      mediaCandidates: unresolvedCandidate,
      notes: [],
      errors: [`4chan catalogue original lookup failed: ${error instanceof Error ? error.message : "unknown error"}`]
    };
  }
}

async function findFourChanApiPost(context: FourChanContext): Promise<FourChanApiPost | undefined> {
  if (!context.board || !context.threadId) return undefined;

  try {
    const catalogPost = (await fetchFourChanCatalogPosts(context.board)).find((post) => fourChanApiPostMatchesContext(post, context));
    if (catalogPost) return catalogPost;
  } catch {
    // Fall back to the individual thread endpoint below.
  }

  const threadPosts = await fetchFourChanThreadPosts(context.board, context.threadId);
  return threadPosts.find((post) => fourChanApiPostMatchesContext(post, context));
}

function fourChanApiPostMatchesContext(post: FourChanApiPost, context: FourChanContext): boolean {
  if (String(post.no ?? "") !== String(context.threadId ?? "")) return false;
  if (!post.tim || !post.ext) return false;
  return !context.thumbnailMediaId || String(post.tim) === context.thumbnailMediaId;
}

function fourChanApiMediaUrl(board: string, post: FourChanApiPost): string | undefined {
  const tim = String(post.tim ?? "");
  const ext = String(post.ext ?? "");
  if (!/^\d+$/.test(tim) || !/^\.[A-Za-z0-9]+$/.test(ext)) return undefined;
  return `https://i.4cdn.org/${board}/${tim}${ext}`;
}

async function fetchFourChanCatalogPosts(board: string): Promise<FourChanApiPost[]> {
  const cached = fourChanCatalogCache.get(board);
  if (cached && Date.now() - cached.fetchedAt < FOUR_CHAN_CATALOG_CACHE_MS) return cached.posts;

  const pending = fourChanCatalogPromises.get(board);
  if (pending) return pending;

  const promise = fetchFourChanJsonQueued(`https://a.4cdn.org/${board}/catalog.json`)
    .then(extractFourChanCatalogPosts)
    .then((posts) => {
      fourChanCatalogCache.set(board, { fetchedAt: Date.now(), posts });
      return posts;
    })
    .finally(() => {
      fourChanCatalogPromises.delete(board);
    });
  fourChanCatalogPromises.set(board, promise);
  return promise;
}

async function fetchFourChanThreadPosts(board: string, threadId: string): Promise<FourChanApiPost[]> {
  const json = await fetchFourChanJsonQueued(`https://a.4cdn.org/${board}/thread/${threadId}.json`);
  if (!json || typeof json !== "object") return [];
  const posts = (json as { posts?: unknown }).posts;
  return Array.isArray(posts) ? posts.filter(isFourChanApiPost) : [];
}

function extractFourChanCatalogPosts(value: unknown): FourChanApiPost[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((page) => {
    const threads = page && typeof page === "object" ? (page as { threads?: unknown }).threads : undefined;
    return Array.isArray(threads) ? threads.filter(isFourChanApiPost) : [];
  });
}

function isFourChanApiPost(value: unknown): value is FourChanApiPost {
  return Boolean(value && typeof value === "object");
}

async function fetchFourChanJsonQueued(url: string): Promise<unknown> {
  const run = fourChanApiQueue.then(async () => {
    const waitMs = Math.max(0, fourChanLastApiFetchAt + FOUR_CHAN_API_MIN_INTERVAL_MS - Date.now());
    if (waitMs > 0) await delay(waitMs);
    fourChanLastApiFetchAt = Date.now();

    const response = await fetch(url, {
      credentials: "omit",
      headers: { accept: "application/json" }
    });
    if (!response.ok) throw new Error(`${url} returned ${response.status}`);
    return response.json();
  });
  fourChanApiQueue = run.catch(() => undefined);
  return run;
}

function fourChanContextFromDraft(draft: ImportDraft): FourChanContext | undefined {
  const context = rawObject(draft.raw).fourChan;
  if (context && typeof context === "object") return context as FourChanContext;

  const threadInfo = fourChanThreadInfo(draft.sourceUrl || draft.pageUrl);
  if (!threadInfo) return undefined;
  return {
    board: threadInfo.board,
    threadId: threadInfo.threadId,
    sourceUrl: threadInfo.url,
    previewUrl: draft.previewUrl,
    thumbnailMediaId: fourChanThumbnailMediaId(draft.previewUrl || draft.mediaUrl),
    catalogue: isFourChanThumbnailUrl(draft.mediaUrl) || isFourChanThumbnailUrl(draft.previewUrl)
  };
}

function updateFourChanContext(raw: unknown, context: FourChanContext): Record<string, unknown> {
  return {
    ...rawObject(raw),
    fourChan: {
      ...(fourChanContextFromRaw(raw) ?? {}),
      ...context
    }
  };
}

function fourChanContextFromRaw(raw: unknown): FourChanContext | undefined {
  const context = rawObject(raw).fourChan;
  return context && typeof context === "object" ? context as FourChanContext : undefined;
}

function isFourChanThumbnailUrl(value: string | undefined): boolean {
  return Boolean(fourChanThumbnailMediaId(value));
}

function fourChanThumbnailMediaId(value: string | undefined): string | undefined {
  const absolute = absoluteUrl(value);
  if (!absolute) return undefined;
  try {
    const url = new URL(absolute);
    return /\.4cdn\.org$/i.test(url.hostname) || url.hostname === "i.4cdn.org"
      ? url.pathname.match(/\/(\d+)s\.jpe?g$/i)?.[1]
      : undefined;
  } catch {
    return undefined;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isXVideoRoute(value: string): boolean {
  try {
    return /\/[^/]+\/status\/\d+\/video\/\d+/.test(new URL(value, location.href).pathname);
  } catch {
    return false;
  }
}

function isTwitterMp4Url(value: string): boolean {
  try {
    const url = new URL(value, location.href);
    return url.hostname === "video.twimg.com" && /\.mp4$/i.test(url.pathname);
  } catch {
    return false;
  }
}

async function getTwitterApiMetadata(): Promise<TwitterApiMetadata | undefined> {
  twitterApiMetadataPromise ??= discoverTwitterApiMetadata();
  return twitterApiMetadataPromise;
}

async function discoverTwitterApiMetadata(): Promise<TwitterApiMetadata | undefined> {
  const scriptUrls = collectTwitterScriptUrls();
  let bearerToken: string | undefined;
  let queryId: string | undefined;
  let featureSwitches: string[] | undefined;
  let fieldToggles: string[] | undefined;

  for (const scriptUrl of scriptUrls) {
    try {
      const response = await fetch(scriptUrl, { credentials: "omit" });
      if (!response.ok) continue;
      const text = await response.text();
      bearerToken ??= extractTwitterBearerToken(text);
      const operation = extractTweetResultOperation(text);
      if (operation) {
        queryId ??= operation.queryId;
        featureSwitches ??= operation.featureSwitches;
        fieldToggles ??= operation.fieldToggles;
      }
      if (bearerToken && queryId) break;
    } catch {
      // Try the next script.
    }
  }

  return {
    bearerToken: bearerToken || TWITTER_WEB_BEARER_FALLBACK,
    queryId: queryId || TWEET_RESULT_QUERY_ID_FALLBACK,
    featureSwitches: featureSwitches?.length ? featureSwitches : TWEET_RESULT_FEATURES_FALLBACK,
    fieldToggles: fieldToggles?.length ? fieldToggles : TWEET_RESULT_FIELD_TOGGLES_FALLBACK
  };
}

function collectTwitterScriptUrls(): string[] {
  const urls = new Set<string>();
  const add = (value: string | undefined | null) => {
    const url = absoluteUrl(value);
    if (url && url.startsWith("https://abs.twimg.com/responsive-web/client-web/") && url.endsWith(".js")) {
      urls.add(url);
    }
  };

  document.querySelectorAll<HTMLScriptElement>("script[src]").forEach((script) => add(script.src));
  performance.getEntriesByType("resource").forEach((entry) => add(entry.name));

  return Array.from(urls).sort((a, b) => {
    const aScore = a.includes("/main.") ? 0 : a.includes("bundle.Conversation") ? 1 : 2;
    const bScore = b.includes("/main.") ? 0 : b.includes("bundle.Conversation") ? 1 : 2;
    return aScore - bScore || a.localeCompare(b);
  });
}

function extractTwitterBearerToken(text: string): string | undefined {
  return text.match(/Bearer ([A-Za-z0-9%._-]+)/)?.[1];
}

function extractTweetResultOperation(text: string): Omit<TwitterApiMetadata, "bearerToken"> | undefined {
  const match = text.match(
    /queryId:"([^"]+)",operationName:"TweetResultByRestId"[\s\S]*?metadata:\{featureSwitches:\[([\s\S]*?)\],fieldToggles:\[([\s\S]*?)\]/
  );
  if (!match) return undefined;

  return {
    queryId: match[1],
    featureSwitches: extractQuotedStrings(match[2]),
    fieldToggles: extractQuotedStrings(match[3])
  };
}

function extractQuotedStrings(value: string): string[] {
  return Array.from(value.matchAll(/"([^"]+)"/g)).map((match) => match[1]);
}

async function fetchTweetResultByRestId(metadata: TwitterApiMetadata, tweetId: string): Promise<unknown> {
  const variables = {
    tweetId,
    withCommunity: false,
    includePromotedContent: false,
    withVoice: false
  };
  const features = Object.fromEntries(metadata.featureSwitches.map((feature) => [feature, true]));
  const fieldToggles = Object.fromEntries(
    metadata.fieldToggles.map((toggle) => [toggle, toggle === "withArticlePlainText" ? false : true])
  );
  const url = new URL(`https://x.com/i/api/graphql/${metadata.queryId}/TweetResultByRestId`);
  url.searchParams.set("variables", JSON.stringify(variables));
  url.searchParams.set("features", JSON.stringify(features));
  url.searchParams.set("fieldToggles", JSON.stringify(fieldToggles));

  const headers: Record<string, string> = {
    authorization: `Bearer ${metadata.bearerToken}`,
    accept: "*/*",
    "x-twitter-active-user": "yes",
    "x-twitter-client-language": document.documentElement.lang || "en"
  };
  const csrf = cookieValue("ct0");
  if (csrf) {
    headers["x-csrf-token"] = csrf;
    headers["x-twitter-auth-type"] = "OAuth2Session";
  }

  const response = await fetch(url.href, {
    credentials: "include",
    headers
  });

  if (!response.ok) {
    throw new Error(`TweetResultByRestId returned ${response.status}`);
  }

  return response.json();
}

function collectGraphqlVideoCandidates(response: unknown): DebugMediaCandidate[] {
  const candidates: DebugMediaCandidate[] = [];
  const seen = new Set<string>();
  let visited = 0;

  const visit = (value: unknown): void => {
    visited += 1;
    if (visited > 5000 || !value || typeof value !== "object") return;

    const record = value as Record<string, unknown>;
    const videoInfo = record.video_info;
    if (videoInfo && typeof videoInfo === "object") {
      const variants = (videoInfo as Record<string, unknown>).variants;
      if (Array.isArray(variants)) {
        for (const variant of variants) {
          const candidate = normalizeGraphqlVideoVariant(variant);
          if (!candidate?.canonicalUrl || seen.has(candidate.canonicalUrl)) continue;
          seen.add(candidate.canonicalUrl);
          candidates.push(candidate);
        }
      }
    }

    for (const child of Object.values(record)) {
      if (child && typeof child === "object") visit(child);
    }
  };

  visit(response);
  return candidates;
}

function normalizeGraphqlVideoVariant(value: unknown): DebugMediaCandidate | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const url = typeof record.url === "string" ? record.url : undefined;
  if (!url || !/\.mp4(\?|$)/i.test(url)) return undefined;

  const bitrate = typeof record.bitrate === "number" ? record.bitrate : 0;
  const dimensions = dimensionsFromVideoUrl(url);
  const areaScore = dimensions.width && dimensions.height ? Math.round((dimensions.width * dimensions.height) / 2500) : 0;

  return {
    originalUrl: url,
    canonicalUrl: url,
    source: "X GraphQL video variant",
    score: bitrate + areaScore,
    accepted: true,
    width: dimensions.width,
    height: dimensions.height,
    twimgKind: "twitter_video_mp4"
  };
}

function dimensionsFromVideoUrl(value: string): Pick<DebugMediaCandidate, "width" | "height"> {
  try {
    const match = new URL(value).pathname.match(/\/(\d{2,5})x(\d{2,5})\//);
    if (!match) return {};
    return { width: Number(match[1]), height: Number(match[2]) };
  } catch {
    return {};
  }
}

function cookieValue(name: string): string | undefined {
  return document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function buildDebugSnapshot(
  pendingDraft: ImportDraft,
  enrichedDraft: ImportDraft,
  target: Element | undefined,
  extra: {
    mediaCandidates?: DebugMediaCandidate[];
    notes?: string[];
    errors?: string[];
  } = {}
): ImportDebugSnapshot {
  const errors: string[] = [...(extra.errors ?? [])];
  const nearestPostContainer = closestPostContainer(target);
  const detailedMedia = safely(
    () => collectDetailedMediaCandidates(pendingDraft, enrichedDraft, target, nearestPostContainer),
    { candidates: [] as DebugMediaCandidate[], notes: [] as string[], x: undefined as ImportDebugSnapshot["x"] },
    errors,
    "detailed media candidates"
  );

  return {
    capturedAt: Date.now(),
    pageUrl: location.href,
    selectedAdapter: enrichedDraft.site,
    pendingDraft: safeDraft(pendingDraft),
    enrichedDraft: safeDraft(enrichedDraft),
    rightClickTarget: summarizeElement(target),
    nearestPostContainer: summarizeElement(nearestPostContainer),
    candidateMediaUrls: safely(() => collectCandidateMediaUrls(target, nearestPostContainer), [], errors, "candidate media"),
    candidateSourceUrls: safely(() => collectCandidateSourceUrls(target, nearestPostContainer), [], errors, "candidate source links"),
    mediaCandidates: [...detailedMedia.candidates, ...(extra.mediaCandidates ?? [])],
    sourceCandidatesDetailed: safely(() => collectDetailedSourceCandidates(target, nearestPostContainer), [], errors, "detailed source candidates"),
    selectionNotes: [...detailedMedia.notes, ...(extra.notes ?? [])],
    x: detailedMedia.x,
    misskey: enrichedDraft.site === "misskey"
      ? {
          rememberedContext: lastMisskeyMediaContext?.draft ? safeDraft(lastMisskeyMediaContext.draft) : undefined,
          photoSwipeOpen: Boolean(document.querySelector(".pswp.pswp--open")),
          activePhotoSwipeImage: summarizeElement(activeMisskeyPhotoSwipeImage()),
          selectedMediaUrl: enrichedDraft.mediaUrl
        }
      : undefined,
    metaImageUrls: safely(collectMetaImageUrls, [], errors, "meta images"),
    visibleTags: safely(() => collectVisibleTags(nearestPostContainer), [], errors, "visible tags"),
    hashtags: safely(() => extractHashtags(nearestPostContainer?.textContent || document.body.textContent || ""), [], errors, "hashtags"),
    errors
  };
}

function safeDraft(draft: ImportDraft): ImportDraft {
  return {
    pageUrl: draft.pageUrl,
    sourceUrl: draft.sourceUrl,
    mediaUrl: draft.mediaUrl,
    previewUrl: draft.previewUrl,
    site: draft.site,
    posterName: draft.posterName,
    artistTag: draft.artistTag,
    caption: draft.caption?.slice(0, 500),
    hashtags: draft.hashtags,
    seedTags: draft.seedTags,
    rating: draft.rating
  };
}

function summarizeElement(element: Element | undefined): DebugElementSummary | undefined {
  if (!element) return undefined;

  return {
    tagName: element.tagName.toLowerCase(),
    id: element.id || undefined,
    className: typeof element.className === "string" ? element.className.slice(0, 220) || undefined : undefined,
    role: element.getAttribute("role") || undefined,
    testId: element.getAttribute("data-testid") || undefined,
    ariaLabel: element.getAttribute("aria-label") || undefined,
    href: element instanceof HTMLAnchorElement ? element.href : undefined,
    src:
      element instanceof HTMLImageElement
        ? element.currentSrc || element.src
        : element instanceof HTMLVideoElement
          ? element.currentSrc || element.src
          : undefined,
    path: cssPathForElement(element),
    width:
      element instanceof HTMLImageElement
        ? element.naturalWidth || element.width || undefined
        : element instanceof HTMLVideoElement
          ? element.videoWidth || element.clientWidth || undefined
          : undefined,
    height:
      element instanceof HTMLImageElement
        ? element.naturalHeight || element.height || undefined
        : element instanceof HTMLVideoElement
          ? element.videoHeight || element.clientHeight || undefined
          : undefined,
    text: compactText(element.textContent)
  };
}

function collectCandidateMediaUrls(target: Element | undefined, container: Element | undefined): string[] {
  const urls = new Set<string>();
  const add = (value: string | undefined | null) => {
    const url = absoluteUrl(value);
    if (url) urls.add(url);
  };

  for (const element of [target, container].filter((item): item is Element => Boolean(item))) {
    for (const url of elementUrls(element)) add(url);
    element.querySelectorAll("img, video, source, a[href]").forEach((candidate) => {
      for (const url of elementUrls(candidate)) add(url);
      if (candidate instanceof HTMLAnchorElement && isLikelyMediaUrl(candidate.href)) add(candidate.href);
    });
  }

  document.querySelectorAll("meta[property='og:image'], meta[property='og:image:url'], meta[name='twitter:image'], meta[name='twitter:image:src']").forEach((meta) => {
    add((meta as HTMLMetaElement).content);
  });

  return Array.from(urls).slice(0, 40);
}

function collectDetailedMediaCandidates(
  pendingDraft: ImportDraft,
  enrichedDraft: ImportDraft,
  target: Element | undefined,
  container: Element | undefined
): {
  candidates: DebugMediaCandidate[];
  notes: string[];
  x?: ImportDebugSnapshot["x"];
} {
  if (enrichedDraft.site === "x") {
    const xContainer = findXPostContainer(pendingDraft, target);
    const selection = selectXMedia(pendingDraft, target, xContainer);
    return {
      candidates: selection.candidates.map((candidate) => ({
        originalUrl: candidate.originalUrl,
        canonicalUrl: candidate.canonicalUrl,
        source: candidate.source,
        score: candidate.score,
        accepted: candidate.accepted,
        selected: candidate.selected,
        rejectionReason: candidate.rejectionReason,
        element: summarizeElement(candidate.element),
        width: candidate.width,
        height: candidate.height,
        twimgKind: candidate.twimgKind,
        twimgNameParamBefore: candidate.twimgNameParamBefore,
        twimgNameParamAfter: candidate.twimgNameParamAfter
      })),
      notes: selection.notes,
      x: {
        parsedStatus: selection.parsedStatus,
        selectedMediaUrl: selection.selected?.canonicalUrl,
        selectedMediaSource: selection.selected?.source,
        statusLinks: selection.statusLinks,
        photoLinks: selection.photoLinks,
        selectedTweetContainer: summarizeElement(xContainer)
      }
    };
  }

  const candidates = collectCandidateMediaUrls(target, container).map((url, index) => ({
    originalUrl: url,
    canonicalUrl: url,
    source: "generic candidate media url",
    score: 100 - index,
    accepted: url === enrichedDraft.mediaUrl || url === enrichedDraft.previewUrl,
    selected: url === enrichedDraft.mediaUrl || url === enrichedDraft.previewUrl
  }));

  return {
    candidates,
    notes: enrichedDraft.mediaUrl ? [`Selected ${enrichedDraft.mediaUrl}.`] : ["No selected media URL in enriched draft."]
  };
}

function collectCandidateSourceUrls(target: Element | undefined, container: Element | undefined): string[] {
  const urls = new Set<string>();
  const add = (value: string | undefined | null) => {
    const url = absoluteUrl(value);
    if (url) urls.add(url);
  };

  add(location.href);
  add(document.querySelector<HTMLLinkElement>("link[rel='canonical']")?.href);
  add(document.querySelector<HTMLMetaElement>("meta[property='og:url']")?.content);

  for (const element of [target, container, document.body].filter((item): item is Element => Boolean(item))) {
    element.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((anchor) => {
      if (looksLikePostSource(anchor.href)) add(anchor.href);
    });
  }

  return Array.from(urls).slice(0, 40);
}

function collectDetailedSourceCandidates(target: Element | undefined, container: Element | undefined): DebugSourceCandidate[] {
  const candidates = new Map<string, DebugSourceCandidate>();
  const add = (value: string | undefined | null, source: string, element?: Element, accepted = false) => {
    const url = absoluteUrl(value);
    if (!url) return;
    const previous = candidates.get(url);
    if (!previous || accepted) {
      candidates.set(url, { url, source, accepted, element: summarizeElement(element) });
    }
  };

  add(location.href, "location.href", undefined, true);
  add(document.querySelector<HTMLLinkElement>("link[rel='canonical']")?.href, "canonical link", undefined, true);
  add(document.querySelector<HTMLMetaElement>("meta[property='og:url']")?.content, "og:url", undefined, true);

  for (const element of [target, container, document.body].filter((item): item is Element => Boolean(item))) {
    element.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((anchor) => {
      if (looksLikePostSource(anchor.href)) add(anchor.href, "post-like anchor", anchor, true);
    });
  }

  return Array.from(candidates.values()).slice(0, 60);
}

function collectMetaImageUrls(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLMetaElement>(
      "meta[property='og:image'], meta[property='og:image:url'], meta[name='twitter:image'], meta[name='twitter:image:src']"
    )
  )
    .map((meta) => absoluteUrl(meta.content))
    .filter((url): url is string => Boolean(url));
}

function collectVisibleTags(container: Element | undefined): string[] {
  const root = container ?? document.body;
  const selectors = [
    ".tag-type-general a",
    ".tag-type-artist a",
    ".tag-type-character a",
    ".tag-type-copyright a",
    ".tag-type-meta a",
    "#tag-list a",
    ".tag-list a",
    ".tag a"
  ];
  const tags = selectors.flatMap((selector) =>
    Array.from(root.querySelectorAll(selector)).map((element) => normalizeAdapterTag(element.textContent))
  );
  return Array.from(new Set(tags.filter(Boolean))).slice(0, 80);
}

function safely<T>(work: () => T, fallback: T, errors: string[], label: string): T {
  try {
    return work();
  } catch (error) {
    errors.push(`${label}: ${error instanceof Error ? error.message : "failed"}`);
    return fallback;
  }
}

function compactText(value: string | null): string | undefined {
  const text = value?.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 260) : undefined;
}

function cssPathForElement(element: Element): string {
  const parts: string[] = [];
  let current: Element | null = element;

  while (current && current !== document.documentElement && parts.length < 6) {
    const testId = current.getAttribute("data-testid");
    const id = current.id ? `#${current.id}` : "";
    const className =
      typeof current.className === "string" && current.className.trim()
        ? `.${current.className.trim().split(/\s+/).slice(0, 3).join(".")}`
        : "";
    parts.unshift(`${current.tagName.toLowerCase()}${id}${testId ? `[data-testid="${testId}"]` : className}`);
    current = current.parentElement;
  }

  return parts.join(" > ");
}

function isLikelyMediaUrl(value: string): boolean {
  try {
    return /\.(jpe?g|png|webp|gif|mp4|webm)(\?|#|$)/i.test(new URL(value).pathname);
  } catch {
    return false;
  }
}

function looksLikePostSource(value: string): boolean {
  try {
    const url = new URL(value);
    return /\/status\/\d+|\/notes\/[A-Za-z0-9_-]+|\/[A-Za-z0-9]+\/thread\/\d+|\/posts?\/\d+|\/post\/show\/\d+|[?&]id=\d+/.test(`${url.pathname}${url.search}`);
  } catch {
    return false;
  }
}
