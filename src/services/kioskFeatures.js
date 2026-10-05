import fs from 'node:fs';
// Temporary owner-requested review mode. Setting false restores normal entry.
export function reportReviewEnabled() {
    if (process.env.RELIV_REPORT_REVIEW_MODE !== undefined) return process.env.RELIV_REPORT_REVIEW_MODE === 'true';
    try { return JSON.parse(fs.readFileSync(new URL('../../config/kiosk-features.json', import.meta.url), 'utf8')).reportReviewMode === true; }
    catch { return false; }
}
