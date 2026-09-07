const fs = require('node:fs');
const crypto = require('node:crypto');

async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function reusablePackage(file, url) {
  try {
    const record = JSON.parse(await fs.promises.readFile(`${file}.json`, 'utf8'));
    const stat = await fs.promises.stat(file);
    if (record.url !== url || !stat.isFile() || stat.size <= 0 || record.bytes !== stat.size) return null;
    const digest = await hashFile(file);
    if (digest !== record.sha256) return null;
    return { path: file, bytes: stat.size, sha256: digest };
  } catch { return null; }
}
module.exports = { hashFile, reusablePackage };
