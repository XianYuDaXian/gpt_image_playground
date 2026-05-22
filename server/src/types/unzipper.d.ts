declare module 'unzipper' {
  import type { Readable } from 'node:stream'

  export interface FileEntry {
    path: string
    type: 'File' | 'Directory'
    buffer(): Promise<Buffer>
    stream(): Readable
  }

  export interface CentralDirectory {
    files: FileEntry[]
  }

  const unzipper: {
    Open: {
      file(path: string): Promise<CentralDirectory>
    }
  }

  export default unzipper
}
