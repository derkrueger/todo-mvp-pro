export async function askNotificationPermission(): Promise<NotificationPermission> {
  if (!('Notification' in window)) return 'denied'
  const status = await Notification.requestPermission()
  return status
}

function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = window.atob(base64)
  const outputArray = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i)
  return outputArray
}

export async function subscribePush(reg: ServiceWorkerRegistration) {
  const vapidPublic = import.meta.env.VITE_VAPID_PUBLIC_KEY
  if (!vapidPublic) throw new Error('VAPID public key fehlt (VITE_VAPID_PUBLIC_KEY)')
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublic)
  })
  return sub
}
