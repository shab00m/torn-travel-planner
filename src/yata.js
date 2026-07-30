import { saveSnapshot } from "./db.js";

const YATA_URL = "https://yata.yt/api/v1/travel/export/";
const POLL_INTERVAL_MS = 60_000;

let latest = null; // last successful payload, served to the frontend
let lastError = null;
let fetchInFlight = false;
let persistInFlight = false;
/** Newest payload waiting to persist while a prior saveSnapshot is still running. */
let persistQueued = null;

async function fetchOnce() {
	const res = await fetch(YATA_URL, { signal: AbortSignal.timeout(15_000) });
	if (!res.ok) {
		throw new Error(`YATA responded with HTTP ${res.status}`);
	}
	const payload = await res.json();
	if (!payload?.stocks) {
		throw new Error("YATA payload is missing the 'stocks' field");
	}
	return payload;
}

async function persistStocks(stocks) {
	const inserted = await saveSnapshot(stocks);
	console.log(
		`[yata] persisted OK at ${new Date().toISOString()}, ${inserted} new snapshot rows`,
	);
}

/**
 * Persist without blocking the next YATA fetch. If a save is already running,
 * keep only the newest payload and save it when the current one finishes.
 */
async function enqueuePersist(payload) {
	persistQueued = payload;
	if (persistInFlight) return;
	persistInFlight = true;
	try {
		while (persistQueued) {
			const next = persistQueued;
			persistQueued = null;
			try {
				await persistStocks(next.stocks);
			} catch (err) {
				lastError = err.message;
				console.error(`[yata] saveSnapshot failed: ${err.message}`);
			}
		}
	} finally {
		persistInFlight = false;
	}
}

async function poll() {
	if (fetchInFlight) {
		console.warn("[yata] skipping poll — previous fetch still in flight");
		return;
	}
	fetchInFlight = true;
	try {
		const payload = await fetchOnce();
		// Serve live stocks immediately; DB persistence must not block fetches.
		latest = payload;
		lastError = null;
		console.log(`[yata] fetched OK at ${new Date().toISOString()}`);
		void enqueuePersist(payload);
	} catch (err) {
		lastError = err.message;
		console.error(`[yata] fetch failed: ${err.message}`);
	} finally {
		fetchInFlight = false;
	}
}

export function startPolling() {
	poll();
	setInterval(poll, POLL_INTERVAL_MS);
}

export function getLatest() {
	return { payload: latest, lastError };
}
