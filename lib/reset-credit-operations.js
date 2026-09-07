const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// One process owns this journal. Persist before sending, including across restarts.
class ResetCreditOperations {
  constructor(filename) { this.filename = filename; this.running = new Map(); }
  read() {
    try {
      const state = JSON.parse(fs.readFileSync(this.filename, 'utf8'));
      if (!state || state.version !== 1 || !Array.isArray(state.operations)) throw new Error('Invalid reset credit journal');
      return state;
    } catch (error) { if (error.code === 'ENOENT') return { version: 1, operations: [] }; throw error; }
  }
  write(state) {
    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    const temp = `${this.filename}.${randomUUID()}.tmp`;
    const descriptor = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(descriptor, JSON.stringify(state)); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
    fs.renameSync(temp, this.filename);
  }
  get(accountId, clientOperationId = null) {
    return this.read().operations.findLast((item) => item.accountId === accountId &&
      (clientOperationId === null || item.clientOperationId === clientOperationId)) || null;
  }
  run(accountId, creditId, consume, clientOperationId = null) {
    if (typeof accountId !== 'string' || !accountId) return Promise.reject(new Error('Account required'));
    if (clientOperationId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientOperationId)) return Promise.reject(new Error('Invalid client operation ID'));
    if (this.running.has(accountId)) {
      const active = this.running.get(accountId);
      if (active.clientOperationId !== clientOperationId || active.creditId !== (creditId ?? null)) return Promise.reject(new Error('Another redemption is running for this account'));
      return active.promise;
    }
    const operation = Promise.resolve().then(async () => {
      const state = this.read();
      let record = clientOperationId && state.operations.find((item) => item.accountId === accountId && item.clientOperationId === clientOperationId);
      if (clientOperationId && record?.clientOperationId === clientOperationId && record.status === 'complete') {
        if (record.creditId !== (creditId ?? null)) throw new Error('Credit selection changed for completed redemption');
        return { ...record };
      }
      record = state.operations.findLast((item) => item.accountId === accountId);
      if (record?.status === 'pending' && record.clientOperationId && record.clientOperationId !== clientOperationId) throw new Error('Retry the pending client operation before starting another redemption');
      if (record?.status === 'pending' && record.creditId !== (creditId ?? null)) throw new Error('Resolve pending redemption before selecting another credit');
      if (!record || record.status !== 'pending') {
        record = { accountId, creditId: creditId ?? null, clientOperationId, idempotencyKey: randomUUID(), status: 'pending', startedAt: new Date().toISOString() };
        state.operations.push(record);
        this.write(state);
      }
      // On any exception retain pending and the same key. Never infer no consumption.
      const result = await consume({ idempotencyKey: record.idempotencyKey, ...(record.creditId == null ? {} : { creditId: record.creditId }) });
      if (!['reset', 'alreadyRedeemed', 'nothingToReset', 'noCredit'].includes(result?.outcome)) throw new Error('Unknown reset credit outcome');
      const latest = this.read();
      const saved = latest.operations.find((item) => item.accountId === accountId && item.idempotencyKey === record.idempotencyKey);
      if (!saved || saved.idempotencyKey !== record.idempotencyKey) throw new Error('Reset credit journal changed unexpectedly');
      Object.assign(saved, { status: 'complete', outcome: result.outcome, completedAt: new Date().toISOString() });
      this.write(latest);
      return { ...saved };
    }).finally(() => this.running.delete(accountId));
    this.running.set(accountId, { promise: operation, clientOperationId, creditId: creditId ?? null });
    return operation;
  }
}

module.exports = { ResetCreditOperations };
