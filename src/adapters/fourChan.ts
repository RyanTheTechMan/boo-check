import type { ImportDraft } from "../types";
import {
  absoluteUrl,
  mediaUrlFromElement,
  previewUrlFromElement
} from "../utils/domExtract";
import type { SiteAdapter } from ".";

const FOUR_CHAN_BOARD_HOSTS = new Set(["boards.4chan.org", "boards.4channel.org"]);
const FOUR_CHAN_CDN_HOST_RE = /(^|\.)4cdn\.org$/i;

export type FourChanContext = {
  board?: string;
  threadId?: string;
  thumbnailMediaId?: string;
  catalogue?: boolean;
  sourceUrl?: string;
  previewUrl?: string;
  originalUrl?: string;
  resolvedOriginal?: boolean;
};

export const fourChanAdapter: SiteAdapter = {
  detect(draft: ImportDraft, target?: Element): boolean {
    if (!isFourChanBoardHost(location.hostname)) return false;
    return Boolean(
      fourChanThreadUrl(document.querySelector<HTMLLinkElement>("link[rel='canonical']")?.href) ||
        fourChanThreadUrl(draft.pageUrl) ||
        fourChanThreadUrl(location.href) ||
        findFourChanCatalogueContext(target)
    );
  },

  extract(draft: ImportDraft, target?: Element): ImportDraft {
    const catalogueContext = findFourChanCatalogueContext(target);
    const post = findFourChanPost(target);
    const file = findFourChanFile(target, post);
    const originalUrl =
      catalogueContext
        ? originalMediaUrlFromDraft(draft)
        : originalMediaUrlFromFile(file) ||
          originalMediaUrlFromFile(post) ||
          originalMediaUrlFromDraft(draft) ||
          mediaUrlFromElement(target);
    const previewUrl =
      catalogueContext?.previewUrl ||
      thumbnailUrlFromFile(file) ||
      thumbnailUrlFromFile(post) ||
      previewUrlFromElement(target) ||
      absoluteUrl(draft.previewUrl) ||
      originalUrl;
    const parsedThreadInfo =
      fourChanThreadInfo(document.querySelector<HTMLLinkElement>("link[rel='canonical']")?.href) ||
      fourChanThreadInfo(draft.pageUrl) ||
      fourChanThreadInfo(location.href);
    const threadContext = catalogueContext ?? parsedThreadInfo;
    const sourceUrl =
      catalogueContext?.sourceUrl ||
      parsedThreadInfo?.url ||
      absoluteUrl(draft.pageUrl) ||
      location.href;

    return {
      ...draft,
      site: "4chan",
      pageUrl: absoluteUrl(draft.pageUrl) || location.href,
      sourceUrl,
      mediaUrl: originalUrl,
      previewUrl,
      posterName: undefined,
      artistTag: undefined,
      caption: undefined,
      hashtags: undefined,
      raw: {
        ...rawRecord(draft.raw),
        fourChan: {
          board: threadContext?.board,
          threadId: threadContext?.threadId,
          thumbnailMediaId: catalogueContext?.thumbnailMediaId ?? mediaIdFromFourChanThumbnail(previewUrl),
          catalogue: Boolean(catalogueContext),
          sourceUrl,
          previewUrl,
          originalUrl,
          resolvedOriginal: Boolean(originalUrl && !isFourChanThumbnailUrl(originalUrl))
        } satisfies FourChanContext
      }
    };
  }
};

export function fourChanThreadUrl(value: string | undefined): string | undefined {
  return fourChanThreadInfo(value)?.url;
}

export function fourChanThreadInfo(value: string | undefined): { url: string; board: string; threadId: string } | undefined {
  const absolute = absoluteUrl(value);
  if (!absolute) return undefined;

  try {
    const url = new URL(absolute);
    const parts = fourChanThreadParts(url);
    if (!isFourChanBoardHost(url.hostname) || !parts) return undefined;
    url.search = "";
    url.hash = "";
    return {
      url: url.href,
      board: parts.board,
      threadId: parts.threadId
    };
  } catch {
    return undefined;
  }
}

export function fourChanBoardCode(value: string | undefined): string | undefined {
  const absolute = absoluteUrl(value);
  if (!absolute) return undefined;

  try {
    const url = new URL(absolute);
    if (!isFourChanBoardHost(url.hostname)) return undefined;
    return fourChanThreadParts(url)?.board;
  } catch {
    return undefined;
  }
}

function isFourChanBoardHost(hostname: string): boolean {
  return FOUR_CHAN_BOARD_HOSTS.has(hostname.replace(/^www\./, "").toLowerCase());
}

function fourChanThreadParts(url: URL): { board: string; threadId: string } | undefined {
  const match = url.pathname.match(/^\/([A-Za-z0-9]+)\/thread\/(\d+)(?:\/[^/?#]*)?$/);
  if (!match) return undefined;
  return {
    board: match[1].toLowerCase(),
    threadId: match[2]
  };
}

function findFourChanPost(target: Element | undefined): Element | undefined {
  return target?.closest(".post, .postContainer, .opContainer, .replyContainer") ?? undefined;
}

function findFourChanFile(target: Element | undefined, post: Element | undefined): Element | undefined {
  return target?.closest(".file") ?? post?.querySelector(".file") ?? undefined;
}

function findFourChanCatalogueContext(target: Element | undefined): FourChanContext | undefined {
  const tile = target?.closest("#threads .thread, .thread");
  if (!tile) return undefined;
  const link = target?.closest<HTMLAnchorElement>("a[href*='/thread/']") ?? tile.querySelector<HTMLAnchorElement>("a[href*='/thread/']");
  const threadInfo = fourChanThreadInfo(link?.href);
  if (!threadInfo) return undefined;

  const image =
    target instanceof HTMLImageElement && target.classList.contains("thumb")
      ? target
      : tile.querySelector<HTMLImageElement>("img.thumb[src], img[id^='thumb-'][src]");
  const previewUrl = absoluteUrl(image?.currentSrc || image?.src);

  return {
    board: threadInfo.board,
    threadId: threadInfo.threadId,
    thumbnailMediaId: mediaIdFromFourChanThumbnail(previewUrl),
    catalogue: true,
    sourceUrl: threadInfo.url,
    previewUrl
  };
}

function originalMediaUrlFromFile(root: Element | undefined): string | undefined {
  if (!root) return undefined;
  const links = [
    root.closest<HTMLAnchorElement>("a.fileThumb[href]"),
    root.querySelector<HTMLAnchorElement>("a.fileThumb[href]"),
    root.querySelector<HTMLAnchorElement>(".fileText a[href]")
  ];

  for (const link of links) {
    const url = absoluteUrl(link?.href);
    if (url && isImportableFourChanMediaUrl(url)) return url;
  }

  return undefined;
}

function originalMediaUrlFromDraft(draft: ImportDraft): string | undefined {
  const sourceUrl = isFourChanCdnMediaUrl(draft.sourceUrl) && !isFourChanThumbnailUrl(draft.sourceUrl) ? absoluteUrl(draft.sourceUrl) : undefined;
  const mediaUrl = isFourChanCdnMediaUrl(draft.mediaUrl) && !isFourChanThumbnailUrl(draft.mediaUrl) ? absoluteUrl(draft.mediaUrl) : undefined;
  return sourceUrl || mediaUrl;
}

function thumbnailUrlFromFile(root: Element | undefined): string | undefined {
  const image = root?.querySelector<HTMLImageElement>("a.fileThumb img[src], img[src]");
  return absoluteUrl(image?.currentSrc || image?.src);
}

function isImportableFourChanMediaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return FOUR_CHAN_CDN_HOST_RE.test(url.hostname) && /\.(jpe?g|png|gif|webp|webm|mp4)(\?|#|$)/i.test(url.pathname);
  } catch {
    return false;
  }
}

function isFourChanCdnMediaUrl(value: string | undefined): boolean {
  const absolute = absoluteUrl(value);
  return Boolean(absolute && isImportableFourChanMediaUrl(absolute));
}

function isFourChanThumbnailUrl(value: string | undefined): boolean {
  const absolute = absoluteUrl(value);
  if (!absolute) return false;

  try {
    const url = new URL(absolute);
    return FOUR_CHAN_CDN_HOST_RE.test(url.hostname) && /\d+s\.jpe?g$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function mediaIdFromFourChanThumbnail(value: string | undefined): string | undefined {
  const absolute = absoluteUrl(value);
  if (!absolute) return undefined;

  try {
    const match = new URL(absolute).pathname.match(/\/(\d+)s\.jpe?g$/i);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function rawRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
}
