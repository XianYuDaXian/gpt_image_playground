import type { BackendReminderItem } from './backendSettings'

const REMINDER_SHOW_STATE_KEY = 'gpt-image-playground-reminder-show-state'
const REMINDER_COMPLETED_STATE_KEY = 'gpt-image-playground-reminder-completed-state'
export const REMINDER_COMPLETED_STATE_CHANGED_EVENT = 'gpt-image-playground-reminder-completed-state-changed'

interface ReminderShowState {
  shownSlotKeys: string[]
}

interface ReminderCompletedState {
  seenKeys: string[]
}

function getTodayKey(now: Date) {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function timeToMinutes(value: string) {
  const [hourText, minuteText] = value.split(':')
  return Number(hourText) * 60 + Number(minuteText)
}

function isWithinDailyWindow(now: Date, startTime: string, endTime: string) {
  const currentMinutes = now.getHours() * 60 + now.getMinutes()
  const startMinutes = timeToMinutes(startTime)
  const endMinutes = timeToMinutes(endTime)

  if (startMinutes === endMinutes) return true
  if (startMinutes < endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes
  }
  return currentMinutes >= startMinutes || currentMinutes < endMinutes
}

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function writeJson(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value))
}

function notifyCompletedStateChanged() {
  window.dispatchEvent(new Event(REMINDER_COMPLETED_STATE_CHANGED_EVENT))
}

function getReminderVersionKey(item: BackendReminderItem) {
  const endAtTime = new Date(item.endAt).getTime()
  return `${item.id}:${Number.isFinite(endAtTime) ? endAtTime : item.endAt}`
}

function getScheduleDayKey(now: Date, startTime: string, endTime: string) {
  const currentMinutes = now.getHours() * 60 + now.getMinutes()
  const startMinutes = timeToMinutes(startTime)
  const endMinutes = timeToMinutes(endTime)
  if (startMinutes > endMinutes && currentMinutes < endMinutes) {
    const previousDay = new Date(now)
    previousDay.setDate(previousDay.getDate() - 1)
    return getTodayKey(previousDay)
  }
  return getTodayKey(now)
}

function getShowState() {
  return readJson<ReminderShowState>(REMINDER_SHOW_STATE_KEY) ?? { shownSlotKeys: [] }
}

function getCompletedState() {
  return readJson<ReminderCompletedState>(REMINDER_COMPLETED_STATE_KEY) ?? { seenKeys: [] }
}

export function clearAnnouncementLocalState() {
  localStorage.removeItem(REMINDER_SHOW_STATE_KEY)
  localStorage.removeItem(REMINDER_COMPLETED_STATE_KEY)
  notifyCompletedStateChanged()
}

export function isReminderCompleted(item: BackendReminderItem, now = new Date()) {
  return new Date(item.endAt).getTime() <= now.getTime()
}

export function isReminderActive(item: BackendReminderItem, now = new Date()) {
  if (!item.enabled) return false
  const startAt = new Date(item.startAt).getTime()
  const endAt = new Date(item.endAt).getTime()
  const current = now.getTime()
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt)) return false
  if (current < startAt || current > endAt) return false
  return isWithinDailyWindow(now, item.startTime, item.endTime)
}

function getReminderCurrentSlot(item: BackendReminderItem, now: Date) {
  const currentMinutes = now.getHours() * 60 + now.getMinutes()
  const startMinutes = timeToMinutes(item.startTime)
  const endMinutes = timeToMinutes(item.endTime)

  let totalWindowMinutes = 0
  let elapsedMinutes = 0

  if (startMinutes === endMinutes) {
    totalWindowMinutes = 24 * 60
    elapsedMinutes = currentMinutes
  } else if (startMinutes < endMinutes) {
    totalWindowMinutes = endMinutes - startMinutes
    elapsedMinutes = currentMinutes - startMinutes
  } else if (currentMinutes >= startMinutes) {
    totalWindowMinutes = 24 * 60 - startMinutes + endMinutes
    elapsedMinutes = currentMinutes - startMinutes
  } else {
    totalWindowMinutes = 24 * 60 - startMinutes + endMinutes
    elapsedMinutes = 24 * 60 - startMinutes + currentMinutes
  }

  const slotLength = totalWindowMinutes / item.maxDailyShows
  return Math.min(item.maxDailyShows - 1, Math.max(0, Math.floor(elapsedMinutes / Math.max(slotLength, 1))))
}

function getReminderShowSlotKey(item: BackendReminderItem, now: Date) {
  return `${getReminderVersionKey(item)}:${getScheduleDayKey(now, item.startTime, item.endTime)}:${getReminderCurrentSlot(item, now)}`
}

export function getNextReminderToShow(items: BackendReminderItem[], now = new Date()) {
  return getRemindersToShow(items, now)[0] ?? null
}

export function getRemindersToShow(items: BackendReminderItem[], now = new Date()) {
  const showState = getShowState()
  const shownSlotSet = new Set(showState.shownSlotKeys)
  const sorted = [...items].sort((a, b) => new Date(a.endAt).getTime() - new Date(b.endAt).getTime())
  const results: BackendReminderItem[] = []
  for (const item of sorted) {
    if (!isReminderActive(item, now)) continue
    if (!item.message.trim()) continue
    if (shownSlotSet.has(getReminderShowSlotKey(item, now))) continue
    results.push(item)
  }
  return results
}

export function markReminderShown(item: BackendReminderItem, now = new Date()) {
  const state = getShowState()
  const key = getReminderShowSlotKey(item, now)
  if (!state.shownSlotKeys.includes(key)) {
    state.shownSlotKeys.push(key)
  }
  writeJson(REMINDER_SHOW_STATE_KEY, state)
}

export function markRemindersShown(items: BackendReminderItem[], now = new Date()) {
  const state = getShowState()
  let changed = false
  for (const item of items) {
    const key = getReminderShowSlotKey(item, now)
    if (state.shownSlotKeys.includes(key)) continue
    state.shownSlotKeys.push(key)
    changed = true
  }
  if (changed) {
    writeJson(REMINDER_SHOW_STATE_KEY, state)
  }
}

export function hasUnreadCompletedReminders(items: BackendReminderItem[], now = new Date()) {
  const completedState = getCompletedState()
  const seenSet = new Set(completedState.seenKeys)
  return items.some((item) => isReminderCompleted(item, now) && !seenSet.has(getReminderVersionKey(item)))
}

export function isCompletedReminderUnread(item: BackendReminderItem, now = new Date()) {
  const completedState = getCompletedState()
  const seenSet = new Set(completedState.seenKeys)
  return isReminderCompleted(item, now) && !seenSet.has(getReminderVersionKey(item))
}

export function markCompletedRemindersSeen(items: BackendReminderItem[], now = new Date()) {
  const completedState = getCompletedState()
  const seenSet = new Set(completedState.seenKeys)
  for (const item of items) {
    if (!isReminderCompleted(item, now)) continue
    seenSet.add(getReminderVersionKey(item))
  }
  writeJson(REMINDER_COMPLETED_STATE_KEY, {
    seenKeys: Array.from(seenSet),
  })
  notifyCompletedStateChanged()
}

export function markCompletedReminderSeen(item: BackendReminderItem) {
  const completedState = getCompletedState()
  const seenSet = new Set(completedState.seenKeys)
  seenSet.add(getReminderVersionKey(item))
  writeJson(REMINDER_COMPLETED_STATE_KEY, {
    seenKeys: Array.from(seenSet),
  })
  notifyCompletedStateChanged()
}
