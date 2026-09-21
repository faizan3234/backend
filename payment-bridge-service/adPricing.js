/**
 * Reliv Ads V1 — cloud-side independent price verification.
 * Keep this intentionally tiny and deterministic so the payment bridge
 * never trusts an amount supplied by a kiosk or browser.
 */

export const AD_PRICING_VERSION = 1;
const VENUES = Object.freeze(['gurukul', 'dps-megacity', 'beeu-resorts']);
const TIERS = new Map([
  [1, 50],
  [3, 117],
  [7, 245],
  [15, 450],
  [30, 750]
]);

export function calculateExpectedAdPricePaise(adCampaign) {
  if (!adCampaign || Number(adCampaign.version) !== 1) {
    const err = new Error('Invalid advertising campaign payload');
    err.code = 'INVALID_AD_CAMPAIGN';
    throw err;
  }

  const ids = [...new Set(
    (Array.isArray(adCampaign.targetVenueIds) ? adCampaign.targetVenueIds : [])
      .map(v => String(v || '').trim())
      .filter(Boolean)
  )];

  if (ids.length === 0 || ids.some(id => !VENUES.includes(id))) {
    const err = new Error('Invalid advertising venues');
    err.code = 'INVALID_AD_CAMPAIGN';
    throw err;
  }

  const days = Number(adCampaign.durationDays);
  if (!Number.isInteger(days) || !TIERS.has(days)) {
    const err = new Error('Invalid advertising duration');
    err.code = 'INVALID_AD_CAMPAIGN';
    throw err;
  }

  if (Number(adCampaign.pricingVersion) !== AD_PRICING_VERSION) {
    const err = new Error('Unsupported advertising pricing version');
    err.code = 'INVALID_AD_CAMPAIGN';
    throw err;
  }

  const singleVenueRupees = TIERS.get(days);
  const baseRupees = singleVenueRupees * ids.length;
  const discountRupees = ids.length === VENUES.length
    ? Math.round(baseRupees * 0.20)
    : 0;

  return (baseRupees - discountRupees) * 100;
}
