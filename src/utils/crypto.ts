import crypto from 'node:crypto';

// TODO(security): Resolve session secret from environment variable, falling back to an ephemeral key for local testing.
const getSecretKey = (): Buffer => {
  const secret = process.env.SESSION_SECRET;
  if (secret) {
    // If it's a 64-character hex string (32 bytes), parse it directly. Otherwise, hash it to ensure 32 bytes.
    if (/^[0-9a-fA-F]{64}$/.test(secret)) {
      return Buffer.from(secret, 'hex');
    }
    return crypto.createHash('sha256').update(secret).digest();
  }
  
  // Safe fallback for development/testing environments.
  console.warn("Generating ephemeral secret. Instance-isolated!");
  return crypto.randomBytes(32);
};

const SECRET_KEY = getSecretKey();
const ALGORITHM = 'aes-256-gcm';

/**
 * Encrypts data into a secure stateless session token.
 * Output format: iv_hex:encrypted_hex:auth_tag_hex
 */
export function encrypt(data: any): string {
  const jsonStr = JSON.stringify(data);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, SECRET_KEY, iv);
  
  let encrypted = cipher.update(jsonStr, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag();
  
  return `${iv.toString('hex')}:${encrypted}:${authTag.toString('hex')}`;
}

/**
 * Decrypts a secure stateless session token and returns the parsed data.
 * Returns null if the token has been tampered with or is invalid.
 */
export function decrypt(token: string): any {
  try {
    const parts = token.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid token structure');
    }
    
    const [ivHex, encryptedHex, authTagHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const encrypted = Buffer.from(encryptedHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    
    const decipher = crypto.createDecipheriv(ALGORITHM, SECRET_KEY, iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(encrypted, undefined, 'utf8');
    decrypted += decipher.final('utf8');
    
    return JSON.parse(decrypted);
  } catch (error) {
    console.error('Failed to decrypt session token:', error);
    return null;
  }
}
