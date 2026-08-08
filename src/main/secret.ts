// 落盘凭据的加解密：模型密钥与 MCP 认证头。密文以 base64 存回原来的 TEXT 列，不改表结构。
//
// 自持密钥（AES-256-GCM，密钥文件在 userData 下、权限 0600），不用 Electron safeStorage：
// macOS 把钥匙串授权绑在单个构建的代码哈希上，自签名应用每发一版都要重新授权一次；
// 想让授权按团队记就得让签名带 Team ID，而自签证书带了 Team ID 会被 AMFI 拒绝加载。
// 代价是保护强度降为文件权限级（等同 .env 里放密钥），换掉每版一弹。
//
// 前缀区分明文与密文，因此新旧数据可以共存：读到没有前缀的按明文返回，
// 下次写入时自然变成密文；migrateSecrets 在启动时把存量明文与 v1 密文一次性转过来。
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'

const PREFIX = 'enc.v2:'
const LEGACY = 'enc.v1:' // safeStorage 时代的密文，只解不写

let cached: Buffer | null = null

// 密钥文件读不到或坏了就新生成一把——此时旧密文本来也解不开，让用户重填
function key(): Buffer {
  if (cached) return cached
  const path = join(app.getPath('userData'), 'secret.key')
  try {
    const k = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64')
    if (k.length !== 32) throw new Error('密钥长度不对')
    cached = k
  } catch {
    cached = randomBytes(32)
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(path, cached.toString('base64'), { mode: 0o600 })
    chmodSync(path, 0o600) // 文件已存在时 writeFileSync 的 mode 不生效，补一次
  }
  return cached
}

export function isSealed(v: string): boolean {
  return v.startsWith(PREFIX)
}

// 留作迁移开关：密钥文件写不进去（磁盘只读等）时降级存明文，功能不受影响
export function canSeal(): boolean {
  try {
    key()
    return true
  } catch {
    return false
  }
}

export function seal(plain: string): string {
  // 空值不加密——空密钥是「没填」，加密后反而看不出来了
  if (!plain || isSealed(plain)) return plain
  if (!canSeal()) return plain
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')
}

export function unseal(stored: string): string {
  if (!stored) return stored
  try {
    // 迁移路径：v1 密文解开后交给调用方，写回时自然变成 v2
    if (stored.startsWith(LEGACY)) {
      return safeStorage.decryptString(Buffer.from(stored.slice(LEGACY.length), 'base64'))
    }
    if (!isSealed(stored)) return stored
    const buf = Buffer.from(stored.slice(PREFIX.length), 'base64')
    const decipher = createDecipheriv('aes-256-gcm', key(), buf.subarray(0, 12))
    decipher.setAuthTag(buf.subarray(12, 28))
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8')
  } catch {
    return '' // 密钥文件丢了或密文坏了：解不开就当没填，让用户重填，不要抛异常拦住启动
  }
}
