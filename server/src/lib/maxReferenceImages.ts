/** 参考图硬上限，前后端统一 */
export const MAX_REFERENCE_IMAGES_HARD_LIMIT = 16

export type ProviderApiMode = 'images' | 'responses' | 'videos' | 'venice_images' | 'wavespeed' | 'kie'

export function isMultiModelImageMode(apiMode: ProviderApiMode | null | undefined): boolean {
  return apiMode === 'venice_images' || apiMode === 'wavespeed' || apiMode === 'kie'
}

/** 按端点类型返回默认参考图上限 */
export function defaultMaxReferenceImages(apiMode: ProviderApiMode | null | undefined): number {
  return isMultiModelImageMode(apiMode) ? 3 : MAX_REFERENCE_IMAGES_HARD_LIMIT
}

/** 规范化管理员配置的参考图上限 */
export function normalizeMaxReferenceImages(
  apiMode: ProviderApiMode | null | undefined,
  value: unknown,
): number {
  const fallback = defaultMaxReferenceImages(apiMode)
  if (value == null || value === '') return fallback
  const numberValue = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numberValue)) return fallback
  const intValue = Math.floor(numberValue)
  return Math.min(MAX_REFERENCE_IMAGES_HARD_LIMIT, Math.max(1, intValue))
}

function isEnabledFlag(value: boolean | number | null | undefined): boolean {
  return value !== false && value !== 0
}

/**
 * 计算实际上传/提交上限。
 * 特殊端点会叠加单图/多图开关；普通端点直接使用配置值。
 */
export function resolveEffectiveMaxReferenceImages(provider: {
  apiMode: ProviderApiMode | null | undefined
  maxReferenceImages?: number | null
  veniceEditEnabled?: boolean | number | null
  veniceMultiEditEnabled?: boolean | number | null
} | null | undefined): number {
  if (!provider) return MAX_REFERENCE_IMAGES_HARD_LIMIT
  const configured = normalizeMaxReferenceImages(provider.apiMode, provider.maxReferenceImages)
  if (!isMultiModelImageMode(provider.apiMode)) return configured

  const editEnabled = isEnabledFlag(provider.veniceEditEnabled)
  const multiEditEnabled = isEnabledFlag(provider.veniceMultiEditEnabled)
  if (!editEnabled && !multiEditEnabled) return 0
  if (!multiEditEnabled) return 1
  return configured
}
