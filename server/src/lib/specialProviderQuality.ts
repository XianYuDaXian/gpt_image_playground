/** Venice / WaveSpeed / Kie：管理员开关门控后的质量/分辨率映射（方案 A） */

export type UserImageQuality = 'auto' | 'low' | 'medium' | 'high' | string

/** 用户是否显式请求高质量（仅 high） */
export function isHighQualityRequested(quality: UserImageQuality | null | undefined): boolean {
  return quality === 'high'
}

/**
 * 管理员关：固定 basic
 * 管理员开 + 用户 high：high
 * 其他：basic
 */
export function resolveAdminGatedKieQuality(options: {
  adminHighEnabled: boolean
  userQuality: UserImageQuality | null | undefined
}): 'basic' | 'high' {
  if (!options.adminHighEnabled) return 'basic'
  return isHighQualityRequested(options.userQuality) ? 'high' : 'basic'
}

/**
 * 管理员关：固定 1k
 * 管理员开 + 用户 high：2k
 * 其他：1k
 * 不升 4k，不按尺寸推断
 */
export function resolveAdminGatedResolution(options: {
  adminHighEnabled: boolean
  userQuality: UserImageQuality | null | undefined
}): '1k' | '2k' {
  if (!options.adminHighEnabled) return '1k'
  return isHighQualityRequested(options.userQuality) ? '2k' : '1k'
}
