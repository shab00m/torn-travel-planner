# Development journal

## 2026-09-26 — World Tourism Day travel capacity

The reported issue was that the planner still displayed normal carrying capacity while World Tourism Day was active in Torn. Investigation found that `src/torn.js` calculated base capacity plus additive travel perks, but never applied an event multiplier.

We checked Torn's API schema and event documentation. The API does not provide a ready-calculated travel capacity field. API v2 `torn/calendar` provides event dates and the `fixed_start_time` flag; `user/calendar` provides the player's personal start time in TCT. Tourism Day uses personal event timing and runs for 48 hours, so a simple September 27 date check would be insufficient.

Implementation:

- Login now fetches the Torn calendar and, when needed, the player's calendar start time. Personal timing shifts the event window while preserving its duration; the start is inclusive and the end exclusive.
- During Tourism Day, general carrying capacity is doubled. The response includes `capacityMultiplier`, while `baseCapacity` and `bonusCapacity` retain their original values for the breakdown.
- The header and capacity tooltip identify the Tourism Day bonus.
- Calendar errors preserve login and return normal capacity with `capacityWarning`. The header visibly marks the event bonus as unverified, with retry and Custom-key permission guidance in the tooltip.
- Flower/plushie-specific perks are excluded from general carrying slots. This does not implement separate item-specific capacity calculations; those job bonuses must not be doubled or applied to every item.
- Removed the guest capacity input's maximum of 50 so guests can enter event-sized capacities manually.
- Updated `README.md`, `docs/API.md`, and the API terms disclosure with the calendar selections and new behavior.

Validation completed during the session:

- `node --test test/torn.test.js`: all five tests passed. Coverage includes personal start/end boundaries, fixed-time events, unrelated events, doubled perk totals, normal capacity outside the event, and calendar permission failures.
- `node --check` passed for `src/torn.js`, `public/auth.js`, `public/api-tos.js`, and `public/shared.js`.
- `git diff --check` passed after correcting the changed guest input line's whitespace.

The API tests use mocked responses. A live authenticated Torn response and the deployed UI were not verified during this session. Capacity refreshes on login/page reload; an already-open page does not automatically update at an event boundary. Custom keys need `torn/calendar` and `user/calendar` for complete event detection. Guest capacity remains manual.

At journal-writing time, the implementation is present in commit `76db98a` (`tourism day integration`). No deployment was performed by the assistant, and Railway deployment status was not checked. The existing Railway project, services, and cron configuration were unchanged.

References consulted:

- [Torn OpenAPI schema](https://www.torn.com/swagger/openapi.json)
- [Torn current events and personal time slots](https://wiki.torn.com/wiki/Current_Events)
- [Torn travel capacity and Tourism Day exceptions](https://wiki.torn.com/wiki/Travel)

## 2026-09-26 — Follow-up: live calendar parsing correction

The user reported that capacity still showed `38 slots — event bonus unverified`, even with a Full access key. This exposed two incorrect assumptions in the first implementation and its mocked test data.

Using the existing local operator key for read-only Torn requests, we observed that `user/calendar` returns a start time such as `10:15 TCT`. The parser only accepted a bare clock time, causing the warning. We also found that `torn/calendar` represents Tourism Day with the nominal September 27 calendar date (`1790467200` through `1790553599` in 2026), rather than the actual 48-hour personal event window.

The parser now accepts the TCT suffix and surrounding whitespace. For a nominal single-day Tourism Day entry, it constructs a 48-hour window beginning on the preceding day at the player's personal start time. Full event windows retain their duration, and fixed-time events continue to use their API timestamps.

Regression tests now use the observed calendar response format and check that 38 normal slots become 76 on September 26. All seven tests passed, along with the server module syntax check and whitespace validation. A live `getPlayerInfo` call then returned base capacity 15, bonus capacity 23, total capacity 76, multiplier 2, and no warning. No API key or player identity was printed or added to the journal.

The correction is local and has not been deployed by the assistant. The earlier statement that no live authenticated response had been verified applies to the initial implementation, not this follow-up. The original mocked tests failed to catch the real response format; higher API key access was not the cause of this failure.
