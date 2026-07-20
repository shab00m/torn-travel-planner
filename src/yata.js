import { saveSnapshot } from "./db.js";

const YATA_URL = "https://yata.yt/api/v1/travel/export/";
const POLL_INTERVAL_MS = 60_000;

let latest = null; // last successful payload, served to the frontend
let lastError = null;
let pollInFlight = false;

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

async function poll() {
	if (pollInFlight) {
		console.warn("[yata] skipping poll — previous poll still in flight");
		return;
	}
	pollInFlight = true;
	try {
		const payload = await fetchOnce();
		// Serve live stocks immediately; DB persistence must not block the API.
		latest = payload;
		lastError = null;

		try {
			const inserted = await saveSnapshot(payload.stocks);
			console.log(
				`[yata] fetched OK at ${new Date().toISOString()}, ${inserted} new snapshot rows`,
			);
		} catch (err) {
			lastError = err.message;
			console.error(`[yata] saveSnapshot failed: ${err.message}`);
		}
	} catch (err) {
		lastError = err.message;
		console.error(`[yata] fetch failed: ${err.message}`);
	} finally {
		pollInFlight = false;
	}
}

export function startPolling() {
	poll();
	setInterval(poll, POLL_INTERVAL_MS);
}

export function getLatest() {
	return { payload: latest, lastError };
}
