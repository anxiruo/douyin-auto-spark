import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { acquireRunLock, RuntimeState } from './runtime-state'

test('persists pending and sent records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'douyin-spark-state-'))
  const statePath = join(directory, 'state.json')

  try {
    const state = await RuntimeState.load(statePath)
    assert.equal(state.getStatus('2026-09-17', 'account', 'friend'), undefined)

    await state.markPending('2026-09-17', 'account', 'friend')
    assert.equal(state.getStatus('2026-09-17', 'account', 'friend'), 'pending')

    const reloaded = await RuntimeState.load(statePath)
    assert.equal(reloaded.getStatus('2026-09-17', 'account', 'friend'), 'pending')

    await reloaded.markSent('2026-09-17', 'account', 'friend')
    assert.equal(reloaded.getStatus('2026-09-17', 'account', 'friend'), 'sent')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('prevents concurrent runs until the lock is released', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'douyin-spark-lock-'))
  const lockPath = join(directory, 'run.lock')

  try {
    const release = await acquireRunLock(lockPath)
    await assert.rejects(acquireRunLock(lockPath), /已有续火任务正在运行/)
    await release()

    const releaseAgain = await acquireRunLock(lockPath)
    await releaseAgain()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
