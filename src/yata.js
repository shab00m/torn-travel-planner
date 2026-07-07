import { saveSnapshot } from "./db.js";

const YATA_URL = "https://yata.yt/api/v1/travel/export/";
const POLL_INTERVAL_MS = 60_000;

let latest = null; // last successful payload, served to the frontend
let lastError = null;

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
	try {
		const payload = await fetchOnce();
		const inserted = saveSnapshot(payload.stocks);
		latest = payload;
		lastError = null;
		console.log(
			`[yata] fetched OK at ${new Date().toISOString()}, ${inserted} new snapshot rows`,
		);
	} catch (err) {
		lastError = err.message;
		console.error(`[yata] fetch failed: ${err.message}`);
	}
}

export function startPolling() {
	poll();
	setInterval(poll, POLL_INTERVAL_MS);
}

export function getLatest() {
	return { payload: latest, lastError };
}
