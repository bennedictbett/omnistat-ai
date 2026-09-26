'use client'

import { useState } from 'react'
import { Activity, Loader2 } from 'lucide-react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts'

export default function SurvivalCurve() {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)
  const [durations, setDurations] = useState('5, 10, 15, 20, 25, 30, 35, 40')
  const [events, setEvents] = useState('1, 1, 0, 1, 0, 1, 1, 0')
  const [label, setLabel] = useState('Treatment Group')

  const handleRun = async () => {
    setLoading(true)
    setError(null)
    setResult(null)

    const parsedDurations = durations.split(',').map((v) => parseFloat(v.trim())).filter((v) => !isNaN(v))
    const parsedEvents = events.split(',').map((v) => parseInt(v.trim())).filter((v) => !isNaN(v))

    if (parsedDurations.length !== parsedEvents.length) {
      setError('Durations and events must have the same number of values')
      setLoading(false)
      return
    }

    try {
      const res = await fetch('process.env.NEXT_PUBLIC_API_URL || 'https://omnistat-ai.onrender.com'/api/analytics/survival', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          durations: parsedDurations,
          event_observed: parsedEvents,
          label
        })
      })
      const data = await res.json()
      setResult(data)
    } catch {
      setError('Failed to connect to API')
    } finally {
      setLoading(false)
    }
  }

  const chartData = result?.timeline?.map((t: number, i: number) => ({
    time: t,
    survival: parseFloat((result.survival_probability[i] * 100).toFixed(1))
  }))

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-purple-500/10 border border-purple-500/20 flex items-center justify-center">
          <Activity size={20} className="text-purple-400" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-white">Kaplan-Meier Survival Curve</h2>
          <p className="text-sm text-gray-400">Survival analysis for clinical cohort data</p>
        </div>
      </div>

      {/* Inputs */}
      <div className="grid grid-cols-1 gap-4 bg-gray-900 border border-gray-800 rounded-xl p-5">
        <div className="space-y-2">
          <label className="text-xs text-gray-500">Group Label</label>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white text-sm focus:outline-none focus:border-purple-500/50"
          />
        </div>
        <div className="space-y-2">
          <label className="text-xs text-gray-500">Time to Event (comma separated)</label>
          <input
            value={durations}
            onChange={(e) => setDurations(e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white text-sm font-mono focus:outline-none focus:border-purple-500/50"
          />
        </div>
        <div className="space-y-2">
          <label className="text-xs text-gray-500">Event Observed — 1=event, 0=censored (comma separated)</label>
          <input
            value={events}
            onChange={(e) => setEvents(e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white text-sm font-mono focus:outline-none focus:border-purple-500/50"
          />
        </div>

        <button
          onClick={handleRun}
          disabled={loading}
          className="px-6 py-2.5 bg-purple-500 hover:bg-purple-400 disabled:bg-gray-700 disabled:cursor-not-allowed rounded-lg text-sm font-medium transition-all flex items-center gap-2 w-fit"
        >
          {loading && <Loader2 size={16} className="animate-spin" />}
          Generate Survival Curve
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
        <div className="space-y-4">
          {/* Median survival */}
          <div className="bg-gray-900 border border-purple-500/20 rounded-xl p-5">
            <div className="flex items-center justify-between mb-6">
              <div>
                <p className="text-xs text-gray-500">Median Survival Time</p>
                <p className="text-3xl font-bold text-white mt-1">
                  {result.median_survival}
                  <span className="text-sm text-gray-400 ml-2">days</span>
                </p>
              </div>
              <div className="px-3 py-1.5 bg-purple-500/10 border border-purple-500/20 rounded-lg">
                <p className="text-xs text-purple-400">{label}</p>
              </div>
            </div>

            {/* Chart */}
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={chartData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                <XAxis
                  dataKey="time"
                  stroke="#6b7280"
                  tick={{ fontSize: 12 }}
                  label={{ value: 'Time', position: 'insideBottom', offset: -2, fill: '#6b7280', fontSize: 12 }}
                />
                <YAxis
                  stroke="#6b7280"
                  tick={{ fontSize: 12 }}
                  domain={[0, 100]}
                  label={{ value: 'Survival (%)', angle: -90, position: 'insideLeft', fill: '#6b7280', fontSize: 12 }}
                />
                <Tooltip
                  contentStyle={{ backgroundColor: '#111827', border: '1px solid #374151', borderRadius: '8px' }}
                  labelStyle={{ color: '#9ca3af', fontSize: 12 }}
                  itemStyle={{ color: '#a78bfa', fontSize: 12 }}
                  formatter={(value: any) => [`${value}%`, 'Survival']}
                  labelFormatter={(label) => `Time: ${label}`}
                />
                <ReferenceLine
                  y={50}
                  stroke="#6b7280"
                  strokeDasharray="4 4"
                  label={{ value: '50%', fill: '#6b7280', fontSize: 11 }}
                />
                <Line
                  type="stepAfter"
                  dataKey="survival"
                  stroke="#a78bfa"
                  strokeWidth={2.5}
                  dot={{ fill: '#a78bfa', r: 4 }}
                  activeDot={{ r: 6 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  )
}

