'use client'

import { useState } from 'react'
import { Brain, Send, Loader2 } from 'lucide-react'

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

export default function JarvisInput() {
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [response, setResponse] = useState<JarvisResponse | null>(null)

  const handleSubmit = async () => {
    if (!query.trim()) return
    setLoading(true)
    setResponse(null)

    try {
      const res = await fetch('http://127.0.0.1:8000/api/agent/query', {
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

      {/* Response */}
      {response && (
        <div className={`rounded-lg border p-5 space-y-4 ${
          response.success
            ? 'bg-gray-900 border-green-500/20'
            : 'bg-red-500/5 border-red-500/20'
        }`}>
          {response.success && response.intent ? (
            <>
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-green-400" />
                <span className="text-sm font-medium text-green-400">Analysis Ready</span>
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
    </div>
  )
}