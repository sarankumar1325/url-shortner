# Frontend Performance

Status: target design · Related: [Frontend architecture](architecture.md) · [UI system](ui-and-a11y.md)

## Performance budgets

Measured at p75 on a mid-tier mobile device over 4G:

| Metric | Budget |
| --- | --- |
| LCP | < 2.5 s |
| INP | < 200 ms |
| CLS | < 0.1 |
| TTFB (HTML) | < 800 ms |
| Initial JS (gzip) | < 200 KB |
| Initial CSS (gzip) | < 30 KB |
| Analytics route JS (gzip, lazy) | < 150 KB |
| Total transferred for first view | < 500 KB |

Budgets are enforced in CI with `size-limit`; Lighthouse/Playwright checks run on the preview deployment.

## Why this app can be fast

- It is a static SPA served from Vercel's CDN; there is no server render to wait for.
- The home screen needs only a form and local storage; it does not need charts or analytics libraries.
- Short-link creation is a single POST; redirects happen outside the app.
- System fonts avoid render-blocking font downloads.
- There are no large images or third-party scripts in v1.

## Loading strategy

### Route-level code splitting

```tsx
const LinkAnalyticsPage = lazy(() => import("@/pages/link-analytics-page"));

<Route
  path="/links/:code"
  element={
    <Suspense fallback={<RouteSkeleton />}>
      <LinkAnalyticsPage />
    </Suspense>
  }
/>
```

- Home and the 404 page are eager.
- Analytics and its chart library load only when the route is visited.
- The Suspense fallback mirrors the final layout to avoid layout shift.

### Heavy dependencies

- Import icons individually (`lucide-react` is tree-shakeable).
- Import only the shadcn components used.
- Load Recharts with the analytics route, never from the home route.
- Prefer `Intl.DateTimeFormat` or a small `date-fns` import over a large date library.
- Avoid adding an animation library for simple CSS transitions.

### Network hints

Add to `index.html`:

```html
<link rel="preconnect" href="https://api.short.example" crossorigin />
<link rel="dns-prefetch" href="https://api.short.example" />
<link rel="preconnect" href="https://short.example" />
```

- Preconnect only to origins used on the critical path.
- Do not preconnect to preview or third-party domains.
- The API is called after user action, so preconnect is a hint, not a blocker.

## Data fetching performance

- TanStack Query deduplicates concurrent requests for the same key.
- `staleTime` prevents refetch storms: 30 s for metadata, 60 s for analytics.
- `refetchOnWindowFocus` is disabled; analytics polls only while visible.
- No request is made while the user types; validation is local and the API is called on submit.
- Query cache is in memory and cleared on full reload; do not persist it in v1.
- The recent-links list reuses cached metadata and caps the number of visible items.

## Rendering performance

- Keep the home route free of chart and date-picker code.
- Split provider trees so the analytics page does not remount global providers.
- Memoize expensive chart transforms (`useMemo`) and keep chart data small (daily buckets).
- Do not use `useMemo`/`memo` by default; profile first.
- Use CSS for hover/focus states; avoid JS-driven animations.
- Reserve space for async content (fixed chart height, skeleton cards) to prevent CLS.

## Caching and delivery

| Asset | Header |
| --- | --- |
| `/assets/*` (hashed) | `public, max-age=31536000, immutable` |
| `/index.html` | `no-cache` (revalidate) |
| API responses | handled by the API; redirects are `no-store` |

- Vercel serves hashed assets from the CDN edge.
- Do not add a service worker in v1; it complicates deploys and analytics.
- HTTP/2/3 and Brotli are provided by Vercel.

## Measuring

### Local

```bash
bun run build
bun run preview
```

- Chrome DevTools Lighthouse (mobile, throttled).
- Network panel: verify the analytics chunk is not loaded on `/`.
- React Profiler for interaction regressions.

### CI

- `size-limit` on initial and route chunks.
- Playwright trace for the create flow.
- Lighthouse CI on the preview URL (optional but recommended).
- Fail the build on budget regressions rather than relying on review.

### Production

- Vercel Speed Insights for Core Web Vitals by route.
- Optional Sentry performance for slow API calls and route transitions.
- Track JS error rate and API error rate separately.
- Use the deployed commit SHA to correlate regressions with releases.

## API and UX performance

- Show optimistic UI only where it is safe; link creation waits for the server because the short code is server-generated.
- Copy acts immediately; no network is required.
- Disable duplicate submits while a create is pending.
- Cap recent links to avoid rendering hundreds of rows; add pagination if the list grows.
- Use a single request for analytics ranges rather than per-day calls.
- Truncate long URLs from the middle for layout stability, preserving the full value for assistive technology.

## Regression checklist

- [ ] Analytics chunk is absent from the initial network waterfall.
- [ ] Initial JS and CSS are within budget.
- [ ] LCP/INP/CLS pass on a throttled mobile profile.
- [ ] No layout shift when the result card or chart appears.
- [ ] No duplicate API calls for the same query key.
- [ ] No third-party scripts except explicitly approved analytics/error tools.
- [ ] Images are SVG or optimized and have explicit dimensions.
- [ ] Fonts are system fonts or self-hosted with `font-display: swap`.
