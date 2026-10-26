// Late telemetry is evidence for staff, NOT permission to complete or rerun a job.
export function recordLateDispenseAck(db, job, ack) {
  if (!job || job.state !== 'MANUAL_REVIEW_REQUIRED' || !job.mqtt_published_at ||
      !ack || typeof ack !== 'object' || Array.isArray(ack)) return false;
  if (ack.jobId !== job.job_id || ack.kitId !== job.kit_id ||
      !Number.isInteger(ack.motor) || ack.motor !== Number(job.motor_id) ||
      !Number.isInteger(ack.quantity) || ack.quantity !== job.quantity) return false;
  const status = typeof ack.status === 'string' ? ack.status.trim().toUpperCase() : '';
  const success = ['SUCCESS', 'COMPLETED', 'DONE', 'OK'].includes(status);
  const failure = ['ERROR', 'FAILED'].includes(status);
  if ((!success && !failure) || ack.success !== success) return false;
  // Keep the first evidence; do not replace a recorded error with later success.
  // Receipt validation separately requires an exact identity/result match.
  if (job.esp32_ack_payload) return false;
  return db.prepare(`UPDATE fulfillment_jobs
    SET esp32_ack_received_at=datetime('now'), esp32_ack_payload=?
    WHERE job_id=? AND state='MANUAL_REVIEW_REQUIRED'
      AND (esp32_ack_payload IS NULL OR esp32_ack_payload='')`)
    .run(JSON.stringify(ack), job.job_id).changes === 1;
}
