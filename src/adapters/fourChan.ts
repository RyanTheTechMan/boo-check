import type { ImportDraft } from "../types";
import {
  absoluteUrl,
  mediaUrlFromElement,
  previewUrlFromElement
} from "../utils/domExtract";
import type { SiteAdapter } from ".";

const FOUR_CHAN_BOARD_HOSTS = new Set(["boards.4chan.org", "boards.4channel.org"]);
const FOUR_CHAN_CDN_HOST_RE = /(^|\.)4cdn\.org$/i;

export const fourChanAdapter: SiteAdapter = {
  detect(draft: ImportDraft): boolean {
    if (!isFourChanBoardHost(location.hostname)) return false;
    return Boolean(
      fourChanThreadUrl(document.querySelector<HTMLLinkElement>("link[rel='canonical']")?.href) ||
        fourChanThreadUrl(draft.pageUrl) ||
        fourChanThreadUrl(location.href)
    );
  },

  extract(draft: ImportDraft, target?: Element): ImportDraft {
    const post = findFourChanPost(target);
    const file = findFourChanFile(target, post);
    const originalUrl =
      originalMediaUrlFromFile(file) ||
      originalMediaUrlFromFile(post) ||
      (isFourChanCdnMediaUrl(draft.sourceUrl) ? absoluteUrl(draft.sourceUrl) : undefined) ||
      (isFourChanCdnMediaUrl(draft.mediaUrl) && !isFourChanThumbnailUrl(draft.mediaUrl) ? absoluteUrl(draft.mediaUrl) : undefined) ||
      mediaUrlFromElement(target);
    const previewUrl =
      thumbnailUrlFromFile(file) ||
      thumbnailUrlFromFile(post) ||
      previewUrlFromElement(target) ||
      absoluteUrl(draft.previewUrl) ||
      originalUrl;
    const sourceUrl =
      fourChanThreadUrl(document.querySelector<HTMLLinkElement>("link[rel='canonical']")?.href) ||
      fourChanThreadUrl(draft.pageUrl) ||
      fourChanThreadUrl(location.href) ||
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
      hashtags: undefined
    };
  }
};

export function fourChanThreadUrl(value: string | undefined): string | undefined {
  const absolute = absoluteUrl(value);
  if (!absolute) return undefined;

  try {
    const url = new URL(absolute);
    if (!isFourChanBoardHost(url.hostname)) return undefined;
    if (!fourChanThreadParts(url)) return undefined;
    url.search = "";
    url.hash = "";
    return url.href;
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
