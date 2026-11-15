import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../src/domain/aeoCapabilities.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const shim = `const CAPABILITIES = ["application.metadata.read", "delivery.request", "transfer.offer", "phone.session.request"];
const ECOSYSTEM_PROTOCOL = "aem-capabilities/1";
function validPlatformId(value) { return typeof value === "string" && /^[a-zA-Z][\\w-]*(\\.[a-zA-Z][\\w-]*)+$/.test(value) && value.length <= 128; }`;
const bundled = js.replace(/import[\s\S]*?from ["']\.\/ecosystem["'];/, shim);
const aeo = await import('data:text/javascript;base64,' + Buffer.from(bundled).toString('base64'));

test('projects the existing AEM capability catalogue into a UCCS manifest', () => {
  const manifest = aeo.createAemAeoCapabilityManifest({
    platformId: 'com.aem.store', displayName: 'AEM Store', version: '1.0.0',
  }, 1_800_000_000);
  assert.equal(aeo.validateAeoCapabilityManifest(manifest, 1_800_000_001), true);
  assert.equal(manifest.capabilities.length, 4);
  assert.equal(manifest.capabilities[0].sourceProtocol, 'aem-capabilities/1');
});

test('rejects expired, altered and duplicate capability manifests', () => {
  const manifest = aeo.createAemAeoCapabilityManifest({
    platformId: 'com.aem.store', displayName: 'AEM Store', version: '1.0.0',
  }, 1_800_000_000);
  assert.equal(aeo.validateAeoCapabilityManifest(manifest, 1_800_301_000), false);
  const altered = structuredClone(manifest);
  altered.capabilities[0].title = 'Forged capability';
  assert.equal(aeo.validateAeoCapabilityManifest(altered, 1_800_000_001), false);
  const duplicate = structuredClone(manifest);
  duplicate.capabilities[1].id = duplicate.capabilities[0].id;
  assert.equal(aeo.validateAeoCapabilityManifest(duplicate, 1_800_000_001), false);
});
