# Boo Check

Boo Check is a personal Chrome Manifest V3 extension for importing images, videos, and post/page metadata into an existing self-hosted Blombooru instance. It does not fork or bundle Blombooru.

## Build and load

```bash
npm install
npm run build
```

Then open Chrome, go to `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select this repo's `dist/` directory.

For development:

```bash
npm run dev
```

The dev command watches and rebuilds `dist/`; reload the unpacked extension in Chrome after changes.

## Configure

Open the extension options page or the Settings section in the side panel and set:

- Blombooru base URL, for example `http://10.10.1.149:8000`
- Blombooru API key
- Default rating
- AI model name, default `wd-eva02-large-tagger-v3`
- AI auto thresholds
- Hide AI rating tags, close-after-import, clear-panel default, Misskey artist naming, multi-add click capture, and debug mode preferences

The API key is stored only in `chrome.storage.local`, not `chrome.storage.sync`.

To create or get a Blombooru API key, use your running Blombooru app's account, profile, admin, or API settings page. Boo Check sends it as:

```http
Authorization: Bearer <api_key>
```

## Usage

Right-click an image, video, link, post, or page and choose **Add to Blombooru**.

The side panel opens with a preview, editable source URL, artist, rating, and a space-separated tag textbox. The source URL is adapter-driven when possible, so Misskey notes and X/Twitter tweets use the nearest post URL instead of a generic feed URL.

Clicked media is preferred when present. For page or empty-space right-clicks, Boo Check records the right-clicked DOM target and uses site adapters plus generic fallbacks to find the most likely media.

Clicking the Boo Check toolbar icon reopens the side panel and restores the most recent side-panel workflow state unless a newer right-click draft exists. Use **Clear Side Panel** to reset the draft, fields, manual suggestions, result popup, and debug snapshot without clearing settings.

## Multi-add queue

Use **Enable multi-add** in the side panel to collect several posts from the active tab. While enabled, Boo Check intercepts the configured click types on the page, blocks the normal website action, extracts the clicked post or media with the same adapters used by the context menu flow, and appends it to the active tab's queue.

The queue is stored in the browser session per tab. Select a queued item to review the preview, original media dimensions/size, source URL, artist, rating, and tags. Edits are saved back to the selected queue item when you switch rows or import.

The multi-add settings control whether left-clicks, right-clicks, or both are captured. Right-click capture is enabled by default; left-click capture starts off.

## Import flows

- **Import** uploads with the current fields and no AI.
- **Import + AI Auto** uploads first, runs Blombooru AI prediction against the returned media ID, appends tags above configured thresholds, then patches the final tag list.
- **Import + AI Manual** uploads first, runs AI prediction, shows tag confidence checkboxes, lets you append selected tags, then saves final tags.
- **Import Queue** imports queued items sequentially with their saved fields.
- **Import Queue + AI Auto** imports queued items sequentially, runs Blombooru AI after each upload, merges selected AI tags with each queued item's existing tags, then patches final tags.

Before upload, Boo Check fetches the media, computes SHA-256 locally with `crypto.subtle.digest`, and renames the file to `<sha256>.<extension>`.

The Artist field has autocomplete and is submitted as an artist-category tag through `category_hints`; it is not inserted into the main tag textbox. In the side panel preview, artist tags render with the artist chip color. The field indicates whether the artist tag already exists or will be added on import.

For Misskey, the artist field defaults to the username only. Settings can also keep the federated handle or put the domain into the normal tag textbox as a separate normalized tag.

AI rating tags such as `safe`, `questionable`, and `explicit` are ignored because the explicit Rating selector handles rating. **Close side panel after import** shows a 10-second countdown after successful final imports, with controls to open the Blombooru media page or keep the side panel open. The result popup also has a **Clear side panel** checkbox; its default checked state is configurable in settings.

Import results appear in a dismissible popup only after a completed import or final save. Close it with the `x` button, Escape, or by clicking behind it.

When **Debug mode** is enabled, the side panel shows **Copy Debug Report**. The report includes extraction context and page/media URLs for troubleshooting site support, but excludes the API key, cookies, auth headers, and fetched media data.

## API paths

All endpoint paths are centralized in `src/api/blombooru.ts`:

- `POST /api/media/`
- `POST /api/ai-tagger/predict/{media_id}`
- `PATCH /api/media/{media_id}`
- `GET /api/tags/autocomplete?q=<query>`, with fallback to `query=<query>`
- Best-effort `POST /api/tags/` for category creation when available

Expected response shapes are intentionally loose:

- Upload/update media ID can be `id`, `media_id`, `media.id`, `item.id`, or `data.id`.
- AI predictions can be under `tags`, `predictions`, `results`, `data.tags`, or `data.predictions`.
- AI tags can be objects such as `{ "name": "1girl", "category": "general", "confidence": 0.91 }`, grouped arrays, or grouped maps such as `{ "general": { "solo": 0.88 } }`.
- Autocomplete can return an array directly or an object with `tags`, `results`, `suggestions`, `items`, or `data`.

## Host permissions

The MVP manifest uses `<all_urls>` because it needs to fetch media from arbitrary sites and call your configured Blombooru base URL. For a stricter install, edit `public/manifest.json` and restrict `host_permissions` to the sites you import from plus your Blombooru host.

## Known limitations

- Site extraction is best effort and falls back to generic import.
- Misskey, X/Twitter, and booru DOMs change often, so source URL and artist detection may need adapter tweaks.
- Private media may fail if the site blocks extension fetches or requires credentials not available to extension pages.
- Blombooru tag creation endpoints are not assumed. If category lookup or creation fails, tags still import with neutral chips unless category data is known from autocomplete or AI.

## Troubleshooting

- **Duplicate detected**: Blombooru returned HTTP 409. Boo Check shows "Already imported" and does not treat it as a crash.
- **401/403**: Check the API key and base URL.
- **Media fetch failed**: Try right-clicking the actual image/video, or open the original post page and retry.
- **Imported, but AI tagging failed**: Upload worked, but the prediction endpoint failed or returned an unexpected error. The uploaded item remains in Blombooru.
- **Imported and AI predicted, but saving final tags failed**: Upload and AI worked, but the final save failed. Review the textbox and click **Save Final Tags** to retry without uploading again.
