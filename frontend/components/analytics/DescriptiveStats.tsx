'use client'

import { useState, useEffect } from 'react'

export default function DescriptiveStats() {
  const [uploadedData, setUploadedData] = useState<any>(null)
  const [selectedCol, setSelectedCol] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const saved = localStorage.getItem('omnistat_data')
    if (saved) {
      const data = JSON.parse(saved)
      setUploadedData(data)
      const firstNumeric = data.columns.find((col: string) =>
        data.dtypes[col]?.includes('int') || data.dtypes[col]?.includes('float')
      )
      if (firstNumeric) setSelectedCol(firstNumeric)
    }
  }, [])

  const numericColumns = uploadedData?.columns.filter((col: string) =>
    uploadedData.dtypes[col]?.includes('int') ||
    uploadedData.dtypes[col]?.includes('float')
  ) || []

  const handleRun = async () => {
    if (!selectedCol || !uploadedData) return
    setLoading(true)
    setError(null)
    setResult(null)

    const values = uploadedData.preview
      .map((row: any) => row[selectedCol])
      .filter((v: any) => v !== null && v !== undefined)

    try {
      const res = await fetch('http://127.0.0.1:8000/api/analytics/descriptive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values, column: selectedCol })
      })
      const data = await res.json()
      setResult(data)
    } catch {
      setError('Failed to connect to API')
    } finally {
      setLoading(false)
    }
  }

  if (!uploadedData) {
    return (
      <div className="max-w-3xl mx-auto">
        <div className="flex flex-col items-center justify-center h-64 bg-gray-900 border border-gray-800 border-dashed rounded-xl gap-4">
          <p className="text-white font-medium">No data loaded</p>
          <p className="text-sm text-gray-500">Go to Upload Data first</p>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-white">Descriptive Statistics</h2>
        <p className="text-sm text-gray-400">Summary statistics for numeric columns</p>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
        <div className="flex gap-3">
          <select
            value={selectedCol}
            onChange={(e) => setSelectedCol(e.target.value)}
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white text-sm focus:outline-none"
          >
            {numericColumns.map((col: string) => (
              <option key={col} value={col}>{col}</option>
            ))}
          </select>
          <button
            onClick={handleRun}
            disabled={loading || !selectedCol}
            className="px-6 py-2.5 bg-cyan-500 hover:bg-cyan-400 disabled:bg-gray-700 rounded-lg text-sm font-medium transition-all"
          >
            {loading ? 'Running...' : 'Analyze'}
          </button>
        </div>
        <p className="text-xs text-gray-600">{uploadedData.rows} rows loaded</p>
      </div>

      {error && (
        <div className="p-4 bg-red-500/5 border border-red-500/20 rounded-lg">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {result && (
        <div className="bg-gray-900 border border-cyan-500/20 rounded-xl p-5">
          <p className="text-sm font-medium text-cyan-400 mb-4">
            Results for <span className="font-mono">{result.column}</span>
          </p>
          <div className="grid grid-cols-4 gap-3 mb-5">
            {[
              { label: 'Mean', value: result.mean },
              { label: 'Median', value: result.median },
              { label: 'Std Dev', value: result.std },
              { label: 'Count', value: result.count },
            ].map((stat) => (
              <div key={stat.label} className="bg-gray-800 rounded-lg p-3 text-center">
                <p className="text-xl font-bold text-white font-mono">{stat.value}</p>
                <p className="text-xs text-gray-500 mt-1">{stat.label}</p>
              </div>
            ))}
          </div>
          <div className="divide-y divide-gray-800 rounded-lg overflow-hidden border border-gray-800">
            {[
              { label: 'Minimum', value: result.min },
              { label: 'Q1 (25th percentile)', value: result.q1 },
              { label: 'Median (Q2)', value: result.median },
              { label: 'Q3 (75th percentile)', value: result.q3 },
              { label: 'Maximum', value: result.max },
              { label: 'IQR', value: result.iqr },
              { label: 'Range', value: result.range },
              { label: 'Variance', value: result.variance },
              { label: 'Skewness', value: result.skewness },
              { label: 'Kurtosis', value: result.kurtosis },
            ].map((row) => (
              <div key={row.label} className="flex justify-between items-center px-4 py-2.5 bg-gray-900 hover:bg-gray-800 transition-colors">
                <span className="text-sm text-gray-400">{row.label}</span>
                <span className="text-sm text-white font-mono">{row.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}