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

export class TaskEventBus {
  private emitter = new EventEmitter()

  emit(taskId: string, event: TaskEventRecord) {
    this.emitter.emit(taskId, event)
  }

  subscribe(taskId: string, listener: (event: TaskEventRecord) => void) {
    this.emitter.on(taskId, listener)
    return () => {
      this.emitter.off(taskId, listener)
    }
  }
}
