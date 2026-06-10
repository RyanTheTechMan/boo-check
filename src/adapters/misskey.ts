import type { ImportDraft } from "../types";
import {
  absoluteUrl,
  closestPostContainer,
  elementUrls,
  extractHashtags,
  findFirstLink,
  normalizeAdapterTag,
  textOf
} from "../utils/domExtract";
import type { SiteAdapter } from ".";

type MisskeyMediaCandidate = {
  originalUrl: string;
  canonicalUrl: string;
  importUrl: string;
  previewUrl?: string;
  source: string;
  score: number;
  accepted: boolean;
  element?: Element;
};

type MisskeyRememberedRaw = {
  misskeyRememberedContext?: ImportDraft;
};

const MISSKEY_POST_PATH_RE = /\/(?:notes|clips)\/[A-Za-z0-9_-]+/;

export const misskeyAdapter: SiteAdapter = {
  detect(draft: ImportDraft, target?: Element): boolean {
    if (misskeyPostUrl(draft.pageUrl) || misskeyPostUrl(draft.sourceUrl) || MISSKEY_POST_PATH_RE.test(location.pathname)) return true;
    const container = findMisskeyNoteContainer(target);
    const targetMediaUrl = directElementUrl(target) || draft.mediaUrl || draft.previewUrl;
    const mediaContainer = targetMediaUrl ? findMisskeyNoteContainerForMedia(targetMediaUrl) : undefined;
    const hasMisskeySignal = Boolean(
      hasMisskeyNoteLink(container) ||
        hasMisskeyNoteLink(mediaContainer) ||
        document.querySelector("a[href*='/notes/'], a[href*='/clips/'], [to^='/notes/'], [to^='/clips/'], meta[property='misskey:summary'], meta[name='misskey:summary']") ||
        rememberedMisskeyContext(draft)
    );
    return Boolean(
      hasMisskeyNoteLink(container) ||
        hasMisskeyNoteLink(mediaContainer) ||
        document.querySelector("meta[property='misskey:summary'], meta[name='misskey:summary']") ||
        (hasMisskeySignal && (isMisskeyPhotoSwipeTarget(target) || looksLikeMisskeyTarget(target)))
    );
  },

  extract(draft: ImportDraft, target?: Element): ImportDraft {
    const targetMediaUrl = directElementUrl(target) || draft.mediaUrl || draft.previewUrl || directElementUrl(activeMisskeyPhotoSwipeImage());
    const remembered = rememberedMisskeyContext(draft);
    const matchedContainer = targetMediaUrl ? findMisskeyNoteContainerForMedia(targetMediaUrl) : undefined;
    const container = findMisskeyNoteContainer(target) || matchedContainer;
    const usableRemembered = shouldUseRememberedMisskeyContext(remembered, targetMediaUrl, target);
    const photoSwipeRemembered = isMisskeyPhotoSwipeTarget(target) ? usableRemembered : undefined;
    const noteLink = container
      ? findFirstLink(container, (href) => MISSKEY_POST_PATH_RE.test(new URL(href).pathname))
      : undefined;
    const containerSourceUrl = absoluteUrl(noteLink?.href) || misskeyNoteUrlFromElement(container) || misskeyNoteUrlFromElement(target);
    const rememberedSourceUrl = misskeyPostUrl(usableRemembered?.sourceUrl);
    const sourceUrl = photoSwipeRemembered
      ? rememberedSourceUrl || containerSourceUrl
      : containerSourceUrl || rememberedSourceUrl;

    const authorLink = container ? findMisskeyAuthorLink(container) : undefined;

    const containerPosterName = extractMisskeyPoster(authorLink) || extractMisskeyPosterFromContainer(container);
    const posterName = photoSwipeRemembered?.posterName || containerPosterName || usableRemembered?.posterName;
    const artistTag = normalizeAdapterTag(posterName);
    const caption = photoSwipeRemembered?.caption || (container ? textOf(container) : usableRemembered?.caption || "");
    const hashtags = extractHashtags(caption);
    const sensitive =
      /sensitive|cw|content warning|nsfw/i.test(caption) ||
      Boolean(container?.querySelector("[class*='sensitive'], [aria-label*='sensitive' i], [class*='nsfw' i]"));
    const mediaSelection = selectMisskeyMedia(draft, target, container, usableRemembered);

    return {
      ...draft,
      site: "misskey",
      pageUrl: absoluteUrl(draft.pageUrl) || location.href,
      sourceUrl: sourceUrl || misskeyPostUrl(draft.sourceUrl) || misskeyPostUrl(location.href) || absoluteUrl(draft.sourceUrl) || location.href,
      mediaUrl: mediaSelection.mediaUrl,
      previewUrl: mediaSelection.previewUrl,
      posterName,
      artistTag: artistTag || draft.artistTag,
      caption,
      hashtags: [...new Set([...hashtags, ...(usableRemembered?.hashtags ?? [])])],
      seedTags: [...new Set([...hashtags, ...(usableRemembered?.hashtags ?? []), ...(usableRemembered?.seedTags ?? []), ...(draft.seedTags ?? [])])],
      rating: sensitive ? "questionable" : draft.rating
    };
  }
};

export function rememberMisskeyContextFromTarget(target: Element | undefined): ImportDraft | undefined {
  const targetMediaUrl = directElementUrl(target) || directElementUrl(activeMisskeyPhotoSwipeImage());
  const container = findMisskeyNoteContainer(target) || findMisskeyNoteContainerForMedia(targetMediaUrl);
  if (!container) return undefined;

  const baseDraft: ImportDraft = {
    pageUrl: location.href,
    sourceUrl: location.href,
    mediaUrl: targetMediaUrl,
    previewUrl: targetMediaUrl,
    site: "misskey"
  };
  const extracted = misskeyAdapter.extract(baseDraft, target);
  return isUsableMisskeyContext(extracted) ? extracted : undefined;
}

export function attachMisskeyRememberedContext(draft: ImportDraft, remembered: ImportDraft | undefined): ImportDraft {
  if (!remembered) return draft;
  return {
    ...draft,
    raw: {
      ...rawRecord(draft.raw),
      misskeyRememberedContext: remembered
    }
  };
}

export function isMisskeyPhotoSwipeTarget(target: Element | undefined): boolean {
  return Boolean(target?.closest(".pswp, .pswp__item, .pswp__zoom-wrap"));
}

export function activeMisskeyPhotoSwipeImage(): HTMLImageElement | undefined {
  const activeImages = Array.from(
    document.querySelectorAll<HTMLImageElement>(".pswp.pswp--open .pswp__item[aria-hidden='false'] .pswp__img")
  );
  const activeImage = bestVisiblePhotoSwipeImage(activeImages);
  if (activeImage) return activeImage;

  return bestVisiblePhotoSwipeImage(Array.from(document.querySelectorAll<HTMLImageElement>(".pswp.pswp--open .pswp__img")));
}

export function rememberedMisskeyContext(draft: ImportDraft): ImportDraft | undefined {
  const remembered = rawRecord(draft.raw).misskeyRememberedContext;
  return remembered && typeof remembered === "object" ? remembered as ImportDraft : undefined;
}

export function isUsableMisskeyContext(draft: ImportDraft | undefined): draft is ImportDraft {
  if (!draft) return false;
  return Boolean(
    misskeyPostUrl(draft.sourceUrl) ||
      draft.posterName?.trim() ||
      draft.artistTag?.trim() ||
      draft.caption?.trim() ||
      draft.hashtags?.length ||
      draft.seedTags?.length
  );
}

export function misskeyMediaUrlsMatch(left: string | undefined, right: string | undefined): boolean {
  return sameMisskeyMediaUrl(left, right);
}

function findMisskeyNoteContainer(target: Element | undefined): Element | undefined {
  if (!target) return findCurrentMisskeyNoteContainer();

  const candidates = [
    target.closest("article"),
    target.closest("[data-scroll-anchor], [tabindex][data-scroll-anchor]"),
    target.closest("[class*='SkNote-root'], [class*='MkNote-root'], [class*='Note-root'], [class*='note-root' i]"),
    closestPostContainer(target)
  ];

  for (const candidate of candidates) {
    const note = normalizeMisskeyNoteContainer(candidate ?? undefined);
    if (note) return note;
  }

  let current: Element | null = target;
  for (let depth = 0; current && depth < 12; depth += 1, current = current.parentElement) {
    const note = normalizeMisskeyNoteContainer(current);
    if (note) return note;
  }

  return undefined;
}

function findCurrentMisskeyNoteContainer(): Element | undefined {
  const photoSwipe = activeMisskeyPhotoSwipeImage();
  if (photoSwipe) return undefined;
  return (
    Array.from(document.querySelectorAll("article, [data-scroll-anchor], [class*='SkNote-root'], [class*='MkNote-root']")).find((element) =>
      hasMisskeyNoteLink(element)
    ) ?? undefined
  );
}

function normalizeMisskeyNoteContainer(candidate: Element | undefined): Element | undefined {
  if (!candidate) return undefined;
  if (hasMisskeyNoteLink(candidate)) return candidate;
  const article = candidate.querySelector("article");
  if (article && hasMisskeyNoteLink(article)) return article;
  return undefined;
}

function hasMisskeyNoteLink(element: Element | undefined): boolean {
  if (!element) return false;
  return Boolean(
    element.querySelector("a[href*='/notes/'], a[href*='/clips/'], [to^='/notes/'], [to^='/clips/']") ||
      misskeyPostUrl(element.getAttribute("to") ?? undefined)
  );
}

function findMisskeyNoteContainerForMedia(mediaUrl: string | undefined): Element | undefined {
  const canonicalMediaUrl = canonicalizeMisskeyMediaUrl(mediaUrl ?? "");
  if (!canonicalMediaUrl) return undefined;

  const containers = Array.from(
    document.querySelectorAll("article, [data-scroll-anchor], [class*='SkNote-root'], [class*='MkNote-root'], [class*='Note-root']")
  ).filter(hasMisskeyNoteLink);

  return containers.find((container) => {
    const mediaElements = Array.from(container.querySelectorAll("img, video, source, a[href]"));
    return mediaElements.some((element) => elementUrls(element).some((url) => sameMisskeyMediaUrl(url, canonicalMediaUrl)));
  });
}

function looksLikeMisskeyTarget(target: Element | undefined): boolean {
  return Boolean(
    target?.closest(
      "[class*='SkNote'], [class*='MkNote'], [class*='MkMedia'], [class*='Misskey'], [data-scroll-anchor]"
    )
  );
}

function shouldUseRememberedMisskeyContext(
  remembered: ImportDraft | undefined,
  currentMediaUrl: string | undefined,
  target: Element | undefined
): ImportDraft | undefined {
  if (!remembered) return undefined;
  if (!isUsableMisskeyContext(remembered)) return undefined;
  if (!isMisskeyPhotoSwipeTarget(target)) return remembered;
  if (!currentMediaUrl) return remembered;
  return rememberedMatchesMedia(remembered, currentMediaUrl) ? remembered : undefined;
}

function rememberedMatchesMedia(remembered: ImportDraft, mediaUrl: string): boolean {
  return [remembered.mediaUrl, remembered.previewUrl].some((candidate) => sameMisskeyMediaUrl(candidate, mediaUrl));
}

function selectMisskeyMedia(
  draft: ImportDraft,
  target: Element | undefined,
  container: Element | undefined,
  remembered: ImportDraft | undefined
): { mediaUrl?: string; previewUrl?: string } {
  const candidates = new Map<string, MisskeyMediaCandidate>();
  const activePreview = activeMisskeyPhotoSwipeImage();
  const photoSwipeTarget = isMisskeyPhotoSwipeTarget(target);
  const focusedMediaUrls = uniqueUrls([
    directElementUrl(target),
    draft.mediaUrl,
    draft.previewUrl,
    directElementUrl(activePreview)
  ]);
  const limitContainerToFocusedMedia = Boolean(focusedMediaUrls.length && (photoSwipeTarget || isMediaTarget(target) || draft.mediaUrl || draft.previewUrl));

  const addCandidate = (url: string | undefined, source: string, score: number, element?: Element, previewUrl?: string) => {
    const originalUrl = absoluteUrl(url);
    if (!originalUrl) return;
    const canonicalUrl = canonicalizeMisskeyMediaUrl(originalUrl);
    if (!canonicalUrl) return;
    const accepted = isAcceptedMisskeyMediaUrl(canonicalUrl, originalUrl, element);
    const candidate: MisskeyMediaCandidate = {
      originalUrl,
      canonicalUrl,
      importUrl: misskeyImportUrl(originalUrl, canonicalUrl),
      previewUrl: absoluteUrl(previewUrl) || originalUrl,
      source,
      score: score + mediaQualityScore(canonicalUrl, originalUrl, element),
      accepted,
      element
    };
    const previous = candidates.get(canonicalUrl);
    if (!previous || candidateRank(candidate) > candidateRank(previous)) {
      candidates.set(canonicalUrl, candidate);
    }
  };

  addCandidate(draft.sourceUrl, "context-menu source media url", photoSwipeTarget ? 7900 : 6700, target, draft.previewUrl);
  for (const url of rawMisskeyMediaUrls(draft.raw)) {
    addCandidate(url, "context-menu raw media url", photoSwipeTarget ? 8200 : 7100, target, draft.previewUrl);
  }
  addCandidate(draft.mediaUrl, "context-menu media url", photoSwipeTarget ? 6200 : 5000, target, draft.previewUrl);
  addCandidate(draft.previewUrl, "context-menu preview url", photoSwipeTarget ? 6100 : 4300, target, draft.previewUrl);
  addElementCandidates(target, "right-click target", photoSwipeTarget ? 7000 : 4900);
  addCandidate(target?.closest<HTMLAnchorElement>("a[href]")?.href, "right-click media link", photoSwipeTarget ? 7800 : 6600, target);
  addElementCandidates(activePreview, "PhotoSwipe active image", photoSwipeTarget ? 6800 : 4800);

  addCandidate(remembered?.mediaUrl, "remembered Misskey note media", 4700, undefined, remembered?.previewUrl);
  addCandidate(remembered?.previewUrl, "remembered Misskey note preview", 4200, undefined, remembered?.previewUrl);

  container?.querySelectorAll<HTMLElement>(
    ".image a[href], [data-id] a[href], a[href*='/files/'], a[href*='/proxy/'], a[href*='url='], img[src], video[src], video source[src]"
  ).forEach((element) => {
    if (limitContainerToFocusedMedia && !elementMatchesFocusedMedia(element, focusedMediaUrls, target)) return;

    if (element instanceof HTMLAnchorElement) {
      addCandidate(element.href, "Misskey note media link", 5400, element);
      const nestedImage = element.querySelector<HTMLImageElement>("img[src]");
      addElementCandidates(nestedImage ?? undefined, "Misskey linked preview image", 3600, element.href);
      return;
    }
    addElementCandidates(element, "Misskey note media element", 4300);
  });

  const selected = Array.from(candidates.values())
    .filter((candidate) => candidate.accepted)
    .sort((a, b) => candidateRank(b) - candidateRank(a))[0];

  return {
    mediaUrl: selected?.importUrl || remembered?.mediaUrl || absoluteUrl(draft.mediaUrl),
    previewUrl: selected?.previewUrl || remembered?.previewUrl || absoluteUrl(draft.previewUrl) || selected?.canonicalUrl
  };

  function addElementCandidates(element: Element | undefined, source: string, score: number, previewUrl?: string): void {
    if (!element) return;
    const urls = elementUrls(element);
    if (!urls.length) {
      addCandidate(directElementUrl(element), source, score, element, previewUrl);
      return;
    }

    for (const url of urls) {
      addCandidate(url, source, score, element, previewUrl);
    }

    if (element instanceof HTMLImageElement) {
      addCandidate(element.getAttribute("data-original") ?? undefined, `${source} data-original`, score + 700, element, previewUrl);
      addCandidate(element.getAttribute("data-url") ?? undefined, `${source} data-url`, score + 700, element, previewUrl);
      addCandidate(bestSrcsetUrl(element.getAttribute("srcset")), `${source} srcset`, score + 350, element, previewUrl);
    }
  }
}

function isMediaTarget(element: Element | undefined): boolean {
  if (!element) return false;
  if (element instanceof HTMLImageElement || element instanceof HTMLVideoElement || element instanceof HTMLSourceElement) return true;
  return Boolean(element.closest("img, video, source"));
}

function rawMisskeyMediaUrls(raw: unknown): string[] {
  const urls: string[] = [];
  const seenObjects = new Set<object>();

  const visit = (value: unknown) => {
    if (!value || typeof value !== "object" || seenObjects.has(value)) return;
    seenObjects.add(value);

    const record = value as Record<string, unknown>;
    for (const key of ["linkUrl", "srcUrl", "mediaUrl", "previewUrl"]) {
      const url = typeof record[key] === "string" ? record[key] : undefined;
      if (url && isAcceptedRawMisskeyMediaUrl(url)) urls.push(url);
    }

    for (const child of Object.values(record)) {
      visit(child);
    }
  };

  visit(raw);
  return uniqueUrls(urls);
}

function isAcceptedRawMisskeyMediaUrl(value: string): boolean {
  const canonical = canonicalizeMisskeyMediaUrl(value);
  return Boolean(canonical && isAcceptedMisskeyMediaUrl(canonical, value, undefined));
}

function elementMatchesFocusedMedia(element: Element, mediaUrls: string[], target: Element | undefined): boolean {
  if (target && (element === target || element.contains(target))) return true;
  return mediaUrls.some((mediaUrl) => elementMediaUrls(element).some((candidate) => sameMisskeyMediaUrl(candidate, mediaUrl)));
}

function elementMediaUrls(element: Element): string[] {
  const urls: string[] = [];
  const add = (value: string | undefined | null) => {
    const url = absoluteUrl(value);
    if (url) urls.push(url);
  };
  const collect = (candidate: Element) => {
    for (const url of elementUrls(candidate)) add(url);
    if (candidate instanceof HTMLAnchorElement) add(candidate.href);
    if (candidate instanceof HTMLImageElement) {
      add(candidate.getAttribute("data-original"));
      add(candidate.getAttribute("data-url"));
      add(bestSrcsetUrl(candidate.getAttribute("srcset")));
    }
  };

  collect(element);
  element.querySelectorAll("img, video, source, a[href]").forEach(collect);
  return uniqueUrls(urls);
}

function directElementUrl(element: Element | undefined): string | undefined {
  if (!element) return undefined;
  if (element instanceof HTMLImageElement) return absoluteUrl(element.currentSrc || element.src);
  if (element instanceof HTMLVideoElement) return absoluteUrl(element.currentSrc || element.src || element.querySelector("source")?.src || element.poster);
  if (element instanceof HTMLSourceElement) return absoluteUrl(element.src);
  if (element instanceof HTMLAnchorElement) return absoluteUrl(element.href);
  const media = element.querySelector<HTMLImageElement | HTMLVideoElement>("img, video");
  return directElementUrl(media ?? undefined);
}

function bestVisiblePhotoSwipeImage(images: HTMLImageElement[]): HTMLImageElement | undefined {
  return images
    .map((image) => ({ image, score: photoSwipeVisibilityScore(image) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.image;
}

function photoSwipeVisibilityScore(image: HTMLImageElement): number {
  const item = image.closest(".pswp__item");
  if (item?.getAttribute("aria-hidden") === "true") return 0;
  const rect = image.getBoundingClientRect();
  if (rect.width <= 1 || rect.height <= 1) return 0;
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  const visibleWidth = Math.max(0, Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0));
  const visibleHeight = Math.max(0, Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0));
  const visibleArea = visibleWidth * visibleHeight;
  if (visibleArea <= 0) return 0;
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const distanceFromViewportCenter = Math.hypot(centerX - viewportWidth / 2, centerY - viewportHeight / 2);
  return visibleArea - distanceFromViewportCenter;
}

function canonicalizeMisskeyMediaUrl(value: string): string | undefined {
  const absolute = absoluteUrl(value);
  if (!absolute) return undefined;
  if (isDecorativeMisskeyUrl(absolute)) return undefined;

  try {
    const url = new URL(absolute);
    const proxied = url.searchParams.get("url");
    if (proxied && !isDecorativeMisskeyUrl(absolute)) {
      const decoded = absoluteUrl(proxied, absolute);
      if (decoded && isLikelyImportableMediaUrl(decoded)) return decoded;
    }
    return absolute;
  } catch {
    return absolute;
  }
}

function misskeyImportUrl(originalUrl: string, canonicalUrl: string): string {
  if (originalUrl === canonicalUrl) return canonicalUrl;

  try {
    const fullProxy = misskeyFullProxyUrl(originalUrl);
    if (fullProxy) return fullProxy;

    const original = new URL(originalUrl);
    if (original.origin === location.origin && !isMisskeyThumbnailUrl(originalUrl)) return originalUrl;
  } catch {
    // Fall back to the canonical URL.
  }

  return canonicalUrl;
}

function misskeyFullProxyUrl(value: string): string | undefined {
  try {
    const url = new URL(value, location.href);
    if (url.origin !== location.origin || !url.searchParams.has("url")) return undefined;

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

    return url.href !== before || isMisskeyThumbnailUrl(value) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function isAcceptedMisskeyMediaUrl(canonicalUrl: string, originalUrl: string, element: Element | undefined): boolean {
  if (isDecorativeMisskeyUrl(originalUrl) || isDecorativeMisskeyUrl(canonicalUrl)) return false;
  if (isDecorativeMisskeyElement(element)) return false;
  return isLikelyImportableMediaUrl(canonicalUrl) || /\/files\//.test(new URL(canonicalUrl, location.href).pathname);
}

function bestSrcsetUrl(srcset: string | null): string | undefined {
  if (!srcset) return undefined;
  return srcset
    .split(",")
    .map((entry) => entry.trim().split(/\s+/)[0])
    .filter(Boolean)
    .pop();
}

function uniqueUrls(values: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const url = absoluteUrl(value);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    result.push(url);
  }

  return result;
}

function sameMisskeyMediaUrl(left: string | undefined, right: string | undefined): boolean {
  const leftCanonical = canonicalizeMisskeyMediaUrl(left ?? "");
  const rightCanonical = canonicalizeMisskeyMediaUrl(right ?? "");
  if (!leftCanonical || !rightCanonical) return false;
  if (leftCanonical === rightCanonical) return true;

  try {
    const leftUrl = new URL(leftCanonical, location.href);
    const rightUrl = new URL(rightCanonical, location.href);
    if (leftUrl.hostname === rightUrl.hostname && leftUrl.pathname === rightUrl.pathname) return true;

    const leftIdentity = misskeyMediaIdentity(leftUrl);
    const rightIdentity = misskeyMediaIdentity(rightUrl);
    return Boolean(leftIdentity && rightIdentity && leftIdentity === rightIdentity);
  } catch {
    return false;
  }
}

function misskeyMediaIdentity(url: URL): string | undefined {
  const file = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "");
  const key = file
    .replace(/^(?:original|webpublic|thumbnail|preview)-/i, "")
    .replace(/\.(?:jpe?g|png|webp|gif|avif)$/i, "");

  return key.length >= 10 ? `${url.hostname}/${key}` : undefined;
}

function isLikelyImportableMediaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return /\.(jpe?g|png|webp|gif|mp4|webm)(\?|#|$)/i.test(url.pathname) || /\/files\//.test(url.pathname);
  } catch {
    return false;
  }
}

function isDecorativeMisskeyUrl(value: string): boolean {
  try {
    const url = new URL(value, location.href);
    const path = url.pathname.toLowerCase();
    return (
      path.includes("/twemoji/") ||
      path.includes("/proxy/avatar") ||
      path.includes("/avadeco/") ||
      url.searchParams.get("avatar") === "1" ||
      url.searchParams.get("emoji") === "1"
    );
  } catch {
    return false;
  }
}

function isDecorativeMisskeyElement(element: Element | undefined): boolean {
  return Boolean(
    element?.closest(
      "header, footer, button, [class*='avatar' i], [class*='reaction' i], [class*='emoji' i], [class*='avadeco' i]"
    )
  );
}

function mediaQualityScore(canonicalUrl: string, originalUrl: string, element: Element | undefined): number {
  let score = 0;
  try {
    const canonical = new URL(canonicalUrl);
    const original = new URL(originalUrl);
    if (canonical.href !== original.href) score += 600;
    if (original.origin === location.origin && !isMisskeyThumbnailUrl(originalUrl)) score += 1400;
    if (/\/original\//i.test(canonical.pathname)) score += 900;
    if (canonical.pathname.includes("/files/webpublic-")) score += 1600;
    if (isMisskeyThumbnailUrl(canonicalUrl) || isMisskeyThumbnailUrl(originalUrl)) score -= 5200;
  } catch {
    // Keep the base score.
  }

  if (element instanceof HTMLImageElement) {
    const width = element.naturalWidth || element.width || 0;
    const height = element.naturalHeight || element.height || 0;
    score += Math.min(500, Math.round((width * height) / 5000));
  }

  return score;
}

function isMisskeyThumbnailUrl(value: string): boolean {
  try {
    const url = new URL(value, location.href);
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

function candidateRank(candidate: MisskeyMediaCandidate): number {
  return candidate.score + (candidate.accepted ? 10000 : 0);
}

function misskeyPostUrl(value: string | undefined): string | undefined {
  const absolute = absoluteUrl(value);
  if (!absolute) return undefined;
  try {
    const url = new URL(absolute);
    return MISSKEY_POST_PATH_RE.test(url.pathname) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function misskeyNoteUrlFromElement(element: Element | undefined): string | undefined {
  const postElement = element?.closest("[to^='/notes/'], [to^='/clips/']") ?? element?.querySelector("[to^='/notes/'], [to^='/clips/']");
  const postTarget = postElement?.getAttribute("to")?.trim();
  const postUrl = misskeyPostUrl(postTarget);
  if (postUrl) return postUrl;

  const noteRoot = element?.closest("[data-scroll-anchor]") ?? element?.querySelector("[data-scroll-anchor]");
  const noteId = noteRoot?.getAttribute("data-scroll-anchor")?.trim();
  if (!noteId || !/^[A-Za-z0-9_-]{6,}$/.test(noteId)) return undefined;
  return absoluteUrl(`/notes/${noteId}`, location.origin);
}

function rawRecord(raw: unknown): Record<string, unknown> & MisskeyRememberedRaw {
  return raw && typeof raw === "object" ? raw as Record<string, unknown> & MisskeyRememberedRaw : {};
}

function findMisskeyAuthorLink(container: Element): HTMLAnchorElement | undefined {
  const authorSelectors = [
    "header a[href^='/@']",
    "header a[href*='/@']",
    "[class*='Header'] a[href^='/@']",
    "[class*='Header'] a[href*='/@']",
    "[class*='avatar' i][href^='/@']",
    "a[href^='/@']",
    "a[href*='/@']"
  ];

  for (const selector of authorSelectors) {
    const anchor = container.querySelector<HTMLAnchorElement>(selector);
    if (anchor && extractMisskeyPoster(anchor)) return anchor;
  }

  return findFirstLink(container, (_href, anchor) => /(^|\/)@[^/]+/.test(anchor.getAttribute("href") ?? "")) ??
    findFirstLink(container, (_href, anchor) => /^@?[\w.-]+(@[\w.-]+)?$/.test(anchor.textContent?.trim() ?? ""));
}

function extractMisskeyPoster(anchor: HTMLAnchorElement | undefined): string | undefined {
  if (!anchor) return undefined;
  const href = anchor.getAttribute("href") ?? "";
  const hrefMatch = href.match(/\/@([^/?#]+)/);
  if (hrefMatch?.[1]) return hrefMatch[1];
  const textMatch = anchor.textContent?.trim().match(/@?([\w.-]+)(?:@[\w.-]+)?/);
  return textMatch?.[1];
}

function extractMisskeyPosterFromContainer(container: Element | undefined): string | undefined {
  if (!container) return undefined;
  const usernameText =
    container.querySelector("[class*='username' i]")?.textContent?.trim() ||
    container.querySelector("[class*='userName' i]")?.textContent?.trim();
  const usernameMatch = usernameText?.match(/@?([\w.-]+(?:@[\w.-]+)?)/);
  if (usernameMatch?.[1]) return usernameMatch[1];

  const avatarTitle = container.querySelector("[class*='avatar' i][title]")?.getAttribute("title")?.trim();
  return avatarTitle || undefined;
}
