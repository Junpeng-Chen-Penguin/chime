// 落盘凭据的加解密：模型密钥与 MCP 认证头。
// 走 Electron safeStorage（macOS 钥匙串 / Windows DPAPI / Linux libsecret），
// 密文以 base64 存回原来的 TEXT 列，不改表结构。
//
// 前缀区分明文与密文，因此新旧数据可以共存：读到没有前缀的按明文返回，
// 下次写入时自然变成密文；migrateSecrets 在启动时把存量明文一次性转过来。
import { safeStorage } from 'electron'

const PREFIX = 'enc.v1:'

export function isSealed(v: string): boolean {
  return v.startsWith(PREFIX)
}

// safeStorage 在 app ready 之前一律返回 false，所以迁移必须等 ready 之后再跑
export function canSeal(): boolean {
  return safeStorage.isEncryptionAvailable()
}

export function seal(plain: string): string {
  // 空值不加密——空密钥是「没填」，加密后反而看不出来了
  if (!plain || isSealed(plain)) return plain
  if (!safeStorage.isEncryptionAvailable()) return plain // 无钥匙串的环境降级存明文，功能不受影响
  return PREFIX + safeStorage.encryptString(plain).toString('base64')
}

export function unseal(stored: string): string {
  if (!stored || !isSealed(stored)) return stored
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(PREFIX.length), 'base64'))
  } catch {
    return '' // 换机器或钥匙串条目被删：解不开就当没填，让用户重填，不要抛异常拦住启动
  }
}
