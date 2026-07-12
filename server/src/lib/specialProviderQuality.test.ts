import { describe, expect, it } from 'vitest'
import {
  isHighQualityRequested,
  resolveAdminGatedKieQuality,
  resolveAdminGatedResolution,
} from './specialProviderQuality.js'

describe('specialProviderQuality', () => {
  it('仅 high 视为用户请求高质量', () => {
    expect(isHighQualityRequested('high')).toBe(true)
    expect(isHighQualityRequested('medium')).toBe(false)
    expect(isHighQualityRequested('low')).toBe(false)
    expect(isHighQualityRequested('auto')).toBe(false)
  })

  it('管理员关闭时 Kie quality 固定 basic', () => {
    expect(resolveAdminGatedKieQuality({ adminHighEnabled: false, userQuality: 'high' })).toBe('basic')
    expect(resolveAdminGatedKieQuality({ adminHighEnabled: false, userQuality: 'auto' })).toBe('basic')
  })

  it('管理员开启时仅 high 映射为 Kie high', () => {
    expect(resolveAdminGatedKieQuality({ adminHighEnabled: true, userQuality: 'high' })).toBe('high')
    expect(resolveAdminGatedKieQuality({ adminHighEnabled: true, userQuality: 'medium' })).toBe('basic')
    expect(resolveAdminGatedKieQuality({ adminHighEnabled: true, userQuality: 'auto' })).toBe('basic')
  })

  it('管理员关闭时分辨率固定 1k', () => {
    expect(resolveAdminGatedResolution({ adminHighEnabled: false, userQuality: 'high' })).toBe('1k')
  })

  it('管理员开启时仅 high 映射为 2k', () => {
    expect(resolveAdminGatedResolution({ adminHighEnabled: true, userQuality: 'high' })).toBe('2k')
    expect(resolveAdminGatedResolution({ adminHighEnabled: true, userQuality: 'medium' })).toBe('1k')
    expect(resolveAdminGatedResolution({ adminHighEnabled: true, userQuality: 'low' })).toBe('1k')
  })
})
