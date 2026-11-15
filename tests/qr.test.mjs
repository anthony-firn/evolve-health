import { test } from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import { encodeQr } from '../web/src/lib/qr.mjs';

const samples = [
  'hi',
  'https://www.evolvetech.dev/play/evolve-health/share/#n.4fLq2M3cQ0aZ9yXw1bVt6A.Zk3pQ8rT2sV9wX1yA4bC6d.https%3A%2F%2Fnode.example.org',
  'x'.repeat(300),
  'Z'.repeat(1200),
  'é'.repeat(700),
];

test('matrices match the qrcode package for every mask and error level', () => {
  for (const text of samples) {
    for (const ecl of ['L', 'M', 'Q', 'H']) {
      for (const mask of [0, 3, 5, 7]) {
        let theirs;
        try { theirs = QRCode.create(text, { errorCorrectionLevel: ecl, maskPattern: mask, toSJISFunc: undefined }); } catch { continue; }
        // qrcode may pick a non-byte mode for some inputs; force byte mode for comparison.
        theirs = QRCode.create([{ data: new TextEncoder().encode(text), mode: 'byte' }], { errorCorrectionLevel: ecl, maskPattern: mask });
        const mine = encodeQr(text, { ecl, mask });
        assert.equal(mine.version, theirs.version, `${ecl} ${text.length}`);
        const size = theirs.modules.size;
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
          assert.equal(mine.modules[y][x], Boolean(theirs.modules.get(y, x)), `module ${x},${y} v${mine.version} ${ecl} mask ${mask}`);
        }
      }
    }
  }
});

test('automatic mask selection produces a valid symbol', () => {
  const q = encodeQr('evolve health', { ecl: 'M' });
  assert.ok(q.mask >= 0 && q.mask < 8);
  assert.equal(q.size, 21);
});
