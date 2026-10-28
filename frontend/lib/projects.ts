import { isUploadResult, UploadResult } from './api'

const DB_NAME = 'omnistat'
const STORE = 'projects'
export const MAX_PROJECT_NAME = 100

export class ProjectStorageError extends Error {}

export interface DatasetProject {
  schema_version: 1
  id: string
  name: string
  source_file: string
  created_at: string
  dataset: UploadResult
}

export interface ProjectSummary {
  id: string
  name: string
  source_file: string
  created_at: string
  rows: number
  columns: number
}

export interface ProjectList {
  projects: ProjectSummary[]
  /** Keys of unreadable records, which can only be deleted. */
  invalid: IDBValidKey[]
}

function isProject(value: unknown): value is DatasetProject {
  if (typeof value !== 'object' || value === null) return false
  const p = value as Record<string, unknown>
  return p.schema_version === 1 && typeof p.id === 'string' && p.id.length > 0 &&
    typeof p.name === 'string' && p.name.trim().length > 0 && p.name.length <= MAX_PROJECT_NAME &&
    typeof p.source_file === 'string' && typeof p.created_at === 'string' &&
    !Number.isNaN(Date.parse(p.created_at)) && isUploadResult(p.dataset)
}

function storageError(error: unknown, action: string): ProjectStorageError {
  if (error instanceof ProjectStorageError) return error
  const name = error instanceof DOMException ? error.name : ''
  if (name === 'QuotaExceededError') {
    return new ProjectStorageError(`Could not ${action}: this browser's storage is full. Delete unused projects or free browser storage.`)
  }
  return new ProjectStorageError(`Could not ${action} in this browser. Check that site storage is allowed and not in a restricted private window.`)
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new ProjectStorageError('Saved projects need browser storage (IndexedDB), which is unavailable here.'))
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new ProjectStorageError('Saved projects are blocked by another OmniStat tab. Close other tabs and try again.'))
  })
}

async function withStore<T>(
  mode: IDBTransactionMode, action: string, run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  let db: IDBDatabase | undefined
  try {
    db = await openDatabase()
    const tx = db.transaction(STORE, mode)
    const request = run(tx.objectStore(STORE))
    return await new Promise<T>((resolve, reject) => {
      tx.oncomplete = () => resolve(request.result)
      tx.onerror = () => reject(tx.error ?? request.error)
      tx.onabort = () => reject(tx.error ?? request.error)
    })
  } catch (error) {
    throw storageError(error, action)
  } finally {
    db?.close()
  }
}

export function defaultProjectName(fileName: string): string {
  return fileName.replace(/\.(csv|xlsx|xls)$/i, '').trim().slice(0, MAX_PROJECT_NAME) || 'Untitled dataset'
}

export async function saveProject(name: string, sourceFile: string, dataset: UploadResult): Promise<DatasetProject> {
  const trimmed = name.trim()
  if (!trimmed || trimmed.length > MAX_PROJECT_NAME) {
    throw new ProjectStorageError(`Enter a project name of 1–${MAX_PROJECT_NAME} characters.`)
  }
  if (!isUploadResult(dataset)) throw new ProjectStorageError('This dataset is incomplete and was not saved. Upload the file again.')
  const project: DatasetProject = {
    schema_version: 1, id: crypto.randomUUID(), name: trimmed,
    source_file: sourceFile, created_at: new Date().toISOString(), dataset,
  }
  await withStore('readwrite', 'save the project', (store) => store.add(project))
  return project
}

export async function listProjects(): Promise<ProjectList> {
  const records = await withStore<unknown[]>('readonly', 'load saved projects', (store) => store.getAll())
  const projects: ProjectSummary[] = []
  const invalid: IDBValidKey[] = []
  for (const record of records) {
    if (isProject(record)) {
      projects.push({
        id: record.id, name: record.name, source_file: record.source_file, created_at: record.created_at,
        rows: record.dataset.rows, columns: record.dataset.columns.length,
      })
    } else {
      const id = (record as { id?: unknown } | null)?.id
      if (typeof id === 'string' || typeof id === 'number') invalid.push(id)
    }
  }
  projects.sort((a, b) => b.created_at.localeCompare(a.created_at))
  return { projects, invalid }
}

export async function getProject(id: string): Promise<DatasetProject> {
  const record = await withStore<unknown>('readonly', 'open the project', (store) => store.get(id))
  if (record === undefined) throw new ProjectStorageError('This project no longer exists. Refresh the project list.')
  if (!isProject(record)) throw new ProjectStorageError('This saved project is damaged and cannot be opened. Delete it and upload the file again.')
  return record
}

export async function deleteProject(id: IDBValidKey): Promise<void> {
  await withStore('readwrite', 'delete the project', (store) => store.delete(id))
}
