import { createClient, SupabaseClient } from '@supabase/supabase-js'
import type { RRunResult } from './rApi'

interface Database {
  public: {
    Tables: {
      analysis_history: {
        Row: { id: string; user_id: string; created_at: string; title: string; result: unknown }
        Insert: { user_id: string; title: string; result: RRunResult }
        Update: never
        Relationships: []
      }
    }
    Views: Record<string, never>
    Functions: Record<string, never>
  }
}

let client: SupabaseClient<Database> | null = null

/** Explains a present but unusable configuration, e.g. a URL copied with "/rest/v1/". */
export function supabaseConfigError(): string | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!url || !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) return null
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'https:' && (parsed.pathname === '/' || parsed.pathname === '') && !parsed.search) return null
  } catch {
    // Reported below as an invalid URL.
  }
  return 'Cloud history is misconfigured: NEXT_PUBLIC_SUPABASE_URL must be the project URL only, such as https://YOUR_PROJECT.supabase.co, without /rest/v1 or another path.'
}

export function getSupabase(): SupabaseClient<Database> | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  if (!url || !key || supabaseConfigError()) return null
  if (!client) client = createClient<Database>(url, key)
  return client
}
