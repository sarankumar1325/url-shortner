# Product improvement plan

## Product direction

Make Shortly a useful home for links people share repeatedly: create a trustworthy link quickly, understand where it was shared, and know when it needs attention. The current product already offers workspaces, tags, QR downloads, bulk import, and click analytics, so new work should connect those strengths rather than duplicate them.

## Priorities

1. **Make the first share effortless.** Clarify destination and expiry behavior, improve empty and error states, and make the next action after creation obvious. Measure creation completion and time to first copied link, with privacy-conscious event collection and consent where appropriate.
2. **Make campaigns easier to measure.** Start with optional UTM fields and a destination preview during creation (implemented in the first increment). Next, explore reusable campaign presets and creating one link per channel. UTM values are passed to the destination; they are not currently a breakdown in Shortly's own analytics. Validate demand with users before adding reporting or storage.
3. **Turn analytics into decisions.** Explain date ranges, data freshness, and bot handling in plain language; show useful comparisons only when data is sufficient. Consider a campaign view that groups related links, with explicit grouping and backend support rather than inferring relationships from tags alone.
4. **Help people maintain links.** Surface expired, paused, or approaching-expiry links and offer clear recovery actions. Investigate destination health checks carefully: network access, SSRF protections, frequency, and false alarms need a backend design first.
5. **Build trust and team confidence.** Test keyboard and screen-reader journeys, mobile layouts, role permissions, error recovery, and abuse reporting. Give teams clear ownership and activity history before adding more administrative controls.

## Unique angle: trust you can see

Most shorteners hide the destination, which is exactly why people distrust short links. Shortly leans the other way: every link can be inspected before it is opened, dead links explain themselves, and the product says plainly what it measures. Each increment below should strengthen that promise.

## Shipped: trust and first-share increment

- **Peek.** Adding `+` to any short link (`/{code}+`) shows the destination, its expiry and offline warning signs (plain HTTP, raw IP, look-alike punycode domain, another shortener hiding the real target, unusual port) before visiting. It never fetches the destination and never counts a click. The link detail page has **Copy preview link**, and the creation result explains the `+` trick.
- **Readable dead ends.** Browsers opening an expired, paused, removed or unknown link get a branded page with next steps and a report link instead of raw JSON. API clients still receive Problem Details.
- **Keyboard shortcuts.** `N` creates a link, `/` focuses search, `?` opens help; they are ignored while typing or when a dialog is open.

## Next increments (proposed, not built)

1. **Expiry fallback destination.** Optional `fallback_url` so an expired campaign link lands somewhere useful instead of the expired page. Needs a migration, validation shared with `long_url`, and cache-entry changes.
2. **Click caps (self-expiring links).** Optional `max_clicks` for one-time or limited links. Needs an atomic Redis counter on the redirect path and a clear rule for cache staleness and bot clicks.
3. **Device-aware destinations.** Separate iOS, Android and desktop targets for app-install links, using the existing device classification.
4. **Campaign presets and per-channel links.** Save UTM presets and generate one tagged link per channel from a single destination.
5. **Traffic spikes.** Highlight links whose daily clicks jump well above their recent baseline, shown only when there is enough data.
6. **Link activity history.** Who created, edited, paused or retagged a link, building team confidence before adding more admin controls.
7. **Destination health checks.** Only after a backend design for SSRF protections, frequency, cost and false alarms.

## Validation and sequencing

Observe a few people creating, sharing, finding, and updating links on desktop and mobile. Track task completion and confusion points before prioritizing the next increment. Ship each improvement behind existing permissions, keep API and accessibility behavior covered, and check analytics data accuracy and operational costs before expanding reporting. The campaign builder is a first step, not evidence that users need a larger campaign suite.
