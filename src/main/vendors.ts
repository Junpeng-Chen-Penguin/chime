// 预置模型服务商：支持哪些家由代码决定，使用者只填密钥、选模型（PRD Case 6）。
// 窗口取值三级：接口字段 → 此处预置 → WINDOW_FALLBACK 兜底。

export interface VendorPreset {
  vendor: string // 主键，全系统以 vendor:model 定位模型
  name: string // 界面显示名
  baseUrl: string // 默认服务地址，可改可还原
  windows: Record<string, number> // 已知模型的上下文窗口（登记表拉不到时的兜底）
  registryId?: string // 该厂商在 models.dev 里的 id，与 vendor 不同时才写
}

export const WINDOW_FALLBACK = 131072

export const VENDORS: VendorPreset[] = [
  {
    vendor: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    // V4 两个型号都是 1M 上下文（2026-08-09 核对官方定价页）。deepseek-chat／deepseek-reasoner
    // 已于 2026-07-24 下线，实测 GET /models 只返回下面两个，故不再预置
    windows: {
      'deepseek-v4-pro': 1048576,
      'deepseek-v4-flash': 1048576
    }
  },
  {
    vendor: 'zhipu',
    name: '智谱开放平台',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    registryId: 'zhipuai',
    windows: {
      'glm-5.2': 1048576,
      'glm-5.1': 204800,
      'glm-5': 204800,
      'glm-5-turbo': 204800,
      'glm-4.7': 204800,
      'glm-4.7-flash': 204800,
      'glm-4.7-flashx': 204800,
      'glm-4.6': 204800,
      'glm-4.5': 131072,
      'glm-4.5-air': 131072,
      'glm-4.5-airx': 131072,
      'glm-4.5-flash': 131072
    }
  }
]

export function vendorPreset(vendor: string): VendorPreset | null {
  return VENDORS.find((v) => v.vendor === vendor) ?? null
}

// 旧配置迁移：按服务地址域名判归属，匹配不上归 deepseek（保留原 base_url，窗口走兜底）
export function vendorFromBaseUrl(baseUrl: string): string {
  if (baseUrl.includes('bigmodel.cn') || baseUrl.includes('z.ai')) return 'zhipu'
  return 'deepseek'
}

// vendor:model 存法的解析（历史数据无前缀按 deepseek 补齐）
export function parseModelRef(ref: string): { vendor: string; model: string } {
  const i = ref.indexOf(':')
  if (i < 0) return { vendor: 'deepseek', model: ref }
  return { vendor: ref.slice(0, i), model: ref.slice(i + 1) }
}

export function windowFor(vendor: string, model: string): number {
  return vendorPreset(vendor)?.windows[model.toLowerCase()] ?? WINDOW_FALLBACK
}
