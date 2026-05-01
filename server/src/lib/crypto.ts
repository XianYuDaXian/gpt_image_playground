import crypto from 'node:crypto'

function createKey(secret: string) {
  return crypto.createHash('sha256').update(secret).digest()
}

export function encryptText(plainText: string, secret: string) {
  const iv = crypto.randomBytes(12)
  const key = createKey(secret)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  return Buffer.concat([iv, tag, encrypted]).toString('base64')
}

export function decryptText(payload: string, secret: string) {
  const raw = Buffer.from(payload, 'base64')
  const iv = raw.subarray(0, 12)
  const tag = raw.subarray(12, 28)
  const encrypted = raw.subarray(28)
  const key = createKey(secret)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const plain = Buffer.concat([decipher.update(encrypted), decipher.final()])
  return plain.toString('utf8')
}

export function maskSecret(value: string | null) {
  if (!value) return null
  if (value.length <= 8) return '********'
  return `${value.slice(0, 4)}****${value.slice(-4)}`
}
