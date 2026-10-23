# UI and Accessibility

Status: target design; Tailwind v4, shadcn/ui and product screens are planned · Related: [architecture](architecture.md), [data fetching](data-fetching.md), [API contract](../backend/api.md)

## Design and scope

Build a small anonymous utility: create a link, safely keep its management token, and inspect/manage that link. Use system fonts, shared color/spacing tokens, a mobile-first layout and selected accessible primitives rather than a new component framework. Light/dark themes must both meet contrast requirements. Do not claim that a component library by itself guarantees accessibility.

V1 includes editing, deletion and rich analytics (totals, daily series, referrer origins, countries and devices). Accounts, team management, QR codes and unique-visitor reporting are outside V1.

## Create and one-time backup

The home screen has a labeled destination field, optional alias/expiry disclosure, a submit action, a result region and a clearly labeled “Recent links on this device” list. Do not steal focus on initial load. Validate on interaction/submission, preserve drafts on failure, and disable duplicate submits while a request is pending.

After confirmed creation:

1. Focus the result heading; show the short URL with distinct **Copy link** and **Open link** actions. Keep the full destination available through an accessible disclosure rather than a hover-only tooltip.
2. Present a dedicated management-token backup section **before dismissing or navigating away from the result**. Offer reveal and **Copy management token**; do not confuse that action with copying the public link.
3. Explain: “This token lets you edit, delete and view analytics. Save a copy now. If you lose it, the server cannot recover it.” The normal default is memory only; reload/closing the page loses that copy.
4. Offer an unchecked **Remember on this device** option. Explain that this stores the token in this browser and scripts on this origin can read it; it is not cross-device backup or an account. Never select it automatically.
5. On dismissal without a confirmed backup, warn and allow an explicit “Continue without saving.” Do not claim a backup exists merely because a token was displayed or a clipboard attempt started. Clear the revealed DOM value and transient create result on exit.

Creation replay can return the same token for 24 hours to recover a lost response; it is not an ongoing reveal/recovery screen. Later views offer token paste/replace/forget, not a server “recover token” action.

Clipboard denial or unavailability must leave a selectable value and manual-copy instructions. Announce “Link copied” or “Management token copied” without announcing the token itself. Avoid including tokens in toasts, support details, telemetry, page titles or URLs.

## Link page and management

The route `/links/:code` displays available metadata, a token entry/management area, UTC date controls, analytics and destructive actions. A copied route shares no authorization.

| State | Presentation |
| --- | --- |
| No token, active link | Public metadata; explain why analytics/edit/delete need a saved token |
| Missing token for private data | Labeled paste-token form; no private request until supplied |
| Invalid token | Clear previous private results and show replacement form; no automatic public fallback |
| Valid token, expired/inactive link | Metadata and analytics remain available; show explicit status and available management actions |
| Public expired link | Expired notice; offer saved-token entry for management |
| Unknown/deleted/blocked | Unavailable/not-found state without guessing the hidden reason |
| Confirmed deletion | Remove local credential and cached views; focus the next logical heading |

Expired owner metadata is not a forced 410 screen. A remembered token rejected with 401 must not leave old analytics visible. Token replacement, rejection or forgetting clears private metadata as well as analytics, including retained results. See the [credential transition rules](data-fetching.md#query-keys-and-credential-transitions).

Use a confirmation dialog naming the link before DELETE. Wait for server confirmation for edits/deletion; avoid optimistic destructive state. Repeated DELETE with a valid token succeeds with 204, but never automatically retry PATCH/DELETE. After an ambiguous network outcome explain that the write may have succeeded, and offer reconciliation/manual retry.

“Forget this link” and “Clear remembered links” remove local access, not the server link or token's validity. Explain that a saved token elsewhere still works. If device storage is denied, full or corrupt, keep the app usable in memory and show whether remembering/forgetting actually succeeded. Cross-tab forget/replace must clear private results in open tabs.

## Analytics is V1

Display:

- Click, human-click and bot-click totals and a zero-filled daily series for the requested rollup range.
- Top 10 referrer **origins**, top 10 countries and device categories from the available raw-event window (last 90 UTC days, including today). Provide tables even if charts are used; label null categories “Unknown,” not “Direct.”
- The effective `breakdowns.from`/`to` and a retention notice when `breakdowns.truncated` is true. No overlap returns null boundaries and empty arrays: show “No breakdowns available for this range,” without erasing rollup totals. Do not imply top-10 rows sum to all clicks.
- A refresh action and distinct fetch/processing freshness messages. `last_processed_at` is the latest retained event ingestion timestamp and may be null; `data_through` is null in V1 because complete coverage cannot be certified. “Checked just now” means only that a fetch succeeded, not that processing is current.

Controls use UTC calendar dates. API ranges are `[from,to)` with `to` exclusive, maximum 366 days, no end beyond tomorrow UTC and no dates outside two-year rollup retention. Last-7/30-day presets end tomorrow UTC and include today. For example, on 2026-10-23 UTC, Last 30 days requests `from=2026-09-24&to=2026-10-24`. Label “All dates UTC”; if displaying an inclusive end date, show October 23 while sending October 24. Do not shift daily bucket labels into the viewer's local timezone.

On the first load, use a labeled skeleton or loading region, not invented zero totals. On refresh or a new range, retain prior results only for the same link and credential generation, labeled with their actual range and “Updating.” If refresh fails, show the last successful range and an inline retry warning. Never relabel retained results as new data. Clear them for token changes or authoritative access/state failures.

Zero-filled daily rows mean no processed clicks for those days, not proof of a fully drained pipeline. For fresh links or missing watermarks, say “Analytics processing may be delayed” or “Processing status not yet available.” Do not promise one-minute freshness, invent estimates, or show a never-ending loading state for a valid empty response. See [backend analytics](../backend/analytics.md).

Privacy copy must match V1: aggregate clicks and limited recent breakdowns; **no IP-hash or unique-visitor collection**. Do not call referrer origins full browsing history or label human clicks as unique people.

## Validation and feedback

Mirror the [API validation rules](../backend/api.md) for UX, with server errors authoritative:

- Destination: absolute HTTP(S), no credentials/control characters, up to 8192 characters. Use `type="url"`, `inputMode="url"`, no auto-capitalization; do not claim client checks prove a target safe.
- Alias: 3–32 lowercase letters/digits/`_`/`-`, alphanumeric ends; show a short-URL preview and reserved-name guidance.
- Expiry: optional future time, at most five years ahead. A `datetime-local` input must identify the user's timezone and convert to a UTC timestamp; handle invalid/ambiguous local times instead of appending `Z` to local input.
- Map server `errors[]` by `field`; show unrecognized fields in the form summary. Use `aria-invalid` and `aria-describedby` and focus the first invalid field after submission.
- Distinguish 409 codes: alias conflict asks for another alias; `request_in_progress` offers manual same-request retry; `idempotency_conflict` explains that the pending request cannot be reused with changed data. Network failure preserves the existing create key/body. A body change starts a new request and warns about the uncertain previous outcome.
- Show 429 retry timing without automatic resubmission. A cancelled action should not produce an offline/error toast or an automatic retry.

Use inline alerts for errors requiring action; toasts alone are insufficient. Include a request-ID disclosure where available, never raw response text. Offline detection is a hint, not proof of server reachability.

## Accessibility acceptance

- One page heading, logical heading order, landmarks, skip link and route-specific document titles. A route change moves focus to the page heading; background refresh does not move focus.
- Every input has a visible associated label; every action works by keyboard, with visible focus. Icon-only buttons have accessible names; decorative icons are hidden from assistive technology.
- Modal dialogs trap focus and restore it on close; nonmodal popovers use their appropriate keyboard pattern, not a blanket focus trap.
- Use a polite status region for copy/create/refresh outcomes; urgent actionable errors remain discoverable inline. Mark loading regions `aria-busy` without repeatedly announcing entire tables.
- Charts have summaries and equivalent accessible tables, including dates, counts and empty/unknown categories. Color never carries status or bot/human distinctions alone.
- Meet WCAG 2.2 AA contrast (4.5:1 normal text, 3:1 large text and relevant UI boundaries). Aim for 44×44 px touch targets, respect reduced motion, and support 200% zoom and 320 px reflow.
- Reserve space for async content; wrap actions and long values. A full URL must remain available without requiring a pointer hover.
- Render all API/user strings as text, not HTML. Restrict clickable destinations to validated HTTP(S); outbound links use `rel="noopener noreferrer"`. Never echo an arbitrary unmatched route into telemetry or an error page.

The SPA not-found view provides a clear route home but ordinarily arrives in an HTTP-200 HTML response; only hosting changes can provide a true document 404. See [deployment](deployment.md).

Before release, test create/backup, clipboard failure, token replacement and cross-tab forget, delete confirmation, all error/loading states, UTC controls and chart tables with keyboard and a screen reader. Automated axe/component tests are planned checks, not evidence of conformance today.
