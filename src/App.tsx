import React, { useEffect, useMemo, useRef, useState } from 'react'
import { parseTaskLine, type Priority } from './helpers'
import { supabase, supabaseAvailable } from './supabaseClient'
import { askNotificationPermission, subscribePush } from './push'

type RepeatMode = 'once' | 'daily' | 'weekly' | 'monthly'

type Task = {
  id: string;
  title: string;
  note?: string;
  checked: boolean;
  createdAt: number;
  priority: Priority;
  tags: string[];
};

type ListSettings = {
  mode: RepeatMode;
  resetHour: number;
  resetMinute: number;
  resetWeekday: number;
  resetDayOfMonth: number;
  carryOver: boolean;
};

type List = {
  id: string;
  name: string;
  color?: string;
  createdAt: number;
  lastResetAt?: number;
  tasks: Task[];
  settings: ListSettings;
};

type Snapshot = {
  id: string;
  listId: string;
  listName: string;
  startedAt: number;
  endedAt: number;
  total: number;
  completed: number;
  percent: number;
  tasks: Task[];
};

type Template = {
  id: string;
  name: string;
  tasks: Pick<Task, 'title' | 'priority' | 'tags'>[];
}

type AppState = {
  lists: List[];
  snapshots: Snapshot[];
  templates: Template[];
  activeListId?: string;
  version: number;
  userId?: string;
  userEmail?: string;
};

const STORAGE_KEY = 'todo_mvp_state_v2'

const newId = () => Math.random().toString(36).slice(2) + Date.now().toString(36)

function clampDayOfMonth(year: number, monthIndex0: number, day: number) {
  const lastDay = new Date(year, monthIndex0 + 1, 0).getDate();
  return Math.min(day, lastDay);
}
function atTime(base: Date, hour: number, minute: number) {
  const d = new Date(base); d.setHours(hour, minute, 0, 0); return d;
}
function mostRecentWeeklyTime(now: Date, weekday: number, hour: number, minute: number) {
  const d = new Date(now); const currentWeekday = d.getDay();
  const diffDays = (currentWeekday - weekday + 7) % 7;
  d.setDate(d.getDate() - diffDays); d.setHours(hour, minute, 0, 0);
  if (d > now) d.setDate(d.getDate() - 7); return d;
}
function mostRecentMonthlyTime(now: Date, dayOfMonth: number, hour: number, minute: number) {
  const y = now.getFullYear(); const m = now.getMonth(); const d = clampDayOfMonth(y, m, dayOfMonth);
  let dt = new Date(y, m, d, hour, minute, 0, 0);
  if (dt > now) { const pm = (m - 1 + 12) % 12; const py = pm === 11 ? y - 1 : y; const pd = clampDayOfMonth(py, pm, dayOfMonth);
    dt = new Date(py, pm, pd, hour, minute, 0, 0);
  } return dt;
}
function mostRecentScheduledTime(now: Date, s: ListSettings): Date | null {
  const { mode, resetHour, resetMinute, resetWeekday, resetDayOfMonth } = s;
  if (mode === 'once') return null;
  if (mode === 'daily') { const today = atTime(now, resetHour, resetMinute); if (today > now) { const y = new Date(today); y.setDate(y.getDate() - 1); return y; } return today; }
  if (mode === 'weekly') return mostRecentWeeklyTime(now, resetWeekday, resetHour, resetMinute);
  if (mode === 'monthly') return mostRecentMonthlyTime(now, resetDayOfMonth, resetHour, resetMinute);
  return null;
}
function progressOf(list: List) {
  const total = list.tasks.length;
  const completed = list.tasks.filter(t => t.checked).length;
  const percent = total === 0 ? 0 : Math.round((completed / total) * 100);
  return { total, completed, percent };
}
function defaultSettings(): ListSettings { return { mode: 'once', resetHour: 5, resetMinute: 0, resetWeekday: 1, resetDayOfMonth: 1, carryOver: true } }
function newList(name: string): List {
  const id = newId(); return { id, name, createdAt: Date.now(), tasks: [], settings: defaultSettings(), lastResetAt: Date.now() }
}
function snapshotFromList(list: List): Snapshot {
  const { total, completed, percent } = progressOf(list);
  return { id: newId(), listId: list.id, listName: list.name, startedAt: list.lastResetAt ?? list.createdAt, endedAt: Date.now(), total, completed, percent, tasks: list.tasks.map(t => ({ ...t })) };
}

// ──────────────────────────────────────────────────────────────────────────────
// App
// ──────────────────────────────────────────────────────────────────────────────
export default function App() {
  const [state, setState] = useState<AppState>(() => {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) { try { return JSON.parse(raw) as AppState } catch {} }
    const first = newList('Meine erste Liste')
    return { lists: [first], snapshots: [], templates: [], activeListId: first.id, version: 2 }
  })
  const activeList = useMemo(() => state.lists.find(l => l.id === state.activeListId) ?? state.lists[0], [state])

  // Persist
  useEffect(() => { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)) }, [state])

  // Intent URLs for Siri Shortcuts: /?intent=add&list=Name&task=Text%20#tag1%20!high
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const intent = params.get('intent')
    if (intent === 'add') {
      const listName = params.get('list') || 'Eingang'
      const taskLine = params.get('task') || ''
      let list = state.lists.find(l => l.name.toLowerCase() === listName.toLowerCase())
      if (!list) { list = newList(listName); setState(s => ({ ...s, lists: [...s.lists, list!], activeListId: list!.id })) }
      if (taskLine) {
        const { title, tags, priority } = parseTaskLine(taskLine)
        const task: Task = { id: newId(), title, checked: false, createdAt: Date.now(), priority, tags }
        setState(s => ({ ...s, lists: s.lists.map(l => l.id === (list as List).id ? { ...l, tasks: [task, ...l.tasks] } : l) }))
      }
      // clear intent from URL to prevent duplicates
      const u = new URL(location.href); u.search = ''; history.replaceState({}, '', u.toString())
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Scheduler: check resets every 30s
  useEffect(() => {
    const check = () => {
      setState(prev => {
        const now = new Date();
        let changed = false;
        const lists = prev.lists.map(list => {
          const scheduled = mostRecentScheduledTime(now, list.settings);
          if (!scheduled) return list;
          const last = new Date(list.lastResetAt ?? list.createdAt);
          if (last < scheduled) {
            changed = true;
            const newTasks = list.settings.carryOver ? list.tasks.filter(t => !t.checked).map(t => ({ ...t, checked: false })) : [];
            const snap = snapshotFromList(list);
            return { ...list, tasks: newTasks, lastResetAt: now.getTime() }
          }
          return list;
        });
        if (!changed) return prev;
        // append snapshots in one go
        const newSnaps = prev.lists.flatMap(l => {
          const scheduled = mostRecentScheduledTime(new Date(), l.settings)
          const last = new Date(l.lastResetAt ?? l.createdAt)
          if (scheduled && last < scheduled) return [snapshotFromList(l)]
          return []
        })
        return { ...prev, lists, snapshots: [...newSnaps, ...prev.snapshots] };
      });
    };
    check();
    const id = setInterval(check, 30000);
    return () => clearInterval(id);
  }, [])

  // Auth (Supabase) optional
  const [email, setEmail] = useState('')
  const [authInfo, setAuthInfo] = useState<{loading: boolean, user?: any}>({loading: false})

  async function signInMagic() {
    if (!supabase) { alert('Supabase nicht konfiguriert'); return }
    setAuthInfo({loading: true})
    const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin } })
    setAuthInfo({loading: false})
    if (error) alert(error.message)
    else alert('Magic Link gesendet. Prüfe deine E-Mails.')
  }

  useEffect(() => {
    if (!supabase) return
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_evt, session) => {
      setState(s => ({...s, userId: session?.user?.id, userEmail: session?.user?.email || undefined}))
    })
    supabase.auth.getUser().then(({ data }) => {
      if (data?.user) setState(s => ({...s, userId: data.user!.id, userEmail: data.user!.email || undefined}))
    })
    return () => subscription.unsubscribe()
  }, [])

  // Basic cloud sync (naive): push full list on change if logged in; in production use proper CRDT/OT
  useEffect(() => {
    if (!supabase || !state.userId) return
    ;(async () => {
      // upsert lists
      for (const l of state.lists) {
        await supabase.from('lists').upsert({
          id: l.id, user_id: state.userId, name: l.name, mode: l.settings.mode, reset_hour: l.settings.resetHour,
          reset_minute: l.settings.resetMinute, reset_weekday: l.settings.resetWeekday, reset_day_of_month: l.settings.resetDayOfMonth,
          carry_over: l.settings.carryOver, last_reset_at: new Date(l.lastResetAt || l.createdAt).toISOString()
        })
        // upsert tasks
        for (const t of l.tasks) {
          await supabase.from('tasks').upsert({
            id: t.id, list_id: l.id, title: t.title, checked: t.checked, priority: t.priority, tags: t.tags
          })
        }
      }
    })()
  }, [state.lists, state.userId])

  // ───────────── UI actions
  const addList = () => {
    const name = prompt('Neuen Listentitel eingeben:')?.trim()
    if (!name) return
    const l = newList(name)
    setState(s => ({ ...s, lists: [...s.lists, l], activeListId: l.id }))
  }
  const renameList = (id: string) => {
    const list = state.lists.find(l => l.id === id)
    const name = prompt('Neuer Name für die Liste:', list?.name ?? '')
    if (!name) return
    setState(s => ({ ...s, lists: s.lists.map(l => (l.id === id ? { ...l, name } : l)) }))
  }
  const deleteList = (id: string) => {
    if (!confirm('Liste wirklich löschen? (Archiv bleibt erhalten)')) return
    setState(s => {
      const lists = s.lists.filter(l => l.id !== id)
      const activeListId = lists[0]?.id
      return { ...s, lists, activeListId }
    })
  }
  const addTask = (line: string) => {
    if (!activeList) return
    const { title, tags, priority } = parseTaskLine(line)
    const task: Task = { id: newId(), title, checked: false, createdAt: Date.now(), priority, tags }
    setState(s => ({ ...s, lists: s.lists.map(l => (l.id === activeList.id ? { ...l, tasks: [task, ...l.tasks] } : l)) }))
  }
  const toggleTask = (listId: string, taskId: string) => {
    setState(s => ({ ...s, lists: s.lists.map(l => l.id !== listId ? l : { ...l, tasks: l.tasks.map(t => t.id === taskId ? { ...t, checked: !t.checked } : t) }) }))
  }
  const removeTask = (listId: string, taskId: string) => {
    setState(s => ({ ...s, lists: s.lists.map(l => l.id !== listId ? l : { ...l, tasks: l.tasks.filter(t => t.id !== taskId) }) }))
  }
  const resetNow = (id: string) => {
    setState(prev => {
      const lists = prev.lists.map(l => {
        if (l.id !== id) return l
        const newTasks = l.settings.carryOver ? l.tasks.filter(t => !t.checked).map(t => ({ ...t, checked: false })) : []
        return { ...l, tasks: newTasks, lastResetAt: Date.now() }
      })
      const active = prev.lists.find(l => l.id === id)!
      const snap = snapshotFromList(active)
      return { ...prev, lists, snapshots: [snap, ...prev.snapshots] }
    })
  }
  const setSettings = (id: string, patch: Partial<ListSettings>) => {
    setState(s => ({ ...s, lists: s.lists.map(l => (l.id === id ? { ...l, settings: { ...l.settings, ...patch } } : l)) }))
  }
  const exportJSON = () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = `todo-mvp-export-${new Date().toISOString()}.json`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
  }
  const importJSON = () => {
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.json,application/json'
    input.onchange = () => {
      const file = input.files?.[0]; if (!file) return; const reader = new FileReader()
      reader.onload = () => { try { const parsed: AppState = JSON.parse(String(reader.result)); setState(parsed) } catch { alert('Import fehlgeschlagen: Ungültige Datei.') } }
      reader.readAsText(file)
    }
    input.click()
  }

  // Bulk‑Add
  const [bulkOpen, setBulkOpen] = useState(false)
  const bulkRef = useRef<HTMLTextAreaElement>(null)
  const doBulkAdd = () => {
    const raw = bulkRef.current?.value || ''
    const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
    lines.forEach(line => addTask(line))
    setBulkOpen(false); if (bulkRef.current) bulkRef.current.value = ''
  }

  // Templates
  const saveTemplate = () => {
    if (!activeList) return
    const name = prompt('Vorlagenname:')?.trim(); if (!name) return
    const tpl: Template = { id: newId(), name, tasks: activeList.tasks.map(t => ({ title: t.title, priority: t.priority, tags: t.tags })) }
    setState(s => ({ ...s, templates: [tpl, ...s.templates] }))
  }
  const newFromTemplate = (tplId: string) => {
    const tpl = state.templates.find(t => t.id === tplId); if (!tpl) return
    const l = newList(tpl.name)
    l.tasks = tpl.tasks.map(t => ({ id: newId(), title: t.title, checked: false, createdAt: Date.now(), priority: t.priority, tags: t.tags }))
    setState(s => ({ ...s, lists: [...s.lists, l], activeListId: l.id }))
  }

  // Filters
  const [query, setQuery] = useState('')
  const [priorityFilter, setPriorityFilter] = useState<Priority | 'any'>('any')
  const [onlyOpen, setOnlyOpen] = useState(false)
  const [tagFilter, setTagFilter] = useState<string | 'any'>('any')

  const allTags = useMemo(() => {
    const tags = new Set<string>()
    for (const t of activeList?.tasks || []) t.tags.forEach(x => tags.add(x))
    return Array.from(tags).sort()
  }, [activeList?.tasks])

  const filteredTasks = useMemo(() => {
    let tasks = activeList?.tasks || []
    if (query) tasks = tasks.filter(t => t.title.toLowerCase().includes(query.toLowerCase()))
    if (onlyOpen) tasks = tasks.filter(t => !t.checked)
    if (priorityFilter !== 'any') tasks = tasks.filter(t => t.priority === priorityFilter)
    if (tagFilter !== 'any') tasks = tasks.filter(t => t.tags.includes(tagFilter))
    return tasks
  }, [activeList?.tasks, query, onlyOpen, priorityFilter, tagFilter])

  const inputRef = useRef<HTMLInputElement>(null)
  const { total, completed, percent } = useMemo(() => (activeList ? progressOf(activeList) : { total: 0, completed: 0, percent: 0 }), [activeList])

  // Push UI
  const [pushStatus, setPushStatus] = useState<'idle'|'enabled'|'denied'|'error'>('idle')
  async function enablePush() {
    try {
      const perm = await askNotificationPermission()
      if (perm !== 'granted') { setPushStatus('denied'); return }
      // vite-plugin-pwa provides sw reg via navigator.serviceWorker
      const reg = await navigator.serviceWorker.ready
      const sub = await subscribePush(reg)
      // save to backend if user is logged in
      if (state.userId) {
        await fetch('/api/push-save-subscription', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: state.userId, endpoint: sub.endpoint, keys: sub.toJSON().keys })
        })
      }
      setPushStatus('enabled')
      alert('Push aktiviert.')
    } catch (e) {
      console.error(e); setPushStatus('error'); alert('Push konnte nicht aktiviert werden. Prüfe VAPID Schlüssel & HTTPS.')
    }
  }

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      {/* Header */}
      <header className="sticky top-0 z-10 backdrop-blur bg-neutral-950/70 border-b border-neutral-800">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-2xl bg-indigo-500" />
            <h1 className="text-xl sm:text-2xl font-semibold">Wiederkehrende To‑Do Listen</h1>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={exportJSON} className="px-3 py-1.5 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-sm">Export</button>
            <button onClick={importJSON} className="px-3 py-1.5 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-sm">Import</button>
            <button onClick={addList} className="px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-sm font-medium">+ Liste</button>
          </div>
        </div>

        {/* Tabs */}
        <div className="max-w-6xl mx-auto px-4 pb-3 overflow-x-auto">
          <div className="flex items-center gap-2">
            {state.lists.map(l => (
              <button key={l.id} onClick={() => setState(s => ({ ...s, activeListId: l.id }))}
                className={`px-3 py-2 rounded-2xl border text-sm whitespace-nowrap ${
                  l.id === activeList?.id ? 'bg-neutral-800 border-neutral-700' : 'bg-neutral-900 border-neutral-800 hover:bg-neutral-800'
                }`} title={`Modus: ${l.settings.mode}`}>
                {l.name}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-6xl mx-auto px-4 py-6 grid lg:grid-cols-3 gap-6">
        {/* List Panel */}
        <section className="lg:col-span-2 space-y-5">
          {activeList ? (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-2xl font-semibold">{activeList.name}</h2>
                  <p className="text-neutral-400 text-sm">{completed}/{total} erledigt · {percent}%</p>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => renameList(activeList.id)} className="px-3 py-1.5 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-sm">Umbenennen</button>
                  <button onClick={() => setBulkOpen(true)} className="px-3 py-1.5 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-sm">Bulk‑Add</button>
                  <button onClick={() => saveTemplate()} className="px-3 py-1.5 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-sm">Als Vorlage speichern</button>
                  <button onClick={() => resetNow(activeList.id)} className="px-3 py-1.5 rounded-xl bg-amber-600 hover:bg-amber-500 text-sm">Jetzt zurücksetzen</button>
                  <button onClick={() => deleteList(activeList.id)} className="px-3 py-1.5 rounded-xl bg-red-600 hover:bg-red-500 text-sm">Löschen</button>
                </div>
              </div>

              {/* Filters */}
              <div className="grid sm:grid-cols-5 gap-2">
                <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Suche…" className="sm:col-span-2 px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800 outline-none focus:ring-2 focus:ring-indigo-600"/>
                <select value={priorityFilter} onChange={e => setPriorityFilter(e.target.value as any)} className="px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800">
                  <option value="any">Priorität: alle</option>
                  <option value="high">hoch</option>
                  <option value="med">mittel</option>
                  <option value="low">niedrig</option>
                </select>
                <select value={tagFilter} onChange={e => setTagFilter(e.target.value as any)} className="px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800">
                  <option value="any">Tag: alle</option>
                  {allTags.map(t => <option key={t} value={t}>#{t}</option>)}
                </select>
                <label className="inline-flex items-center gap-2 text-sm px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800">
                  <input type="checkbox" checked={onlyOpen} onChange={e => setOnlyOpen(e.target.checked)} className="size-4 accent-indigo-500" />
                  nur offen
                </label>
              </div>

              {/* Progress */}
              <div className="w-full h-3 bg-neutral-900 rounded-xl overflow-hidden border border-neutral-800">
                <div className="h-full bg-indigo-500" style={{ width: `${percent}%` }} />
              </div>

              {/* Add input */}
              <div className="flex items-center gap-2">
                <input ref={inputRef} type="text" placeholder="Neue Aufgabe… (Enter). Tags mit #, Priorität mit !low/!med/!high"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const v = (e.target as HTMLInputElement).value.trim()
                      if (v) { addTask(v); (e.target as HTMLInputElement).value = '' }
                    }
                  }} className="flex-1 px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800 outline-none focus:ring-2 focus:ring-indigo-600" />
                <button onClick={() => { const v = inputRef.current?.value.trim(); if (v) { addTask(v); if (inputRef.current) inputRef.current.value='' } }} className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500">Hinzufügen</button>
              </div>

              {/* Task list */}
              <ul className="space-y-2">
                {filteredTasks.length === 0 && (<li className="text-neutral-500 text-sm">Keine Aufgaben für diesen Filter.</li>)}
                {filteredTasks.map(task => (
                  <li key={task.id} className="flex items-center gap-3 p-2 rounded-xl bg-neutral-900 border border-neutral-800">
                    <input type="checkbox" checked={task.checked} onChange={() => toggleTask(activeList.id, task.id)} className="size-5 accent-indigo-500" />
                    <div className="flex-1">
                      <div className={`text-sm ${task.checked ? 'line-through text-neutral-500' : ''}`}>{task.title}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-neutral-400">
                        <span className="px-2 py-0.5 rounded-full border border-neutral-700">{task.priority}</span>
                        {task.tags.map(t => <span key={t} className="px-2 py-0.5 rounded-full border border-neutral-700">#{t}</span>)}
                      </div>
                    </div>
                    <button onClick={() => removeTask(activeList.id, task.id)} className="text-neutral-400 hover:text-red-400 text-sm">Entfernen</button>
                  </li>
                ))}
              </ul>

              {/* Bulk Add Modal */}
              {bulkOpen && (
                <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4">
                  <div className="w-full max-w-xl p-4 rounded-2xl bg-neutral-950 border border-neutral-800">
                    <h3 className="text-lg font-semibold mb-2">Bulk‑Add</h3>
                    <p className="text-sm text-neutral-400 mb-2">Eine Aufgabe pro Zeile. Tags mit <code>#tag</code>, Priorität mit <code>!low/!med/!high</code>.</p>
                    <textarea ref={bulkRef} rows={10} className="w-full px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-800 outline-none"></textarea>
                    <div className="mt-3 flex justify-end gap-2">
                      <button onClick={() => setBulkOpen(false)} className="px-3 py-1.5 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-sm">Abbrechen</button>
                      <button onClick={doBulkAdd} className="px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-sm">Hinzufügen</button>
                    </div>
                  </div>
                </div>
              )}
            </>
          ) : (<div className="text-neutral-400">Keine Liste ausgewählt.</div>)}
        </section>

        {/* Settings & Archive & Templates */}
        {activeList && (
          <aside className="space-y-6">
            {/* Settings */}
            <div className="p-4 rounded-2xl bg-neutral-900 border border-neutral-800">
              <h3 className="text-lg font-semibold mb-3">Listen‑Einstellungen</h3>
              <label className="block text-sm mb-1">Modus</label>
              <select value={activeList.settings.mode} onChange={(e) => setSettings(activeList.id, { mode: e.target.value as RepeatMode })}
                className="w-full mb-3 px-3 py-2 rounded-xl bg-neutral-950 border border-neutral-800">
                <option value="once">Einmalig</option>
                <option value="daily">Täglich</option>
                <option value="weekly">Wöchentlich</option>
                <option value="monthly">Monatlich</option>
              </select>

              {activeList.settings.mode !== 'once' && (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm mb-1">Reset‑Stunde</label>
                      <input type="number" min={0} max={23} value={activeList.settings.resetHour}
                        onChange={(e) => setSettings(activeList.id, { resetHour: Number(e.target.value) })}
                        className="w-full px-3 py-2 rounded-xl bg-neutral-950 border border-neutral-800" />
                    </div>
                    <div>
                      <label className="block text-sm mb-1">Reset‑Minute</label>
                      <input type="number" min={0} max={59} value={activeList.settings.resetMinute}
                        onChange={(e) => setSettings(activeList.id, { resetMinute: Number(e.target.value) })}
                        className="w-full px-3 py-2 rounded-xl bg-neutral-950 border border-neutral-800" />
                    </div>
                  </div>
                  {activeList.settings.mode === 'weekly' && (
                    <div>
                      <label className="block text-sm mb-1">Wochentag</label>
                      <select value={activeList.settings.resetWeekday} onChange={(e) => setSettings(activeList.id, { resetWeekday: Number(e.target.value) })}
                        className="w-full px-3 py-2 rounded-xl bg-neutral-950 border border-neutral-800">
                        <option value={1}>Montag</option><option value={2}>Dienstag</option><option value={3}>Mittwoch</option><option value={4}>Donnerstag</option><option value={5}>Freitag</option><option value={6}>Samstag</option><option value={0}>Sonntag</option>
                      </select>
                    </div>
                  )}
                  {activeList.settings.mode === 'monthly' && (
                    <div>
                      <label className="block text-sm mb-1">Tag im Monat</label>
                      <input type="number" min={1} max={31} value={activeList.settings.resetDayOfMonth}
                        onChange={(e) => setSettings(activeList.id, { resetDayOfMonth: Number(e.target.value) })}
                        className="w-full px-3 py-2 rounded-xl bg-neutral-950 border border-neutral-800" />
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <input id="carry" type="checkbox" checked={activeList.settings.carryOver}
                      onChange={(e) => setSettings(activeList.id, { carryOver: e.target.checked })}
                      className="size-4 accent-indigo-500" />
                    <label htmlFor="carry" className="text-sm">Unerledigte Aufgaben in neue Instanz übernehmen</label>
                  </div>
                </div>
              )}

              <div className="mt-3 text-xs text-neutral-500">Zeitzone: Systemzeit. Resets alle 30 Sekunden geprüft.</div>
            </div>

            {/* Templates */}
            <div className="p-4 rounded-2xl bg-neutral-900 border border-neutral-800">
              <h3 className="text-lg font-semibold mb-3">Vorlagen</h3>
              {state.templates.length === 0 ? (
                <p className="text-sm text-neutral-500">Noch keine Vorlagen. Speichere oben eine aus der aktuellen Liste.</p>
              ) : (
                <ul className="space-y-2">
                  {state.templates.map(t => (
                    <li key={t.id} className="flex items-center justify-between p-2 rounded-xl bg-neutral-950 border border-neutral-800">
                      <div className="text-sm">{t.name}</div>
                      <button onClick={() => newFromTemplate(t.id)} className="px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-sm">Neue Liste aus Vorlage</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Archive */}
            <div className="p-4 rounded-2xl bg-neutral-900 border border-neutral-800">
              <h3 className="text-lg font-semibold mb-3">Archiv</h3>
              {state.snapshots.filter(s => s.listId === activeList.id).length === 0 ? (
                <p className="text-sm text-neutral-500">Noch keine Einträge. Nutze „Jetzt zurücksetzen" oder warte auf den geplanten Reset.</p>
              ) : (
                <ul className="space-y-2 max-h-80 overflow-y-auto pr-1">
                  {state.snapshots.filter(s => s.listId === activeList.id).sort((a,b)=>b.endedAt-a.endedAt).map(s => (
                    <li key={s.id} className="p-2 rounded-xl bg-neutral-950 border border-neutral-800">
                      <div className="flex items-center justify-between">
                        <div className="text-sm font-medium">{new Date(s.startedAt).toLocaleString()} → {new Date(s.endedAt).toLocaleString()}</div>
                        <div className="text-sm text-neutral-400">{s.completed}/{s.total} · {s.percent}%</div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Account & Push */}
            <div className="p-4 rounded-2xl bg-neutral-900 border border-neutral-800">
              <h3 className="text-lg font-semibold mb-3">Konto & Benachrichtigungen</h3>
              {supabaseAvailable() ? (
                state.userId ? (
                  <p className="text-sm text-neutral-400 mb-2">Eingeloggt als <span className="text-neutral-200">{state.userEmail || state.userId}</span></p>
                ) : (
                  <div className="flex gap-2 items-center mb-2">
                    <input value={email} onChange={e=>setEmail(e.target.value)} placeholder="E‑Mail für Magic Link" className="flex-1 px-3 py-2 rounded-xl bg-neutral-950 border border-neutral-800" />
                    <button onClick={signInMagic} disabled={authInfo.loading} className="px-3 py-1.5 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-sm">{authInfo.loading?'Sende…':'Magic Link'}</button>
                  </div>
                )
              ) : (
                <p className="text-sm text-neutral-500 mb-2">Supabase nicht konfiguriert. Fülle <code>.env.local</code> aus.</p>
              )}
              <div className="flex items-center gap-2">
                <button onClick={enablePush} className="px-3 py-1.5 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-sm">Push aktivieren</button>
                <span className="text-xs text-neutral-500">Status: {pushStatus}</span>
              </div>
              <p className="text-xs text-neutral-500 mt-2">iPhone: Füge die App über „Zum Home‑Bildschirm“ hinzu. Siri‑Kurzbefehle: Erstelle in der Kurzbefehle‑App einen Befehl, der die URL <code>{window.location.origin}/?intent=add&list=Inbox&task=Milch%20#einkauf%20!high</code> öffnet.</p>
            </div>
          </aside>
        )}
      </main>

      {/* Footer */}
      <footer className="max-w-6xl mx-auto px-4 pb-8 text-xs text-neutral-500">
        <div className="flex items-center justify-between">
          <span>PWA offline‑fähig · Export/Import · Templates · Tags/Prios · optionaler Cloud‑Sync</span>
          <span>Pro</span>
        </div>
      </footer>
    </div>
  )
}
