async function settledMap(items, limit, operation) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Concurrency must be a positive integer');
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      try { results[index] = { status: 'fulfilled', value: await operation(items[index], index) }; }
      catch (reason) { results[index] = { status: 'rejected', reason }; }
    }
  }));
  return results;
}
module.exports = { settledMap };
