const zlib = require('node:zlib');

const MAX_ZIP_BYTES = 12 * 1024 * 1024;
const MAX_ENTRY_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 200;

function readU16(buffer, offset) { return buffer.readUInt16LE(offset); }
function readU32(buffer, offset) { return buffer.readUInt32LE(offset); }

function safeEntryName(name) {
  const normalized = String(name || '').replace(/\\/g, '/');
  return normalized && !normalized.startsWith('/') && !normalized.split('/').some((part) => part === '..');
}

function findEndOfCentralDirectory(buffer) {
  const start = Math.max(0, buffer.length - 65557);
  for (let offset = buffer.length - 22; offset >= start; offset -= 1) {
    if (readU32(buffer, offset) === 0x06054b50) return offset;
  }
  return -1;
}

function parseZipJson(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > MAX_ZIP_BYTES) throw new Error('CPA ZIP 数据包过大');
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw new Error('不是有效的 ZIP 数据包');
  const entries = readU16(buffer, eocd + 10);
  const centralSize = readU32(buffer, eocd + 12);
  const centralOffset = readU32(buffer, eocd + 16);
  if (!entries || entries > MAX_ENTRIES || centralOffset + centralSize > buffer.length) throw new Error('ZIP 目录无效');
  const result = [];
  let cursor = centralOffset;
  for (let i = 0; i < entries; i += 1) {
    if (readU32(buffer, cursor) !== 0x02014b50) throw new Error('ZIP 中央目录损坏');
    const flags = readU16(buffer, cursor + 8);
    const compression = readU16(buffer, cursor + 10);
    const compressedSize = readU32(buffer, cursor + 20);
    const uncompressedSize = readU32(buffer, cursor + 24);
    const nameLength = readU16(buffer, cursor + 28);
    const extraLength = readU16(buffer, cursor + 30);
    const commentLength = readU16(buffer, cursor + 32);
    const localOffset = readU32(buffer, cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString((flags & 0x800) ? 'utf8' : 'latin1');
    cursor += 46 + nameLength + extraLength + commentLength;
    if (!safeEntryName(name) || name.endsWith('/')) continue;
    if (flags & 0x1) throw new Error('不支持加密 ZIP 数据包');
    if (uncompressedSize > MAX_ENTRY_BYTES || compressedSize > MAX_ENTRY_BYTES) throw new Error('ZIP 文件项过大');
    if (readU32(buffer, localOffset) !== 0x04034b50) throw new Error('ZIP 文件项损坏');
    const localNameLength = readU16(buffer, localOffset + 26);
    const localExtraLength = readU16(buffer, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataStart < 0 || dataEnd > buffer.length) throw new Error('ZIP 文件项越界');
    const compressed = buffer.subarray(dataStart, dataEnd);
    let data;
    if (compression === 0) data = compressed;
    else if (compression === 8) data = zlib.inflateRawSync(compressed);
    else throw new Error(`ZIP 使用了不支持的压缩方式：${compression}`);
    if (data.length > MAX_ENTRY_BYTES) throw new Error('ZIP 解压后的文件过大');
    if (/\.(json|txt|conf|yaml|yml)$/i.test(name)) result.push({ name, text: data.toString('utf8') });
  }
  if (!result.length) throw new Error('CPA ZIP 中没有可识别的 JSON 数据文件');
  return result;
}

module.exports = { parseZipJson, MAX_ZIP_BYTES, MAX_ENTRY_BYTES };
