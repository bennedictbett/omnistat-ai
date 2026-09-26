'use client'

import { Brain, Upload, BarChart2, Activity, Database, FileText } from 'lucide-react'

const tabs = [
  { id: 'jarvis', label: 'Jarvis AI', icon: Brain },
  { id: 'upload', label: 'Upload Data', icon: Upload },
  { id: 'summary', label: 'Data Summary', icon: Database },
  { id: 'normality', label: 'Normality Test', icon: BarChart2 },
  { id: 'survival', label: 'Survival Curve', icon: Activity },
  { id: 'history', label: 'History', icon: FileText },
  { id: 'descriptive', label: 'Descriptive Stats', icon: BarChart2 },
]

interface SidebarProps {
  activeTab: string
  setActiveTab: (tab: string) => void
}

export default function Sidebar({ activeTab, setActiveTab }: SidebarProps) {
  return (
    <div className="w-64 bg-gray-900 border-r border-gray-800 flex flex-col">
      {/* Logo */}
      <div className="p-6 border-b border-gray-800">
        <h1 className="text-xl font-bold text-green-400">OmniStat AI</h1>
        <p className="text-xs text-gray-500 mt-1">Clinical Statistics Engine</p>
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-4 space-y-1">
        {tabs.map((tab) => {
          const Icon = tab.icon
          const isActive = activeTab === tab.id
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm transition-all ${
                isActive
                  ? 'bg-green-500/10 text-green-400 border border-green-500/20'
                  : 'text-gray-400 hover:bg-gray-800 hover:text-white'
              }`}
            >
              <Icon size={18} />
              {tab.label}
            </button>
          )
        })}
      </nav>

      {/* Footer */}
      <div className="p-4 border-t border-gray-800">
        <p className="text-xs text-gray-600 text-center">v1.0.0 — MVP</p>
      </div>
    </div>
  )
}

