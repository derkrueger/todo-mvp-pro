import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL as string
const service = process.env.SUPABASE_SERVICE_ROLE as string

const supabase = url && service ? createClient(url, service) : null

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' })
  const { user_id, endpoint, keys } = req.body || {}
  if (!user_id || !endpoint || !keys) return res.status(400).json({ error: 'Missing fields' })

  const { error } = await supabase.from('push_subscriptions').insert({
    user_id, endpoint, p256dh: keys.p256dh, auth: keys.auth
  }).select().single()

  if (error) return res.status(500).json({ error: error.message })
  return res.status(200).json({ ok: true })
}
