import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'
import webpush from 'web-push'

const url = process.env.SUPABASE_URL as string
const service = process.env.SUPABASE_SERVICE_ROLE as string
const vapidPublic = process.env.VAPID_PUBLIC_KEY as string
const vapidPrivate = process.env.VAPID_PRIVATE_KEY as string

if (vapidPublic && vapidPrivate) {
  webpush.setVapidDetails('mailto:admin@example.com', vapidPublic, vapidPrivate)
}

const supabase = url && service ? createClient(url, service) : null

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  if (!supabase) return res.status(500).json({ error: 'Supabase not configured' })
  if (!vapidPublic || !vapidPrivate) return res.status(500).json({ error: 'VAPID keys missing' })
  const { user_id, title, body } = req.body || {}
  if (!user_id) return res.status(400).json({ error: 'Missing user_id' })

  const { data, error } = await supabase.from('push_subscriptions').select('*').eq('user_id', user_id)
  if (error) return res.status(500).json({ error: error.message })

  const payload = JSON.stringify({ title: title || 'To‑Do', body: body || 'Erinnerung' })
  const results = []
  for (const sub of data || []) {
    try {
      await webpush.sendNotification({
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth }
      }, payload)
      results.push({ endpoint: sub.endpoint, ok: true })
    } catch (e: any) {
      results.push({ endpoint: sub.endpoint, ok: false, error: e?.message })
    }
  }
  return res.status(200).json({ ok: true, results })
}
