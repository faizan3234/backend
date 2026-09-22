import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateAdPrice } from './src/services/adPricingService.js';
import { AdPaymentService } from './src/services/adPaymentService.js';

test('Reliv Ads pricing is authoritative', () => {
  assert.equal(calculateAdPrice({ targetVenueIds:['gurukul'], durationDays:1 }).pricePaise, 5000);
  assert.equal(calculateAdPrice({ targetVenueIds:['gurukul'], durationDays:3 }).pricePaise, 11700);
  assert.equal(calculateAdPrice({ targetVenueIds:['gurukul'], durationDays:7 }).pricePaise, 24500);
  assert.equal(calculateAdPrice({ targetVenueIds:['gurukul'], durationDays:15 }).pricePaise, 45000);
  assert.equal(calculateAdPrice({ targetVenueIds:['gurukul'], durationDays:30 }).pricePaise, 75000);
});

test('all-venue bundle receives exactly 20 percent discount', () => {
  const quote = calculateAdPrice({
    targetVenueIds:['gurukul','dps-megacity','beeu-resorts'],
    durationDays:3
  });
  assert.equal(quote.baseRupees, 351);
  assert.equal(quote.discountRupees, 70);
  assert.equal(quote.finalRupees, 281);
  assert.equal(quote.pricePaise, 28100);
});

test('ad activation HMAC is campaign and media bound', () => {
  const service = new AdPaymentService({ pepper:'test-pepper', kioskId:'RELIV-TEST' });
  const base = {
    requestId:'REQ-1',
    requestNonce:'nonce-1',
    campaignId:'AD-TEST-1',
    amount:11700,
    mediaSHA256:'a'.repeat(64),
    confirmationCode:'4899'
  };
  const one = service.codeHmac(base);
  const two = service.codeHmac({ ...base, mediaSHA256:'b'.repeat(64) });
  const three = service.codeHmac({ ...base, campaignId:'AD-TEST-2' });
  assert.match(one, /^[a-f0-9]{64}$/);
  assert.notEqual(one, two);
  assert.notEqual(one, three);
});

test('default ad payment service reads pepper after environment initialization', async () => {
  const savedPepper = process.env.PAYMENT_V2_CODE_PEPPER;
  delete process.env.PAYMENT_V2_CODE_PEPPER;

  try {
    // Fresh module instance with no pepper present at import time.
    const mod = await import(`./src/services/adPaymentService.js?lazy-env-test=${Date.now()}`);
    process.env.PAYMENT_V2_CODE_PEPPER = 'late-loaded-ad-pepper';

    assert.equal(
      mod.default.pepper,
      'late-loaded-ad-pepper',
      'default singleton must read PAYMENT_V2_CODE_PEPPER on first use, not at module import'
    );
  } finally {
    if (savedPepper === undefined) delete process.env.PAYMENT_V2_CODE_PEPPER;
    else process.env.PAYMENT_V2_CODE_PEPPER = savedPepper;
  }
});
