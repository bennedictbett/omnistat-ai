'use client'

import { useRef, useState } from 'react'
import { Brain, Send, Loader2, Play, Mic, Square } from 'lucide-react'
import RAnalysisPanel from '@/components/jarvis/RAnalysisPanel'
import { RApiError, RTestCatalog, fetchRTests, normalizeTestName } from '@/lib/rApi'
import { ApiError, JarvisResponse, queryJarvis } from '@/lib/api'
import { formatClock, joinText, MAX_SECONDS } from '@/lib/voiceInput'
import { useVoiceInput } from './useVoiceInput'

const TEST_DESCRIPTIONS: Record<string, string> = {
  paired_t_test: 'Comparing paired measurements before and after treatment',
  independent_t_test: 'Comparing two independent groups',
  repeated_measures_anova: 'Comparing multiple measurements across time',
  one_way_anova: 'Comparing means across three or more groups',
  kaplan_meier: 'Estimating survival probability over time',
  cox_regression: 'Modeling survival with covariates',
  shapiro_wilk: 'Testing whether data follows normal distribution',
  pearson_correlation: 'Measuring linear relationship between variables',
  spearman_correlation: 'Measuring monotonic relationship between variables',
  mann_whitney: 'Non-parametric comparison of two groups',
  kruskal_wallis: 'Non-parametric comparison of multiple groups',
}

export default function JarvisInput() {
    const [query, setQuery] = useState('')
    const [loading, setLoading] = useState(false)
    const [running, setRunning] = useState(false)
    const [response, setResponse] = useState<JarvisResponse | null>(null)
    const [analysisError, setAnalysisError] = useState<string | null>(null)
    const [rCatalog, setRCatalog] = useState<RTestCatalog | null>(null)
    const [rTest, setRTest] = useState<string | null>(null)
    const inputRef = useRef<HTMLInputElement>(null)

    // Dictation fills the box; the person reads it and presses Send themselves.
    const voice = useVoiceInput((text) => {
      setQuery((q) => joinText(q, text))
      inputRef.current?.focus()
    })
    const recording = voice.state === 'recording'
    const transcribing = voice.state === 'transcribing'

  const handleSubmit = async () => {
    if (!query.trim() || loading || running) return
    setLoading(true)
    setResponse(null)
    setAnalysisError(null)
    setRTest(null)

    try {
      setResponse(await queryJarvis(query))
    } catch (e) {
      setResponse({ success: false, error: e instanceof Error ? e.message : 'Failed to interpret your question.' })
    } finally {
      setLoading(false)
    }
  }

  const handleRunAnalysis = async () => {
    if (!response?.intent) return
    setRunning(true)
    setAnalysisError(null)
    setRTest(null)

    try {
      const catalog = rCatalog ?? await fetchRTests()
      setRCatalog(catalog)
      const rName = normalizeTestName(response.intent.test)
      if (!catalog[rName]) {
        setAnalysisError(`"${response.intent.test}" is not available in the uploaded-data workflow yet. Use the Test Wizard to select a supported analysis. No analysis was run.`)
        return
      }
      setRTest(rName)
    } catch (e) {
      setAnalysisError(e instanceof RApiError || e instanceof ApiError ? e.message : 'Could not load available analyses. Check the API connection and try again. No analysis was run.')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-green-500/10 border border-green-500/20 flex items-center justify-center">
          <Brain size={20} className="text-green-400" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-white">Jarvis AI</h2>
          <p className="text-sm text-gray-400">Describe your research question in plain English</p>
        </div>
      </div>

      {/* Example queries */}
      <div className="grid grid-cols-2 gap-3">
        {[
          "Compare blood pressure between two groups before and after treatment",
          "Check if my data is normally distributed",
          "Run a survival analysis on patient cohort",
          "Find correlation between age and cholesterol"
        ].map((example) => (
          <button
            key={example}
            onClick={() => setQuery(example)}
            className="text-left p-3 rounded-lg bg-gray-900 border border-gray-800 text-sm text-gray-400 hover:border-green-500/30 hover:text-white transition-all"
          >
            {example}
          </button>
        ))}
      </div>

      {/* Input */}
      <div className="flex gap-3">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSubmit()
            if (e.key === 'Escape' && voice.state !== 'idle') voice.cancel()
          }}
          placeholder="e.g. Compare survival rates between treatment and control groups..."
          className="flex-1 bg-gray-900 border border-gray-800 rounded-lg px-4 py-3 text-white placeholder-gray-600 focus:outline-none focus:border-green-500/50 text-sm"
        />
        {voice.supported && (
          <button
            type="button"
            onClick={voice.toggle}
            disabled={transcribing}
            aria-label={recording ? 'Stop recording' : 'Speak your question'}
            aria-pressed={recording}
            title={recording ? 'Stop and write it down' : 'Speak your question'}
            className={`px-4 py-3 rounded-lg border transition-all flex items-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed ${
              recording
                ? 'bg-red-500/15 border-red-500/40 text-red-300'
                : 'bg-gray-900 border-gray-800 text-gray-300 hover:border-green-500/40 hover:text-white'
            }`}
          >
            {transcribing ? <Loader2 size={18} className="animate-spin" /> : recording ? <Square size={18} /> : <Mic size={18} />}
          </button>
        )}
        <button
          aria-label="Send"
          onClick={handleSubmit}
          disabled={loading || running || !query.trim()}
          className="px-4 py-3 bg-green-500 hover:bg-green-400 disabled:bg-gray-700 disabled:cursor-not-allowed rounded-lg transition-all flex items-center gap-2"
        >
          {loading ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
        </button>
      </div>

      {/* Voice status */}
      <div className="min-h-[1.25rem] -mt-3" aria-live="polite">
        {recording ? (
          <p className="text-xs text-red-300 flex items-center gap-2" data-testid="voice-status">
            <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse" />
            Listening… {formatClock(voice.seconds)} of {formatClock(MAX_SECONDS)}. Click the square to stop, Esc to cancel.
          </p>
        ) : transcribing ? (
          <p className="text-xs text-gray-400" data-testid="voice-status">
            Writing it down… (Esc to cancel)
          </p>
        ) : voice.error ? (
          <p role="alert" className="text-xs text-red-400" data-testid="voice-error">
            {voice.error}
          </p>
        ) : voice.supported ? (
          <p className="text-xs text-gray-600">
            Voice is sent to be turned into text and is not stored. Do not say patient names.
          </p>
        ) : null}
      </div>

      {/* Intent Response */}
      {response && (
        <div className={`rounded-lg border p-5 space-y-4 ${
          response.success
            ? 'bg-gray-900 border-green-500/20'
            : 'bg-red-500/5 border-red-500/20'
        }`}>
          {response.needs_clarification ? (
            <p className="text-sm text-yellow-400" role="status">
              Your question is ambiguous. Include the outcome, grouping columns and whether measurements are paired, or use the Test Wizard. No analysis was run.
            </p>
          ) : response.success && response.intent ? (
            <>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-green-400" />
                  <span className="text-sm font-medium text-green-400">Suggested Analysis</span>
                </div>
                <button
                  onClick={handleRunAnalysis}
                  disabled={running}
                  className="flex items-center gap-2 px-4 py-2 bg-green-500 hover:bg-green-400 disabled:bg-gray-700 disabled:cursor-not-allowed rounded-lg text-sm font-medium transition-all"
                >
                  {running
                    ? <Loader2 size={14} className="animate-spin" />
                    : <Play size={14} />
                  }
                  {running ? 'Loading...' : 'Choose Data Columns'}
                </button>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-xs text-gray-500 mb-1">Recommended Test</p>
                  <p className="text-sm font-mono text-white bg-gray-800 px-3 py-2 rounded">
                    {response.intent.test}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-gray-500 mb-1">Visualization</p>
                  <p className="text-sm font-mono text-white bg-gray-800 px-3 py-2 rounded">
                    {response.intent.visualization ?? 'Shown with results'}
                  </p>
                </div>
              </div>

              {TEST_DESCRIPTIONS[response.intent.test] && (
                <p className="text-xs text-gray-400 italic">
                  {TEST_DESCRIPTIONS[response.intent.test]}
                </p>
              )}

              <div>
                <p className="text-xs text-gray-500 mb-2">Variables Required</p>
                <div className="flex flex-wrap gap-2">
                  {response.intent.variables?.map((v) => (
                    <span key={v} className="px-2 py-1 bg-blue-500/10 border border-blue-500/20 rounded text-xs text-blue-400">
                      {v}
                    </span>
                  ))}
                </div>
              </div>

              <div>
                <p className="text-xs text-gray-500 mb-2">Assumptions to Check</p>
                <div className="flex flex-wrap gap-2">
                  {response.intent.assumptions?.map((a) => (
                    <span key={a} className="px-2 py-1 bg-yellow-500/10 border border-yellow-500/20 rounded text-xs text-yellow-400">
                      {a}
                    </span>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <p className="text-sm text-red-400">{response.error}</p>
          )}
        </div>
      )}

      {/* R analysis on uploaded data */}
      {rTest && rCatalog && rCatalog[rTest] && response?.intent && (
        <RAnalysisPanel
          test={rTest}
          spec={rCatalog[rTest]}
          intentVariables={response.intent.variables ?? []}
        />
      )}

      {analysisError && (
        <div role="alert" className="rounded-lg border border-red-500/20 bg-red-500/5 p-5 text-sm text-red-400">
          {analysisError}
        </div>
      )}
    </div>
  )
}