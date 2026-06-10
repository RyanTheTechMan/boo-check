import type { ImportDraft } from "../types";
import {
  absoluteUrl,
  findBestImageFromMeta,
  mediaUrlFromElement,
  previewUrlFromElement,
  visibleLargestImage
} from "../utils/domExtract";
import type { SiteAdapter } from ".";

export const genericAdapter: SiteAdapter = {
  detect: () => true,
  extract(draft: ImportDraft, target?: Element): ImportDraft {
    const linkUrl = absoluteUrl((draft.raw as { linkUrl?: string } | undefined)?.linkUrl);
    const mediaUrl =
      absoluteUrl(draft.mediaUrl) ||
      mediaUrlFromElement(target) ||
      (linkUrl && isLikelyMediaUrl(linkUrl) ? linkUrl : undefined) ||
      findBestImageFromMeta() ||
      visibleLargestImage();

    return {
      ...draft,
      site: "generic",
      pageUrl: absoluteUrl(draft.pageUrl) || location.href,
      sourceUrl: absoluteUrl(draft.sourceUrl) || absoluteUrl(draft.pageUrl) || location.href,
      mediaUrl,
      previewUrl: absoluteUrl(draft.previewUrl) || previewUrlFromElement(target) || mediaUrl
    };
  }
};

function isLikelyMediaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return /\.(jpe?g|png|webp|gif|mp4|webm)(\?|#|$)/i.test(url.pathname);
  } catch {
    return false;
  }
}
