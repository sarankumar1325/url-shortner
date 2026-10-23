# UI System and Accessibility

Status: target design · Stack: Tailwind CSS v4, shadcn/ui, Radix primitives

## Design direction

The product should feel like a utility: fast, calm, and trustworthy. The primary action is obvious, the result is copyable in one click, and advanced options stay out of the way.

Principles:

- **One job per screen.** Create on the home page; understand one link on the analytics page.
- **Show the outcome.** After creation, the short URL and copy action dominate.
- **Explain limits before failure.** Alias rules and expiry are visible near the fields.
- **No dark patterns.** No forced sign-up, no hidden expiry, no misleading copy.
- **Accessible by default.** Keyboard, screen reader, contrast, and reduced motion are part of every component.

## Tailwind v4 + shadcn setup

```bash
bun add tailwindcss @tailwindcss/vite
bunx shadcn@latest init
```

`vite.config.ts`:

```ts
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": "/src" },
  },
});
```

`src/shared/styles/index.css`:

```css
@import "tailwindcss";

@theme {
  --color-background: oklch(1 0 0);
  --color-foreground: oklch(0.16 0.02 250);
  --color-primary: oklch(0.55 0.2 255);
  --color-muted: oklch(0.96 0.01 250);
  --radius-lg: 0.75rem;
}
```

- Use CSS variables and Tailwind tokens rather than scattered hex values.
- Support light and dark themes through the `dark` class; default to the system preference.
- Keep the font stack local (system UI fonts) to avoid render-blocking font requests.
- Add only the shadcn components that are used; they are copied into the repo and tree-shaken.

## Component inventory

| Area | Components |
| --- | --- |
| Primitives | Button, Input, Label, Card, Badge, Skeleton, Alert, Dialog, Tooltip, Toast |
| Forms | URL field, alias field, expiry field, advanced disclosure, submit button |
| Result | Short URL display, copy button, open link, manage/analytics actions |
| Recent links | Compact list, copy action, status badge, empty state |
| Analytics | Summary cards, daily chart, date range controls, token prompt |
| Feedback | Inline field errors, form-level alert, loading skeleton, 404 panel |

Use shadcn/ui primitives for focus management and ARIA behavior rather than building dialogs, popovers, or toasts from scratch.

## Screens

### Home

```text
Header: product name · theme toggle · GitHub/docs link

Hero: "Shorten a link in one step"
Form:
  [ Destination URL                     ] [ Shorten ]
  Advanced: custom alias, expiry
Result card (after success):
  short.example/abc123        [Copy] [Open]
  destination (truncated)
  [Analytics] [Manage]
Recent links (this browser):
  code · destination · created · [Copy] [Analytics]
```

- Destination URL is required and focused on load.
- The submit button shows a pending state and is disabled during submission.
- Advanced options are collapsed by default.
- The result card receives focus after creation so keyboard users land on the outcome.
- Recent links are local to the browser and clearly labeled as such.

### Link analytics

```text
Back to home
short.example/sysdesign   [Copy] [Open]
Destination (truncated, expandable)
Date range: [Last 7 days] [Last 30 days] [Custom]
Totals: Clicks · Human · Bots
Daily chart
[Refresh]  Last updated ...
Manage: edit destination · change expiry · delete
```

- Missing token → token paste form with an explanation that the token was shown once.
- Deleted link → 404 state with a link home.
- Expired link → 410 state; analytics may still be available with a token.
- Fresh links show a note that analytics can lag by up to a minute.

### Not found

- Clear message, link home, no stack trace.
- Preserve the requested path in the message for support.

## State matrix

Every data surface implements all states:

| State | Treatment |
| --- | --- |
| Idle | Form ready; no empty skeleton |
| Loading | Skeleton matching the final layout; `aria-busy` |
| Empty | Helpful explanation + primary action |
| Error | Specific message, retry, request ID |
| Success | Result or data; focus moves appropriately |
| Partial | Show available totals; mark series as delayed |
| Offline | Banner; preserve input; retry when online |

## Forms and validation

- Use React Hook Form with a Zod schema.
- Client validation mirrors server rules for UX: absolute URL, max length, alias regex, expiry in the future.
- Server errors map to fields when a `field` is present; otherwise show a form-level alert.
- Error text is connected with `aria-describedby`; invalid inputs set `aria-invalid`.
- Do not disable the submit button merely because the form is invalid on first render; show errors after interaction.
- Use `type="url"`, `inputMode="url"`, and `autoCapitalize="none"` for the destination field.
- Use `datetime-local` for expiry in v1 to avoid a custom date picker; convert to UTC before sending.
- Show a character counter for the alias and a preview of the resulting short URL.

## Accessibility requirements

**Structure**

- One `<h1>` per page; logical heading order.
- Landmarks: `<header>`, `<main>`, `<footer>`, `<nav>` where appropriate.
- Skip link to main content.
- Document title updates per route.

**Keyboard and focus**

- Every action is reachable by Tab and operable by Enter/Space.
- Visible focus ring with at least 3:1 contrast against the background.
- Dialog and popover focus is trapped and restored on close.
- After create success, focus the result heading or copy button.
- After delete, focus the next logical element or the page heading.

**Screen readers**

- Labels for every input; placeholders are not labels.
- `aria-live="polite"` region for copy confirmation, create success, and async errors.
- Status badges include text, not color alone.
- Charts include a text summary and an accessible data table or list.
- Icons that duplicate text are `aria-hidden`; icon-only buttons have `aria-label`.

**Visual**

- WCAG 2.2 AA contrast (4.5:1 for normal text, 3:1 for large text and UI boundaries).
- Minimum 44×44 px touch targets.
- Respect `prefers-reduced-motion`; disable non-essential transitions.
- Support 200% zoom and 320 px width without horizontal scrolling.
- Do not rely on color alone for error, success, or bot/human status.

**Content**

- Error messages say what happened and what to do next.
- Use plain language; avoid "422", "idempotency", and internal codes in primary copy.
- Put technical details (request ID) behind a disclosure.
- Confirm destructive actions (delete link) with a dialog that names the link.

## Responsive layout

- Mobile-first single column.
- Content max width around 960 px on desktop.
- Form and result stack on mobile; result actions wrap rather than overflow.
- Long URLs truncate with a middle ellipsis and a title/tooltip; the full value is available to assistive technology.
- The analytics chart is horizontally scrollable only if a minimum readable width cannot be preserved; otherwise stack summary cards.

## Visual and interaction details

- Use one primary button per view.
- Copy action gives immediate feedback ("Copied") and resets after ~2 seconds.
- Pending actions use a spinner plus text, not spinner alone.
- Destructive actions use a distinct, accessible danger style.
- Empty recent links state includes a short explanation, not a blank panel.
- Do not use toast notifications for errors that need action; use inline alerts.

## Security in the UI

- Never inject URLs or aliases with `dangerouslySetInnerHTML`.
- Treat API strings as untrusted; React escapes text by default.
- External links use `rel="noopener noreferrer"`.
- Do not display management tokens in the DOM after storage; allow replace/forget.
- CSP (configured in deployment) blocks inline scripts, third-party scripts, and framing.

## Content checklist

- [ ] Product name and short domain are consistent.
- [ ] Alias rules are visible before submission.
- [ ] Expiry is explicit and shown in local time with a UTC hint.
- [ ] The result card explains that the management token is saved in this browser.
- [ ] Privacy copy explains hashed-IP analytics.
- [ ] Error copy is actionable and free of internal jargon.
- [ ] Empty states offer a next step.

## Future UI work

- QR code generation and download.
- Link editing dialog with optimistic updates.
- Referrer/country/device breakdowns.
- Account dashboard and team management.
- Internationalization; keep copy in one module when that lands.
