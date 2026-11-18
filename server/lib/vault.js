// Encrypts OEM API credentials at rest with AES-256-GCM.
// The key comes from the MASTER_KEY environment variable, or is generated
// once into <DATA_DIR>/master.key (mode 0600). Neither is ever in source code.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export class Vault {
  constructor(key) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Vault key must be 32 bytes');
    this.key = key;
  }

  static fromEnv(dataDir, env = process.env) {
    if (env.MASTER_KEY) {
      const raw = env.MASTER_KEY.trim();
      if (/^[0-9a-f]{64}$/i.test(raw)) return new Vault(Buffer.from(raw, 'hex'));
      // Any other value (for example a hosting provider's generated secret) is
      // stretched to 32 bytes. It should be long and random.
      if (raw.length < 32) throw new Error('MASTER_KEY must be 64 hex characters or a random string of at least 32 characters');
      return new Vault(crypto.createHash('sha256').update(raw).digest());
    }
    const file = path.join(dataDir, 'master.key');
    if (fs.existsSync(file)) return new Vault(Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex'));
    fs.mkdirSync(dataDir, { recursive: true });
    const k = crypto.randomBytes(32);
    fs.writeFileSync(file, k.toString('hex'), { mode: 0o600 });
    console.warn(`[vault] No MASTER_KEY set. Generated a key at ${file}. Set MASTER_KEY in production.`);
    return new Vault(k);
  }

  encrypt(obj) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
    return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  }

  decrypt(box) {
    if (!box) return {};
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(box.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
    const out = Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]);
    return JSON.parse(out.toString('utf8'));
  }
}

/** Describe which secret fields are set without revealing them. */
export function maskSecrets(fields, secrets) {
  const out = {};
  for (const f of fields) {
    const v = secrets?.[f.key];
    out[f.key] = v ? 'Stored' : null;
  }
  return out;
}
