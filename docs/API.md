# API reference

Base URL: `http://localhost:3000` (or your deployed host).

All JSON responses use `Content-Type: application/json`. Errors return `{ "error": "message" }` with an appropriate HTTP status.

## Country codes

Used in path parameters as `:country`:

| Code | Destination |
|------|-------------|
| `mex` | Mexico |
| `cay` | Cayman Islands |
| `can` | Canada |
| `haw` | Hawaii |
| `uni` | United Kingdom |
| `arg` | Argentina |
| `swi` | Switzerland |
| `jap` | Japan |
| `chi` | China |
| `uae` | UAE |
| `sou` | South Africa |

---

## Stocks & countries

### `GET /api/countries`

Country metadata and one-way flight durations (seconds) for each travel type.

**Response:** `{ [countryCode]: { name, flag, flightSec: { Standard, Airstrip, Private, Business } } }`

Flight times are derived from [Torn Travel handbook](https://www.torntravel.com/handbook/getting-started) standard durations, scaled by travel type.

---

### `GET /api/stocks`

Latest committed DB observation for each country/item, including both YATA and
API submissions. The newest `snapshot_ts` wins, with API preferred on ties.

**Response:** `{ stocks, timestamp, lastError }`

The existing shape is preserved: `stocks[country] = { update, stocks: [...] }`.
Each item contains `{ id, name, quantity, cost, source, snapshot_ts }`.
Country `update` is the newest item timestamp in that country; top-level
`timestamp` is the newest observation timestamp across the feed.

Works with API-only data, even if YATA has never been fetched successfully.
Returns **503** only if no observations exist or the DB read fails. Responses
disable browser caching. DB reads are shared for up to two seconds, invalidated
immediately when the server receives a committed snapshot notification.

---

### `GET /api/stocks/status`

Lightweight revision probe for detecting new committed snapshots without downloading full stock data.

**Response:** `{ ready, timestamp, lastError, snapshotRevision }`

`ready` and `timestamp` come from committed DB observations, not the YATA cache.
`snapshotRevision` changes on committed DB inserts, including historical API
observations whose timestamp does not advance the latest timestamp. Optional
`country` and `itemId` query parameters must be supplied together and scope both
the revision and timestamp to one item. Invalid scopes return 400. Responses disable caching.

### `GET /api/snapshots/events`

Server-sent event stream. `ready` events signal connection/reconnection and require
a catch-up refresh. `snapshots` events contain `{ revision, items }`, with each
item identified by `{ country, itemId, snapshot_ts }`. Events are delivered only
after the snapshot/restock transaction commits. Heartbeats keep idle connections
open; clients automatically reconnect and refresh after interruptions.

### `GET /api/items/:country/:itemId/stock`

Latest DB observation: `{ country, itemId, name, snapshot_ts, quantity, cost, source }`.
The latest timestamp wins, with API preferred over YATA for a tie. Returns 404 if
no observation exists. This endpoint disables caching and supplies current item
stock and restock-alarm confirmation. `/api/stocks` uses the same latest-observation
rule for the full country/item feed.

---

## Item history & restocks

Path parameters: `:country`, `:itemId` (integer).

### `GET /api/history/:country/:itemId`

Snapshot history from the database.

| Query param | Type | Default | Description |
|-------------|------|---------|-------------|
| `hours` | number | `24` | How far back to include. `0` = all snapshots. |

**Response:**

```json
{
  "country": "uni",
  "itemId": 206,
  "points": [
    { "snapshot_ts": 1783961506, "quantity": 781, "cost": 782617, "source": "YATA" }
  ]
}
```

---

### `GET /api/restocks/:country/:itemId`

Out-of-stock periods and in-stock depletion-rate windows (newest first, full history).

**Response:** `{ restocks, rates, rateTod }`

- `restocks[]` — `{ depleted_ts, restocked_ts, duration, ignored, adjusted_depleted_ts, adjusted_restocked_ts, adjusted_duration }`
  - `depleted_ts` / `restocked_ts` — first observed qty=0 / first in-stock snapshots
  - `adjusted_depleted_ts` — rate-extrapolated empty start (always set when known)
  - `adjusted_restocked_ts` / `adjusted_duration` — restock-amount back-extrapolation and effective empty-for (`adjusted_restocked − adjusted_depleted`); `adjusted_restocked_ts` is null when no restock amount is configured
- `rates[]` — `{ start_ts, end_ts, start_qty, end_qty, rate, open }` (rate in items/minute)
- `rateTod` — `{ hours: (number|null)[24], updatedAt: number|null }` minute-weighted average depletion rate by Torn City Time (UTC) hour-of-day, rebuilt daily from all completed non-ignored rate windows. Missing hours are `null`.

---

### `PATCH /api/restocks/:country/:itemId/:depletedTs`

Mark a restock cycle as ignored (excluded from averages).

**Body:** `{ "ignored": true | false }`

**Response:** `{ ok, restocks, rates }`

The item page sends `includeViews: false` for a compact response: `{ ok, depletedTs, ignored, bounds, rates }`. It queues rapid checkbox changes and disables each pending checkbox until its save completes. The server serializes the write with snapshot ingestion and rebuilds; a lock wait longer than five seconds returns HTTP 409 with a retry message.

---

### `POST /api/restocks/:country/:itemId/flag-outliers`

Scan completed cycles for this item and set `ignored` on empty-for outliers (typically from snapshot gaps). Uses an iterative robust modified Z-score (median/MAD, threshold 2.5) so each item’s own cluster defines the band — extreme gaps are removed first, then clearer misses (e.g. ~44m next to a 55–65m group), without dropping near-cluster values. The normal-range baseline uses only cycles that still have Count checked; already-unchecked rows are never included. Rate averages follow automatically because ignored cycles are excluded from rate windows too. Does not re-include cycles that were already ignored.

Admin only. If either min/max empty-for bound is configured, only the configured range is used: cycles whose effective empty-for (`adjusted_duration` if set, otherwise `duration`) falls outside it are ignored. Endpoints are inclusive. Median/MAD checks run only when neither bound is configured, so points inside a manual window are kept even if they differ from the historical cluster.

New cycles are checked automatically when live ingestion closes an empty period. Historical imports and snapshot rebuilds also apply configured bounds to rebuilt cycles.

**Response:** `{ ok, flagged, depletedTs, restocks, rates }`

- `flagged` — number of cycles newly ignored
- `depletedTs` — `depleted_ts` values that were flagged

---

### `POST /api/restocks/:country/:itemId/flag-outside-window`

Admin only. Requires both min and max empty-for to be configured; returns HTTP 400 if either is missing. Marks existing completed cycles outside the inclusive window as ignored, using adjusted duration when available and observed duration otherwise. Leaves open cycles and existing exclusions unchanged. Repeated calls only count newly excluded cycles.

**Response:** `{ ok, flagged, depletedTs, restocks, rates }`

The item page exposes this as **Exclude outside window**, visible only to admins and disabled until both bounds are saved.

---

### `POST /api/restocks/:country/:itemId/backfill`

Admin only. Rebuild restock cycles for this item by replaying its snapshot history through the depletion/restock transition logic. Only replaces cycles that can still be derived from remaining snapshots (plus any open/incomplete cycles). Closed restocks older than the oldest remaining snapshot are kept. Previously ignored flags on rebuilt cycles are restored onto covering cycles when possible.

**Response:** `{ ok, opened, closed, restocks, rates }`

- `opened` — depletion transitions recorded
- `closed` — restock closes recorded

The item page sends `{ "background": true }` and receives HTTP 202 with `{ jobId, country, itemId, status }`. It polls the admin-only `GET /api/restocks/:country/:itemId/backfill/:jobId` for `queued`, `running`, `completed` (with `result: { opened, closed }`), or `failed` (with `error`). Completion refreshes the item data. Without `background`, the synchronous response above remains supported.

Background jobs run in the existing web process, one at a time. Repeated starts for an active item return its current job. Completed jobs are retained for 30 minutes; a web process restart loses job status, and polling returns HTTP 404 with instructions to refresh the saved history before retrying.

Rebuilds use the same per-item transaction lock as snapshot ingestion. A busy item fails immediately with a retry message (HTTP 409 for synchronous requests, `failed` status for background jobs). Replay skips sub-minute empty periods and computes adjusted times in bulk. Database timeouts return HTTP 503 for synchronous requests or a failed background job. Server logs include the item, error code, and duration.

---

## Restock amounts (database)

Per-item “full restock quantity” used for safe-window prediction. Stored server-side; the web UI reads/writes these endpoints.

### `GET /api/restock-amounts`

**Response:** `{ "amounts": { "uni:206": 2500, "chi:1494": 5000 } }`

Keys are `"country:itemId"`.

---

### `GET /api/restock-amounts/:country/:itemId`

**Response:** `{ country, itemId, amount }` — `amount` is `null` if not configured.

---

## Empty-for bounds (database)

Optional per-item min/max empty-for duration (seconds) plus a stored average. When min/max are set, stockout MIN/MAX use these values instead of the shortest/longest historical cycle. `avgEmptyFor` is calculated on the server: midpoint of min and max when both are set, otherwise the mean of the last 100 non-excluded cycles. It is not client-writable.

### `GET /api/empty-for-bounds`

**Response:** `{ "bounds": { "uni:206": { "minEmptyFor": 3000, "maxEmptyFor": 4200, "avgEmptyFor": 3600 } } }`

Keys are `"country:itemId"`. Missing fields are `null`.

---

### `GET /api/empty-for-bounds/:country/:itemId`

**Response:** `{ country, itemId, minEmptyFor, maxEmptyFor, avgEmptyFor }` — unset fields are `null`.

---

### `PUT /api/empty-for-bounds/:country/:itemId`

Set or clear the range. The server recomputes `avgEmptyFor`. Existing exclusion flags stay unchanged; use `flag-outside-window` to apply the window to existing history. The row is deleted only when min, max, and avg are all unset.

**Body:** `{ "minEmptyFor": 3000, "maxEmptyFor": 4200 }` — seconds; either field may be `null`. `avgEmptyFor` in the body is ignored.

**Response:** `{ country, itemId, minEmptyFor, maxEmptyFor, avgEmptyFor, flagged, depletedTs }`

- `flagged` — always `0`; saving bounds does not change existing exclusions
- `depletedTs` — always `[]`

---

### `PUT /api/restock-amounts/:country/:itemId`

Set or clear the restock amount.

**Body:** `{ "amount": 2500 }` or `{ "amount": null }` to delete.

**Response:** `{ country, itemId, amount }`

---

## Safe windows

Safe-window endpoints use **database snapshots only** (not live YATA). They read the stored restock amount automatically when `restockAmount` is omitted.

A **safe window** is the range from the latest possible restock time to the earliest possible depletion time. Window #1 uses the known (or currently projected) depletion. Later windows **compound** historical min/max empty-for across cycles (latest path uses max empty-for; earliest path uses min empty-for + depletion). Depletion uses a single rate: the selected historical rate when `safeWindowUseRateSelection` is true (UI: **Use for safe window**), otherwise the fastest historical rate. Each subsequent window shrinks and often disappears by #2 or #3 once the envelope collapses (`safeStart >= safeEnd`).

To match the web UI, pass the same options the app sends (see [Safe window options](#safe-window-options) below). UI preferences live in browser `localStorage` (`plannerPrefs`); the server does not read them unless you pass them in the request.

### `GET /api/safe-window/:country/:itemId`

Compute the next leave window where you can still arrive during a safe stock period.

**Query parameters:** all [safe window options](#safe-window-options) are supported as query params.

**Example:**

```
GET /api/safe-window/uni/206?predictionHours=24&safeWindowUseRateSelection=true&travelType=Standard
```

**Response:**

```json
{
  "country": "uni",
  "itemId": 206,
  "available": true,
  "restockAmount": 2500,
  "safeWindow": {
    "safeStart": 1783990140,
    "safeEnd": 1783990180,
    "leaveEarliest": 1783981080,
    "leaveLatest": 1783981120,
    "depletedTs": 1783982316
  },
  "reason": null,
  "hint": null
}
```

When `available` is `false`, `safeWindow` is `null` and `reason` explains why:

| `reason` | Meaning |
|----------|---------|
| `no_stock_data` | No snapshots in the database for this item |
| `insufficient_history` | Not enough restock/rate history to compute |
| `no_upcoming_restock` | No valid safe window in the prediction horizon |
| `missed` | A safe window exists but the leave-by time has already passed |
| `unknown_travel_type` | Invalid `travelType` |

`hint` may contain a human-readable suggestion when `reason` is set.

All timestamps are Unix seconds.

---

### `POST /api/safe-windows`

Batch safe-window lookup (used by the favorites list).

**Body:**

```json
{
  "items": [
    { "country": "uni", "itemId": 206 },
    { "country": "chi", "itemId": 1494, "restockAmount": 5000 }
  ],
  "predictionHours": 24,
  "safeWindowUseRateSelection": true,
  "travelType": "Airstrip",
  "flightTimeVariance": true,
  "avgSamples": 5,
  "avgRateSamples": 3,
  "stockoutTiming": "avg",
  "rateTiming": "avg"
}
```

- `items` (required) — array of `{ country, itemId }`. Per-item `restockAmount` overrides the database value for that item only.
- Remaining fields are [safe window options](#safe-window-options) applied to every item.

**Response:**

```json
{
  "windows": {
    "uni:206": { "country": "uni", "itemId": 206, "available": true, "safeWindow": { ... }, "reason": null, "restockAmount": 2500 }
  }
}
```

Keys are `"country:itemId"`.

---

### Safe window options

Used as query params on `GET /api/safe-window/...` or as JSON body fields on `POST /api/safe-windows`.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `restockAmount` | integer | DB value | Full quantity when the item restocks. Overrides the stored value for this request. |
| `predictionHours` | number | `24` | How far ahead (hours) to predict restock/stockout events. |
| `travelType` | string | `"Standard"` | `"Standard"`, `"Airstrip"`, `"Private"`, or `"Business"`. Affects one-way flight time used for leave-by times. |
| `flightTimeVariance` | boolean | `true` | If `true`, apply ±3% flight-time variance (fast for earliest leave, slow for latest). |
| `safeWindowUseRateSelection` | boolean | `true` | If `true`, use the selected historical depletion rate for safe-window bounds. If `false`, use the fastest (`max`) historical rate (shorter, pessimistic window). Matches the item page checkbox **“Use for safe window”**. |
| `historicalRatePrediction` | boolean | `false` | If `true`, use Torn City Time hour-of-day average depletion rates instead of `rateTiming` avg/min/max. Matches **“Historical depletion rate prediction”**. |
| `historicalRateMaxAgeDays` | integer | _(none)_ | When historical rate prediction is on, only use rate-window history newer than this many days. Omit for all history. Matches **“Max age”**. |
| `stockoutTiming` | string | `"avg"` | How to pick empty-for duration from history: `"avg"`, `"min"`, or `"max"`. When `"avg"`, uses the stored `avgEmptyFor`. When `"min"` or `"max"`, uses the item’s configured min/max empty-for if set, otherwise the shortest/longest historical cycle. Matches the stockout timing buttons on the item page. |
| `rateTiming` | string | `"avg"` | How to pick depletion rate from history: `"avg"`, `"min"`, or `"max"`. When `"avg"`, uses the most recent `avgRateSamples` in-stock windows. Matches **“Rate avg”** on the item page. |
| `avgSamples` | integer | `5` | Unused for stockout timing (kept for older clients). Stored `avgEmptyFor` is used instead. |
| `avgRateSamples` | integer | `3` | Number of recent in-stock windows to average when `rateTiming` is `"avg"`. |

**Matching the web UI**

The item detail page and favorites list pass options from browser state. A bare GET with no params uses server defaults, which often differ from logged-in / configured UI settings. Minimum params to match a typical configured item page:

```
?predictionHours=24
&safeWindowUseRateSelection=true
&travelType=<your travel type>
&rateTiming=avg
&stockoutTiming=avg
```

`restockAmount` is loaded from the database automatically if set on the item page.

---

## Internal snapshot ingestion

### `PUT /api/internal/snapshots`

Insert observations collected outside YATA. Requires the server's
`INTERNAL_API_KEY` environment variable in the **`X-Internal-Key`** header.
This is separate from Torn API keys and admin login; query parameters and body
fields cannot authorize a request. The key is never sent to the frontend.
Set the variable in local `.env` or on the Railway web service. Missing or blank
configuration disables ingestion with HTTP 503; there is no hardcoded fallback.

**Headers:** `Content-Type: application/json`, `X-Internal-Key: <INTERNAL_API_KEY>`

**Body:**

```json
{
  "snapshots": [
    {
      "country": "mex",
      "itemId": 260,
      "name": "Dahlia",
      "snapshot_ts": 1793799852,
      "quantity": 100,
      "cost": 300
    }
  ]
}
```

- A batch contains 1–100 records, with all fields above required.
- `country` must be one of the codes returned by `/api/countries`.
- `itemId` is a positive 32-bit integer; `name` is trimmed and limited to 255 characters.
- `snapshot_ts` is positive Unix **seconds**, at most 60 seconds ahead of the server clock.
- `quantity` and `cost` are non-negative safe integers (JSON numbers).
- Omit `source`: the server always records `API` and rejects attempts to specify it.
- Duplicate `(country, itemId, snapshot_ts, source)` identities within a batch are invalid (`source` is always `API` for this endpoint).

**Response (202):** `{ "accepted": true }`

The server authenticates and validates the batch, queues it in memory, and returns
immediately without waiting for PostgreSQL. Acceptance does not confirm persistence.
The background writer processes batches serially; a failed batch is logged and the
next batch continues. Up to 100 batches may wait behind the active write; a full
queue returns HTTP 503. Queued/in-flight uploads may be lost if the process exits.
There is no durable queue or automatic retry.

Each batch executes one atomic `INSERT INTO snapshots ... ON CONFLICT DO NOTHING`,
with source fixed to `API`. Existing country/item/timestamp/source identities are
skipped without changing data. YATA and API observations at the same timestamp
remain independent; API wins ties in effective-history and latest-stock reads.
No item metadata, restock events, depletion rates, or other derived calculations
are updated by this upload path. `name` remains required for payload compatibility,
but does not update the item catalogue; catalogue-backed listings require an
existing item entry.

After a successful commit, the existing PostgreSQL `snapshot_updates` trigger
notifies the web listener. It relays changed items through
`GET /api/snapshots/events`; matching armed browser alarms recheck current stock
and can confirm a restock without a rebuilt restock row. Notifications describe
changed snapshots, not guaranteed zero-to-positive transitions. Historical derived
calculations require an explicit backfill; YATA retains its existing tracking path.

**Errors before acceptance:** 401 for a missing/incorrect key; 400 for an invalid
batch (nothing queued); 503 for missing/blank server key configuration or a full queue.

Authenticated requests include an `X-Request-Id` response header. Background
completion/failure logs include the same request ID, batch/item counts, and duration.
Failure logs contain redacted diagnostic details; persistence errors do not change
the already-sent 202 response. Callers do not need to parse a persistence receipt.

Imports appear in database-backed stock/history and the admin Data Inspector's
Source column after persistence. The same 30-day snapshot retention applies to
both sources.

---

## Snapshots (manual edit)

Mutating snapshot routes require a whitelisted admin (`X-Api-Key` or `apiKey` in the body). The Data Inspector UI is only shown to admins.
Single-row GET, PATCH and DELETE routes accept `?source=API` or `?source=YATA`
(default `YATA`). Source is part of row identity; operations only target that
source. The inspector supplies the selected row's source automatically.

### `GET /api/snapshots/:country/:itemId/:snapshotTs`

**Response:** `{ country, itemId, snapshot_ts, quantity, cost, source }`

---

### `PATCH /api/snapshots/:country/:itemId/:snapshotTs`

Admin only. Update snapshot fields. Changing `snapshot_ts` replaces the primary-key row.
The observation's original `source` is preserved.

**Body:** any of `{ snapshot_ts, quantity, cost }`

**Response:** `{ ok, snapshot, restocks, rates }`

---

### `DELETE /api/snapshots/:country/:itemId/:snapshotTs`

Admin only.

**Response:** `{ ok, restocks, rates }`

---

### `POST /api/snapshots/:country/:itemId/delete`

Admin only. Bulk delete.

**Body:** `{ "snapshots": [{ "snapshot_ts": 1783961506, "source": "API" }, { "snapshot_ts": 1783960900, "source": "YATA" }] }`

The legacy `{ "snapshot_ts": [1783961506, 1783960900] }` form only deletes YATA rows.

**Response:** `{ ok, deleted, restocks, rates }`

---

## Torn API proxy

These relay requests to the Torn API. The server does not store API keys.

### `POST /api/login`

Validate a Torn API key against the Torn API (`user/?selections=basic,perks`), then ensure a local user row.

Missing accounts are auto-created with `is_allowed = true` (and `is_admin = false`). Uncheck Allowed in the users admin UI to blacklist someone.

Requires a Torn API key with **Minimal** access (or a Custom key that includes `user: basic` and `user: perks`). Public keys return Torn error 16.

**Body:** `{ "apiKey": "..." }`

**Response:** `{ name, playerId, level, travelType, capacity, baseCapacity, bonusCapacity, capacityMultiplier, capacityPerks, capacityWarning, isAdmin, isAllowed }`

From September 25 through September 29 inclusive (TCT/UTC), login also reads API v2 `torn/calendar` and, for events using personal start times, `user/calendar`. Outside this two-day margin around September 27, both calendar requests are skipped and normal capacity is returned without an event warning. Custom keys should include both calendar selections. During the player's Tourism Day window, `capacityMultiplier` is 2 and `capacity` is twice the sum of base and general perk capacity. The base and bonus fields remain the unmultiplied breakdown. Item-specific flower/plushie job slots are excluded from general capacity.

Calendar failures do not prevent login: normal capacity is returned with a visible `capacityWarning` explaining that the event bonus could not be verified. On success the warning is null. Capacity is recalculated on login/page reload; guest capacity remains manually controlled.

Returns **403** if the Torn account exists in `users` with `is_allowed` false.

---

### Users (admin only)

All `/api/users` routes require an allowed admin. Pass the Torn API key as `X-Api-Key` (or `apiKey` in the JSON body for mutating requests).

### `GET /api/users`

**Response:** `{ users: [{ playerId, name, isAdmin, isAllowed, createdAt, updatedAt, lastLoginAt }] }`

### `POST /api/users`

**Body:** `{ "playerId": 123, "name": "...", "isAdmin"?: false, "isAllowed"?: true }`

**Response:** created user object (201).

### `PATCH /api/users/:playerId`

**Body:** partial `{ name?, isAdmin?, isAllowed? }`

### `DELETE /api/users/:playerId`

**Response:** `{ ok: true }`

Admins cannot demote, disallow, or delete their own account. The last remaining admin cannot be demoted or deleted.

---

### Analytics

### `POST /api/page-views`

Record a page load. Called automatically from the client after auth resolves. IP is taken from `X-Real-IP` when present (Railway edge), otherwise `req.ip` / the socket address.

**Body:** `{ "url": "/item/uni/206", "playerId"?: 123 }`

If `playerId` is present and matches a whitelist user, their current username is stored. Anonymous loads omit `playerId`.

**Response:** created page-view object (201).

### `GET /api/page-views` (admin only)

| Query param | Type | Default | Description |
|-------------|------|---------|-------------|
| `limit` | number | `100` | Max rows (1–500). |
| `offset` | number | `0` | Pagination offset. |

**Response:** `{ views: [{ id, createdAt, url, ipAddress, playerId, name }] }` ordered newest first.

Requires `X-Api-Key` of a whitelisted admin.

---

### `POST /api/travel`

Check if the player is currently flying to a country (`user/?selections=travel`).

Requires **Minimal** access (or Custom with `user: travel`).

**Body:** `{ "apiKey": "...", "country": "uni" }`

**Response:** `{ flyingToCountry, arriveTs }`

---

### `POST /api/market`

Fetch market price for one item (uses server cache when possible).

**Body:** `{ "itemId": 206, "apiKey": "..." }` — `apiKey` optional when a cached price exists. Live Torn fetch uses the visitor's key only; the server key is reserved for cron.

**Response:** `{ itemId, marketPrice }`

---

### `GET /api/markets`

Cached market prices for all known items.

**Response:** `{ prices, fetchedAt, cacheTtlSec }`

`prices` is `{ [itemId]: number | null }`.
