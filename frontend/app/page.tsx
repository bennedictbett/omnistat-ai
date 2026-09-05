'use client'

import { useState } from 'react'
import Sidebar from '@/components/core/Sidebar'
import Header from '@/components/core/Header'
import JarvisInput from '@/components/jarvis/JarvisInput'
import FileUpload from '@/components/data/FileUpload'
import DataSummary from '@/components/data/DataSummary'
import NormalityTest from '@/components/analytics/NormalityTest'
import SurvivalCurve from '@/components/analytics/SurvivalCurve'

export default function Home() {
  const [activeTab, setActiveTab] = useState('jarvis')
  const [uploadedData, setUploadedData] = useState<any>(null)

  return (
    <div className="flex h-screen bg-gray-950 text-white overflow-hidden">
      <Sidebar activeTab={activeTab} setActiveTab={setActiveTab} />
      <div className="flex flex-col flex-1 overflow-hidden">
        <Header />
        <main className="flex-1 overflow-y-auto p-6">
          {activeTab === 'jarvis' && <JarvisInput />}
          {activeTab === 'upload' && (
            <FileUpload onUpload={setUploadedData} />
          )}
          {activeTab === 'summary' && uploadedData && (
            <DataSummary data={uploadedData} />
          )}
          {activeTab === 'normality' && <NormalityTest />}
          {activeTab === 'survival' && <SurvivalCurve />}
        </main>
      </div>
    </div>
  )
}