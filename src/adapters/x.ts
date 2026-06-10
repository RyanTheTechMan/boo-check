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

export type XMediaCandidate = {
  originalUrl: string;
  canonicalUrl: string;
  source: string;
  score: number;
  accepted: boolean;
  selected?: boolean;
  rejectionReason?: string;
  element?: Element;
  width?: number;
  height?: number;
  twimgKind?: string;
  twimgNameParamBefore?: string;
  twimgNameParamAfter?: string;
};

export type XMediaSelection = {
  selected?: XMediaCandidate;
  candidates: XMediaCandidate[];
  notes: string[];
  statusLinks: string[];
  photoLinks: string[];
  parsedStatus?: { username: string; statusId: string };
};

export const xAdapter: SiteAdapter = {
  detect(draft: ImportDraft, target?: Element): boolean {
    const host = location.hostname.replace(/^www\./, "");
    if (host === "x.com" || host === "twitter.com" || draft.pageUrl?.includes("/status/")) return true;
    const container = closestPostContainer(target);
    return Boolean(container?.querySelector("a[href*='/status/']"));
  },

  extract(draft: ImportDraft, target?: Element): ImportDraft {
    const container = findXPostContainer(draft, target);
    const statusLink =
      container === document.body
        ? undefined
        : findFirstLink(container, (href) => /\/[^/]+\/status\/\d+/.test(new URL(href).pathname));
    const canonicalStatus = document.querySelector<HTMLLinkElement>("link[rel='canonical']")?.href;
    const parsedStatus =
      parseTwitterStatusUrl(draft.sourceUrl || "") ||
      parseTwitterStatusUrl(statusLink?.href || "") ||
      parseTwitterStatusUrl(canonicalStatus || "") ||
      parseTwitterStatusUrl(draft.pageUrl || location.href);
    const handle = parsedStatus?.username || extractHandle(container);
    const sourceUrl = parsedStatus ? twitterStatusUrl(parsedStatus) : canonicalizeTwitterSourceUrl(statusLink?.href || draft.sourceUrl || location.href);
    const mediaSelection = selectXMedia(draft, target, container);
    const directMediaUrl = directContextMediaUrl(draft, target);
    const containsVideo = hasXVideo(target, container);
    const mediaUrl =
      directMediaUrl ??
      (containsVideo && mediaSelection.selected?.twimgKind !== "twitter_video_mp4"
        ? undefined
        : mediaSelection.selected?.canonicalUrl);
    const previewUrl = mediaUrl || findXPreviewUrl(target, container) || absoluteUrl(draft.previewUrl);
    const caption = extractTweetCaption(container);
    const hashtags = extractHashtags(caption);

    return {
      ...draft,
      site: "x",
      pageUrl: absoluteUrl(draft.pageUrl) || location.href,
      sourceUrl,
      mediaUrl,
      previewUrl,
      posterName: handle,
      artistTag: normalizeAdapterTag(handle) || draft.artistTag,
      caption,
      hashtags,
      seedTags: [...hashtags, ...(draft.seedTags ?? [])]
    };
  }
};

function hasXVideo(target: Element | undefined, container: Element): boolean {
  return Boolean(
    target?.closest("[data-testid='videoPlayer']") ||
      container.querySelector("[data-testid='videoPlayer'] video, video") ||
      /\/status\/\d+\/video\/\d+/.test(location.pathname)
  );
}

function extractTweetCaption(container: Element): string {
  const tweetText = container.querySelector("[data-testid='tweetText']");
  if (tweetText) return textOf(tweetText);
  if (container === document.body) return "";
  return textOf(container);
}

export function selectXMedia(
  draft: ImportDraft,
  target: Element | undefined,
  container = findXPostContainer(draft, target)
): XMediaSelection {
  const candidates = new Map<string, XMediaCandidate>();
  const notes: string[] = [];
  const statusLinks = collectLinks(container, /\/[^/]+\/status\/\d+/);
  const photoLinks = collectLinks(container, /\/[^/]+\/status\/\d+\/photo\/\d+/);
  const parsedStatus = parseTwitterStatusUrl(statusLinks[0] || draft.sourceUrl || draft.pageUrl || location.href);
  const videoElements = Array.from(container.querySelectorAll<HTMLVideoElement>("[data-testid='videoPlayer'] video, video"));
  const videoPosterIds = new Set(videoElements.flatMap((video) => extractTwitterVideoIdsFromPoster(video.poster)));

  const addCandidate = (
    url: string | undefined,
    source: string,
    score: number,
    element?: Element,
    options: {
      explicit?: boolean;
      forceRejectReason?: string;
      width?: number;
      height?: number;
    } = {}
  ) => {
    const originalUrl = absoluteUrl(url);
    if (!originalUrl) return;

    const canonicalUrl = canonicalizeTwitterMediaUrl(originalUrl);
    const twimgInfo = inspectTwitterImageUrl(originalUrl, canonicalUrl);
    const accepted =
      !options.forceRejectReason &&
      (isAcceptedAutomaticKind(twimgInfo.kind) || Boolean(options.explicit && isExplicitImportableUrl(originalUrl, twimgInfo.kind)));
    const rejectionReason = options.forceRejectReason || (accepted ? undefined : rejectionReasonForTwimgKind(twimgInfo.kind));
    const key = canonicalUrl;
    const elementDimensions = dimensionsForElement(element);
    const urlDimensions = dimensionsFromTwitterVideoUrl(canonicalUrl);
    const next: XMediaCandidate = {
      originalUrl,
      canonicalUrl,
      source,
      score,
      accepted,
      rejectionReason,
      element,
      width: options.width ?? elementDimensions.width ?? urlDimensions.width,
      height: options.height ?? elementDimensions.height ?? urlDimensions.height,
      twimgKind: twimgInfo.kind,
      twimgNameParamBefore: twimgInfo.nameBefore,
      twimgNameParamAfter: twimgInfo.nameAfter
    };
    const previous = candidates.get(key);
    if (!previous || candidateRank(next) > candidateRank(previous)) {
      candidates.set(key, next);
    }
  };

  for (const url of [draft.mediaUrl, draft.previewUrl]) {
    addCandidate(url, "context-menu media url", 5000, target, {
      explicit: Boolean(draft.mediaUrl),
      forceRejectReason: isKnownVideoPosterUrl(url, videoElements) ? "video poster thumbnail ignored while looking for the real video" : undefined
    });
  }

  addElementUrls(target, "right-click target", 4900, { explicit: isDirectMediaElement(target) });

  for (const video of videoElements) {
    addVideoElementUrls(video, "tweet video element", 1250);
  }

  for (const resource of collectTwitterVideoResources(videoPosterIds)) {
    addCandidate(resource.url, resource.source, resource.score, undefined, {
      width: resource.width,
      height: resource.height
    });
  }

  if (isXPhotoRoute(draft.sourceUrl || draft.pageUrl || location.href)) {
    const viewer = findXPhotoViewer(target);
    viewer?.querySelectorAll("img[src*='pbs.twimg.com/media'], [data-testid='tweetPhoto'] img").forEach((element) => {
      addElementUrls(element, "X photo viewer media", 4800);
    });
  }

  container.querySelectorAll("[data-testid='tweetPhoto'] img, [data-testid='tweetPhoto'] video").forEach((element) => {
    addElementUrls(element, "tweetPhoto media", 900);
  });

  container.querySelectorAll("a[href*='/photo/'] img, a[href*='/photo/'] video").forEach((element) => {
    addElementUrls(element, "status photo link media", 875);
  });

  container.querySelectorAll("img, video, source").forEach((element) => {
    const source = isAvatarLike(element) ? "automatic avatar/profile candidate" : "automatic container media candidate";
    addElementUrls(element, source, source === "automatic avatar/profile candidate" ? 200 : 700);
  });

  const ordered = Array.from(candidates.values()).sort((a, b) => candidateRank(b) - candidateRank(a));
  const selected = ordered.find((candidate) => candidate.accepted);
  if (selected) {
    selected.selected = true;
    notes.push(`Selected ${selected.canonicalUrl} from ${selected.source}.`);
  } else if (videoElements.length) {
    notes.push("X video was detected, but no importable video.twimg.com MP4 resource was found. Poster thumbnails were ignored.");
  } else if (ordered.length) {
    notes.push("No acceptable X tweet media candidate was found. Profile/sidebar/card images were ignored.");
  } else {
    notes.push("No X media candidates were found near the right-click target.");
  }

  return {
    selected,
    candidates: ordered,
    notes,
    statusLinks,
    photoLinks,
    parsedStatus
  };

  function addElementUrls(
    element: Element | undefined,
    source: string,
    score: number,
    options: { explicit?: boolean } = {}
  ): void {
    if (!element) return;
    if (element instanceof HTMLVideoElement) {
      addVideoElementUrls(element, source, score, options.explicit);
      return;
    }
    for (const url of elementUrls(element)) addCandidate(url, source, score, element, options);
  }

  function addVideoElementUrls(video: HTMLVideoElement, source: string, score: number, explicit = false): void {
    const sourceUrls = new Set<string>();
    const addSource = (value: string | undefined | null) => {
      const url = absoluteUrl(value);
      if (url) sourceUrls.add(url);
    };

    addSource(video.currentSrc);
    addSource(video.src);
    video.querySelectorAll<HTMLSourceElement>("source").forEach((sourceElement) => addSource(sourceElement.src));

    for (const url of sourceUrls) {
      addCandidate(url, `${source} source`, score, video, { explicit });
    }

    addCandidate(video.poster, `${source} poster thumbnail`, score - 300, video, {
      forceRejectReason: "video poster thumbnail ignored while looking for the real video"
    });
  }
}

function findXPreviewUrl(target: Element | undefined, container: Element): string | undefined {
  const video =
    target?.closest("[data-testid='videoPlayer']")?.querySelector<HTMLVideoElement>("video") ??
    container.querySelector<HTMLVideoElement>("[data-testid='videoPlayer'] video, video");
  if (video?.poster) return absoluteUrl(video.poster);
  return absoluteUrl(target instanceof HTMLImageElement ? target.currentSrc || target.src : undefined);
}

export function findXPostContainer(draft: ImportDraft, target?: Element): Element {
  const nearest = closestPostContainer(target);
  if (nearest) return nearest;

  const canonicalStatus = document.querySelector<HTMLLinkElement>("link[rel='canonical']")?.href;
  const parsedStatus = parseTwitterStatusUrl(draft.sourceUrl || "") || parseTwitterStatusUrl(draft.pageUrl || "") || parseTwitterStatusUrl(canonicalStatus || "") || parseTwitterStatusUrl(location.href);
  if (parsedStatus) {
    const matchingAnchor = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href*='/status/']")).find((anchor) => {
      const parsed = parseTwitterStatusUrl(anchor.href);
      return parsed?.statusId === parsedStatus.statusId && parsed.username.toLowerCase() === parsedStatus.username.toLowerCase();
    });
    const container = closestPostContainer(matchingAnchor);
    if (container) return container;
  }

  return document.body;
}

function directContextMediaUrl(draft: ImportDraft, target?: Element): string | undefined {
  const url = absoluteUrl(draft.mediaUrl);
  if (!url) return undefined;

  const canonicalUrl = canonicalizeTwitterMediaUrl(url);
  const kind = inspectTwitterImageUrl(url, canonicalUrl).kind;
  const isDirectImageClick = target instanceof HTMLImageElement || target?.querySelector("img");
  const isContextMenuMedia = Boolean(draft.mediaUrl);

  if (!isContextMenuMedia) return undefined;
  if (kind === "media" || kind === "twitter_video_mp4") return canonicalUrl;
  if ((kind === "profile_image" || kind === "profile_banner") && isDirectImageClick) return canonicalUrl;

  return undefined;
}

export function parseTwitterStatusUrl(value: string): { username: string; statusId: string } | undefined {
  const absolute = absoluteUrl(value);
  if (!absolute) return undefined;
  try {
    const url = new URL(absolute);
    const match = url.pathname.match(/^\/([^/]+)\/status\/(\d+)/);
    if (!match) return undefined;
    return { username: match[1], statusId: match[2] };
  } catch {
    return undefined;
  }
}

function twitterStatusUrl(status: { username: string; statusId: string }): string {
  return `https://x.com/${status.username}/status/${status.statusId}`;
}

function canonicalizeTwitterSourceUrl(value: string | undefined): string {
  const parsed = parseTwitterStatusUrl(value || "");
  if (parsed) return twitterStatusUrl(parsed);
  return absoluteUrl(value) || location.href;
}

function extractHandle(container: Element): string | undefined {
  const text = textOf(container);
  const match = text.match(/@([A-Za-z0-9_]{1,20})/);
  return match?.[1];
}

export function canonicalizeTwitterMediaUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.hostname !== "pbs.twimg.com") return value;
    if (!url.pathname.includes("/media/")) return value;
    url.searchParams.set("name", "orig");
    return url.href;
  } catch {
    return value;
  }
}

function isAcceptedAutomaticKind(kind: string): boolean {
  return kind === "media" || kind === "twitter_video_mp4";
}

function isExplicitImportableUrl(value: string, kind: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (kind === "x_asset" || kind === "twitter_video_playlist" || kind === "twitter_video_segment") return false;
    return (
      kind === "media" ||
      kind === "profile_image" ||
      kind === "profile_banner" ||
      kind === "twitter_video_mp4" ||
      /\.(jpe?g|png|webp|gif|mp4|webm)(\?|#|$)/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function collectLinks(container: ParentNode, pathPattern: RegExp): string[] {
  const urls = new Set<string>();
  container.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((anchor) => {
    const href = absoluteUrl(anchor.getAttribute("href"));
    if (!href) return;
    try {
      const url = new URL(href);
      if (pathPattern.test(url.pathname)) urls.add(url.href);
    } catch {
      // Ignore malformed candidate links.
    }
  });
  return Array.from(urls).slice(0, 40);
}

function candidateRank(candidate: XMediaCandidate): number {
  return candidate.score + (candidate.accepted ? 10000 : 0);
}

function dimensionsForElement(element: Element | undefined): Pick<XMediaCandidate, "width" | "height"> {
  if (element instanceof HTMLImageElement) {
    const width = element.naturalWidth || element.width || undefined;
    const height = element.naturalHeight || element.height || undefined;
    return { width, height };
  }

  if (element instanceof HTMLVideoElement) {
    const width = element.videoWidth || element.clientWidth || undefined;
    const height = element.videoHeight || element.clientHeight || undefined;
    return { width, height };
  }

  return {};
}

function dimensionsFromTwitterVideoUrl(value: string): Pick<XMediaCandidate, "width" | "height"> {
  try {
    const match = new URL(value).pathname.match(/\/(\d{2,5})x(\d{2,5})\//);
    if (!match) return {};
    return { width: Number(match[1]), height: Number(match[2]) };
  } catch {
    return {};
  }
}

function isAvatarLike(element: Element): boolean {
  return Boolean(
    element.closest(
      "[data-testid^='UserAvatar-Container'], [data-testid='Tweet-User-Avatar'], [data-testid='UserAvatar'], [aria-label*='profile picture' i]"
    )
  );
}

function isDirectMediaElement(element: Element | undefined): boolean {
  if (!element) return false;
  if (element instanceof HTMLImageElement || element instanceof HTMLVideoElement || element instanceof HTMLSourceElement) return true;
  if (element instanceof HTMLAnchorElement) return elementUrls(element).some(isLikelyMediaHref);
  return false;
}

function isLikelyMediaHref(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.hostname === "pbs.twimg.com" ||
      url.hostname === "video.twimg.com" ||
      url.hostname.endsWith("twimg.com") ||
      /\.(jpe?g|png|webp|gif|mp4|webm)(\?|#|$)/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function isXPhotoRoute(value: string): boolean {
  try {
    return /\/[^/]+\/status\/\d+\/photo\/\d+/.test(new URL(value, location.href).pathname);
  } catch {
    return false;
  }
}

function findXPhotoViewer(target: Element | undefined): Element | undefined {
  return (
    target?.closest("[role='dialog'], [aria-modal='true'], [data-testid='swipe-to-dismiss']") ??
    document.querySelector("[role='dialog'], [aria-modal='true'], [data-testid='swipe-to-dismiss']") ??
    undefined
  );
}

function inspectTwitterImageUrl(originalUrl: string, canonicalUrl: string): { kind: string; nameBefore?: string; nameAfter?: string } {
  try {
    const original = new URL(originalUrl);
    const canonical = new URL(canonicalUrl);
    if (original.protocol === "blob:") return { kind: "blob_video" };
    if (original.hostname === "video.twimg.com") {
      if (/\.mp4$/i.test(original.pathname)) return { kind: "twitter_video_mp4" };
      if (/\.m3u8$/i.test(original.pathname)) return { kind: "twitter_video_playlist" };
      if (/\.(m4s|ts)$/i.test(original.pathname)) return { kind: "twitter_video_segment" };
      return { kind: "twitter_video_other" };
    }
    if (original.hostname === "pbs.twimg.com") {
      if (original.pathname.startsWith("/media/")) {
        return {
          kind: "media",
          nameBefore: original.searchParams.get("name") || undefined,
          nameAfter: canonical.searchParams.get("name") || undefined
        };
      }
      if (original.pathname.startsWith("/profile_images/")) return { kind: "profile_image" };
      if (original.pathname.startsWith("/profile_banners/")) return { kind: "profile_banner" };
      if (original.pathname.startsWith("/commerce_product_img/")) return { kind: "commerce_product" };
      return { kind: "pbs_other" };
    }
    if (original.hostname === "abs.twimg.com") return { kind: "x_asset" };
    if (original.hostname.endsWith("twimg.com")) return { kind: "twimg_other" };
    return { kind: "other" };
  } catch {
    return { kind: "invalid" };
  }
}

function rejectionReasonForTwimgKind(kind: string): string {
  if (kind === "profile_image" || kind === "profile_banner") return "profile or avatar image ignored for automatic X extraction";
  if (kind === "x_asset") return "X interface asset ignored";
  if (kind === "commerce_product") return "commerce/card image ignored for automatic X extraction";
  if (kind === "blob_video") return "blob video URL cannot be fetched from the side panel";
  if (kind === "twitter_video_playlist") return "HLS playlist found, but Boo Check needs a single importable video file";
  if (kind === "twitter_video_segment") return "video segment ignored; Boo Check needs a complete video file";
  if (kind === "twitter_video_other") return "unknown Twitter video resource";
  if (kind === "other" || kind === "twimg_other" || kind === "pbs_other") return "not a tweet media URL";
  if (kind === "invalid") return "invalid media URL";
  return "not an automatic X tweet media candidate";
}

function extractTwitterVideoIdsFromPoster(value: string | undefined | null): string[] {
  const absolute = absoluteUrl(value);
  if (!absolute) return [];
  try {
    const pathname = new URL(absolute).pathname;
    const matches = [
      pathname.match(/\/amplify_video_thumb\/([^/]+)/),
      pathname.match(/\/ext_tw_video_thumb\/([^/]+)/),
      pathname.match(/\/tweet_video_thumb\/([^/.]+)/)
    ];
    return matches.map((match) => match?.[1]).filter((id): id is string => Boolean(id));
  } catch {
    return [];
  }
}

function isKnownVideoPosterUrl(value: string | undefined, videos: HTMLVideoElement[]): boolean {
  const url = absoluteUrl(value);
  if (!url) return false;
  return videos.some((video) => absoluteUrl(video.poster) === url);
}

function collectTwitterVideoResources(videoIds: Set<string>): Array<{
  url: string;
  source: string;
  score: number;
  width?: number;
  height?: number;
}> {
  const urls = new Map<string, { url: string; source: string; score: number; width?: number; height?: number }>();

  for (const entry of performance.getEntriesByType("resource")) {
    const url = absoluteUrl(entry.name);
    if (!url) continue;

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }

    if (parsed.hostname !== "video.twimg.com") continue;
    const kind = inspectTwitterImageUrl(url, url).kind;
    const dimensions = dimensionsFromTwitterVideoUrl(url);
    const matchesKnownVideo = Array.from(videoIds).some((id) => parsed.pathname.includes(`/${id}/`) || parsed.pathname.includes(`/${id}.`));
    const areaScore = dimensions.width && dimensions.height ? Math.min(600, Math.round((dimensions.width * dimensions.height) / 2500)) : 0;
    const kindScore = kind === "twitter_video_mp4" ? 1500 : kind === "twitter_video_playlist" ? 500 : 250;
    const score = kindScore + (matchesKnownVideo ? 800 : 0) + areaScore;

    urls.set(url, {
      url,
      source: matchesKnownVideo ? "matching X video performance resource" : "X video performance resource",
      score,
      ...dimensions
    });
  }

  return Array.from(urls.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 80);
}
