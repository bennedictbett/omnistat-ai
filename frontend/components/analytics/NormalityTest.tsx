'use client'

import { useState } from 'react'
import { BarChart2, Loader2, CheckCircle, XCircle } from 'lucide-react'

export default function NormalityTest() {
  const [values, setValues] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)

  const handleTest = async () => {
    setLoading(true)
    setError(null)
    setResult(null)

    const parsed = values
      .split(',')
      .map((v) => parseFloat(v.trim()))
      .filter((v) => !isNaN(v))

    if (parsed.length < 3) {
      setError('Please enter at least 3 numeric values')
      setLoading(false)
      return
    }

    try {
      const res = await fetch('http://127.0.0.1:8000/api/analytics/normality', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: parsed })
      })
      const data = await res.json()
      setResult(data)
    } catch {
      setError('Failed to connect to API')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-blue-500/10 border border-blue-500/20 flex items-center justify-center">
          <BarChart2 size={20} className="text-blue-400" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-white">Normality Test</h2>
          <p className="text-sm text-gray-400">Shapiro-Wilk test for normal distribution</p>
        </div>
      </div>

      {/* Example data */}
      <div className="p-4 bg-gray-900 border border-gray-800 rounded-lg">
        <p className="text-xs text-gray-500 mb-2">Example — click to use:</p>
        <button
          onClick={() => setValues('2.3, 3.1, 2.8, 3.5, 2.9, 3.2, 2.7, 3.0, 2.6, 3.3')}
          className="text-xs text-blue-400 hover:text-blue-300 font-mono"
        >
          2.3, 3.1, 2.8, 3.5, 2.9, 3.2, 2.7, 3.0, 2.6, 3.3
        </button>
      </div>

      {/* Input */}
      <div className="space-y-3">
        <label className="text-sm text-gray-400">
          Enter numeric values separated by commas
        </label>
        <textarea
          value={values}
          onChange={(e) => setValues(e.target.value)}
          placeholder="e.g. 2.3, 3.1, 2.8, 3.5, 2.9..."
          rows={4}
          className="w-full bg-gray-900 border border-gray-800 rounded-lg px-4 py-3 text-white placeholder-gray-600 focus:outline-none focus:border-blue-500/50 text-sm font-mono resize-none"
        />
        <button
          onClick={handleTest}
          disabled={loading || !values.trim()}
          className="px-6 py-2.5 bg-blue-500 hover:bg-blue-400 disabled:bg-gray-700 disabled:cursor-not-allowed rounded-lg text-sm font-medium transition-all flex items-center gap-2"
        >
          {loading && <Loader2 size={16} className="animate-spin" />}
          Run Shapiro-Wilk Test
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="p-4 bg-red-500/5 border border-red-500/20 rounded-lg">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {/* Result */}
      {result && (
        <div className={`rounded-xl border p-6 space-y-5 ${
          result.normal
            ? 'bg-gray-900 border-green-500/20'
            : 'bg-gray-900 border-yellow-500/20'
        }`}>
          <div className="flex items-center gap-3">
            {result.normal
              ? <CheckCircle size={20} className="text-green-400" />
              : <XCircle size={20} className="text-yellow-400" />
            }
            <span className={`font-medium ${result.normal ? 'text-green-400' : 'text-yellow-400'}`}>
              {result.normal ? 'Normally Distributed' : 'Not Normally Distributed'}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="bg-gray-800 rounded-lg p-4 text-center">
              <p className="text-2xl font-bold text-white font-mono">{result.statistic}</p>
              <p className="text-xs text-gray-500 mt-1">W Statistic</p>
            </div>
            <div className="bg-gray-800 rounded-lg p-4 text-center">
              <p className="text-2xl font-bold text-white font-mono">{result.p_value}</p>
              <p className="text-xs text-gray-500 mt-1">P-Value</p>
            </div>
          </div>

          <div className="p-4 bg-gray-800 rounded-lg">
            <p className="text-sm text-gray-300">{result.interpretation}</p>
          </div>

          <div className="p-4 bg-gray-800/50 rounded-lg border border-gray-700">
            <p className="text-xs text-gray-500 font-medium mb-2">What this means:</p>
            <p className="text-xs text-gray-400">
              {result.normal
                ? 'Your data follows a normal distribution. You can use parametric tests like t-test, ANOVA, and Pearson correlation.'
                : 'Your data does not follow a normal distribution. Consider non-parametric alternatives like Mann-Whitney U, Kruskal-Wallis, or Spearman correlation.'
              }
            </p>
          </div>
        </div>
      )}
    </div>
  )
}