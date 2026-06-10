import { extractImportDraft } from "./adapters";
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

type MisskeyMediaContext = {
  draft: ImportDraft;
  capturedAt: number;
  mediaUrls: string[];
};

const MISSKEY_CONTEXT_MAX_AGE_MS = 10 * 60 * 1000;

let lastContextMenuTarget: Element | undefined;
let lastContextMenuPoint: { clientX: number; clientY: number } | undefined;
let lastMisskeyMediaContext: MisskeyMediaContext | undefined;
let twitterApiMetadataPromise: Promise<TwitterApiMetadata | undefined> | undefined;

document.addEventListener(
  "contextmenu",
  (event) => {
    const target = eventTargetElement(event.target);
    lastContextMenuPoint = { clientX: event.clientX, clientY: event.clientY };
    lastContextMenuTarget = resolveContextMenuTarget(event, target);
    rememberMisskeyMediaContext(lastContextMenuTarget);
  },
  { capture: true }
);

document.addEventListener(
  "pointerdown",
  (event) => {
    const target = event.target;
    rememberMisskeyMediaContext(target instanceof Element ? target : target instanceof Node ? target.parentElement ?? undefined : undefined);
  },
  { capture: true }
);

document.addEventListener(
  "click",
  (event) => {
    const target = event.target;
    rememberMisskeyMediaContext(target instanceof Element ? target : target instanceof Node ? target.parentElement ?? undefined : undefined);
  },
  { capture: true }
);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== EXTRACT_PAGE_CONTEXT_MESSAGE) return false;

  void handleExtractPageContext(message, sendResponse);
  return true;
});

async function handleExtractPageContext(message: { draft?: ImportDraft }, sendResponse: (response?: unknown) => void): Promise<void> {
  try {
    const messageDraft = applyMisskeyPhotoSwipeMediaToDraft((message.draft ?? {}) as ImportDraft, lastContextMenuTarget);
    const pendingDraft = attachMisskeyRememberedContext(
      messageDraft,
      misskeyContextForExtraction(lastContextMenuTarget)
    );
    let draft = extractImportDraft(pendingDraft, lastContextMenuTarget);
    const asyncDebug = await enrichXVideoFromGraphqlIfNeeded(pendingDraft, draft, lastContextMenuTarget);
    draft = asyncDebug.draft;
    if (draft.site === "misskey" && isUsableMisskeyContext(draft)) {
      rememberMisskeyMediaContext(lastContextMenuTarget);
    }
    const debug = buildDebugSnapshot(pendingDraft, draft, lastContextMenuTarget, {
      mediaCandidates: asyncDebug.mediaCandidates,
      notes: asyncDebug.notes,
      errors: asyncDebug.errors
    });
    sendResponse({ ok: true, draft, debug });
  } catch (error) {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : "Page extraction failed"
    });
  }
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
    return /\/status\/\d+|\/notes\/[A-Za-z0-9_-]+|\/posts?\/\d+|\/post\/show\/\d+|[?&]id=\d+/.test(`${url.pathname}${url.search}`);
  } catch {
    return false;
  }
}
