/** AEO membership verification; separate from AEM's existing aem-capabilities/1 protocol. */
export const AEO_FRAMEWORK_AUDIENCE = 'urn:aeo:framework' as const;
export const AEO_MEMBERSHIP_TYP = 'AEO-MEMBERSHIP+jwt' as const;
export const AEO_UCCS_PROTOCOL = 'uccs/1' as const;
export const AEO_TRUST_BUNDLE_TYP = 'AEO-TRUST-BUNDLE+jwt' as const;
export const AEO_TRUST_BUNDLE_AUDIENCE = 'urn:aeo:trust-bundle' as const;
const MAX_TOKEN_LENGTH = 16_384;
const MAX_LIFETIME_SECONDS = 90 * 24 * 60 * 60;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class AeoCredentialError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'AeoCredentialError';
  }
}

export interface AeoTrustedIssuerKey {
  kid: string;
  issuer: string;
  algorithm: 'Ed25519';
  publicKey: string | Uint8Array;
  notBefore?: number;
  notAfter?: number;
  revokedAt?: number;
}
export interface AeoMembershipVerificationOptions {
  trustedKeys: AeoTrustedIssuerKey[];
  isCredentialRevoked: (input: { issuer: string; jti: string; platformId: string }) => boolean | Promise<boolean>;
  nowSeconds?: number;
  clockSkewSeconds?: number;
  maxLifetimeSeconds?: number;
}
export interface AeoVerifiedMembership {
  valid: true;
  membership: {
    ecosystem: 'AEO'; issuer: string; platformId: string; platformName: string;
    publisherId: string; publisherKeyId: string; credentialId: string;
    issuedAt: number; expiresAt: number; scopes: readonly string[];
  };
}
export interface AeoPeerRegistration {
  ecosystem: 'AEO';
  protocol: typeof AEO_UCCS_PROTOCOL;
  platformId: string;
  displayName: string;
  membershipCredential: string;
}
export interface AeoVerifiedPeerRegistration {
  valid: true;
  protocol: typeof AEO_UCCS_PROTOCOL;
  platformId: string;
  displayName: string;
  membership: AeoVerifiedMembership['membership'];
}

function fail(code: string, message: string): never { throw new AeoCredentialError(code, message); }
function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function decodeBase64Url(value: string, field: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) fail('malformed_token', 'Invalid ' + field + ' encoding');
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  let binary: string;
  try { binary = atob(padded); } catch { return fail('malformed_token', 'Invalid ' + field + ' encoding'); }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (encodeBase64Url(bytes) !== value) fail('malformed_token', 'Non-canonical ' + field + ' encoding');
  return bytes;
}
function decodeJsonSegment(segment: string, field: string): Record<string, unknown> {
  let source: string;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64Url(segment, field)); }
  catch (error) {
    if (error instanceof AeoCredentialError) throw error;
    return fail('malformed_token', 'Invalid UTF-8 in ' + field);
  }
  try {
    const value: unknown = JSON.parse(source);
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('malformed_token', field + ' must be a JSON object');
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AeoCredentialError) throw error;
    return fail('malformed_token', 'Invalid JSON in ' + field);
  }
}
function requiredString(value: unknown, field: string, maxLength = 255): string {
  if (typeof value !== 'string' || !value || value.length > maxLength || value.trim() !== value) {
    fail('invalid_claims', 'Invalid ' + field);
  }
  return value;
}
function validPlatformId(value: unknown, field: string): string {
  const id = requiredString(value, field);
  const labels = id.split('.');
  if (labels.length < 2 || labels.some((label) => label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    fail('invalid_claims', 'Invalid ' + field);
  }
  return id;
}

/** Verify signed membership only. It does not authenticate devices or authorize capabilities. */
export async function verifyAeoMembershipCredential(
  compact: string,
  options: AeoMembershipVerificationOptions,
): Promise<AeoVerifiedMembership> {
  if (typeof compact !== 'string' || !compact || compact.length > MAX_TOKEN_LENGTH) {
    fail('malformed_token', 'Credential is missing or exceeds the size limit');
  }
  if (!options || !Array.isArray(options.trustedKeys) || typeof options.isCredentialRevoked !== 'function') {
    fail('invalid_verifier_config', 'Trusted keys and a credential revocation checker are required');
  }
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const skew = options.clockSkewSeconds ?? 60;
  const maxLifetime = options.maxLifetimeSeconds ?? MAX_LIFETIME_SECONDS;
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(skew) || skew < 0 || skew > 300 ||
      !Number.isSafeInteger(maxLifetime) || maxLifetime < 60 || maxLifetime > MAX_LIFETIME_SECONDS) {
    fail('invalid_verifier_config', 'Invalid verifier time configuration');
  }
  const parts = compact.split('.');
  if (parts.length !== 3 || parts.some((part) => !part)) fail('malformed_token', 'Credential must be a three-part compact JWS');
  const encodedHeader = parts[0];
  const encodedPayload = parts[1];
  const encodedSignature = parts[2];
  const header = decodeJsonSegment(encodedHeader, 'protected header');
  const claims = decodeJsonSegment(encodedPayload, 'payload');
  if (header.alg !== 'EdDSA' || header.typ !== AEO_MEMBERSHIP_TYP ||
      typeof header.kid !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(header.kid) ||
      Object.keys(header).some((key) => !['alg', 'typ', 'kid'].includes(key))) {
    fail('unsupported_header', 'Credential does not match the AEO EdDSA membership profile');
  }
  const matches = options.trustedKeys.filter((candidate) => candidate?.kid === header.kid);
  if (matches.length !== 1) fail('untrusted_issuer_key', 'Signing key is missing or ambiguous');
  const key = matches[0];
  if (key.algorithm !== 'Ed25519' || !key.issuer ||
      (key.notBefore !== undefined && !Number.isSafeInteger(key.notBefore)) ||
      (key.notAfter !== undefined && !Number.isSafeInteger(key.notAfter)) ||
      (key.revokedAt !== undefined && !Number.isSafeInteger(key.revokedAt)) ||
      (key.notBefore !== undefined && key.notAfter !== undefined && key.notAfter <= key.notBefore)) {
    fail('invalid_trust_key', 'Trusted key record is invalid');
  }
  if ((key.notBefore !== undefined && now + skew < key.notBefore) ||
      (key.notAfter !== undefined && now - skew > key.notAfter) ||
      (key.revokedAt !== undefined && now >= key.revokedAt)) {
    fail('untrusted_issuer_key', 'Signing key is not currently valid');
  }
  const issuer = requiredString(claims.iss, 'issuer');
  if (issuer !== key.issuer || claims.aud !== AEO_FRAMEWORK_AUDIENCE || claims.ecosystem !== 'AEO' ||
      claims.credential_type !== 'aeo-membership' || claims.credential_version !== 1) {
    fail('wrong_credential_purpose', 'Credential issuer or AEO membership purpose is invalid');
  }
  const platformId = validPlatformId(claims.sub, 'subject platform ID');
  const platform = claims.platform as Record<string, unknown> | undefined;
  if (!platform || platform.id !== platformId) fail('invalid_claims', 'Platform identity does not match the subject');
  const platformName = requiredString(platform.name, 'platform name', 80);
  const publisher = claims.publisher as Record<string, unknown> | undefined;
  const publisherId = validPlatformId(publisher?.id, 'publisher ID');
  const publisherKeyId = requiredString(publisher?.key_id, 'publisher key ID', 128);
  const jti = requiredString(claims.jti, 'credential ID', 64);
  if (!UUID_V4.test(jti)) fail('invalid_claims', 'Credential ID must be a UUIDv4');
  if (!Array.isArray(claims.scope) || !claims.scope.includes('member') ||
      claims.scope.some((scope) => typeof scope !== 'string') || new Set(claims.scope).size !== claims.scope.length) {
    fail('invalid_claims', 'Membership scope must contain a unique member entry');
  }
  const iat = claims.iat;
  const nbf = claims.nbf;
  const exp = claims.exp;
  if (![iat, nbf, exp].every(Number.isSafeInteger) || (exp as number) <= (iat as number) ||
      (nbf as number) < (iat as number) || (nbf as number) > (exp as number) ||
      (iat as number) > now + skew || (nbf as number) > now + skew ||
      (exp as number) <= now - skew || (exp as number) - (iat as number) > maxLifetime) {
    fail('credential_time_invalid', 'Credential is expired, not yet valid, or has an invalid lifetime');
  }
  const signature = decodeBase64Url(encodedSignature, 'signature');
  if (signature.length !== 64) fail('malformed_token', 'Ed25519 signature must be 64 bytes');
  const publicKey = typeof key.publicKey === 'string' ? decodeBase64Url(key.publicKey, 'trusted public key') : key.publicKey;
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32) fail('invalid_trust_key', 'Ed25519 public key must be 32 bytes');
  try {
    const imported = await crypto.subtle.importKey('raw', publicKey, { name: 'Ed25519' }, false, ['verify']);
    const valid = await crypto.subtle.verify({ name: 'Ed25519' }, imported, signature,
      new TextEncoder().encode(encodedHeader + '.' + encodedPayload));
    if (!valid) fail('invalid_signature', 'Credential signature is invalid');
  } catch (error) {
    if (error instanceof AeoCredentialError) throw error;
    fail('crypto_unavailable', 'Ed25519 verification is unavailable in this runtime');
  }
  let revoked: boolean;
  try { revoked = await options.isCredentialRevoked({ issuer, jti, platformId }); }
  catch { return fail('revocation_check_failed', 'Credential revocation status could not be checked'); }
  if (revoked !== false) fail('credential_revoked_or_unknown', 'Credential is revoked or its status is unknown');
  return Object.freeze({ valid: true, membership: Object.freeze({
    ecosystem: 'AEO', issuer, platformId, platformName, publisherId, publisherKeyId,
    credentialId: jti, issuedAt: iat as number, expiresAt: exp as number,
    scopes: Object.freeze([...(claims.scope as string[])]),
  }) });
}

/** Verify AEO membership around a platform's existing, independently-owned registration. */
export async function verifyAeoPeerRegistration(
  value: unknown,
  options: AeoMembershipVerificationOptions,
): Promise<AeoVerifiedPeerRegistration> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_registration', 'AEO peer registration must be an object');
  const registration = value as Record<string, unknown>;
  if (registration.ecosystem !== 'AEO' || registration.protocol !== AEO_UCCS_PROTOCOL) {
    fail('invalid_registration', 'Unsupported AEO ecosystem or UCCS protocol');
  }
  const platformId = validPlatformId(registration.platformId, 'registration platform ID');
  const displayName = requiredString(registration.displayName, 'registration display name', 80);
  const credential = requiredString(registration.membershipCredential, 'membership credential', MAX_TOKEN_LENGTH);
  const verified = await verifyAeoMembershipCredential(credential, options);
  if (verified.membership.platformId !== platformId || verified.membership.platformName !== displayName) {
    fail('registration_identity_mismatch', 'Registration identity does not match the signed membership credential');
  }
  return Object.freeze({ valid: true, protocol: AEO_UCCS_PROTOCOL, platformId, displayName, membership: verified.membership });
}

export interface AeoPinnedRootKey {
  kid: string;
  issuer: 'AEO';
  algorithm: 'Ed25519';
  publicKey: string | Uint8Array;
  notBefore?: number;
  notAfter?: number;
  revokedAt?: number;
}
export interface AeoTrustBundleVerificationOptions {
  pinnedRootKeys: AeoPinnedRootKey[];
  minimumVersion?: number;
  nowSeconds?: number;
  clockSkewSeconds?: number;
}
export interface AeoVerifiedTrustBundle {
  version: number;
  issuedAt: number;
  expiresAt: number;
  trustedKeys: readonly AeoTrustedIssuerKey[];
  isCredentialRevoked: (input: { issuer: string; jti: string; platformId: string }) => boolean;
}

/** Verify an AEO root-signed trust bundle. Persist version outside this function to prevent rollback. */
export async function verifyAeoTrustBundle(
  compact: string,
  options: AeoTrustBundleVerificationOptions,
): Promise<AeoVerifiedTrustBundle> {
  if (typeof compact !== 'string' || !compact || compact.length > MAX_TOKEN_LENGTH * 4) {
    fail('malformed_trust_bundle', 'Trust bundle is missing or exceeds the size limit');
  }
  if (!options || !Array.isArray(options.pinnedRootKeys)) {
    fail('invalid_trust_config', 'Pinned AEO root keys are required');
  }
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const skew = options.clockSkewSeconds ?? 60;
  const minimumVersion = options.minimumVersion ?? 0;
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(skew) || skew < 0 || skew > 300 ||
      !Number.isSafeInteger(minimumVersion) || minimumVersion < 0) {
    fail('invalid_trust_config', 'Invalid trust-bundle verifier configuration');
  }
  const parts = compact.split('.');
  if (parts.length !== 3 || parts.some((part) => !part)) {
    fail('malformed_trust_bundle', 'Trust bundle must be a three-part compact JWS');
  }
  const encodedHeader = parts[0];
  const encodedPayload = parts[1];
  const encodedSignature = parts[2];
  const header = decodeJsonSegment(encodedHeader, 'trust-bundle header');
  const payload = decodeJsonSegment(encodedPayload, 'trust-bundle payload');
  if (header.alg !== 'EdDSA' || header.typ !== AEO_TRUST_BUNDLE_TYP ||
      typeof header.kid !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(header.kid) ||
      Object.keys(header).some((key) => !['alg', 'typ', 'kid'].includes(key))) {
    fail('unsupported_trust_bundle_header', 'Trust bundle does not match the AEO root-signature profile');
  }
  const roots = options.pinnedRootKeys.filter((candidate) => candidate.kid === header.kid);
  if (roots.length !== 1) fail('untrusted_root_key', 'Pinned AEO root key is missing or ambiguous');
  const root = roots[0];
  if (root.issuer !== 'AEO' || root.algorithm !== 'Ed25519' ||
      (root.notBefore !== undefined && !Number.isSafeInteger(root.notBefore)) ||
      (root.notAfter !== undefined && !Number.isSafeInteger(root.notAfter)) ||
      (root.revokedAt !== undefined && !Number.isSafeInteger(root.revokedAt)) ||
      (root.notBefore !== undefined && now + skew < root.notBefore) ||
      (root.notAfter !== undefined && now - skew > root.notAfter) ||
      (root.revokedAt !== undefined && now >= root.revokedAt)) {
    fail('untrusted_root_key', 'Pinned AEO root key is not currently valid');
  }
  if (payload.iss !== 'AEO' || payload.aud !== AEO_TRUST_BUNDLE_AUDIENCE ||
      payload.bundle_type !== 'aeo-trust-bundle' || payload.bundle_version !== 1) {
    fail('invalid_trust_bundle', 'Trust bundle issuer, audience or profile version is invalid');
  }
  const version = payload.version;
  const iat = payload.iat;
  const nbf = payload.nbf;
  const exp = payload.exp;
  const maxBundleLifetime = 7 * 24 * 60 * 60;
  if (!Number.isSafeInteger(version) || (version as number) < 1 ||
      (version as number) < minimumVersion ||
      ![iat, nbf, exp].every(Number.isSafeInteger) ||
      (exp as number) <= (iat as number) || (nbf as number) < (iat as number) ||
      (nbf as number) > (exp as number) || (iat as number) > now + skew ||
      (nbf as number) > now + skew || (exp as number) <= now - skew ||
      (exp as number) - (iat as number) > maxBundleLifetime) {
    fail('trust_bundle_time_or_version_invalid', 'Trust bundle is expired, stale, or has an invalid lifetime/version');
  }
  const signature = decodeBase64Url(encodedSignature, 'trust-bundle signature');
  if (signature.length !== 64) fail('malformed_trust_bundle', 'Ed25519 trust-bundle signature must be 64 bytes');
  const rootPublicKey = typeof root.publicKey === 'string'
    ? decodeBase64Url(root.publicKey, 'pinned root public key')
    : root.publicKey;
  if (!(rootPublicKey instanceof Uint8Array) || rootPublicKey.length !== 32) {
    fail('invalid_trust_key', 'Pinned root public key must be 32 bytes');
  }
  try {
    const imported = await crypto.subtle.importKey('raw', rootPublicKey, { name: 'Ed25519' }, false, ['verify']);
    const valid = await crypto.subtle.verify({ name: 'Ed25519' }, imported, signature,
      new TextEncoder().encode(encodedHeader + '.' + encodedPayload));
    if (!valid) fail('invalid_trust_bundle_signature', 'Trust bundle signature is invalid');
  } catch (error) {
    if (error instanceof AeoCredentialError) throw error;
    fail('crypto_unavailable', 'Ed25519 trust-bundle verification is unavailable in this runtime');
  }
  if (!Array.isArray(payload.keys) || payload.keys.length < 1 || payload.keys.length > 100) {
    fail('invalid_trust_bundle', 'Trust bundle must contain 1 to 100 issuer keys');
  }
  const seenKids = new Set<string>();
  const trustedKeys = payload.keys.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      fail('invalid_trust_bundle', 'Invalid issuer key record');
    }
    const record = item as Record<string, unknown>;
    const kid = requiredString(record.kid, 'issuer key ID', 128);
    const issuer = requiredString(record.issuer, 'issuer');
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(kid) || seenKids.has(kid) || record.algorithm !== 'Ed25519') {
      fail('invalid_trust_bundle', 'Issuer key ID is duplicated or its algorithm is unsupported');
    }
    seenKids.add(kid);
    const publicKey = decodeBase64Url(requiredString(record.publicKey, 'issuer public key', 128), 'issuer public key');
    if (publicKey.length !== 32) fail('invalid_trust_bundle', 'Issuer Ed25519 public key must be 32 bytes');
    for (const field of ['notBefore', 'notAfter', 'revokedAt'] as const) {
      if (record[field] !== undefined && !Number.isSafeInteger(record[field])) {
        fail('invalid_trust_bundle', 'Invalid issuer key ' + field);
      }
    }
    if (record.notBefore !== undefined && record.notAfter !== undefined &&
        (record.notAfter as number) <= (record.notBefore as number)) {
      fail('invalid_trust_bundle', 'Issuer key validity interval is invalid');
    }
    return Object.freeze({
      kid, issuer, algorithm: 'Ed25519' as const, publicKey,
      ...(record.notBefore !== undefined ? { notBefore: record.notBefore as number } : {}),
      ...(record.notAfter !== undefined ? { notAfter: record.notAfter as number } : {}),
      ...(record.revokedAt !== undefined ? { revokedAt: record.revokedAt as number } : {}),
    });
  });
  const revokedIds = payload.revokedCredentialIds ?? [];
  if (!Array.isArray(revokedIds) || revokedIds.length > 10_000 ||
      revokedIds.some((id) => typeof id !== 'string' || !UUID_V4.test(id)) ||
      new Set(revokedIds).size !== revokedIds.length) {
    fail('invalid_trust_bundle', 'Credential revocation list is invalid');
  }
  const revoked = new Set(revokedIds as string[]);
  return Object.freeze({
    version: version as number,
    issuedAt: iat as number,
    expiresAt: exp as number,
    trustedKeys: Object.freeze(trustedKeys),
    isCredentialRevoked: ({ jti }: { issuer: string; jti: string; platformId: string }) => revoked.has(jti),
  });
}
