'use client'

import { Activity, Wifi } from 'lucide-react'
import { useState, useEffect } from 'react'

export default function Header() {
  const [apiStatus, setApiStatus] = useState<'checking' | 'online' | 'offline'>('checking')

  useEffect(() => {
    const checkApi = async () => {
      try {
        const res = await fetch('http://127.0.0.1:8000/')
        if (res.ok) setApiStatus('online')
        else setApiStatus('offline')
      } catch {
        setApiStatus('offline')
      }
    }
    checkApi()
    const interval = setInterval(checkApi, 10000)
    return () => clearInterval(interval)
  }, [])

  return (
    <header className="h-16 bg-gray-900 border-b border-gray-800 flex items-center justify-between px-6">
      <div>
        <h2 className="text-sm font-medium text-white">Statistical Analysis Workstation</h2>
        <p className="text-xs text-gray-500">AI-powered clinical research tools</p>
      </div>

      <div className="flex items-center gap-4">
        {/* API Status */}
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${
            apiStatus === 'online' ? 'bg-green-400' :
            apiStatus === 'offline' ? 'bg-red-400' :
            'bg-yellow-400 animate-pulse'
          }`} />
          <span className="text-xs text-gray-400">
            API {apiStatus === 'checking' ? 'checking...' : apiStatus}
          </span>
        </div>

        <div className="flex items-center gap-2 text-gray-400">
          <Wifi size={16} />
          <Activity size={16} />
        </div>
      </div>
    </header>
  )
}