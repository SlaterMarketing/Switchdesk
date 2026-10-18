'use strict';
// Attaching files: documents become text, and anything else goes to the agent as its path.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { extract } = require('../src/extract');

test('files Switchdesk cannot read still attach, as their path', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-extract-'));
  const cer = path.join(dir, 'developerID_application.cer');
  fs.writeFileSync(cer, Buffer.from([0x30, 0x82, 0x05, 0x00, 0x00, 0x01, 0x02, 0xff]));
  assert.deepStrictEqual(await extract(cer), { kind: 'file', name: 'developerID_application.cer', file: cer, size: 8 });
  const old = path.join(dir, 'notes.doc');
  fs.writeFileSync(old, 'hello');
  assert.strictEqual((await extract(old)).kind, 'file');
  const txt = path.join(dir, 'a.txt');
  fs.writeFileSync(txt, 'hello');
  assert.strictEqual((await extract(txt)).text, 'hello');
});
