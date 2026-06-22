// backend/tests/zip-writer.test.js
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
const { createZip } = require('../zip-writer');

const FIXED = new Date(Date.UTC(2026, 4, 1, 10, 0, 0));

test('createZip: returns a Buffer with local header + EOCD signatures', () => {
  const buf = createZip([{ name: 'a.txt', data: 'hello', mtime: FIXED }]);
  assert.ok(Buffer.isBuffer(buf));
  assert.strictEqual(buf.readUInt32LE(0), 0x04034b50);          // first local file header
  // EOCD signature appears near the end:
  const eocd = buf.indexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd > 0, 'EOCD present');
});

test('createZip: entries round-trip (manual central-directory parse + inflate)', () => {
  const entries = [
    { name: 'mess.csv', data: 'ts;v\r\n1;2\r\n', mtime: FIXED },
    { name: 'meld.csv', data: Buffer.from('x'), mtime: FIXED },
  ];
  const buf = createZip(entries);
  // Find EOCD, read central-directory offset + count, then parse each central record.
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let cd = buf.readUInt32LE(eocd + 16);
  assert.strictEqual(count, 2);
  const got = {};
  for (let i = 0; i < count; i++) {
    assert.strictEqual(buf.readUInt32LE(cd), 0x02014b50);       // central dir signature
    const method = buf.readUInt16LE(cd + 10);
    const compSize = buf.readUInt32LE(cd + 20);
    const nameLen = buf.readUInt16LE(cd + 28);
    const extraLen = buf.readUInt16LE(cd + 30);
    const commentLen = buf.readUInt16LE(cd + 32);
    const lho = buf.readUInt32LE(cd + 42);
    const name = buf.toString('utf8', cd + 46, cd + 46 + nameLen);
    // Local header: 30 + nameLen + extraLen, then compressed data.
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    const raw = method === 8 ? zlib.inflateRawSync(comp) : comp;
    got[name] = raw.toString('utf8');
    cd += 46 + nameLen + extraLen + commentLen;
  }
  assert.strictEqual(got['mess.csv'], 'ts;v\r\n1;2\r\n');
  assert.strictEqual(got['meld.csv'], 'x');
});

test('createZip: sets UTF-8 general-purpose flag (bit 11) for filenames', () => {
  const buf = createZip([{ name: 'Serverraum_2026-05.csv', data: 'x', mtime: FIXED }]);
  const flags = buf.readUInt16LE(6); // local header general purpose bit flag
  assert.strictEqual(flags & 0x0800, 0x0800);
});

test('createZip: umlaut filename round-trips as UTF-8 (central directory + flag)', () => {
  const name = 'Büro_2026-05.csv';
  const buf = createZip([{ name, data: 'x', mtime: FIXED }]);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const cd = buf.readUInt32LE(eocd + 16);
  const nameLen = buf.readUInt16LE(cd + 28);
  assert.strictEqual(buf.toString('utf8', cd + 46, cd + 46 + nameLen), name);
  assert.strictEqual(buf.readUInt16LE(cd + 8) & 0x0800, 0x0800); // UTF-8 flag set in central dir too
});
