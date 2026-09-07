'use client'

import { useState } from 'react'
import { Database, Upload } from 'lucide-react'

interface DataSummaryProps {
  data: any
}

export default function DataSummary({ data }: DataSummaryProps) {
  const [activeCol, setActiveCol] = useState<string | null>(null)

  if (!data) {
    return (
      <div className="max-w-3xl mx-auto">
        <div className="flex flex-col items-center justify-center h-64 bg-gray-900 border border-gray-800 border-dashed rounded-xl gap-4">
          <Database size={40} className="text-gray-600" />
          <div className="text-center">
            <p className="text-white font-medium">No data loaded</p>
            <p className="text-sm text-gray-500 mt-1">Go to Upload Data first</p>
          </div>
          <div className="flex items-center gap-2 text-xs text-gray-600">
            <Upload size={14} />
            <span>Upload a CSV or Excel file to see summary</span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center">
          <Database size={20} className="text-indigo-400" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-white">Data Summary</h2>
          <p className="text-sm text-gray-400">Overview of your uploaded clinical dataset</p>
        </div>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
          <p className="text-3xl font-bold text-white">{data.rows}</p>
          <p className="text-xs text-gray-500 mt-1">Total Rows</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
          <p className="text-3xl font-bold text-white">{data.columns.length}</p>
          <p className="text-xs text-gray-500 mt-1">Columns</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
          <p className="text-3xl font-bold text-white">
            {Object.values(data.missing).filter((v: any) => v > 0).length}
          </p>
          <p className="text-xs text-gray-500 mt-1">Columns with Missing</p>
        </div>
      </div>

      {/* Column explorer */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="p-4 border-b border-gray-800">
          <p className="text-sm font-medium text-white">Column Explorer</p>
          <p className="text-xs text-gray-500 mt-0.5">Click a column to inspect it</p>
        </div>
        <div className="divide-y divide-gray-800">
          {data.columns.map((col: string) => (
            <div
              key={col}
              onClick={() => setActiveCol(activeCol === col ? null : col)}
              className={`flex items-center justify-between px-4 py-3 cursor-pointer transition-all ${
                activeCol === col
                  ? 'bg-indigo-500/5 border-l-2 border-indigo-400'
                  : 'hover:bg-gray-800'
              }`}
            >
              <div className="flex items-center gap-3">
                <span className={`text-xs px-2 py-0.5 rounded font-mono ${
                  data.dtypes[col]?.includes('int') || data.dtypes[col]?.includes('float')
                    ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20'
                    : 'bg-orange-500/10 text-orange-400 border border-orange-500/20'
                }`}>
                  {data.dtypes[col]?.includes('int') || data.dtypes[col]?.includes('float') ? 'num' : 'cat'}
                </span>
                <span className="text-sm text-white font-mono">{col}</span>
              </div>
              <div className="flex items-center gap-4 text-xs text-gray-500">
                <span>{data.dtypes[col]}</span>
                {data.missing[col] > 0 && (
                  <span className="text-yellow-400">{data.missing[col]} missing</span>
                )}
                {data.missing[col] === 0 && (
                  <span className="text-green-400">complete</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Preview table */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="p-4 border-b border-gray-800">
          <p className="text-sm font-medium text-white">Data Preview</p>
          <p className="text-xs text-gray-500 mt-0.5">First 5 rows</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-800">
                {data.columns.map((col: string) => (
                  <th key={col} className="px-4 py-3 text-left text-gray-400 font-mono font-medium">
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {data.preview.map((row: any, i: number) => (
                <tr key={i} className="hover:bg-gray-800 transition-colors">
                  {data.columns.map((col: string) => (
                    <td key={col} className="px-4 py-3 text-gray-300 font-mono">
                      {row[col] ?? '-'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}