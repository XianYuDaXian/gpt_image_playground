import { EventEmitter } from 'node:events'

export interface TaskEventRecord {
  id: number
  taskId: string
  status: string
  step: string
  percent: number
  message: string | null
  createdAt: string
}

export interface TaskListEventRecord {
  type: 'upsert' | 'delete'
  taskId: string
  ownerUsageCodeId?: string | null
  ownerKind?: string
}

export class TaskEventBus {
  private emitter = new EventEmitter()
  private static readonly TASK_LIST_CHANNEL = '__task-list__'

  emit(taskId: string, event: TaskEventRecord) {
    this.emitter.emit(taskId, event)
    this.emitter.emit(TaskEventBus.TASK_LIST_CHANNEL, {
      type: 'upsert',
      taskId,
    } satisfies TaskListEventRecord)
  }

  emitDeleted(taskId: string, owner?: { ownerUsageCodeId: string | null; ownerKind: string }) {
    this.emitter.emit(TaskEventBus.TASK_LIST_CHANNEL, {
      type: 'delete',
      taskId,
      ownerUsageCodeId: owner?.ownerUsageCodeId,
      ownerKind: owner?.ownerKind,
    } satisfies TaskListEventRecord)
  }

  emitTaskChanged(taskId: string) {
    this.emitter.emit(TaskEventBus.TASK_LIST_CHANNEL, {
      type: 'upsert',
      taskId,
    } satisfies TaskListEventRecord)
  }

  subscribe(taskId: string, listener: (event: TaskEventRecord) => void) {
    this.emitter.on(taskId, listener)
    return () => {
      this.emitter.off(taskId, listener)
    }
  }

  subscribeAll(listener: (event: TaskListEventRecord) => void) {
    this.emitter.on(TaskEventBus.TASK_LIST_CHANNEL, listener)
    return () => {
      this.emitter.off(TaskEventBus.TASK_LIST_CHANNEL, listener)
    }
  }
}
