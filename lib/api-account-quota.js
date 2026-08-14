'use strict';

function combinedAccountQuota(accounts = [], remainingFor = (account) => account.remainingPercent) {
  const values = accounts.map((account) => Number(remainingFor(account)))
    .filter(Number.isFinite).map((value) => Math.max(0, Math.min(100, value)));
  const totalRemainingPercent = values.reduce((sum, value) => sum + value, 0);
  return {
    accountCount: values.length,
    totalRemainingPercent: Math.round(totalRemainingPercent * 10) / 10,
    remainingPercent: values.length ? Math.round(totalRemainingPercent / values.length * 10) / 10 : 0,
  };
}

module.exports = { combinedAccountQuota };
