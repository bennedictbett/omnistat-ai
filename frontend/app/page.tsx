'use client'

import { useState, useEffect } from 'react'
import dynamic from 'next/dynamic'
import Sidebar from '@/components/core/Sidebar'
import Header from '@/components/core/Header'
import { UploadResult } from '@/lib/api'
import { DatasetProject } from '@/lib/projects'
import { loadUploadedData } from '@/lib/rApi'
import { AuditFailureBanner } from '@/components/audit/AuditLog'

const SOURCE_KEY = 'omnistat_data_source'

/** Replaces the active dataset; throws if browser storage rejects it, leaving the previous dataset active. */
function activateDataset(data: UploadResult, source: string) {
  localStorage.setItem('omnistat_data', JSON.stringify(data))
  try {
    localStorage.setItem(SOURCE_KEY, source)
  } catch {
    localStorage.removeItem(SOURCE_KEY)
  }
}

const JarvisInput = dynamic(() => import('@/components/jarvis/JarvisInput'), { ssr: false })
const FileUpload = dynamic(() => import('@/components/data/FileUpload'), { ssr: false })
const DataSummary = dynamic(() => import('@/components/data/DataSummary'), { ssr: false })
const NormalityTest = dynamic(() => import('@/components/analytics/NormalityTest'), { ssr: false })
const SurvivalCurve = dynamic(() => import('@/components/analytics/SurvivalCurve'), { ssr: false })
const DescriptiveStats = dynamic(() => import('@/components/analytics/DescriptiveStats'), { ssr: false })
const ChartStudio = dynamic(() => import('@/components/charts/ChartStudio'), { ssr: false })
const TestWizard = dynamic(() => import('@/components/analytics/TestWizard'), { ssr: false })
const DatasetProjects = dynamic(() => import('@/components/data/DatasetProjects'), { ssr: false })
const AnalysisHistory = dynamic(() => import('@/components/history/AnalysisHistory'), { ssr: false })

export default function Home() {
  const [activeTab, setActiveTab] = useState('jarvis')
  const [uploadedData, setUploadedData] = useState<any>(null)
  const [source, setSource] = useState<string | null>(null)
  const [storageError, setStorageError] = useState<string | null>(null)

  useEffect(() => {
    try {
      if (loadUploadedData()) {
        const saved = localStorage.getItem('omnistat_data')
        if (saved) setUploadedData(JSON.parse(saved))
        setSource(localStorage.getItem(SOURCE_KEY))
      }
    } catch (e) {
      setStorageError(e instanceof Error ? e.message : 'Could not restore the dataset. Upload your file again.')
    }
  }, [])

  const handleUpload = (data: UploadResult, fileName: string) => {
    activateDataset(data, fileName)
    setUploadedData(data)
    setSource(fileName)
    setStorageError(null)
    setActiveTab('summary')
  }

  const handleOpenProject = (project: DatasetProject) => {
    activateDataset(project.dataset, project.source_file)
    setUploadedData(project.dataset)
    setSource(project.source_file)
    setStorageError(null)
  }

  return (
    <div className="flex h-screen bg-gray-950 text-white overflow-hidden">
      <Sidebar activeTab={activeTab} setActiveTab={setActiveTab} />
      <div className="flex flex-col flex-1 overflow-hidden">
        <Header />
        <main className="flex-1 overflow-y-auto p-6">
          <AuditFailureBanner />
          {storageError && <p role="alert" className="mb-4 text-sm text-red-400">{storageError}</p>}
          {activeTab === 'jarvis' && <JarvisInput />}
          {activeTab === 'upload' && <FileUpload onUpload={handleUpload} />}
          {activeTab === 'projects' && (
            <DatasetProjects current={uploadedData} currentSource={source} onOpen={handleOpenProject} />
          )}
          {activeTab === 'summary' && <DataSummary data={uploadedData} />}
          {activeTab === 'normality' && <NormalityTest />}
          {activeTab === 'survival' && <SurvivalCurve />}
          {activeTab === 'descriptive' && <DescriptiveStats />}
          {activeTab === 'charts' && <ChartStudio data={uploadedData} />}
          {activeTab === 'wizard' && <TestWizard />}
          {activeTab === 'history' && <AnalysisHistory />}
        </main>
      </div>
    </div>
  )
}