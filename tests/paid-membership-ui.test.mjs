import { test } from 'node:test';
import assert from 'node:assert/strict';
import { annualPassPanel } from '../dist/paid-membership.js';

const panel={enabled:true,available:true,status:'none',canPurchase:true,fee:1990,termMonths:12};

test('annual pass displays the fee, manual terms and refund policy before Stripe',()=>{
 const html=annualPassPanel(panel);
 assert.match(html,/S\$19\.90/);
 assert.match(html,/12 months/);
 assert.match(html,/Renew manually/);
 assert.match(html,/voluntary refunds/);
 assert.match(html,/statutory consumer rights/);
 assert.match(html,/type="checkbox" name="acceptTerms" required/);
 assert.match(html,/Buy annual pass/);
 assert.equal(annualPassPanel({...panel,enabled:false}),'');
});

test('paid years display Singapore dates and renewal preserves the term already paid for',()=>{
 const active={...panel,status:'active',period:{startsAt:'2026-11-24T02:00:00Z',expiresAt:'2027-11-24T02:00:00Z'}};
 const renewable=annualPassPanel(active);
 assert.match(renewable,/24 Nov 2026, 10:00/);
 assert.match(renewable,/24 Nov 2027, 10:00/);
 assert.match(renewable,/Renew annual pass/);
 const queued=annualPassPanel({...active,canPurchase:false,purchaseStatus:'paid',
  nextPeriod:{startsAt:'2027-11-24T02:00:00Z',expiresAt:'2028-11-24T02:00:00Z'}},'return');
 assert.match(queued,/Annual pass payment confirmed/);
 assert.match(queued,/Next term expires/);
 assert.match(queued,/24 Nov 2028/);
 assert.doesNotMatch(queued,/Continue to Stripe|Renew annual pass/);
 const expired=annualPassPanel({...active,status:'expired'});
 assert.match(expired,/Expired/);
 assert.match(expired,/Buy annual pass again/);
});
