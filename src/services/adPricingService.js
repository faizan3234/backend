/**
 * Reliv Ads V1 — authoritative advertising pricing.
 * All values returned in paise. The browser is never authoritative.
 */

export const AD_PRICING_VERSION = 1;
export const AD_VENUES = Object.freeze(['gurukul', 'dps-megacity', 'beeu-resorts']);
export const ALL_VENUES_DISCOUNT_PERCENT = 20;

const TIERS = new Map([
  [1, 50],
  [3, 117],
  [7, 245],
  [15, 450],
  [30, 750]
]);

export function normalizeAdVenueIds(input) {
  const source = Array.isArray(input) ? input : [input];
  const ids = [...new Set(source.map(v => String(v || '').trim()).filter(Boolean))];

  if (ids.length === 1 && ids[0] === 'all') {
    return [...AD_VENUES];
  }

  if (ids.length === 0 || ids.some(id => !AD_VENUES.includes(id))) {
    const err = new Error('Invalid advertising venue selection');
    err.code = 'INVALID_AD_VENUES';
    throw err;
  }

  return ids;
}

export function calculateAdPrice({ targetVenueIds = ['gurukul'], durationDays = 1 } = {}) {
  const venues = normalizeAdVenueIds(targetVenueIds);
  const days = Number(durationDays);

  if (!Number.isInteger(days) || !TIERS.has(days)) {
    const err = new Error('Unsupported advertising duration');
    err.code = 'INVALID_AD_DURATION';
    throw err;
  }

  const singleVenueRupees = TIERS.get(days);
  const baseRupees = singleVenueRupees * venues.length;
  const discountRupees = venues.length === AD_VENUES.length
    ? Math.round(baseRupees * (ALL_VENUES_DISCOUNT_PERCENT / 100))
    : 0;
  const finalRupees = baseRupees - discountRupees;

  return {
    pricingVersion: AD_PRICING_VERSION,
    durationDays: days,
    targetVenueIds: venues,
    venueCount: venues.length,
    baseRupees,
    discountRupees,
    finalRupees,
    pricePaise: finalRupees * 100,
    effectivePerDayRupees: Math.round(finalRupees / days)
  };
}
