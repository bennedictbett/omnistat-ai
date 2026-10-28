import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import DatasetProjects from '@/components/data/DatasetProjects'
import { UploadResult } from '@/lib/api'
import { defaultProjectName, deleteProject, getProject, listProjects, saveProject } from '@/lib/projects'

const dataset = (n: number): UploadResult => ({
  rows: n, columns: ['bp', 'arm'], numeric_cols: ['bp'],
  full_data: Array.from({ length: n }, (_, i) => ({ bp: i, arm: i % 2 ? 'A' : 'B' })),
  missing: { bp: 0, arm: 0 },
})

beforeEach(() => { vi.stubGlobal('indexedDB', new IDBFactory()) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function putRaw(record: unknown) {
  return new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('omnistat', 1)
    open.onupgradeneeded = () => open.result.createObjectStore('projects', { keyPath: 'id' })
    open.onsuccess = () => {
      const tx = open.result.transaction('projects', 'readwrite')
      tx.objectStore('projects').put(record)
      tx.oncomplete = () => { open.result.close(); resolve() }
      tx.onerror = () => reject(tx.error)
    }
  })
}

it('saves, lists newest first, reopens complete data and deletes projects', async () => {
  const first = await saveProject(' Trial A ', 'trial-a.csv', dataset(3))
  await new Promise((resolve) => setTimeout(resolve, 2))
  const second = await saveProject('Trial B', 'trial-b.xlsx', dataset(250))
  const { projects, invalid } = await listProjects()
  expect(invalid).toEqual([])
  expect(projects.map((p) => [p.name, p.rows, p.columns])).toEqual([['Trial B', 250, 2], ['Trial A', 3, 2]])
  expect((await getProject(second.id)).dataset).toEqual(dataset(250))
  await deleteProject(first.id)
  expect((await listProjects()).projects.map((p) => p.id)).toEqual([second.id])
  await expect(getProject(first.id)).rejects.toThrow('no longer exists')
})

it('rejects invalid names and incomplete datasets without saving', async () => {
  await expect(saveProject('   ', 'a.csv', dataset(2))).rejects.toThrow('project name')
  await expect(saveProject('x'.repeat(101), 'a.csv', dataset(2))).rejects.toThrow('project name')
  await expect(saveProject('Bad', 'a.csv', { ...dataset(4), full_data: [] })).rejects.toThrow('incomplete')
  expect((await listProjects()).projects).toEqual([])
  expect(defaultProjectName('Clinical trial.XLSX')).toBe('Clinical trial')
  expect(defaultProjectName('')).toBe('Untitled dataset')
})

it('reports damaged records instead of opening them', async () => {
  await putRaw({ id: 'broken', schema_version: 1, name: 'Broken', dataset: { rows: 2, full_data: [] } })
  expect(await listProjects()).toEqual({ projects: [], invalid: ['broken'] })
  await expect(getProject('broken')).rejects.toThrow('damaged')
})

it('explains unavailable browser storage', async () => {
  vi.stubGlobal('indexedDB', undefined)
  await expect(listProjects()).rejects.toThrow('IndexedDB')
})

it('saves the current upload and opens a project only when chosen', async () => {
  const onOpen = vi.fn()
  render(<DatasetProjects current={dataset(5)} currentSource="baseline.csv" onOpen={onOpen} />)
  await screen.findByText('No saved projects yet.')
  expect(screen.getByText(/only in this browser/).textContent).toContain('sensitive patient data')
  expect((screen.getByLabelText('Project name') as HTMLInputElement).value).toBe('baseline')
  fireEvent.click(screen.getByRole('button', { name: /Save project/ }))
  await screen.findByText('Saved “baseline” in this browser.')
  expect(onOpen).not.toHaveBeenCalled()
  fireEvent.click(await screen.findByRole('button', { name: 'Open baseline' }))
  await screen.findByText('Opened “baseline”.')
  expect(onOpen).toHaveBeenCalledOnce()
  expect(onOpen.mock.calls[0][0].dataset).toEqual(dataset(5))
})

it('keeps the previous dataset message when activation storage fails', async () => {
  await saveProject('Large', 'large.csv', dataset(5))
  const onOpen = vi.fn(() => { throw new DOMException('full', 'QuotaExceededError') })
  render(<DatasetProjects current={null} currentSource={null} onOpen={onOpen} />)
  screen.getByText('Upload a dataset first.')
  fireEvent.click(await screen.findByRole('button', { name: 'Open Large' }))
  expect((await screen.findByRole('alert')).textContent).toContain('previous dataset remains active')
})

it('requires confirmation before deleting and can remove damaged records', async () => {
  await saveProject('Keep me', 'k.csv', dataset(2))
  await putRaw({ id: 'broken', schema_version: 99 })
  render(<DatasetProjects current={null} currentSource={null} onOpen={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Delete Keep me' }))
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect((await listProjects()).projects).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: 'Delete Keep me' }))
  fireEvent.click(screen.getByRole('button', { name: 'Confirm delete Keep me' }))
  await screen.findByText('Project deleted from this browser.')
  fireEvent.click(screen.getByRole('button', { name: 'Delete damaged' }))
  await screen.findByText('Damaged projects deleted.')
  await waitFor(async () => expect(await listProjects()).toEqual({ projects: [], invalid: [] }))
})

vi.mock('@/components/core/Header', () => ({ default: () => null }))
vi.mock('@/components/jarvis/JarvisInput', () => ({ default: () => null }))

it('makes an opened project the dataset used by analyses, or keeps the previous one on failure', async () => {
  const { default: Home } = await import('@/app/page')
  const { loadUploadedData } = await import('@/lib/rApi')
  localStorage.clear()
  localStorage.setItem('omnistat_data', JSON.stringify(dataset(2)))
  localStorage.setItem('omnistat_data_source', 'old.csv')
  await saveProject('Follow-up', 'follow-up.csv', dataset(7))
  render(<Home />)
  fireEvent.click(screen.getByRole('button', { name: 'Projects' }))
  await screen.findByText(/old\.csv · 2 rows/)

  const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
    throw new DOMException('full', 'QuotaExceededError')
  })
  fireEvent.click(await screen.findByRole('button', { name: 'Open Follow-up' }))
  expect((await screen.findByRole('alert')).textContent).toContain('previous dataset remains active')
  expect(loadUploadedData()?.rows).toHaveLength(2)
  setItem.mockRestore()

  fireEvent.click(screen.getByRole('button', { name: 'Open Follow-up' }))
  await screen.findByText('Opened “Follow-up”.')
  expect(loadUploadedData()?.rows).toEqual(dataset(7).full_data)
  expect(localStorage.getItem('omnistat_data_source')).toBe('follow-up.csv')
  expect(screen.getByRole('region', { name: 'Save current dataset' }).textContent).toContain('follow-up.csv · 7 rows')
})
