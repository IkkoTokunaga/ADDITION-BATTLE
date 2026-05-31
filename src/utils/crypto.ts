import crypto from 'node:crypto';

const ALGO = 'aes-256-gcm';

// Derive a stable 32-byte key. In production SESSION_SECRET MUST be set
// (ideally 64 hex chars). The dev fallback is deterministic so tokens stay
// valid across multiple serverless instances / restarts during development.
function getKey(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (secret && /^[0-9a-fA-F]{64}$/.test(secret)) {
    return Buffer.from(secret, 'hex');
  }
  const source = secret || 'addition-battle-dev-stable-key';
  return crypto.createHash('sha256').update(source).digest();
}

const KEY = getKey();

// Token format: ivHex:encryptedHex:authTagHex
export function encrypt(payload: unknown): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const json = JSON.stringify(payload);
  const encrypted = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${encrypted.toString('hex')}:${authTag.toString('hex')}`;
}

export function decrypt<T = any>(token: string): T | null {
  try {
    const [ivHex, encHex, tagHex] = token.split(':');
    if (!ivHex || !encHex || !tagHex) return null;
    const iv = Buffer.from(ivHex, 'hex');
    const encrypted = Buffer.from(encHex, 'hex');
    const authTag = Buffer.from(tagHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGO, KEY, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8')) as T;
  } catch {
    return null;
  }
}
