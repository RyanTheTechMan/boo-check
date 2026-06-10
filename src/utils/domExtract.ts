import type { ImportDraft, Rating } from "../types";

export function absoluteUrl(value: string | undefined | null, base = location.href): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value, base).href;
  } catch {
    return undefined;
  }
}

export function normalizeAdapterTag(value: string | undefined | null): string {
  if (!value) return "";
  return value
    .trim()
    .replace(/^#+/, "")
    .replace(/^[\s"'`.,;!?()[\]{}<>]+|[\s"'`.,;!?()[\]{}<>]+$/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

export function normalizeInstanceTag(hostname = location.hostname): string {
  return normalizeAdapterTag(hostname.replace(/^www\./, "").replace(/\./g, "_"));
}

export function extractHashtags(text: string | undefined | null): string[] {
  if (!text) return [];
  const matches = text.match(/#[\p{L}\p{N}_-]+/gu) ?? [];
  return unique(matches.map(normalizeAdapterTag).filter(Boolean));
}

export function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

export function findElementForDraft(draft: ImportDraft): Element | undefined {
  const mediaUrl = draft.mediaUrl || draft.previewUrl;
  if (!mediaUrl) return undefined;

  const candidates = Array.from(
    document.querySelectorAll<HTMLImageElement | HTMLVideoElement | HTMLSourceElement | HTMLAnchorElement>(
      "img, video, source, a[href]"
    )
  );

  return candidates.find((element) => {
    const urls = elementUrls(element);
    return urls.some((url) => sameUrlLoose(url, mediaUrl));
  });
}

export function elementUrls(element: Element): string[] {
  const urls = new Set<string>();
  const add = (value: string | null | undefined) => {
    const absolute = absoluteUrl(value);
    if (absolute) urls.add(absolute);
  };

  if (element instanceof HTMLImageElement) {
    add(element.currentSrc);
    add(element.src);
    add(element.getAttribute("data-src"));
    add(element.getAttribute("data-original"));
  } else if (element instanceof HTMLVideoElement) {
    add(element.currentSrc);
    add(element.src);
    add(element.poster);
    element.querySelectorAll("source").forEach((source) => add(source.src));
  } else if (element instanceof HTMLSourceElement) {
    add(element.src);
    add(element.srcset?.split(/\s+/)[0]);
  } else if (element instanceof HTMLAnchorElement) {
    add(element.href);
  }

  return Array.from(urls);
}

export function mediaUrlFromElement(element: Element | undefined): string | undefined {
  if (!element) return undefined;
  if (element instanceof HTMLImageElement) {
    return absoluteUrl(element.currentSrc || element.src || element.getAttribute("data-src"));
  }
  if (element instanceof HTMLVideoElement) {
    return absoluteUrl(element.currentSrc || element.src || element.querySelector("source")?.src);
  }
  if (element instanceof HTMLSourceElement) {
    return absoluteUrl(element.src || element.srcset?.split(/\s+/)[0]);
  }
  if (element instanceof HTMLAnchorElement) {
    return absoluteUrl(element.href);
  }
  const nested = element.querySelector<HTMLImageElement | HTMLVideoElement>("img, video");
  return mediaUrlFromElement(nested ?? undefined);
}

export function previewUrlFromElement(element: Element | undefined): string | undefined {
  if (!element) return undefined;
  if (element instanceof HTMLVideoElement && element.poster) return absoluteUrl(element.poster);
  return mediaUrlFromElement(element);
}

export function textOf(element: Element | Document | undefined): string {
  return (element?.textContent ?? "").trim();
}

export function closestPostContainer(target: Element | undefined): Element | undefined {
  if (!target) return undefined;
  return (
    target.closest("article, [role='article'], [data-testid='tweet'], [data-testid='note'], .note, [class*='note'], [class*='Note'], .post, [class*='post']") ??
    undefined
  );
}

export function findFirstLink(container: ParentNode, predicate: (href: string, anchor: HTMLAnchorElement) => boolean): HTMLAnchorElement | undefined {
  return Array.from(container.querySelectorAll<HTMLAnchorElement>("a[href]")).find((anchor) => {
    const href = absoluteUrl(anchor.getAttribute("href"));
    return href ? predicate(href, anchor) : false;
  });
}

export function findBestImageFromMeta(): string | undefined {
  const selectors = [
    "meta[property='og:image']",
    "meta[property='og:image:url']",
    "meta[name='twitter:image']",
    "meta[name='twitter:image:src']"
  ];

  for (const selector of selectors) {
    const value = document.querySelector<HTMLMetaElement>(selector)?.content;
    const absolute = absoluteUrl(value);
    if (absolute) return absolute;
  }

  return undefined;
}

export function visibleLargestImage(): string | undefined {
  const images = Array.from(document.images)
    .filter((image) => image.currentSrc || image.src)
    .map((image) => ({
      url: absoluteUrl(image.currentSrc || image.src),
      area: image.naturalWidth * image.naturalHeight
    }))
    .filter((item): item is { url: string; area: number } => Boolean(item.url));

  images.sort((a, b) => b.area - a.area);
  return images[0]?.url;
}

export function ratingFromText(text: string): Rating | undefined {
  const lower = text.toLowerCase();
  if (/\brating\s*[:=]\s*explicit\b|\bexplicit\b|\brating:e\b|\brating_e\b/.test(lower)) return "explicit";
  if (/\brating\s*[:=]\s*questionable\b|\bquestionable\b|\brating:q\b|\brating_q\b/.test(lower)) return "questionable";
  if (/\brating\s*[:=]\s*safe\b|\bsafe\b|\brating:s\b|\brating_s\b/.test(lower)) return "safe";
  return undefined;
}

function sameUrlLoose(left: string, right: string): boolean {
  const leftUrl = absoluteUrl(left);
  const rightUrl = absoluteUrl(right);
  if (!leftUrl || !rightUrl) return false;
  if (leftUrl === rightUrl) return true;

  try {
    const a = new URL(leftUrl);
    const b = new URL(rightUrl);
    a.hash = "";
    b.hash = "";
    if (a.href === b.href) return true;
    const aNoQuery = `${a.origin}${a.pathname}`;
    const bNoQuery = `${b.origin}${b.pathname}`;
    return aNoQuery === bNoQuery;
  } catch {
    return false;
  }
}
