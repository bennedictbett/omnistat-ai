'use client'

import { useState, useRef } from 'react'
import { Upload, File, CheckCircle, Loader2, AlertCircle } from 'lucide-react'

interface FileUploadProps {
  onUpload: (data: any) => void
}

export default function FileUpload({ onUpload }: FileUploadProps) {
  const [dragging, setDragging] = useState(false)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFile = async (file: File) => {
    setLoading(true)
    setError(null)
    setResult(null)

    const formData = new FormData()
    formData.append('file', file)

    try {
      const res = await fetch('http://127.0.0.1:8000/api/analytics/upload', {
        method: 'POST',
        body: formData
      })
      const data = await res.json()
      setResult(data)
      onUpload(data)
    } catch {
      setError('Failed to upload file. Make sure the API is running.')
    } finally {
      setLoading(false)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-white">Upload Clinical Data</h2>
        <p className="text-sm text-gray-400">Supports CSV and Excel files</p>
      </div>

      {/* Drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        className={`border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-all ${
          dragging
            ? 'border-green-400 bg-green-500/5'
            : 'border-gray-700 hover:border-gray-600 bg-gray-900'
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.xlsx,.xls"
          className="hidden"
          onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
        />

        {loading ? (
          <div className="flex flex-col items-center gap-3">
            <Loader2 size={40} className="text-green-400 animate-spin" />
            <p className="text-gray-400">Parsing file...</p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3">
            <Upload size={40} className="text-gray-600" />
            <div>
              <p className="text-white font-medium">Drop your file here</p>
              <p className="text-sm text-gray-500 mt-1">or click to browse</p>
            </div>
            <p className="text-xs text-gray-600">CSV, XLSX supported</p>
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-3 p-4 bg-red-500/5 border border-red-500/20 rounded-lg">
          <AlertCircle size={18} className="text-red-400" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {/* Result */}
      {result && (
        <div className="bg-gray-900 border border-green-500/20 rounded-xl p-5 space-y-4">
          <div className="flex items-center gap-2">
            <CheckCircle size={18} className="text-green-400" />
            <span className="text-sm font-medium text-green-400">File parsed successfully</span>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="bg-gray-800 rounded-lg p-3 text-center">
              <p className="text-2xl font-bold text-white">{result.rows}</p>
              <p className="text-xs text-gray-500 mt-1">Rows</p>
            </div>
            <div className="bg-gray-800 rounded-lg p-3 text-center">
              <p className="text-2xl font-bold text-white">{result.columns.length}</p>
              <p className="text-xs text-gray-500 mt-1">Columns</p>
            </div>
            <div className="bg-gray-800 rounded-lg p-3 text-center">
              <p className="text-2xl font-bold text-white">
                {Object.values(result.missing).filter((v: any) => v > 0).length}
              </p>
              <p className="text-xs text-gray-500 mt-1">Missing Cols</p>
            </div>
          </div>

          <div>
            <p className="text-xs text-gray-500 mb-2">Columns Detected</p>
            <div className="flex flex-wrap gap-2">
              {result.columns.map((col: string) => (
                <span key={col} className="px-2 py-1 bg-blue-500/10 border border-blue-500/20 rounded text-xs text-blue-400">
                  {col}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}