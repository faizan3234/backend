// Return a receipt only for the exact result durably stored by ACK finalization.
export function dispenseReceipt(job, ack) {
  if (!job || !['COMPLETED', 'MANUAL_REVIEW_REQUIRED'].includes(job.state)) return null;
  if (!ack || typeof ack !== 'object' || Array.isArray(ack)) return null;
  // Old firmware would resume stale queued motors after any receipt. Require
  // v2's clear-queue handling before acknowledging a manual-review outcome.
  if (job.state === 'MANUAL_REVIEW_REQUIRED' && ack.receiptProtocol !== 2) return null;
  let stored;
  try { stored = JSON.parse(job.esp32_ack_payload); } catch { return null; }
  if (!stored || typeof stored !== 'object') return null;
  for (const key of ['jobId', 'kitId', 'motor', 'quantity', 'status', 'success']) {
    if (ack[key] === undefined || ack[key] !== stored[key]) return null;
  }
  if (ack.jobId !== job.job_id || ack.kitId !== job.kit_id ||
      ack.motor !== Number(job.motor_id) || ack.quantity !== job.quantity) return null;
  return { jobId: job.job_id, kitId: job.kit_id, motor: Number(job.motor_id),
    quantity: job.quantity, status: ack.status, recorded: true, jobState: job.state };
}

