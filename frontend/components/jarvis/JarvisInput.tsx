'use client'

import { useState } from 'react'
import { Brain, Send, Loader2, Play } from 'lucide-react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts'
import RAnalysisPanel from '@/components/jarvis/RAnalysisPanel'
import { RTestCatalog, fetchRTests, normalizeTestName } from '@/lib/rApi'

interface JarvisIntent {
  test: string
  variables: string[]
  assumptions: string[]
  parameters: Record<string, any>
  visualization: string
}

interface JarvisResponse {
  success: boolean
  intent?: JarvisIntent
  error?: string
}

interface AnalysisResult {
  [key: string]: any
}

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

const SAMPLE_DATA: Record<string, any> = {
  normality: {
    values: [2.3, 3.1, 2.8, 3.5, 2.9, 3.2, 2.7, 3.0, 2.6, 3.3]
  },
  survival: {
    durations: [5, 10, 15, 20, 25, 30, 35, 40],
    event_observed: [1, 1, 0, 1, 0, 1, 1, 0],
    label: 'Treatment Group'
  }
}

function getEndpointForTest(test: string): { url: string; body: any } | null {
  const t = test.toLowerCase()

  const normalityTests = ['shapiro', 'normality', 'anderson', 'kolmogorov', 'lilliefors', 'jarque']
  const survivalTests = ['kaplan', 'survival', 'cox', 'competing']

  if (normalityTests.some(keyword => t.includes(keyword))) {
    return {
      url: 'https://omnistat-ai.onrender.com/api/analytics/normality',
      body: SAMPLE_DATA.normality
    }
  }

  if (survivalTests.some(keyword => t.includes(keyword))) {
    return {
      url: 'https://omnistat-ai.onrender.com/api/analytics/survival',
      body: SAMPLE_DATA.survival
    }
  }

  return null
}

export default function JarvisInput() {
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [running, setRunning] = useState(false)
  const [response, setResponse] = useState<JarvisResponse | null>(null)
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null)
  const [rCatalog, setRCatalog] = useState<RTestCatalog | null>(null)
  const [rTest, setRTest] = useState<string | null>(null)

  const handleSubmit = async () => {
    if (!query.trim()) return
    setLoading(true)
    setResponse(null)
    setAnalysisResult(null)
    setRTest(null)

    try {
      const res = await fetch('https://omnistat-ai.onrender.com/api/agent/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
      })
      const data = await res.json()
      setResponse(data)
    } catch {
      setResponse({ success: false, error: 'Failed to connect to API' })
    } finally {
      setLoading(false)
    }
  }

  const handleRunAnalysis = async () => {
    if (!response?.intent) return
    setRunning(true)
    setAnalysisResult(null)
    setRTest(null)

    // Tests that have an R template run on the user's uploaded data via the column picker.
    let catalog = rCatalog
    if (!catalog) {
      try {
        catalog = await fetchRTests()
        setRCatalog(catalog)
      } catch {
        catalog = null // backend unreachable: fall back to the original behaviour below
      }
    }
    const rName = normalizeTestName(response.intent.test)
    if (catalog && catalog[rName]) {
      setRTest(rName)
      setRunning(false)
      return
    }

    const endpoint = getEndpointForTest(response.intent.test)

    if (!endpoint) {
      setAnalysisResult({
        message: `Analysis type "${response.intent.test}" requires data upload first.`,
        hint: 'Go to Upload Data, upload your clinical file, then run this analysis.'
      })
      setRunning(false)
      return
    }

    try {
      const res = await fetch(endpoint.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(endpoint.body)
      })
      const data = await res.json()
      setAnalysisResult(data)
    } catch {
      setAnalysisResult({ error: 'Failed to run analysis' })
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
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          placeholder="e.g. Compare survival rates between treatment and control groups..."
          className="flex-1 bg-gray-900 border border-gray-800 rounded-lg px-4 py-3 text-white placeholder-gray-600 focus:outline-none focus:border-green-500/50 text-sm"
        />
        <button
          onClick={handleSubmit}
          disabled={loading || !query.trim()}
          className="px-4 py-3 bg-green-500 hover:bg-green-400 disabled:bg-gray-700 disabled:cursor-not-allowed rounded-lg transition-all flex items-center gap-2"
        >
          {loading ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
        </button>
      </div>

      {/* Intent Response */}
      {response && (
        <div className={`rounded-lg border p-5 space-y-4 ${
          response.success
            ? 'bg-gray-900 border-green-500/20'
            : 'bg-red-500/5 border-red-500/20'
        }`}>
          {response.success && response.intent ? (
            <>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-green-400" />
                  <span className="text-sm font-medium text-green-400">Analysis Ready</span>
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
                  {running ? 'Running...' : 'Run Analysis'}
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
                    {response.intent.visualization}
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
                  {response.intent.variables.map((v) => (
                    <span key={v} className="px-2 py-1 bg-blue-500/10 border border-blue-500/20 rounded text-xs text-blue-400">
                      {v}
                    </span>
                  ))}
                </div>
              </div>

              <div>
                <p className="text-xs text-gray-500 mb-2">Assumptions to Check</p>
                <div className="flex flex-wrap gap-2">
                  {response.intent.assumptions.map((a) => (
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
          intentVariables={response.intent.variables}
        />
      )}

            {/* Analysis Result */}
      {analysisResult && (
        <div className="rounded-lg border border-blue-500/20 bg-gray-900 p-5 space-y-4">
          <p className="text-sm font-medium text-blue-400">Analysis Results</p>

          {analysisResult.message ? (
            <div className="space-y-2">
              <p className="text-sm text-gray-300">{analysisResult.message}</p>
              {analysisResult.hint && (
                <p className="text-xs text-gray-500">{analysisResult.hint}</p>
              )}
            </div>

          ) : analysisResult.survival_probability ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-gray-800 rounded-lg p-3 text-center">
                  <p className="text-2xl font-bold text-white">{analysisResult.median_survival}</p>
                  <p className="text-xs text-gray-500 mt-1">Median Survival</p>
                </div>
                <div className="bg-gray-800 rounded-lg p-3 text-center">
                  <p className="text-2xl font-bold text-white">{analysisResult.timeline.length}</p>
                  <p className="text-xs text-gray-500 mt-1">Time Points</p>
                </div>
              </div>
              <ResponsiveContainer width="100%" height={250}>
                <LineChart
                  data={analysisResult.timeline.map((t: number, i: number) => ({
                    time: t,
                    survival: parseFloat((analysisResult.survival_probability[i] * 100).toFixed(1))
                  }))}
                  margin={{ top: 5, right: 20, left: 0, bottom: 5 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                  <XAxis dataKey="time" stroke="#6b7280" tick={{ fontSize: 11 }} />
                  <YAxis stroke="#6b7280" tick={{ fontSize: 11 }} domain={[0, 100]} />
                  <Tooltip
                    contentStyle={{ backgroundColor: '#111827', border: '1px solid #374151', borderRadius: '8px' }}
                    formatter={(value: any) => [`${value}%`, 'Survival']}
                    labelFormatter={(label) => `Time: ${label}`}
                  />
                  <ReferenceLine y={50} stroke="#6b7280" strokeDasharray="4 4" />
                  <Line type="stepAfter" dataKey="survival" stroke="#a78bfa" strokeWidth={2} dot={{ r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>

          ) : analysisResult.statistic !== undefined ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-gray-800 rounded-lg p-3 text-center">
                  <p className="text-2xl font-bold text-white font-mono">{analysisResult.statistic}</p>
                  <p className="text-xs text-gray-500 mt-1">W Statistic</p>
                </div>
                <div className="bg-gray-800 rounded-lg p-3 text-center">
                  <p className="text-2xl font-bold text-white font-mono">{analysisResult.p_value}</p>
                  <p className="text-xs text-gray-500 mt-1">P-Value</p>
                </div>
              </div>
              <div className={`p-3 rounded-lg border ${
                analysisResult.normal
                  ? 'bg-green-500/5 border-green-500/20'
                  : 'bg-yellow-500/5 border-yellow-500/20'
              }`}>
                <p className={`text-sm font-medium ${analysisResult.normal ? 'text-green-400' : 'text-yellow-400'}`}>
                  {analysisResult.normal ? '✓ Normally Distributed' : '✗ Not Normally Distributed'}
                </p>
                <p className="text-xs text-gray-400 mt-1">{analysisResult.interpretation}</p>
              </div>
            </div>

          ) : (
            <div className="space-y-2">
              {Object.entries(analysisResult).map(([key, value]) => (
                <div key={key} className="flex justify-between items-start py-2 border-b border-gray-800 last:border-0">
                  <span className="text-xs text-gray-500 font-mono">{key}</span>
                  <span className="text-xs text-white font-mono text-right max-w-xs truncate">
                    {typeof value === 'object' ? JSON.stringify(value).slice(0, 60) + '...' : String(value)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}