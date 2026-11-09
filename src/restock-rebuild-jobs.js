import { randomUUID } from "node:crypto";

/** Run maintenance in this web process, outside the lifetime of an HTTP request.
 * One rebuild runs at a time; repeated starts for an item join its current job.
 * Completed jobs remain available for 30 minutes. A restart loses this registry.
 */
export function createRestockRebuildJobs(rebuild, { logger = console, now = Date.now } = {}) {
  const jobs = new Map();
  let queue = Promise.resolve();
  const publicJob = (job) => ({
    jobId: job.jobId, country: job.country, itemId: job.itemId, status: job.status,
    ...(job.result ? { result: job.result } : {}),
    ...(job.error ? { error: job.error } : {}),
  });
  function start(country, itemId) {
    for (const [id, job] of jobs) {
      if (job.finishedAt != null && now() - job.finishedAt > 30 * 60_000) jobs.delete(id);
      else if (job.country === country && job.itemId === itemId &&
        (job.status === "queued" || job.status === "running")) return publicJob(job);
    }
    const job = { jobId: randomUUID(), country, itemId, status: "queued" };
    jobs.set(job.jobId, job);
    queue = queue.then(async () => {
      job.status = "running";
      const started = now();
      logger.log("[restock-rebuild] started:", JSON.stringify(publicJob(job)));
      try {
        job.result = await rebuild(country, itemId);
        job.status = "completed";
        logger.log("[restock-rebuild] completed:", JSON.stringify({ ...publicJob(job), durationMs: now() - started }));
      } catch (err) {
        job.status = "failed";
        job.error = err.code === "57014" || err.code === "55P03"
          ? "Restock rebuild exceeded the database time limit. Please try again shortly."
          : err.message;
        logger.error("[restock-rebuild] failed:", JSON.stringify({ ...publicJob(job), code: err.code, durationMs: now() - started }));
      } finally {
        job.finishedAt = now();
      }
    });
    return publicJob(job);
  }
  function get(country, itemId, jobId) {
    const job = jobs.get(jobId);
    if (!job || job.country !== country || job.itemId !== itemId) return null;
    return publicJob(job);
  }
  return { start, get };
}
