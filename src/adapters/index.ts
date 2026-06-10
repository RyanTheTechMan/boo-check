import type { ImportDraft } from "../types";
import { findElementForDraft } from "../utils/domExtract";
import { booruAdapter } from "./booru";
import { genericAdapter } from "./generic";
import { misskeyAdapter } from "./misskey";
import { xAdapter } from "./x";

export type SiteAdapter = {
  detect(draft: ImportDraft, target?: Element): boolean;
  extract(draft: ImportDraft, target?: Element): ImportDraft;
};

const adapters: SiteAdapter[] = [misskeyAdapter, xAdapter, booruAdapter, genericAdapter];

export function extractImportDraft(draft: ImportDraft, rightClickTarget?: Element): ImportDraft {
  const target = rightClickTarget ?? findElementForDraft(draft);
  const adapter = adapters.find((candidate) => candidate.detect(draft, target)) ?? genericAdapter;
  return adapter.extract(draft, target);
}
