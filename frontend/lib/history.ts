import { getSupabase } from './supabase'
import { isRRunResult, RRunResult } from './rApi'

export interface HistoryItem {
  id: string
  title: string
  created_at: string
}
export const HISTORY_PAGE_SIZE = 20

function client() {
  const supabase = getSupabase()
  if (!supabase) throw new Error('Cloud history is not configured.')
  return supabase
}

async function authenticatedClient(expectedUserId: string) {
  const supabase = client()
  const { data, error } = await supabase.auth.getUser()
  if (error || data.user?.id !== expectedUserId) throw new Error('Your account changed or expired. Sign in again before accessing history.')
  return supabase
}

function isHistoryItem(value: unknown): value is HistoryItem {
  return typeof value === 'object' && value !== null && 'id' in value &&
    typeof value.id === 'string' && 'title' in value && typeof value.title === 'string' &&
    'created_at' in value && typeof value.created_at === 'string'
}

export async function saveAnalysis(result: RRunResult, userId: string): Promise<void> {
  if (!isRRunResult(result) || !result.ok) throw new Error('Only successful, valid analyses can be saved.')
  const payload = JSON.stringify(result)
  if (new TextEncoder().encode(payload).length > 4_000_000) {
    throw new Error('This result is too large for cloud history (4 MB limit). The analysis is still available on screen.')
  }
  const supabase = await authenticatedClient(userId)
  const { error } = await supabase.from('analysis_history').insert({
    user_id: userId, title: result.title.slice(0, 200), result,
  })
  if (error) throw new Error('Could not save this analysis. Check your connection and account configuration before trying again.')
}

export async function listAnalyses(userId: string, page: number): Promise<HistoryItem[]> {
  const supabase = await authenticatedClient(userId)
  const { data, error } = await supabase.from('analysis_history')
    .select('id,title,created_at').eq('user_id', userId)
    .order('created_at', { ascending: false }).order('id', { ascending: false })
    .range(page * HISTORY_PAGE_SIZE, (page + 1) * HISTORY_PAGE_SIZE - 1)
  if (error) throw new Error('Could not load history. Check your connection and try again.')
  if (!Array.isArray(data) || !data.every(isHistoryItem)) throw new Error('The history service returned an invalid list.')
  return data
}

export async function openAnalysis(userId: string, id: string): Promise<RRunResult> {
  const supabase = await authenticatedClient(userId)
  const { data, error } = await supabase.from('analysis_history').select('result')
    .eq('user_id', userId).eq('id', id).single()
  if (error) throw new Error('Could not open this analysis. It may have been deleted, or your session may have expired.')
  if (!isRRunResult(data?.result)) throw new Error('The saved analysis is invalid or uses an unsupported format.')
  return data.result
}

export async function deleteAnalysis(userId: string, id: string): Promise<void> {
  const supabase = await authenticatedClient(userId)
  const { data, error } = await supabase.from('analysis_history').delete()
    .eq('user_id', userId).eq('id', id).select('id')
  if (error || !data?.length) throw new Error('Could not delete this analysis. Refresh history and try again.')
}
