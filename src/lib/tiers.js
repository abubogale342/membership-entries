'use strict';

// Entry rules, in one place, as data.
//
// These are the numbers a sweepstakes administrator and compliance counsel
// will check line by line, so they live here rather than being scattered
// through the code that applies them.
const TIERS = {
  explorer_monthly:   { label: 'Explorer',   cadence: 'monthly', priceCents: 1000,  entriesPerCycle: 10, annualBonus: 0 },
  patron_monthly:     { label: 'Patron',     cadence: 'monthly', priceCents: 2500,  entriesPerCycle: 25, annualBonus: 0 },
  ambassador_monthly: { label: 'Ambassador', cadence: 'monthly', priceCents: 5000,  entriesPerCycle: 50, annualBonus: 0 },

  // Annual members pay 10 months for 12 and receive the equivalent monthly
  // entry rate, plus a bonus credited once at enrolment.
  explorer_annual:    { label: 'Explorer',   cadence: 'annual',  priceCents: 10000, entriesPerCycle: 120, annualBonus: 20 },
  patron_annual:      { label: 'Patron',     cadence: 'annual',  priceCents: 25000, entriesPerCycle: 300, annualBonus: 50 },
  ambassador_annual:  { label: 'Ambassador', cadence: 'annual',  priceCents: 50000, entriesPerCycle: 600, annualBonus: 100 },
};

function tier(code) {
  const t = TIERS[code];
  // An unknown tier must stop the process rather than quietly crediting zero.
  if (!t) throw new Error(`Unknown tier: ${code}`);
  return t;
}

// Quarters are the unit the draw runs on, so every credit is stamped with one.
function periodFor(date = new Date()) {
  const d = new Date(date);
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

module.exports = { TIERS, tier, periodFor };
