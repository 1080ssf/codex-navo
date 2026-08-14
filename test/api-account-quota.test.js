'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { combinedAccountQuota } = require('../lib/api-account-quota');

test('API account quota converts the sum of linked account quota to one percentage', () => {
  assert.deepEqual(combinedAccountQuota([{ remaining: 100 }, { remaining: 74 }], (item) => item.remaining), {
    accountCount: 2, totalRemainingPercent: 174, remainingPercent: 87,
  });
});

test('API account quota includes empty accounts and clamps invalid percentages', () => {
  assert.deepEqual(combinedAccountQuota([{ remaining: 100 }, { remaining: 0 }, { remaining: 140 }], (item) => item.remaining), {
    accountCount: 3, totalRemainingPercent: 200, remainingPercent: 66.7,
  });
});
