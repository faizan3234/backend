export function dispensingSnapshot(session, transaction, jobs) {
  const total = jobs.length;
  const completed = jobs.filter(j => j.state === 'COMPLETED').length;
  const review = jobs.some(j => ['FAILED', 'MANUAL_REVIEW_REQUIRED'].includes(j.state));
  const done = total > 0 && completed === total;
  const paymentVerified = ['VERIFIED', 'FULFILLED'].includes(transaction?.status) || transaction?.fulfilled === 1;
  let status = session.status;
  if (session.service_type === 'MEDICINE') {
    status = !paymentVerified ? 'payment_required' : review ? 'dispense_review_required' : done ? 'dispense_complete' : total ? 'dispensing' : 'dispense_waiting';
  } else if (session.service_type === 'HEALTH_CHECKUP') {
    status = session.report_status === 'READY' && paymentVerified ? 'report_ready' : session.report_status === 'FAILED' ? 'report_failed' : 'report_generating';
  }
  return { ok: true, sessionId: session.session_id, serviceType: session.service_type,
    status, paymentVerified, sessionStatus: session.status,
    dispenseStatus: review ? 'MANUAL_REVIEW_REQUIRED' : done ? 'COMPLETED' : total ? 'IN_PROGRESS' : 'PENDING',
    reportStatus: session.report_status, fulfilled: transaction?.fulfilled === 1,
    jobsCount: total, jobsCompleted: completed };
}
