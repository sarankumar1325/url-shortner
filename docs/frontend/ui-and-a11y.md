# UI and Accessibility

Status: auth, workspace, link and analytics screens implemented; shadcn/ui and automated accessibility checks are not used · Related: [architecture](architecture.md), [data fetching](data-fetching.md), [API contract](../backend/api.md)

## Design and scope

Build a calm workspace product: create an account, work in a personal or shared workspace, create short links, invite teammates and understand clicks. Use system fonts, shared color/spacing tokens, a mobile-first layout and selected accessible primitives rather than a new component framework. Light/dark themes must both meet contrast requirements. Do not claim that a component library by itself guarantees accessibility.

V1 includes email/password accounts, personal and shared workspaces, invitations, four roles, editing, deletion, bulk actions and CSV import/export, password-protected links, smart redirects, a QR studio (see [system design](../system-design.md#qr-studio)) and rich analytics (totals, daily series, referrer origins, countries and devices). Password reset, email verification, SSO and unique-visitor reporting are not in V1; do not imply they exist.

## Auth and onboarding

- `/login` and `/signup` share one focused form layout: labeled email, password (with an accessible show/hide control), optional display name on sign-up, a submit button with pending state, and a link to the other mode. Preserve the `next` return path, but never allow an absolute or protocol-relative redirect.
- Password guidance appears before submission (“At least 10 characters”). Do not enforce composition rules the server does not enforce.
- Fields carry `name` and `autocomplete` attributes for password managers: the sign-in email uses `username`, passwords use `current-password` or `new-password`. Emails are trimmed before submission. The change-password form in Settings includes a hidden `username` field so managers update the right entry.
- A **Stay signed in** checkbox, on by default, sends `remember`. Unchecked, the session ends when the browser closes and after 24 hours at most.
- The password field warns when Caps Lock is on, and when a pasted password starts or ends with a space or ends with a line break, because passwords are compared exactly.
- After 2 seconds the pending button reads “Still signing in…”. A `429` shows a countdown and keeps the button disabled until it ends. Offline, unreachable server, timeout and 5xx failures each get their own message, and none blames the user's details.
- The typed email carries over when switching between sign-in and sign-up. There is no forgot-password link because there is no reset flow.
- Invalid credentials produce one form-level message that does not reveal whether the email exists. `409 email_taken` maps to the email field and points to sign-in.
- After sign-up/sign-in, focus the workspace page heading and announce that the personal workspace is ready. Sign-out asks for confirmation only if unsaved drafts exist, then clears all private views.
- When the session is loading, show a non-flashing checking state; an anonymous user is redirected to `/login?next=…`.
- `/invite/:token` previews workspace name, role, inviter and optional bound email. Joining requires a session; anonymous visitors get sign-in/sign-up actions that return to the invitation. Expired/revoked/accepted invitations show a closed state, not a form error.

## Workspace shell and navigation

The authenticated shell contains a skip link, a sidebar with primary navigation, an account menu with sign-out, and a status region. On small screens the sidebar becomes a drawer and stays reachable without hover. There is no workspace switcher in the sidebar; other workspaces are listed in the command palette (below).

- Choosing a workspace in the palette updates `X-Workspace-Id`, clears the link list and navigates to `/` before rendering new data. Settings also switches workspace from the account-deletion blocker list.
- The create screen has a labeled destination field, optional alias and expiry disclosure, a submit action, a result region and the workspace link list. “Recent links on this device” is replaced by server-backed workspace links; a copy of a code is not proof of authorization.
- Members shows the member list to everyone; invite and role controls appear only for admins/owners. The owner row is visibly immutable. Self-service “Leave” is available for non-owners.
- Role changes and removals show the target name and role, wait for server confirmation, and refresh the row from the response. Never optimistically remove a person.
- Workspace creation is a small labeled dialog or inline form; after success, switch to it and focus its heading.

### Command palette

⌘K or Ctrl+K opens the command palette (`src/CommandPalette.tsx`, matching in `src/palette.ts`) from anywhere, including a text field, unless another dialog is open. It is a modal `<dialog>` with a combobox input ("Search links, pages and actions") that controls a listbox; the highlighted option is exposed with `aria-activedescendant`. Arrow keys move and wrap, Enter runs the highlighted command, Esc or ⌘K/Ctrl+K closes it, and focus returns to where it was.

Results are grouped as Links (5 recent before typing, up to 8 matches, also matching code, destination and tags), Pages, Actions and Workspaces. Actions are create a link and import CSV (members and above), export CSV (when links exist), switch theme, collapse or expand the sidebar (wide screens), help and sign out. Workspaces lists the other workspaces with their role. Matching prefers exact, then prefix, then word-start, then substring, then in-order letters; a multi-word query needs every word to match. An empty result shows a status message.

## Create and result

Validate on interaction/submission, preserve drafts on failure, and disable duplicate submits while a request is pending. Do not steal focus on initial load.

After confirmed creation:

1. Move focus to **Copy link**, so Enter copies immediately; also show **Open link**. The short URL appears in a read-only field that selects all on click or focus. Keep the full destination available through an accessible disclosure rather than a hover-only tooltip.
2. For a workspace link, state that it is live in the named workspace and that members can manage it. There is **no management token** to back up.
3. For a legacy unauthenticated create (outside the normal product UI), present the one-time management-token backup before dismissal: reveal, **Copy management token**, “If you lose it, the server cannot recover it,” and an unchecked **Remember on this device** option that warns same-origin scripts can read it.
4. Clear the revealed value and transient create result on exit. Announce “Link copied” or “Management token copied” without announcing the secret.

### Copying

`copyText` (`src/clipboard.ts`) tries the Clipboard API, then `document.execCommand('copy')`, and if both are blocked (embedded browsers, plain-HTTP pages) the shell opens a manual-copy dialog with the value preselected. Short links are always copied as full `https://` URLs (`fullUrl`). Copy buttons share this path through `useCopy()` in the create result, link list rows, Top links on the overview, the dashboard link-health table, link details (short link, `+` preview link and destination), the QR studio and invite links.

### Keyboard shortcuts and paste

Single-key shortcuts are ignored while typing in a field, with modifier keys held, or while a dialog is open. The help dialog (`?`) lists them:

| Key | Action |
| --- | --- |
| `N` | New link |
| `/` | Search links |
| `C` | Copy the focused row, else the hovered row, else the open link (detail page or new result) |
| `[` | Collapse or expand the sidebar |
| `?` | Shortcut help |
| ⌘K / Ctrl+K | Command palette (works in text fields too) |
| ⌘V / Ctrl+V | Outside a text field, a pasted URL opens the create form prefilled |

`C` reads `data-copy-url` from the focused or hovered element; the page-level fallback is marked `data-copy-default`. A global paste that is a URL, or a bare domain (which gets `https://`), fills the destination and focuses **Shorten link**, so Enter creates it. Anything else is ignored, and pastes into fields behave normally.

### Campaign (UTM) fields

The create form's campaign options have labeled Source, Medium, Campaign, Term (optional) and Content (optional) fields (`src/utm.ts`). Pasting a destination that already has `utm_*` parameters fills the fields from it. Values are appended without rewriting the rest of the query; if the URL already has a parameter being added, an inline alert asks the user to choose **Replace existing** or leave the field blank. With **Replace existing**, the URL's own UTM values are swapped for the fields, and clearing every field removes them. The last 8 values per field are remembered per workspace in `localStorage` (`shortly.utm.v1:<workspace id>`) and offered through a `<datalist>`; blocked storage only means no suggestions. The link detail page shows the destination's campaign values as chips.

### Link password

The create form's **Customize your link** options include a **Require a password** checkbox that reveals a labeled **Link password** field; CSV import accepts a `password` column. The detail page has a password field with **Set password** or **Change password** and **Remove**, using `aria-invalid` and a hint linked with `aria-describedby`. Passwords are 4–128 characters, counted as code points and never trimmed. The hint explains that changing it asks visitors who already unlocked the link for the new one, and that link previews show a locked page. The visitor-facing password page is server-rendered by the backend ([API](../backend/api.md#password-protected-links)) with a labeled field, `autocomplete="current-password"`, and an error announced with `role="alert"` and tied to the field.

Creation replay can return the same response for 24 hours; it is transport recovery, not an ongoing reveal screen. Workspace replay never contains a token.

## Link page and management

`/links/:code` displays metadata, UTC date controls, analytics and allowed management actions. A copied route shares no authorization.

| State | Presentation |
| --- | --- |
| Valid session, member+ | Full metadata, edit, pause/resume and delete |
| Valid session, viewer | Metadata and analytics; create/edit/delete disabled with an explanation |
| Invalid/expired session | Redirect to sign-in with a return path; do not show stale private data |
| Workspace no longer accessible | Fall back to the personal workspace; other workspaces stay reachable from the command palette; no retry loop |
| Legacy link, no token | Public metadata where available; labeled paste-token form for private data |
| Invalid legacy token | Clear previous private results and show the replacement form; no public fallback |
| Expired/inactive link, authorized | Metadata and analytics remain available; show explicit status and allowed actions |
| Public expired link | Expired notice; authorized users may still open management |
| Unknown/deleted/blocked | Unavailable/not-found state without guessing the hidden reason |
| Confirmed deletion | Remove cached views; focus the next logical heading |

### Bulk selection

On the links list (`src/LinkList.tsx`, helpers in `src/bulk.ts`) members get a checkbox per row (`Select <code>`) and a header checkbox, "Select all visible links", that selects every row the current filters show, or clears them when all are selected. Selections that a filter hides drop out of the action. A sticky region, "Actions for selected links", shows the count and **Pause**, **Resume**, **Add tag**, **Remove tag**, **Export selected**, **Delete** (with a confirmation dialog) and **Clear selection**. Requests are sent in chunks of 200 codes, retry `429` after `Retry-After`, and update rows from the per-code results; the outcome summary (for example "2 were not found") goes to the status region. Rows carry **Password** and **Smart** badges for protected links and links with redirect rules.

CSV import accepts `long_url,custom_alias,expires_at,tags,fallback_url,max_clicks,password`, creates three rows at a time and waits out `429` responses. CSV export columns end with `fallback_url,max_clicks,clicks_used,has_password,smart_rules`.

### Smart redirect rules

The detail page's **Smart redirects** section (`src/SmartRulesEditor.tsx`, validation in `src/smartRules.ts`) edits up to 10 rules, each in a numbered card:

- Devices are checkbox chips (iPhone and iPad, Android, Any phone, Any tablet, Desktop) inside a `<fieldset>` with the legend "Devices".
- A labeled **Countries** input takes two-letter codes separated by commas or spaces; its hint shows the country names, or the error.
- A labeled **Send these visitors to** URL input is validated like the main destination.
- Invalid fields get `aria-invalid` and `aria-describedby` pointing at their error; a missing condition is linked to the device fieldset. On save, focus moves to the first invalid field. Server errors such as `redirect_rules.2.url` map back to that rule.
- Icon buttons have names such as "Move rule 2 up", "Move rule 2 down" and "Remove rule 2". **Add rule** and **Save rules** follow the list; Save is disabled while nothing has changed.

A hint states that rules are checked top to bottom, the first match wins, and every condition set in a rule must match.

Use a confirmation dialog naming the link before DELETE. Wait for server confirmation for edits/deletion; avoid optimistic destructive state. Repeated DELETE with the same valid scope succeeds with 204, but never automatically retry PATCH/DELETE. After an ambiguous network outcome explain that the write may have succeeded and offer reconciliation/manual retry.

“Forget this link” (legacy only) removes local access, not the server link or token validity. Explain that a saved token elsewhere still works. If device storage is denied, full or corrupt, keep the app usable in memory and show whether remembering/forgetting actually succeeded. Cross-tab forget/replace must clear private results in open tabs.

## Analytics is V1

Display:

- Click, human-click and bot-click totals and a zero-filled daily series for the requested rollup range.
- Top 10 referrer **origins**, top 10 countries and device categories from the available raw-event window (last 90 UTC days, including today). Provide tables even if charts are used; label null categories “Unknown,” not “Direct.”
- The effective `breakdowns.from`/`to` and a retention notice when `breakdowns.truncated` is true. No overlap returns null boundaries and empty arrays: show “No breakdowns available for this range,” without erasing rollup totals. Do not imply top-10 rows sum to all clicks.
- A refresh action and distinct fetch/processing freshness messages. `last_processed_at` is the latest retained event ingestion timestamp and may be null; `data_through` is null in V1 because complete coverage cannot be certified. `freshness` reports queue lag, pending count/age, dead letters and Redis availability, so show “Ingestion queue is clear,” “N clicks queued (oldest X min),” or an unavailable warning. “Checked just now” means only that a fetch succeeded, not that processing is current.

Range controls are a labeled button group with 7, 30, 90 and 365 day presets (`aria-pressed`) and **Custom**, which opens a From/To form with inclusive UTC dates, at most 366 days and ending no later than today. Breakdowns use the selected range (still limited to the 90-day raw window). **Compare to previous period** (`aria-pressed`) loads the period of the same length just before it, shows the change on each total ("+12% vs previous 30 days") and draws it as a dashed line; the chart summary mentions the comparison in text. **Export CSV** downloads the daily series followed by the breakdowns in one file with a `section` column.

Controls use UTC calendar dates. API ranges are `[from,to)` with `to` exclusive, maximum 366 days, no end beyond tomorrow UTC and no dates outside two-year rollup retention. Last-7/30-day presets end tomorrow UTC and include today. For example, on 2026-10-23 UTC, Last 30 days requests `from=2026-09-24&to=2026-10-24`. Label “All dates UTC”; if displaying an inclusive end date, show October 23 while sending October 24. Do not shift daily bucket labels into the viewer's local timezone.

On the first load, use a labeled skeleton or loading region, not invented zero totals. On refresh or a new range, retain prior results only for the same link and workspace/credential scope, labeled with their actual range and “Updating.” If refresh fails, show the last successful range and an inline retry warning. Never relabel retained results as new data. Clear them on workspace/session/credential changes or authoritative access/state failures.

Zero-filled daily rows mean no processed clicks for those days, not proof of a fully drained pipeline. For fresh links or missing watermarks, say “Analytics processing may be delayed” or “Processing status not yet available.” Do not promise one-minute freshness, invent estimates, or show a never-ending loading state for a valid empty response. See [backend analytics](../backend/analytics.md).

Privacy copy must match V1: aggregate clicks and limited recent breakdowns; **no IP-hash or unique-visitor collection**. Do not call referrer origins full browsing history or label human clicks as unique people.

## Validation and feedback

Mirror the [API validation rules](../backend/api.md) for UX, with server errors authoritative:

- Email: use `type="email"`, `autoComplete` appropriate to sign-in/sign-up, and surface `email_taken` on the field.
- Password: at least 10 and at most 128 characters; show an accessible reveal control and allow paste, with a warning for leading/trailing whitespace in the pasted value.
- Destination: absolute HTTP(S), no credentials/control characters, up to 8192 characters. Use `type="url"`, `inputMode="url"`, no auto-capitalization; do not claim client checks prove a target safe.
- Alias: 3–32 lowercase letters/digits/`_`/`-`, alphanumeric ends; show a short-URL preview and reserved-name guidance.
- Expiry: optional future time, at most five years ahead. A `datetime-local` input must identify the user's timezone and convert to a UTC timestamp; handle invalid/ambiguous local times instead of appending `Z` to local input.
- Workspace name: 1–80 visible characters after whitespace normalization; show the trimmed result before submit.
- Map server `errors[]` by `field`; show unrecognized fields in the form summary. Use `aria-invalid` and `aria-describedby` and focus the first invalid field after submission.
- Distinguish 409 codes: `email_taken`, `alias_taken`, `request_in_progress` and `idempotency_conflict` each have different recovery copy. Network failure preserves the existing create key/body. A body or workspace change starts a new request and warns about the uncertain previous outcome.
- `401 authentication_required` clears private views and returns to sign-in. `403 csrf_rejected` is a configuration error, not a retryable action. `403 forbidden` refreshes role state and explains the missing permission. `404 workspace_not_found` falls back to the personal workspace; other workspaces are reachable from the command palette.
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
- The workspace role select and destructive buttons must have names that include the target person, not just “Remove” repeated down a list.

The SPA not-found view provides a clear route home but ordinarily arrives in an HTTP-200 HTML response; only hosting changes can provide a true document 404. See [deployment](deployment.md).

Settings ends with a **Delete account** danger section. It needs the current password and the account email typed again; the button stays disabled until a password is entered and the email matches. If the account owns shared workspaces with other members, the `409` is shown as a list of those workspaces (each switches to that workspace) with instructions to transfer or delete them first. On success the app returns to sign-in with a one-time “Your account was deleted.” notice.

Before release, test sign-up/sign-in/validation, invite acceptance and role boundaries, workspace switching from the command palette, bulk selection, the smart rule editor, link create/backup (legacy), clipboard failure, token replacement and cross-tab forget, delete confirmation, all error/loading states, UTC controls and chart tables with keyboard and a screen reader. Automated axe/component tests are planned checks, not evidence of conformance today.
