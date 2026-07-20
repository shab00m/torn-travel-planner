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

Latest stock levels from the most recent successful YATA poll (in-memory cache).

**Response:** `{ stocks, timestamp, lastError }`

Returns **503** if YATA has not been polled yet.

---

### `GET /api/stocks/status`

Lightweight poll probe — timestamp only, for detecting new YATA snapshots without downloading full stock data.

**Response:** `{ timestamp, lastError }`

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
    { "yata_ts": 1783961506, "quantity": 781, "cost": 782617 }
  ]
}
```

---

### `GET /api/restocks/:country/:itemId`

Recent out-of-stock periods and in-stock depletion-rate windows (newest first, up to 50).

**Response:** `{ restocks, rates }`

- `restocks[]` — `{ depleted_ts, restocked_ts, duration, ignored }`
- `rates[]` — `{ start_ts, end_ts, start_qty, end_qty, rate, open }` (rate in items/minute)

---

### `PATCH /api/restocks/:country/:itemId/:depletedTs`

Mark a restock cycle as ignored (excluded from averages).

**Body:** `{ "ignored": true | false }`

**Response:** `{ ok, restocks, rates }`

---

### `POST /api/restocks/:country/:itemId/flag-outliers`

Scan completed cycles for this item and set `ignored` on empty-for outliers (typically from snapshot gaps). Uses an iterative robust modified Z-score (median/MAD, threshold 2.5) so each item’s own cluster defines the band — extreme gaps are removed first, then clearer misses (e.g. ~44m next to a 55–65m group), without dropping near-cluster values. The normal-range baseline uses only cycles that still have Count checked; already-unchecked rows are never included. Rate averages follow automatically because ignored cycles are excluded from rate windows too. Does not re-include cycles that were already ignored.

New cycles are also checked automatically when YATA polling closes an empty period.

**Response:** `{ ok, flagged, depletedTs, restocks, rates }`

- `flagged` — number of cycles newly ignored
- `depletedTs` — `depleted_ts` values that were flagged

---

### `POST /api/restocks/:country/:itemId/backfill`

Admin only. Rebuild restock cycles for this item by replaying its snapshot history through the depletion/restock transition logic. Clears that item’s existing restock rows first; previously ignored cycles are restored onto covering cycles when possible.

**Response:** `{ ok, opened, closed, restocks, rates }`

- `opened` — depletion transitions recorded
- `closed` — restock closes recorded

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
| `stockoutTiming` | string | `"avg"` | How to pick empty-for duration from history: `"avg"`, `"min"`, or `"max"`. When `"avg"`, uses the most recent `avgSamples` restock cycles. Matches **“Avg empty for”** on the item page. |
| `rateTiming` | string | `"avg"` | How to pick depletion rate from history: `"avg"`, `"min"`, or `"max"`. When `"avg"`, uses the most recent `avgRateSamples` in-stock windows. Matches **“Rate avg”** on the item page. |
| `avgSamples` | integer | `5` | Number of recent out-of-stock periods to average when `stockoutTiming` is `"avg"`. |
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

## Snapshots (manual edit)

Mutating snapshot routes require a whitelisted admin (`X-Api-Key` or `apiKey` in the body). The Data Inspector UI is only shown to admins.

### `GET /api/snapshots/:country/:itemId/:yataTs`

**Response:** `{ country, itemId, yata_ts, quantity, cost }`

---

### `PATCH /api/snapshots/:country/:itemId/:yataTs`

Admin only. Update snapshot fields. Changing `yata_ts` replaces the primary-key row.

**Body:** any of `{ yata_ts, quantity, cost }`

**Response:** `{ ok, snapshot, restocks, rates }`

---

### `DELETE /api/snapshots/:country/:itemId/:yataTs`

Admin only.

**Response:** `{ ok, restocks, rates }`

---

### `POST /api/snapshots/:country/:itemId/delete`

Admin only. Bulk delete.

**Body:** `{ "yata_ts": [1783961506, 1783960900] }`

**Response:** `{ ok, deleted, restocks, rates }`

---

## Torn API proxy

These relay requests to the Torn API. The server does not store API keys.

### `POST /api/login`

Validate a Torn API key against the Torn API (`user/?selections=basic,perks`), then check the local whitelist.

Requires a Torn API key with **Minimal** access (or a Custom key that includes `user: basic` and `user: perks`). Public keys return Torn error 16.

**Body:** `{ "apiKey": "..." }`

**Response:** `{ name, playerId, level, travelType, capacity, baseCapacity, bonusCapacity, capacityPerks, isAdmin, isAllowed }`

Returns **403** if the Torn account is not in the `users` table with `is_allowed`.

---

### Users (admin only)

All `/api/users` routes require a whitelisted admin. Pass the Torn API key as `X-Api-Key` (or `apiKey` in the JSON body for mutating requests).

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

**Body:** `{ "itemId": 206, "apiKey": "..." }` — `apiKey` optional if `TORN_API_KEY` is set on the server.

**Response:** `{ itemId, marketPrice }`

---

### `GET /api/markets`

Cached market prices for all known items.

**Response:** `{ prices, fetchedAt, cacheTtlSec }`

`prices` is `{ [itemId]: number | null }`.
