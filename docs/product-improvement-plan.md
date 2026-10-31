# Product improvement plan

## Product direction

Make Shortly a useful home for links people share repeatedly: create a trustworthy link quickly, understand where it was shared, and know when it needs attention. The current product already offers workspaces, tags, QR downloads, bulk import, and click analytics, so new work should connect those strengths rather than duplicate them.

## Priorities

1. **Make the first share effortless.** Clarify destination and expiry behavior, improve empty and error states, and make the next action after creation obvious. Measure creation completion and time to first copied link, with privacy-conscious event collection and consent where appropriate.
2. **Make campaigns easier to measure.** Start with optional UTM fields and a destination preview during creation (implemented in the first increment). Next, explore reusable campaign presets and creating one link per channel. UTM values are passed to the destination; they are not currently a breakdown in Shortly's own analytics. Validate demand with users before adding reporting or storage.
3. **Turn analytics into decisions.** Explain date ranges, data freshness, and bot handling in plain language; show useful comparisons only when data is sufficient. Consider a campaign view that groups related links, with explicit grouping and backend support rather than inferring relationships from tags alone.
4. **Help people maintain links.** Surface expired, paused, or approaching-expiry links and offer clear recovery actions. Investigate destination health checks carefully: network access, SSRF protections, frequency, and false alarms need a backend design first.
5. **Build trust and team confidence.** Test keyboard and screen-reader journeys, mobile layouts, role permissions, error recovery, and abuse reporting. Give teams clear ownership and activity history before adding more administrative controls.

## Validation and sequencing

Observe a few people creating, sharing, finding, and updating links on desktop and mobile. Track task completion and confusion points before prioritizing the next increment. Ship each improvement behind existing permissions, keep API and accessibility behavior covered, and check analytics data accuracy and operational costs before expanding reporting. The campaign builder is a first step, not evidence that users need a larger campaign suite.
