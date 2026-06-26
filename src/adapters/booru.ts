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
    const isPostPage = looksLikePostUrl(pageUrl) || sourceUrl === pageUrl;
    const listingPreview = findListingPreviewMediaUrl(target);
    const originalUrl = isPostPage
      ? findOriginalMediaUrl() || mediaUrlFromElement(target) || absoluteUrl(draft.mediaUrl)
      : mediaUrlFromElement(target) || listingPreview || absoluteUrl(draft.mediaUrl);
    const tagData = isPostPage ? extractVisibleTagData() : { tags: [], artistTags: [] };
    const artistTags = unique([
      ...tagData.artistTags,
      ...(draft.artistTags ?? []),
      draft.artistTag
    ].filter((tag): tag is string => Boolean(tag)));
    const rating = isPostPage ? extractVisibleRating() || draft.rating : draft.rating;

    return {
      ...draft,
      site: "booru",
      pageUrl,
      sourceUrl,
      mediaUrl: originalUrl,
      previewUrl: previewUrlFromElement(target) || listingPreview || absoluteUrl(draft.previewUrl) || originalUrl,
      artistTag: artistTags[0] || draft.artistTag,
      artistTags,
      seedTags: unique([...tagData.tags, ...(draft.seedTags ?? [])]),
      rating
    };
  }
};

function findListingPreviewMediaUrl(target: Element | undefined): string | undefined {
  const post = target?.closest(BOORU_POST_CONTAINER_SELECTOR);
  if (!post) return undefined;
  return mediaUrlFromElement(post);
}

function findPostSourceUrl(target: Element | undefined): string | undefined {
  const linkedPost = target?.closest<HTMLAnchorElement>("a[href*='/post'], a[href*='show?id='], a[href*='?id=']");
  const linkedPostUrl = absoluteUrl(linkedPost?.href);
  if (linkedPostUrl && looksLikePostUrl(linkedPostUrl)) return linkedPostUrl;

  const postContainer = target?.closest(BOORU_POST_CONTAINER_SELECTOR);
  const containerPostUrl = postContainer
    ? Array.from(postContainer.querySelectorAll<HTMLAnchorElement>("a[href]"))
        .map((anchor) => absoluteUrl(anchor.href))
        .find((url): url is string => Boolean(url && looksLikePostUrl(url)))
    : undefined;
  if (containerPostUrl) return containerPostUrl;

  const canonical = absoluteUrl(document.querySelector<HTMLLinkElement>("link[rel='canonical']")?.href);
  if (canonical && looksLikePostUrl(canonical)) return canonical;

  const ogUrl = absoluteUrl(document.querySelector<HTMLMetaElement>("meta[property='og:url']")?.content);
  if (ogUrl && looksLikePostUrl(ogUrl)) return ogUrl;

  const current = absoluteUrl(location.href);
  return current && looksLikePostUrl(current) ? current : undefined;
}

const BOORU_POST_CONTAINER_SELECTOR = [
  "article[id^='post_']",
  "article.post-preview",
  ".post-preview",
  ".post-preview-container",
  "[data-post-id]",
  "[data-id]"
].join(",");

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

function extractVisibleTagData(): { tags: string[]; artistTags: string[] } {
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
    "#tag-list a",
    ".tag-list a",
    "li[class*='tag-type'] a",
    "li[class*='category-'] a",
    "a[class*='tag-type']",
    "a[class*='category-']",
    ".tag a"
  ];

  const tags: string[] = [];
  const artistTags: string[] = [];

  for (const selector of selectors) {
    for (const element of Array.from(document.querySelectorAll(selector))) {
      const tag = normalizeAdapterTag(element.textContent);
      if (!tag) continue;
      tags.push(tag);
      if (booruTagElementCategory(element) === "artist") artistTags.push(tag);
    }
  }

  return {
    tags: unique(tags),
    artistTags: unique(artistTags)
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
