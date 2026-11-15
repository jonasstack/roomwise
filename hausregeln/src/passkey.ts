/**
 * Face ID / Touch ID / fingerprint via passkeys (WebAuthn). Needs a secure connection (https or localhost);
 * the server checks every confirmation (custom_components/roomwise/house_rules/webauthn.py).
 */
import type { Store } from './store';
import { t } from './i18n';
// i18n: complete

const b64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

export function passkeyAvailable(): boolean {
  return !!(window.isSecureContext && window.PublicKeyCredential && navigator.credentials);
}

/** Sets up this device. Anyone but a Home Assistant admin needs the alarm PIN (`code`, checked by the server). */
export async function registerPasskey(store: Store, name: string, code?: string): Promise<void> {
  const ch = await store.alarmChallenge();
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: unb64(ch.challenge),
      rp: { name: t('app.name'), id: location.hostname },
      user: { id: new TextEncoder().encode(ch.user || 'hausregeln'), name: name || t('app.name'), displayName: name || t('app.name') },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
      attestation: 'none',
      timeout: 60000,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error(t('alarm.cancelled'));
  const r = cred.response as AuthenticatorAttestationResponse;
  await store.alarmRegisterDevice({ id: cred.id, attestationObject: b64(r.attestationObject), clientDataJSON: b64(r.clientDataJSON) }, name, location.hostname, code);
}

/** Confirms with Face ID / Touch ID and returns what the server checks. */
export async function confirmPasskey(store: Store): Promise<Record<string, string>> {
  const ch = await store.alarmChallenge();
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: unb64(ch.challenge),
      rpId: location.hostname,
      allowCredentials: ch.credentials.map((id) => ({ type: 'public-key' as const, id: unb64(id) })),
      userVerification: 'required',
      timeout: 60000,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error(t('alarm.cancelled'));
  const r = cred.response as AuthenticatorAssertionResponse;
  return { id: cred.id, authenticatorData: b64(r.authenticatorData), clientDataJSON: b64(r.clientDataJSON), signature: b64(r.signature) };
}
