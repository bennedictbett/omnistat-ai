'use client'

import { useState, useEffect } from 'react'
import Sidebar from '@/components/core/Sidebar'
import Header from '@/components/core/Header'
import JarvisInput from '@/components/jarvis/JarvisInput'
import FileUpload from '@/components/data/FileUpload'
import DataSummary from '@/components/data/DataSummary'
import DescriptiveStats from '@/components/analytics/DescriptiveStats'
import NormalityTest from '@/components/analytics/NormalityTest'
import SurvivalCurve from '@/components/analytics/SurvivalCurve'

export default function Home() {
  const [activeTab, setActiveTab] = useState('jarvis')
  const [uploadedData, setUploadedData] = useState<any>(null)

  // Load saved data on mount
  useEffect(() => {
    const saved = localStorage.getItem('omnistat_data')
    if (saved) setUploadedData(JSON.parse(saved))
  }, [])

  const handleUpload = (data: any) => {
    setUploadedData(data)
    localStorage.setItem('omnistat_data', JSON.stringify(data))
    setActiveTab('summary')
  }

  return (
    <div className="flex h-screen bg-gray-950 text-white overflow-hidden">
      <Sidebar activeTab={activeTab} setActiveTab={setActiveTab} />
      <div className="flex flex-col flex-1 overflow-hidden">
        <Header />
        <main className="flex-1 overflow-y-auto p-6">
          {activeTab === 'jarvis' && <JarvisInput />}
          {activeTab === 'upload' && <FileUpload onUpload={handleUpload} />}
          {activeTab === 'summary' && <DataSummary data={uploadedData} />}
          {activeTab === 'normality' && <NormalityTest />}
          {activeTab === 'survival' && <SurvivalCurve />}
          {activeTab === 'descriptive' && <DescriptiveStats />}
        </main>
      </div>
    </div>
  )
}