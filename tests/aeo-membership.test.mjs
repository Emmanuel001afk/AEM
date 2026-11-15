import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import ts from 'typescript';

globalThis.crypto ??= webcrypto;
const source = fs.readFileSync(new URL('../src/domain/aeoMembership.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const aeo = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
const { AEO_FRAMEWORK_AUDIENCE, AEO_MEMBERSHIP_TYP, AEO_UCCS_PROTOCOL, AeoCredentialError,
  verifyAeoMembershipCredential, verifyAeoPeerRegistration } = aeo;
const now = 1_800_000_000;
const encoder = new TextEncoder();
const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
const jsonPart = (value) => b64url(encoder.encode(JSON.stringify(value)));
const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
const key = { kid: 'aeo-root-test', issuer: 'https://identity.aeo.example', algorithm: 'Ed25519',
  publicKey, notBefore: now - 10_000, notAfter: now + 10_000_000 };
const claims = {
  iss: key.issuer, aud: AEO_FRAMEWORK_AUDIENCE, ecosystem: 'AEO',
  credential_type: 'aeo-membership', credential_version: 1,
  sub: 'com.aem.store', platform: { id: 'com.aem.store', name: 'AEM Store' },
  publisher: { id: 'com.aeo.platforms', key_id: 'aem-release-test' }, scope: ['member'],
  jti: '7f4e8c1a-4b8d-4c5a-9e2d-2f7a8b9c0d1e',
  iat: now - 60, nbf: now - 60, exp: now + 86_340,
};
async function sign(payload = claims, header = { alg: 'EdDSA', typ: AEO_MEMBERSHIP_TYP, kid: key.kid }) {
  const h = jsonPart(header); const p = jsonPart(payload); const input = h + '.' + p;
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', pair.privateKey, encoder.encode(input)));
  return input + '.' + b64url(signature);
}
const verify = (token, overrides = {}) => verifyAeoMembershipCredential(token, {
  trustedKeys: [key], isCredentialRevoked: async () => false, nowSeconds: now, ...overrides,
});

test('verifies a valid AEO membership credential', async () => {
  const result = await verify(await sign());
  assert.equal(result.valid, true);
  assert.equal(result.membership.platformId, 'com.aem.store');
});
test('rejects a tampered signature', async () => {
  const parts = (await sign()).split('.');
  parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
  await assert.rejects(() => verify(parts.join('.')), (error) =>
    error instanceof AeoCredentialError && error.code === 'invalid_signature');
});
test('rejects unknown signing keys', async () => {
  const token = await sign();
  await assert.rejects(() => verify(token, { trustedKeys: [] }), (error) => error.code === 'untrusted_issuer_key');
});
test('rejects expired credentials and the wrong audience', async () => {
  const expired = await sign({ ...claims, exp: now - 120 });
  await assert.rejects(() => verify(expired), (error) => error.code === 'credential_time_invalid');
  const wrongAudience = await sign({ ...claims, aud: 'urn:other' });
  await assert.rejects(() => verify(wrongAudience), (error) => error.code === 'wrong_credential_purpose');
});
test('rejects revoked credentials and unavailable revocation state', async () => {
  const token = await sign();
  await assert.rejects(() => verify(token, { isCredentialRevoked: async () => true }),
    (error) => error.code === 'credential_revoked_or_unknown');
  await assert.rejects(() => verify(token, { isCredentialRevoked: async () => { throw new Error('offline'); } }),
    (error) => error.code === 'revocation_check_failed');
});
test('rejects unsupported algorithms and malformed platform IDs', async () => {
  const badAlgorithm = await sign(claims, { alg: 'HS256', typ: AEO_MEMBERSHIP_TYP, kid: key.kid });
  await assert.rejects(() => verify(badAlgorithm), (error) => error.code === 'unsupported_header');
  const badPlatform = await sign({ ...claims, sub: 'com..aem', platform: { id: 'com..aem', name: 'AEM' } });
  await assert.rejects(() => verify(badPlatform), (error) => error.code === 'invalid_claims');
});
test('verifies AEO/UCCS registration while preserving the platform registration boundary', async () => {
  const result = await verifyAeoPeerRegistration({
    ecosystem: 'AEO', protocol: AEO_UCCS_PROTOCOL, platformId: claims.sub,
    displayName: claims.platform.name, membershipCredential: await sign(),
  }, { trustedKeys: [key], isCredentialRevoked: async () => false, nowSeconds: now });
  assert.equal(result.valid, true);
  assert.equal(result.protocol, 'uccs/1');
});
test('rejects a registration identity that differs from the signed credential', async () => {
  const membershipCredential = await sign();
  await assert.rejects(() => verifyAeoPeerRegistration({
    ecosystem: 'AEO', protocol: AEO_UCCS_PROTOCOL, platformId: 'com.phormi.browser',
    displayName: 'Phormi', membershipCredential,
  }, { trustedKeys: [key], isCredentialRevoked: async () => false, nowSeconds: now }),
  (error) => error.code === 'registration_identity_mismatch');
});
