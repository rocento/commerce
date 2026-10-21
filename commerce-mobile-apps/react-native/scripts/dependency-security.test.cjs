const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const braces = require('braces');
const forge = require('node-forge');

test('brace patterns retain ordinary behavior and reject excessive nesting', () => {
  assert.deepEqual(braces.expand('file-{a,b}.{ts,tsx}'), ['file-a.ts', 'file-a.tsx', 'file-b.ts', 'file-b.tsx']);
  for (const open of ['{', '(']) {
    const close = open === '{' ? '}' : ')';
    const pattern = open.repeat(4000) + 'a,b' + close.repeat(4000);
    for (const method of ['parse', 'compile', 'expand', 'stringify']) {
      assert.throws(() => braces[method](pattern), /supported depth/);
    }
  }
  let ast = { type: 'text', value: 'x' };
  for (let i = 0; i < 10000; i++) ast = { type: 'root', nodes: [ast] };
  for (const method of ['compile', 'expand', 'stringify']) assert.throws(() => braces[method](ast), /supported depth/);
});

test('RSA verification rejects extra nested DigestAlgorithm elements', () => {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 1024, e: 3 });
  const digest = forge.md.sha256.create().update('regression fixture');
  assert.equal(keys.publicKey.verify(digest.digest().bytes(), keys.privateKey.sign(digest)), true);
  const asn1 = forge.asn1;
  const node = (type, constructed, value) => asn1.create(asn1.Class.UNIVERSAL, type, constructed, value);
  const algorithm = node(asn1.Type.SEQUENCE, true, [
    node(asn1.Type.OID, false, asn1.oidToDer(forge.pki.oids.sha256).getBytes()),
    node(asn1.Type.NULL, false, ''),
    node(asn1.Type.OCTETSTRING, false, 'unexpected'),
  ]);
  const info = node(asn1.Type.SEQUENCE, true, [algorithm, node(asn1.Type.OCTETSTRING, false, digest.digest().bytes())]);
  const signature = forge.pki.rsa.encrypt(asn1.toDer(info).getBytes(), keys.privateKey, 0x01);
  assert.throws(() => keys.publicKey.verify(digest.digest().bytes(), signature), /DigestInfo/);
});

test('xcode uses patched CommonJS uuid with stable project ID generation', () => {
  const xcodeRequire = createRequire(require.resolve('xcode'));
  const uuid = xcodeRequire('uuid');
  assert.match(uuid.v4(), /^[\da-f-]{36}$/);
  assert.throws(() => uuid.v5('x', uuid.v5.DNS, new Uint8Array(8), 4), RangeError);
  const project = require('xcode').project('unused');
  project.hash = { project: { objects: {} } };
  assert.match(project.generateUuid(), /^[A-F\d]{24}$/);
});
