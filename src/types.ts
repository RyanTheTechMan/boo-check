export type Rating = "safe" | "questionable" | "explicit";

export type SiteKind = "misskey" | "x" | "4chan" | "booru" | "generic";

export type MisskeyArtistMode = "append-domain" | "username-only" | "domain-tag";

export type FourChanTagMode = "none" | "site" | "board" | "site-and-board";

export type SidePanelImageBlurMode = "off" | "hover" | "click";

export type TagCategory =
  | "general"
  | "artist"
  | "character"
  | "copyright"
  | "meta"
  | "unknown"
  | string;

export type BlombooruBooruImportTag = {
  name: string;
  category?: TagCategory;
  isNew?: boolean;
  userAssigned?: boolean;
};

export type BlombooruBooruImportDraft = {
  originalUrl: string;
  booruUrl?: string;
  fileUrl?: string;
  previewUrl?: string;
  proxyFileUrl?: string;
  proxyPreviewUrl?: string;
  filename?: string;
  width?: number;
  height?: number;
  fileSize?: number;
  source?: string;
  tags: BlombooruBooruImportTag[];
  fetchedAt: number;
};

export type ImportDraft = {
  pageUrl?: string;
  sourceUrl?: string;
  mediaUrl?: string;
  previewUrl?: string;
  site?: SiteKind;
  posterName?: string;
  artistTag?: string;
  artistTags?: string[];
  caption?: string;
  hashtags?: string[];
  seedTags?: string[];
  rating?: Rating;
  blombooruBooruImport?: BlombooruBooruImportDraft;
  raw?: unknown;
};

export type AppSettings = {
  baseUrl: string;
  apiKey: string;
  defaultRating: Rating;
  aiModelName: string;
  aiAutoGeneralThreshold: number;
  aiAutoCharacterThreshold: number;
  hideRatingTags: boolean;
  includePostHashtagsDefault: boolean;
  closeAfterImport: boolean;
  clearPanelAfterImportDefault: boolean;
  misskeyArtistMode: MisskeyArtistMode;
  fourChanTagMode: FourChanTagMode;
  sidePanelImageBlurMode: SidePanelImageBlurMode;
  multiAddCaptureLeftClick: boolean;
  multiAddCaptureRightClick: boolean;
  debugMode: boolean;
};

export type TagSuggestion = {
  name: string;
  category?: TagCategory;
  postCount?: number;
};

export type AiTagPrediction = {
  name: string;
  category?: TagCategory;
  confidence?: number;
};

export type PendingImport = {
  draft: ImportDraft;
  tabId?: number;
  createdAt: number;
};

export type ImportFormState = {
  source: string;
  artist: string;
  rating: Rating;
  tags: string;
  includePostHashtags?: boolean;
};

export type ManualImportState = {
  mediaId: string;
  link?: string;
  predictions: AiTagPrediction[];
  baseTags?: string[];
  appliedNames?: string[];
  selectedNames: string[];
};

export type UploadedImportState = {
  mediaId?: string;
  link?: string;
  finalSaved?: boolean;
};

export type ImportMediaMetadata = {
  url: string;
  width?: number;
  height?: number;
  bytes?: number;
  mimeType?: string;
  sizeSource?: "head" | "blob";
  sizeProbeFailed?: boolean;
  loading?: boolean;
  error?: string;
};

export type ImportQueueItemStatus = "queued" | "importing" | "imported" | "duplicate" | "error";

export type ImportQueueItem = {
  id: string;
  createdAt: number;
  updatedAt: number;
  draft: ImportDraft;
  form?: ImportFormState;
  debug?: ImportDebugSnapshot;
  mediaMetadata?: ImportMediaMetadata;
  manual?: ManualImportState;
  uploaded?: UploadedImportState;
  status: ImportQueueItemStatus;
  statusMessage?: string;
  statusLink?: string;
  error?: string;
};

export type ImportQueueState = {
  tabId: number;
  captureEnabled: boolean;
  autoCollectEnabled: boolean;
  selectedItemId?: string;
  items: ImportQueueItem[];
  updatedAt: number;
};

export type ImportQueueStore = Record<string, ImportQueueState>;

export type DebugElementSummary = {
  tagName: string;
  id?: string;
  className?: string;
  role?: string;
  testId?: string;
  ariaLabel?: string;
  href?: string;
  src?: string;
  path?: string;
  width?: number;
  height?: number;
  text?: string;
};

export type DebugMediaCandidate = {
  originalUrl?: string;
  canonicalUrl?: string;
  source: string;
  score?: number;
  accepted?: boolean;
  selected?: boolean;
  rejectionReason?: string;
  element?: DebugElementSummary;
  width?: number;
  height?: number;
  twimgKind?: string;
  twimgNameParamBefore?: string;
  twimgNameParamAfter?: string;
};

export type DebugSourceCandidate = {
  url: string;
  source: string;
  accepted?: boolean;
  element?: DebugElementSummary;
};

export type ImportDebugSnapshot = {
  capturedAt: number;
  pageUrl?: string;
  selectedAdapter?: SiteKind;
  pendingDraft?: ImportDraft;
  enrichedDraft?: ImportDraft;
  rightClickTarget?: DebugElementSummary;
  nearestPostContainer?: DebugElementSummary;
  candidateMediaUrls: string[];
  candidateSourceUrls: string[];
  mediaCandidates?: DebugMediaCandidate[];
  sourceCandidatesDetailed?: DebugSourceCandidate[];
  selectionNotes?: string[];
  x?: {
    parsedStatus?: { username: string; statusId: string };
    selectedMediaUrl?: string;
    selectedMediaSource?: string;
    statusLinks?: string[];
    photoLinks?: string[];
    selectedTweetContainer?: DebugElementSummary;
  };
  misskey?: {
    rememberedContext?: ImportDraft;
    photoSwipeOpen?: boolean;
    activePhotoSwipeImage?: DebugElementSummary;
    selectedMediaUrl?: string;
  };
  booruImport?: {
    endpoint?: string;
    sourceUrl?: string;
    status?: number;
    delegated?: boolean;
    mediaStrategy?: string;
    fetchStrategy?: string;
    blombooruFetchTimeoutMs?: number;
    blombooruFetchFallbackReason?: string;
    blombooruFetchSkippedReason?: string;
    proxySkippedReason?: string;
    ignoredPendingUpdateReason?: string;
    tagCount?: number;
    proxyFileUrl?: string;
    proxyPreviewUrl?: string;
    selectedPreviewUrl?: string;
    previewReused?: boolean;
    previewCandidates?: string[];
    previewFailures?: Array<{
      url: string;
      error: string;
      status?: number;
      contentType?: string;
      responseUrl?: string;
      bodyPreview?: string;
      authAttempted?: boolean;
    }>;
    mediaFetchCandidates?: string[];
    fallbackProxyApplied?: boolean;
    fallbackProxyReason?: string;
    fallbackProxyRawCandidates?: string[];
    fallbackProxyCandidates?: string[];
    pageContextFetchUrl?: string;
    pageContextFetchResponseUrl?: string;
    pageContextFetchBytes?: number;
    pageContextFetchContentType?: string;
    pageContextFetchError?: string;
    pageContextFetches?: Array<{
      url: string;
      responseUrl?: string;
      bytes?: number;
      contentType?: string;
      error?: string;
    }>;
    pagePostFetchUrl?: string;
    pagePostFetchResponseUrl?: string;
    pagePostFetchBytes?: number;
    pagePostFetchContentType?: string;
    pagePostFetchTagCount?: number;
    pagePostFetchMediaUrl?: string;
    pagePostFetchPreviewUrl?: string;
    pagePostFetchSourceUrl?: string;
    pagePostFetchArtistTag?: string;
    pagePostFetchArtistTags?: string[];
    pagePostFetchError?: string;
    mediaValidationRejectedUrl?: string;
    mediaValidationError?: string;
    error?: string;
  };
  metaImageUrls: string[];
  visibleTags: string[];
  hashtags: string[];
  errors: string[];
};

export type SavedSidePanelState = {
  savedAt: number;
  tabId?: number;
  pendingCreatedAt?: number;
  draft: ImportDraft;
  form: ImportFormState;
  manual?: ManualImportState;
  uploaded?: UploadedImportState;
  status?: {
    message: string;
    tone: "info" | "success" | "error";
    link?: string;
  };
  success?: {
    visible: boolean;
    title: string;
    message: string;
    link?: string;
    clearPanelChecked?: boolean;
  };
  debug?: ImportDebugSnapshot;
};
