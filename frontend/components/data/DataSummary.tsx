'use client'

import { useState } from 'react'
import { Database, Upload } from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  PieChart, Pie, Cell, ResponsiveContainer, ScatterChart,
  Scatter, Legend
} from 'recharts'

const COLORS = ['#10b981', '#3b82f6', '#8b5cf6', '#f59e0b', '#ef4444', '#06b6d4']

interface DataSummaryProps {
  data: any
}

export default function DataSummary({ data }: DataSummaryProps) {
  const [activeSection, setActiveSection] = useState<string>('overview')

  if (!data) {
    return (
      <div className="max-w-3xl mx-auto">
        <div className="flex flex-col items-center justify-center h-64 bg-gray-900 border border-gray-800 border-dashed rounded-xl gap-4">
          <Database size={40} className="text-gray-600" />
          <div className="text-center">
            <p className="text-white font-medium">No data loaded</p>
            <p className="text-sm text-gray-500 mt-1">Go to Upload Data first</p>
          </div>
        </div>
      </div>
    )
  }

  // Prepare histogram chart data
  const getHistogramData = (col: string) => {
    const values = data.full_data?.map((row: any) => row[col]) || []
    const min = Math.min(...values)
    const max = Math.max(...values)
    const binCount = 8
    const binSize = (max - min) / binCount
    const bins = Array.from({ length: binCount }, (_, i) => {
      const start = min + i * binSize
      const end = start + binSize
      return {
        range: `${Math.round(start)}-${Math.round(end)}`,
        count: values.filter((v: number) => v >= start && v < end).length
      }
    })
    return bins
  }

  // Prepare correlation data
  const getCorrelationColor = (value: number) => {
    if (value >= 0.7) return 'bg-green-500'
    if (value >= 0.4) return 'bg-green-300'
    if (value >= 0.1) return 'bg-gray-500'
    if (value >= -0.4) return 'bg-orange-300'
    return 'bg-red-500'
  }

  const sections = ['overview', 'distributions', 'categorical', 'correlation']

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center">
            <Database size={20} className="text-indigo-400" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-white">Data Dashboard</h2>
            <p className="text-sm text-gray-400">{data.rows} rows · {data.columns.length} columns · {data.numeric_cols?.length || 0} numeric · {data.categorical_cols?.length || 0} categorical</p>
          </div>
        </div>
      </div>

      {/* Section tabs */}
      <div className="flex gap-2">
        {sections.map((s) => (
          <button
            key={s}
            onClick={() => setActiveSection(s)}
            className={`px-4 py-2 rounded-lg text-sm font-medium capitalize transition-all ${
              activeSection === s
                ? 'bg-indigo-500/20 text-indigo-400 border border-indigo-500/30'
                : 'text-gray-400 hover:text-white hover:bg-gray-800'
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      {/* Overview */}
      {activeSection === 'overview' && (
        <div className="space-y-4">
          {/* Stats cards */}
          <div className="grid grid-cols-4 gap-4">
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
              <p className="text-3xl font-bold text-white">{data.rows}</p>
              <p className="text-xs text-gray-500 mt-1">Total Rows</p>
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
              <p className="text-3xl font-bold text-white">{data.columns.length}</p>
              <p className="text-xs text-gray-500 mt-1">Columns</p>
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
              <p className="text-3xl font-bold text-white">{data.numeric_cols?.length || 0}</p>
              <p className="text-xs text-gray-500 mt-1">Numeric</p>
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
              <p className="text-3xl font-bold text-white">
                {Object.values(data.missing || {}).filter((v: any) => v > 0).length}
              </p>
              <p className="text-xs text-gray-500 mt-1">Missing Cols</p>
            </div>
          </div>

          {/* Numeric summary table */}
          {data.numeric_stats && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              <div className="p-4 border-b border-gray-800">
                <p className="text-sm font-medium text-white">Numeric Summary</p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-gray-800">
                      <th className="px-4 py-3 text-left text-gray-400 font-medium">Column</th>
                      <th className="px-4 py-3 text-right text-gray-400 font-medium">Mean</th>
                      <th className="px-4 py-3 text-right text-gray-400 font-medium">Median</th>
                      <th className="px-4 py-3 text-right text-gray-400 font-medium">Std Dev</th>
                      <th className="px-4 py-3 text-right text-gray-400 font-medium">Min</th>
                      <th className="px-4 py-3 text-right text-gray-400 font-medium">Max</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800">
                    {Object.entries(data.numeric_stats).map(([col, stats]: [string, any]) => (
                      <tr key={col} className="hover:bg-gray-800 transition-colors">
                        <td className="px-4 py-3 text-white font-mono">{col}</td>
                        <td className="px-4 py-3 text-gray-300 text-right font-mono">{stats.mean}</td>
                        <td className="px-4 py-3 text-gray-300 text-right font-mono">{stats.median}</td>
                        <td className="px-4 py-3 text-gray-300 text-right font-mono">{stats.std}</td>
                        <td className="px-4 py-3 text-gray-300 text-right font-mono">{stats.min}</td>
                        <td className="px-4 py-3 text-gray-300 text-right font-mono">{stats.max}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Preview table */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <div className="p-4 border-b border-gray-800">
              <p className="text-sm font-medium text-white">Data Preview <span className="text-gray-500 text-xs ml-2">First 5 rows</span></p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-800">
                    {data.columns.map((col: string) => (
                      <th key={col} className="px-4 py-3 text-left text-gray-400 font-mono font-medium">{col}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {data.preview.map((row: any, i: number) => (
                    <tr key={i} className="hover:bg-gray-800 transition-colors">
                      {data.columns.map((col: string) => (
                        <td key={col} className="px-4 py-3 text-gray-300 font-mono">{row[col] ?? '-'}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Distributions — histograms */}
      {activeSection === 'distributions' && (
        <div className="space-y-4">
          <p className="text-sm text-gray-400">Histograms for all numeric columns</p>
          <div className="grid grid-cols-2 gap-4">
            {data.numeric_cols?.filter((col: string) => col !== 'patient_id').map((col: string) => (
              <div key={col} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <p className="text-sm font-medium text-white mb-1">{col}</p>
                <p className="text-xs text-gray-500 mb-3">
                  Mean: {data.numeric_stats[col]?.mean} · Std: {data.numeric_stats[col]?.std}
                </p>
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart data={getHistogramData(col)} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                    <XAxis dataKey="range" tick={{ fontSize: 9, fill: '#6b7280' }} />
                    <YAxis tick={{ fontSize: 9, fill: '#6b7280' }} />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#111827', border: '1px solid #374151', borderRadius: '6px', fontSize: '11px' }}
                    />
                    <Bar dataKey="count" fill="#6366f1" radius={[2, 2, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Categorical — pie/bar charts */}
      {activeSection === 'categorical' && (
        <div className="space-y-4">
          <p className="text-sm text-gray-400">Distribution of categorical columns</p>
          <div className="grid grid-cols-2 gap-4">
            {data.categorical_cols?.map((col: string) => {
              const stats = data.categorical_stats?.[col] || {}
              const pieData = Object.entries(stats).map(([name, value]) => ({ name, value }))
              const barData = Object.entries(stats).map(([name, value]) => ({ name, count: value }))

              return (
                <div key={col} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                  <p className="text-sm font-medium text-white mb-4">{col}</p>
                  <div className="flex gap-4 items-center">
                    {/* Pie chart */}
                    <div className="flex-1">
                      <ResponsiveContainer width="100%" height={160}>
                        <PieChart>
                          <Pie
                            data={pieData}
                            cx="50%"
                            cy="50%"
                            innerRadius={40}
                            outerRadius={70}
                            dataKey="value"
                            labelLine={false}
                          >
                            {pieData.map((_, index) => (
                              <Cell key={index} fill={COLORS[index % COLORS.length]} />
                            ))}
                          </Pie>
                          <Tooltip
                            contentStyle={{ backgroundColor: '#111827', border: '1px solid #374151', borderRadius: '6px', fontSize: '11px' }}
                          />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                    {/* Bar chart */}
                    <div className="flex-1">
                      <ResponsiveContainer width="100%" height={160}>
                        <BarChart data={barData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                          <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#6b7280' }} />
                          <YAxis tick={{ fontSize: 11, fill: '#6b7280' }} />
                          <Tooltip
                            contentStyle={{ backgroundColor: '#111827', border: '1px solid #374151', borderRadius: '6px', fontSize: '11px' }}
                          />
                          <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                            {barData.map((_, index) => (
                              <Cell key={index} fill={COLORS[index % COLORS.length]} />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Correlation heatmap */}
      {activeSection === 'correlation' && data.correlation && (
        <div className="space-y-4">
          <p className="text-sm text-gray-400">Pearson correlation between numeric columns</p>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 overflow-x-auto">
            <table className="text-xs">
              <thead>
                <tr>
                  <th className="w-24"></th>
                  {Object.keys(data.correlation).map((col) => (
                    <th key={col} className="px-2 py-1 text-gray-400 font-mono text-center" style={{ writingMode: 'vertical-rl', height: '80px' }}>
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Object.entries(data.correlation).map(([row, values]: [string, any]) => (
                  <tr key={row}>
                    <td className="px-2 py-1 text-gray-400 font-mono text-right pr-3">{row}</td>
                    {Object.entries(values).map(([col, val]: [string, any]) => (
                      <td key={col} className="p-0.5">
                        <div className={`w-12 h-8 rounded flex items-center justify-center text-white font-mono text-xs ${getCorrelationColor(val)}`}>
                          {val.toFixed(2)}
                        </div>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Correlation insights */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <p className="text-xs font-medium text-gray-400 mb-3">Strong Correlations (|r| ≥ 0.7)</p>
            <div className="space-y-2">
              {Object.entries(data.correlation).flatMap(([row, values]: [string, any]) =>
                Object.entries(values)
                  .filter(([col, val]: [string, any]) => col !== row && Math.abs(val) >= 0.7)
                  .map(([col, val]: [string, any]) => (
                    <div key={`${row}-${col}`} className="flex items-center justify-between p-2 bg-gray-800 rounded-lg">
                      <span className="text-xs text-gray-300 font-mono">{row} ↔ {col}</span>
                      <span className={`text-xs font-mono font-bold ${Number(val) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        r = {Number(val).toFixed(3)}
                      </span>
                    </div>
                  ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}


