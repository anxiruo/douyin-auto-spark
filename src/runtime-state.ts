import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export type SendStatus = 'pending' | 'sent'

interface SendRecord {
  date: string
  account: string
  target: string
  status: SendStatus
  updatedAt: string
}

interface RuntimeStateData {
  version: 1
  records: SendRecord[]
}

const STATE_RETENTION_DAYS = 14
const DEFAULT_LOCK_STALE_MILLISECONDS = 2 * 60 * 60 * 1000

export class RuntimeState {
  private constructor(
    private readonly path: string,
    private readonly data: RuntimeStateData,
  ) {}

  static async load(path: string): Promise<RuntimeState> {
    try {
      const text = await readFile(path, 'utf8')
      const value = JSON.parse(text) as Partial<RuntimeStateData>

      if (value.version !== 1 || !Array.isArray(value.records)) {
        throw new Error('状态文件格式不受支持')
      }

      return new RuntimeState(path, {
        version: 1,
        records: value.records.filter(isSendRecord),
      })
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return new RuntimeState(path, { version: 1, records: [] })
      }

      throw new Error(`无法读取运行状态文件 ${path}`, { cause: error })
    }
  }

  getStatus(date: string, account: string, target: string): SendStatus | undefined {
    return this.data.records.find(
      (record) => record.date === date && record.account === account && record.target === target,
    )?.status
  }

  async markPending(date: string, account: string, target: string): Promise<void> {
    await this.upsert(date, account, target, 'pending')
  }

  async markSent(date: string, account: string, target: string): Promise<void> {
    await this.upsert(date, account, target, 'sent')
  }

  private async upsert(
    date: string,
    account: string,
    target: string,
    status: SendStatus,
  ): Promise<void> {
    const existing = this.data.records.find(
      (record) => record.date === date && record.account === account && record.target === target,
    )

    if (existing) {
      existing.status = status
      existing.updatedAt = new Date().toISOString()
    } else {
      this.data.records.push({
        date,
        account,
        target,
        status,
        updatedAt: new Date().toISOString(),
      })
    }

    const retentionStart = new Date()
    retentionStart.setDate(retentionStart.getDate() - STATE_RETENTION_DAYS)
    const retentionDate = retentionStart.toISOString().slice(0, 10)
    this.data.records = this.data.records.filter((record) => record.date >= retentionDate)
    await writeJsonAtomically(this.path, this.data)
  }
}

export async function acquireRunLock(
  lockPath: string,
  staleMilliseconds = DEFAULT_LOCK_STALE_MILLISECONDS,
): Promise<() => Promise<void>> {
  await mkdir(dirname(lockPath), { recursive: true })

  try {
    const handle = await open(lockPath, 'wx')
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
      'utf8',
    )
    await handle.close()
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') {
      throw error
    }

    const lockStat = await stat(lockPath)
    if (Date.now() - lockStat.mtimeMs <= staleMilliseconds) {
      throw new Error('已有续火任务正在运行；为避免重复发送，本次任务已停止')
    }

    await unlink(lockPath)
    return acquireRunLock(lockPath, staleMilliseconds)
  }

  let released = false
  return async () => {
    if (released) return
    released = true
    await unlink(lockPath).catch((error: unknown) => {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error
    })
  }
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporaryPath, path)
}

function isSendRecord(value: unknown): value is SendRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<SendRecord>
  return (
    typeof record.date === 'string' &&
    typeof record.account === 'string' &&
    typeof record.target === 'string' &&
    (record.status === 'pending' || record.status === 'sent') &&
    typeof record.updatedAt === 'string'
  )
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
