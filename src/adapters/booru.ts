import type { ImportDraft, Rating } from "../types";
import {
  absoluteUrl,
  mediaUrlFromElement,
  normalizeAdapterTag,
  previewUrlFromElement,
  ratingFromText,
  textOf,
  unique
} from "../utils/domExtract";
import type { SiteAdapter } from ".";

const BOORU_HOST_RE = /(booru|danbooru|gelbooru|safebooru|yande\.re|konachan|rule34|e621|e926)/i;

export const booruAdapter: SiteAdapter = {
  detect(draft: ImportDraft): boolean {
    const host = location.hostname;
    return (
      BOORU_HOST_RE.test(host) ||
      /\/posts?\/\d+|[?&]id=\d+/.test(location.href) ||
      Boolean(document.querySelector("#image, img#image, #image-container, .image-container, #tag-list, .tag-list"))
    );
  },

  extract(draft: ImportDraft, target?: Element): ImportDraft {
    const pageUrl = absoluteUrl(draft.pageUrl) || location.href;
    const sourceUrl = findPostSourceUrl(target) || pageUrl;
    const originalUrl = findOriginalMediaUrl() || mediaUrlFromElement(target) || absoluteUrl(draft.mediaUrl);
    const tags = extractVisibleTags();
    const rating = extractVisibleRating() || draft.rating;

    return {
      ...draft,
      site: "booru",
      pageUrl,
      sourceUrl,
      mediaUrl: originalUrl,
      previewUrl: previewUrlFromElement(target) || absoluteUrl(draft.previewUrl) || originalUrl,
      seedTags: unique([...tags, ...(draft.seedTags ?? [])]),
      rating
    };
  }
};

function findPostSourceUrl(target: Element | undefined): string | undefined {
  const linkedPost = target?.closest<HTMLAnchorElement>("a[href*='/post'], a[href*='show?id='], a[href*='?id=']");
  const linkedPostUrl = absoluteUrl(linkedPost?.href);
  if (linkedPostUrl && looksLikePostUrl(linkedPostUrl)) return linkedPostUrl;

  const canonical = absoluteUrl(document.querySelector<HTMLLinkElement>("link[rel='canonical']")?.href);
  if (canonical && looksLikePostUrl(canonical)) return canonical;

  const ogUrl = absoluteUrl(document.querySelector<HTMLMetaElement>("meta[property='og:url']")?.content);
  if (ogUrl && looksLikePostUrl(ogUrl)) return ogUrl;

  const current = absoluteUrl(location.href);
  return current && looksLikePostUrl(current) ? current : undefined;
}

function looksLikePostUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return /\/posts?\/\d+|\/index\.php$|\/post\/show\/\d+|[?&]id=\d+/.test(`${url.pathname}${url.search}`);
  } catch {
    return false;
  }
}

function findOriginalMediaUrl(): string | undefined {
  const selectors = [
    "a#image-download-link[href]",
    "a#highres[href]",
    "a.original-file[href]",
    "a[href*='/original/'][href]",
    "a[href*='/data/'][href]",
    "video source[src]",
    "video[src]",
    "img#image[src]",
    "#image-container img[src]",
    ".image-container img[src]"
  ];

  for (const selector of selectors) {
    const element = document.querySelector<HTMLElement>(selector);
    const value =
      element instanceof HTMLAnchorElement
        ? element.href
        : element instanceof HTMLSourceElement
          ? element.src
          : element instanceof HTMLVideoElement
            ? element.currentSrc || element.src
            : element instanceof HTMLImageElement
              ? element.currentSrc || element.src
              : element?.getAttribute("href") || element?.getAttribute("src");
    const absolute = absoluteUrl(value);
    if (absolute) return absolute;
  }

  return undefined;
}

function extractVisibleTags(): string[] {
  const selectors = [
    ".tag-type-general a.search-tag",
    ".tag-type-artist a.search-tag",
    ".tag-type-character a.search-tag",
    ".tag-type-copyright a.search-tag",
    ".tag-type-meta a.search-tag",
    "#tag-list a",
    ".tag-list a",
    "li[class*='tag-type'] a",
    ".tag a"
  ];

  const tags = selectors.flatMap((selector) =>
    Array.from(document.querySelectorAll(selector)).map((element) => normalizeAdapterTag(element.textContent))
  );

  return unique(tags.filter(Boolean));
}

function extractVisibleRating(): Rating | undefined {
  const ratingElement = document.querySelector("[data-rating], .rating, #rating, li[class*='rating']");
  const dataRating = ratingElement?.getAttribute("data-rating");
  const dataMapped = mapRating(dataRating);
  if (dataMapped) return dataMapped;
  return ratingFromText(textOf(ratingElement ?? document.body));
}

function mapRating(value: string | undefined | null): Rating | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "s" || normalized === "safe") return "safe";
  if (normalized === "q" || normalized === "questionable") return "questionable";
  if (normalized === "e" || normalized === "explicit") return "explicit";
  return undefined;
}
