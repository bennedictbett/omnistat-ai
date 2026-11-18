'use client'

import { useEffect, useRef, useState } from 'react'
import { Brain, Send, Loader2, Mic, Square, User } from 'lucide-react'
import RAnalysisPanel from '@/components/jarvis/RAnalysisPanel'
import { formatNumber, loadUploadedData, RApiError, RTestCatalog, fetchRTests, UploadedData } from '@/lib/rApi'
import { ApiError } from '@/lib/api'
import {
  ChatTurn, chatWithJarvis, DescriptiveRow, JarvisAction, runDescriptives, setShareColumns, shareColumnsEnabled,
} from '@/lib/jarvisChat'
import { formatClock, joinText, MAX_SECONDS } from '@/lib/voiceInput'
import { useVoiceInput } from './useVoiceInput'

interface Message extends ChatTurn {
  action?: JarvisAction | null
  problem?: string | null
  error?: boolean
}

type Workspace =
  | { kind: 'analysis'; test: string; mapping: Record<string, string>; autoReview: boolean; key: number }
  | { kind: 'descriptive'; columns: string[]; key: number }

const EXAMPLES = [
  'Hi Jarvis, what can you do?',
  'Run descriptive statistics',
  'Run a one-way ANOVA',
  'Is my data normally distributed?',
]

const errorText = (e: unknown, fallback: string) =>
  e instanceof ApiError || e instanceof RApiError ? e.message : fallback

export default function JarvisInput() {
  const [query, setQuery] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(false)
  const [shareColumns, setShare] = useState(true)
  const [catalog, setCatalog] = useState<RTestCatalog | null>(null)
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [workspaceError, setWorkspaceError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const keyRef = useRef(0)

  useEffect(() => { setShare(shareColumnsEnabled()) }, [])

  // Dictation fills the box; the person reads it and presses Send themselves.
  const voice = useVoiceInput((text) => {
    setQuery((q) => joinText(q, text))
    inputRef.current?.focus()
  })
  const recording = voice.state === 'recording'
  const transcribing = voice.state === 'transcribing'

  const openAnalysis = async (test: string, mapping: Record<string, string>, autoReview: boolean) => {
    setWorkspaceError(null)
    try {
      const tests = catalog ?? await fetchRTests()
      setCatalog(tests)
      if (!tests[test]) {
        setWorkspace(null)
        setWorkspaceError(`"${test}" is not available in the uploaded-data workflow yet. Use the Test Wizard. No analysis was run.`)
        return
      }
      setWorkspace({ kind: 'analysis', test, mapping, autoReview, key: ++keyRef.current })
    } catch (e) {
      setWorkspace(null)
      setWorkspaceError(errorText(e, 'Could not load available analyses. Check the API connection. No analysis was run.'))
    }
  }

  const applyAction = async (action: JarvisAction | null) => {
    if (!action || action.type === 'choose_test') return
    if (action.type === 'descriptive') {
      setWorkspaceError(null)
      setWorkspace({ kind: 'descriptive', columns: action.columns, key: ++keyRef.current })
      return
    }
    await openAnalysis(action.test, action.variables, Object.keys(action.variables).length > 0)
  }

  const handleSubmit = async () => {
    const text = query.trim()
    if (!text || loading) return
    let data: UploadedData | null = null
    try {
      data = loadUploadedData()
    } catch (e) {
      setWorkspaceError(errorText(e, 'Could not read the uploaded data. Upload your file again.'))
    }
    const history: Message[] = [...messages, { role: 'user', content: text }]
    setMessages(history)
    setQuery('')
    setLoading(true)
    try {
      const reply = await chatWithJarvis(
        history.filter((m) => !m.error).map(({ role, content }) => ({ role, content })), data, shareColumns,
      )
      setMessages([...history, { role: 'assistant', content: reply.reply, action: reply.action, problem: reply.action_problem }])
      await applyAction(reply.action)
    } catch (e) {
      setMessages([...history, { role: 'assistant', content: errorText(e, 'Jarvis could not answer. Please try again.'), error: true }])
    } finally {
      setLoading(false)
      inputRef.current?.focus()
    }
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-green-500/10 border border-green-500/20 flex items-center justify-center">
          <Brain size={20} className="text-green-400" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-white">Jarvis AI</h2>
          <p className="text-sm text-gray-400">Chat about your data, or ask Jarvis to run an analysis</p>
        </div>
      </div>

      {messages.length === 0 && (
        <div className="grid grid-cols-2 gap-3">
          {EXAMPLES.map((example) => (
            <button key={example} onClick={() => setQuery(example)}
              className="text-left p-3 rounded-lg bg-gray-900 border border-gray-800 text-sm text-gray-400 hover:border-green-500/30 hover:text-white transition-all">
              {example}
            </button>
          ))}
        </div>
      )}

      {messages.length > 0 && (
        <ol aria-label="Conversation" className="space-y-3">
          {messages.map((m, i) => (
            <li key={i} className={`flex gap-3 ${m.role === 'user' ? 'justify-end' : ''}`}>
              {m.role === 'assistant' && <Brain size={16} className="mt-1 shrink-0 text-green-400" aria-hidden />}
              <div className={`max-w-[85%] rounded-lg px-4 py-2 text-sm space-y-2 ${
                m.role === 'user' ? 'bg-green-500/10 text-white' : m.error ? 'bg-red-500/5 border border-red-500/20 text-red-400' : 'bg-gray-900 border border-gray-800 text-gray-200'
              }`}>
                <p role={m.error ? 'alert' : undefined} className="whitespace-pre-wrap">{m.content}</p>
                {m.problem && <p className="text-xs text-yellow-400">{m.problem}</p>}
                {m.action?.type === 'choose_test' && (
                  <div className="flex flex-wrap gap-2">
                    {m.action.options.map((o) => (
                      <button key={o.test} onClick={() => void openAnalysis(o.test, {}, false)} title={o.reason}
                        className="rounded border border-green-500/30 px-3 py-1 text-xs text-green-300 hover:bg-green-500/10">
                        {o.title}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {m.role === 'user' && <User size={16} className="mt-1 shrink-0 text-gray-500" aria-hidden />}
            </li>
          ))}
          {loading && <li className="flex items-center gap-2 text-sm text-gray-500"><Loader2 size={14} className="animate-spin" /> Jarvis is thinking…</li>}
        </ol>
      )}

      <div className="flex gap-3">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleSubmit()
            if (e.key === 'Escape' && voice.state !== 'idle') voice.cancel()
          }}
          placeholder="Message Jarvis, e.g. run a one-way ANOVA of bp by site"
          className="flex-1 bg-gray-900 border border-gray-800 rounded-lg px-4 py-3 text-white placeholder-gray-600 focus:outline-none focus:border-green-500/50 text-sm"
        />
        {voice.supported && (
          <button type="button" onClick={voice.toggle} disabled={transcribing}
            aria-label={recording ? 'Stop recording' : 'Speak your question'} aria-pressed={recording}
            title={recording ? 'Stop and write it down' : 'Speak your question'}
            className={`px-4 py-3 rounded-lg border transition-all flex items-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed ${
              recording ? 'bg-red-500/15 border-red-500/40 text-red-300' : 'bg-gray-900 border-gray-800 text-gray-300 hover:border-green-500/40 hover:text-white'
            }`}>
            {transcribing ? <Loader2 size={18} className="animate-spin" /> : recording ? <Square size={18} /> : <Mic size={18} />}
          </button>
        )}
        <button aria-label="Send" onClick={() => void handleSubmit()} disabled={loading || !query.trim()}
          className="px-4 py-3 bg-green-500 hover:bg-green-400 disabled:bg-gray-700 disabled:cursor-not-allowed rounded-lg transition-all flex items-center gap-2">
          {loading ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
        </button>
      </div>

      <div className="-mt-3 space-y-1 text-xs" aria-live="polite">
        {recording ? (
          <p className="text-red-300 flex items-center gap-2" data-testid="voice-status">
            <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse" />
            Listening… {formatClock(voice.seconds)} of {formatClock(MAX_SECONDS)}. Click the square to stop, Esc to cancel.
          </p>
        ) : transcribing ? (
          <p className="text-gray-400" data-testid="voice-status">Writing it down… (Esc to cancel)</p>
        ) : voice.error ? (
          <p role="alert" className="text-red-400" data-testid="voice-error">{voice.error}</p>
        ) : null}
        <label className="flex items-center gap-2 text-gray-500">
          <input type="checkbox" checked={shareColumns} onChange={(e) => { setShare(e.target.checked); setShareColumns(e.target.checked) }} />
          Share column names and types (never data values) with Jarvis so it can pick your columns
        </label>
        <p className="text-gray-600">
          Messages are sent to an external AI service (Groq). Do not include patient names or identifiers. Jarvis never sees
          your data values; results are computed in R and every analysis asks for your confirmation before it runs.
        </p>
      </div>

      {workspaceError && (
        <div role="alert" className="rounded-lg border border-red-500/20 bg-red-500/5 p-5 text-sm text-red-400">{workspaceError}</div>
      )}

      {workspace?.kind === 'analysis' && catalog?.[workspace.test] && (
        <RAnalysisPanel key={workspace.key} test={workspace.test} spec={catalog[workspace.test]}
          intentVariables={[]} initialMapping={workspace.mapping} autoReview={workspace.autoReview} />
      )}
      {workspace?.kind === 'descriptive' && <DescriptiveResults key={workspace.key} columns={workspace.columns} />}
    </div>
  )
}

const STAT_LABELS: [keyof DescriptiveRow, string][] = [
  ['count', 'n'], ['mean', 'Mean'], ['std', 'SD'], ['median', 'Median'], ['q1', 'Q1'], ['q3', 'Q3'], ['min', 'Min'], ['max', 'Max'],
]

function DescriptiveResults({ columns }: { columns: string[] }) {
  const [rows, setRows] = useState<DescriptiveRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    runDescriptives(columns)
      .then((r) => { if (active) setRows(r) })
      .catch((e) => { if (active) setError(errorText(e, 'Descriptive statistics failed.')) })
    return () => { active = false }
  }, [columns])

  return (
    <section aria-label="Descriptive statistics" className="rounded-lg border border-blue-500/20 bg-gray-900 p-5 space-y-3">
      <p className="text-sm font-medium text-blue-400">Descriptive statistics</p>
      {error ? <p role="alert" className="text-sm text-red-400">{error}</p> : !rows ? (
        <p className="flex items-center gap-2 text-sm text-gray-400"><Loader2 size={14} className="animate-spin" /> Calculating…</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead><tr className="text-left text-gray-500"><th className="py-1 pr-4 font-normal">Column</th>
              {STAT_LABELS.map(([, label]) => <th key={label} className="py-1 pr-4 font-normal">{label}</th>)}</tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.column} className="border-t border-gray-800">
                  <td className="py-1 pr-4 text-white">{r.column}</td>
                  {STAT_LABELS.map(([key]) => <td key={key} className="py-1 pr-4 font-mono text-white">{formatNumber(r[key] as number)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-gray-500">Computed on the server from all finite values in each column; missing values are excluded.</p>
        </div>
      )}
    </section>
  )
}
