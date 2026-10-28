'use client'

import { useCallback, useEffect, useState } from 'react'
import { FolderOpen, Save, Trash2 } from 'lucide-react'
import { UploadResult } from '@/lib/api'
import {
  DatasetProject, defaultProjectName, deleteProject, getProject, listProjects, MAX_PROJECT_NAME,
  ProjectList, ProjectStorageError, saveProject,
} from '@/lib/projects'

interface Props {
  current: UploadResult | null
  currentSource: string | null
  onOpen: (project: DatasetProject) => void
}

const message = (error: unknown, fallback: string) =>
  error instanceof ProjectStorageError || error instanceof Error ? error.message : fallback

export default function DatasetProjects({ current, currentSource, onOpen }: Props) {
  const [list, setList] = useState<ProjectList | null>(null)
  const [name, setName] = useState(defaultProjectName(currentSource ?? ''))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<IDBValidKey | null>(null)

  const refresh = useCallback(async () => {
    try {
      setList(await listProjects())
    } catch (e) {
      setError(message(e, 'Could not load saved projects.'))
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const run = async (action: () => Promise<string>) => {
    setBusy(true)
    setError(null)
    setStatus(null)
    try {
      setStatus(await action())
    } catch (e) {
      setError(message(e, 'The project action failed. Your current dataset is unchanged.'))
    } finally {
      setBusy(false)
    }
  }

  const save = () => run(async () => {
    if (!current) throw new ProjectStorageError('Upload a dataset before saving a project.')
    const project = await saveProject(name, currentSource ?? '', current)
    await refresh()
    return `Saved “${project.name}” in this browser.`
  })

  const open = (id: string) => run(async () => {
    const project = await getProject(id)
    try {
      onOpen(project)
    } catch {
      throw new ProjectStorageError('The project could not be made the active dataset because browser storage is full or unavailable. Your previous dataset remains active.')
    }
    return `Opened “${project.name}”.`
  })

  const remove = (id: IDBValidKey) => run(async () => {
    await deleteProject(id)
    setConfirmDelete(null)
    await refresh()
    return 'Project deleted from this browser.'
  })

  return (
    <div className="max-w-3xl mx-auto space-y-6 text-sm">
      <div>
        <h2 className="text-lg font-semibold text-white">Dataset Projects</h2>
        <p className="text-gray-400">
          Projects are saved only in this browser on this device, unencrypted, and are not uploaded or synced.
          They can contain sensitive patient data, and clearing site data removes them.
        </p>
      </div>

      <section aria-label="Save current dataset" className="space-y-3 rounded-lg border border-gray-800 bg-gray-900 p-4">
        <h3 className="font-medium text-white">Save current dataset</h3>
        {current ? (
          <>
            <p className="text-gray-400">
              {currentSource ? `${currentSource} · ` : ''}{current.rows} rows · {current.columns.length} columns
            </p>
            <label className="block text-gray-300">
              Project name
              <input value={name} maxLength={MAX_PROJECT_NAME} disabled={busy}
                onChange={(e) => setName(e.target.value)}
                className="mt-1 block w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-white" />
            </label>
            <button onClick={save} disabled={busy || !name.trim()}
              className="flex items-center gap-2 rounded bg-green-700 px-4 py-2 text-white disabled:opacity-50">
              <Save size={16} /> Save project
            </button>
          </>
        ) : <p className="text-gray-500">Upload a dataset first.</p>}
      </section>

      {status && <p role="status" className="text-green-400">{status}</p>}
      {error && <p role="alert" className="text-red-400">{error}</p>}

      <section aria-label="Saved projects" className="space-y-2">
        <h3 className="font-medium text-white">Saved projects</h3>
        {!list && !error && <p className="text-gray-500">Loading projects…</p>}
        {list && list.projects.length === 0 && <p className="text-gray-500">No saved projects yet.</p>}
        <ul className="space-y-2">
          {list?.projects.map((project) => (
            <li key={project.id} className="flex items-center justify-between gap-4 rounded-lg border border-gray-800 bg-gray-900 p-3">
              <div>
                <p className="font-medium text-white">{project.name}</p>
                <p className="text-xs text-gray-500">
                  {project.source_file ? `${project.source_file} · ` : ''}{project.rows} rows · {project.columns} columns ·
                  saved {new Date(project.created_at).toLocaleString()}
                </p>
              </div>
              <div className="flex gap-2">
                <button onClick={() => open(project.id)} disabled={busy} aria-label={`Open ${project.name}`}
                  className="flex items-center gap-1 rounded bg-blue-700 px-3 py-1 text-white disabled:opacity-50">
                  <FolderOpen size={14} /> Open
                </button>
                {confirmDelete === project.id ? (
                  <>
                    <button onClick={() => remove(project.id)} disabled={busy} aria-label={`Confirm delete ${project.name}`}
                      className="rounded bg-red-700 px-3 py-1 text-white disabled:opacity-50">Confirm delete</button>
                    <button onClick={() => setConfirmDelete(null)} disabled={busy}
                      className="rounded border border-gray-700 px-3 py-1 text-gray-300">Cancel</button>
                  </>
                ) : (
                  <button onClick={() => setConfirmDelete(project.id)} disabled={busy} aria-label={`Delete ${project.name}`}
                    className="flex items-center gap-1 rounded border border-gray-700 px-3 py-1 text-gray-300 disabled:opacity-50">
                    <Trash2 size={14} /> Delete
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
        {list && list.invalid.length > 0 && (
          <div role="alert" className="flex items-center justify-between rounded-lg border border-red-500/30 p-3 text-red-400">
            <span>{list.invalid.length} saved project(s) are damaged and cannot be opened.</span>
            <button onClick={() => run(async () => {
              for (const id of list.invalid) await deleteProject(id)
              await refresh()
              return 'Damaged projects deleted.'
            })} disabled={busy} className="rounded border border-red-500/40 px-3 py-1">Delete damaged</button>
          </div>
        )}
      </section>
    </div>
  )
}
