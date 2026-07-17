import { describe, expect, it } from 'vitest'
import {
  buildTaskListRequestKey,
  canApplyTaskListResult,
  clampTaskPage,
  isSameTaskListRequestKey,
} from './taskListRequest'

describe('taskListRequest', () => {
  it('相同筛选与页码生成稳定 requestKey', () => {
    const a = buildTaskListRequestKey({
      page: 4,
      pageSize: 50,
      searchTags: ['猫', '白底'],
      searchTagMode: 'include',
      status: 'done',
      taskType: 'image',
      favorite: false,
      archived: false,
      showUsageCodeTasksForAdmin: false,
    })
    const b = buildTaskListRequestKey({
      page: 4,
      pageSize: 50,
      searchTags: ['猫', '白底'],
      searchTagMode: 'include',
      status: 'done',
      taskType: 'image',
      favorite: false,
      archived: false,
      showUsageCodeTasksForAdmin: false,
    })
    expect(isSameTaskListRequestKey(a, b)).toBe(true)
  })

  it('旧请求结果不可覆盖新请求', () => {
    const key = buildTaskListRequestKey({
      page: 4,
      pageSize: 50,
      searchTags: [],
      searchTagMode: 'include',
      status: 'all',
      taskType: 'all',
      favorite: false,
      archived: false,
      showUsageCodeTasksForAdmin: false,
    })
    expect(canApplyTaskListResult({
      responseSeq: 3,
      lastAppliedSeq: 4,
      inFlightSeq: 5,
      requestKey: key,
      currentKey: key,
    })).toBe(false)
  })

  it('最新飞行请求且 key 仍匹配时可以应用', () => {
    const key = buildTaskListRequestKey({
      page: 4,
      pageSize: 50,
      searchTags: ['风景'],
      searchTagMode: 'include',
      status: 'all',
      taskType: 'all',
      favorite: false,
      archived: false,
      showUsageCodeTasksForAdmin: false,
    })
    expect(canApplyTaskListResult({
      responseSeq: 5,
      lastAppliedSeq: 4,
      inFlightSeq: 5,
      requestKey: key,
      currentKey: key,
    })).toBe(true)
  })

  it('仅在当前条件下 total 变小时才 clamp 页码', () => {
    expect(clampTaskPage({ page: 4, total: 120, pageSize: 30 })).toBe(4)
    expect(clampTaskPage({ page: 4, total: 50, pageSize: 30 })).toBe(2)
    expect(clampTaskPage({ page: 1, total: 0, pageSize: 30 })).toBe(1)
  })
})
