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
  "flightTimeVariance": false,
  "avgSamples": 5,
  "avgRateSamples": 5,
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
| `flightTimeVariance` | boolean | `false` | If `true`, apply ±3% flight-time variance (fast for earliest leave, slow for latest). |
| `safeWindowUseRateSelection` | boolean | `false` | If `true`, use the selected historical depletion rate for safe-window bounds. If `false`, use the fastest (`max`) historical rate (shorter, pessimistic window). Matches the item page checkbox **“Use for safe window”**. |
| `stockoutTiming` | string | `"avg"` | How to pick empty-for duration from history: `"avg"`, `"min"`, or `"max"`. When `"avg"`, uses the most recent `avgSamples` restock cycles. Matches **“Avg empty for”** on the item page. |
| `rateTiming` | string | `"avg"` | How to pick depletion rate from history: `"avg"`, `"min"`, or `"max"`. When `"avg"`, uses the most recent `avgRateSamples` in-stock windows. Matches **“Rate avg”** on the item page. |
| `avgSamples` | integer | `5` | Number of recent out-of-stock periods to average when `stockoutTiming` is `"avg"`. |
| `avgRateSamples` | integer | `5` | Number of recent in-stock windows to average when `rateTiming` is `"avg"`. |

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

### `GET /api/snapshots/:country/:itemId/:yataTs`

**Response:** `{ country, itemId, yata_ts, quantity, cost }`

---

### `PATCH /api/snapshots/:country/:itemId/:yataTs`

Update snapshot fields. Changing `yata_ts` replaces the primary-key row.

**Body:** any of `{ yata_ts, quantity, cost }`

**Response:** `{ ok, snapshot, restocks, rates }`

---

### `DELETE /api/snapshots/:country/:itemId/:yataTs`

**Response:** `{ ok, restocks, rates }`

---

### `POST /api/snapshots/:country/:itemId/delete`

Bulk delete.

**Body:** `{ "yata_ts": [1783961506, 1783960900] }`

**Response:** `{ ok, deleted, restocks, rates }`

---

## Torn API proxy

These relay requests to the Torn API. The server does not store API keys.

### `POST /api/login`

Validate a Torn API key and return player travel info.

**Body:** `{ "apiKey": "..." }`

**Response:** `{ name, playerId, level, travelType, capacity, baseCapacity, bonusCapacity, capacityPerks }`

---

### `POST /api/travel`

Check if the player is currently flying to a country.

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
