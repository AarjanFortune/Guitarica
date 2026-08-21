// Opt-in, client-side-only cache of full transcription results -- notes,
// tab data, metadata, everything except the audio bytes (audioCache.ts
// already owns those, keyed by the same job id). This is what keeps a
// "keep on this device only" job usable from Account history after its
// cloud row expires and is deleted server-side: without this, only the
// audio would have survived, which on its own has nothing to play back
// against. Entirely local to one browser profile, same as audioCache.ts.

import { TranscriptionResult } from '../types/transcription'

const DB_NAME = 'guitarica-local-history'
const STORE = 'entries'
const DB_VERSION = 1

export interface LocalHistoryEntry {
  jobId: string
  sourceKind: 'upload' | 'youtube'
  sourceName: string
  createdAt: string
  hasLocalAudio: boolean
  result: Omit<TranscriptionResult, 'audioUrl' | 'sourceFile'>
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: 'jobId' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function saveLocalHistory(entry: LocalHistoryEntry): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(entry)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}

export async function listLocalHistory(): Promise<LocalHistoryEntry[]> {
  const db = await openDb()
  const entries = await new Promise<LocalHistoryEntry[]>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const request = tx.objectStore(STORE).getAll()
    request.onsuccess = () => resolve((request.result as LocalHistoryEntry[]) || [])
    request.onerror = () => reject(request.error)
  })
  db.close()
  return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function deleteLocalHistory(jobId: string): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(jobId)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}

export async function clearAllLocalHistory(): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).clear()
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}
