'use client'

import { useState, useEffect } from 'react'
import dynamic from 'next/dynamic'
import Sidebar from '@/components/core/Sidebar'
import Header from '@/components/core/Header'
import { UploadResult } from '@/lib/api'
import { loadUploadedData } from '@/lib/rApi'

const JarvisInput = dynamic(() => import('@/components/jarvis/JarvisInput'), { ssr: false })
const FileUpload = dynamic(() => import('@/components/data/FileUpload'), { ssr: false })
const DataSummary = dynamic(() => import('@/components/data/DataSummary'), { ssr: false })
const NormalityTest = dynamic(() => import('@/components/analytics/NormalityTest'), { ssr: false })
const SurvivalCurve = dynamic(() => import('@/components/analytics/SurvivalCurve'), { ssr: false })
const DescriptiveStats = dynamic(() => import('@/components/analytics/DescriptiveStats'), { ssr: false })
const ChartStudio = dynamic(() => import('@/components/charts/ChartStudio'), { ssr: false })
const TestWizard = dynamic(() => import('@/components/analytics/TestWizard'), { ssr: false })

export default function Home() {
  const [activeTab, setActiveTab] = useState('jarvis')
  const [uploadedData, setUploadedData] = useState<any>(null)
  const [storageError, setStorageError] = useState<string | null>(null)

  useEffect(() => {
    try {
      if (loadUploadedData()) {
        const saved = localStorage.getItem('omnistat_data')
        if (saved) setUploadedData(JSON.parse(saved))
      }
    } catch (e) {
      setStorageError(e instanceof Error ? e.message : 'Could not restore the dataset. Upload your file again.')
    }
  }, [])

  const handleUpload = (data: UploadResult) => {
    localStorage.setItem('omnistat_data', JSON.stringify(data))
    setUploadedData(data)
    setStorageError(null)
    setActiveTab('summary')
  }

  return (
    <div className="flex h-screen bg-gray-950 text-white overflow-hidden">
      <Sidebar activeTab={activeTab} setActiveTab={setActiveTab} />
      <div className="flex flex-col flex-1 overflow-hidden">
        <Header />
        <main className="flex-1 overflow-y-auto p-6">
          {storageError && <p role="alert" className="mb-4 text-sm text-red-400">{storageError}</p>}
          {activeTab === 'jarvis' && <JarvisInput />}
          {activeTab === 'upload' && <FileUpload onUpload={handleUpload} />}
          {activeTab === 'summary' && <DataSummary data={uploadedData} />}
          {activeTab === 'normality' && <NormalityTest />}
          {activeTab === 'survival' && <SurvivalCurve />}
          {activeTab === 'descriptive' && <DescriptiveStats />}
          {activeTab === 'charts' && <ChartStudio data={uploadedData} />}
          {activeTab === 'wizard' && <TestWizard />}
        </main>
      </div>
    </div>
  )
}