import React, { useEffect, useMemo, useRef, useState } from 'react'
import { supabase, supabaseAvailable } from './supabaseClient'

type Task = { id:string; title:string; checked:boolean; createdAt:number; tags:string[]; dueAt?:number }
type RepeatMode = 'once' | 'daily' | 'weekly' | 'monthly'
type ListSettings = { mode:RepeatMode; resetHour:number; resetMinute:number; resetWeekday:number; resetDayOfMonth:number; carryOver:boolean }
type List = { id:string; name:string; createdAt:number; lastResetAt?:number; tasks:Task[]; settings:ListSettings; pinned?:boolean }
type Snapshot = { id:string; listId:string; listName:string; endedAt:number; total:number; completed:number; percent:number }
type AppState = { lists:List[]; snapshots:Snapshot[]; templates:{id:string;name:string;titles:string[]}[]; activeListId?:string; version:number; archiveRetentionDays:number; theme:{ primary:string } }
type Route = { name:'start' } | { name:'lists' } | { name:'new' } | { name:'list', id:string } | { name:'archive' } | { name:'account' } | { name:'shortcuts' }

const STORAGE_KEY='what_to_do_state_v1'
const newId=()=> Math.random().toString(36).slice(2)+Date.now().toString(36)
const defaultSettings=():ListSettings=>({mode:'once',resetHour:5,resetMinute:0,resetWeekday:1,resetDayOfMonth:1,carryOver:true})

function parseTags(title:string){ const tags:string[]=[]; for(const m of title.matchAll(/#([\p{L}0-9_-]+)/gu)){ tags.push(m[1].toLowerCase()) } return tags }
function stripTags(title:string){ return title.replace(/#[\p{L}0-9_-]+/gu,'').trim() }
function progress(list:List){ const total=list.tasks.length; const completed=list.tasks.filter(t=>t.checked).length; return { total, completed, percent: total? Math.round(completed/total*100):0 } }
function atTime(base:Date,h:number,m:number){ const d=new Date(base); d.setHours(h,m,0,0); return d }
function clamp(y:number,m:number,d:number){ return Math.min(d,new Date(y,m+1,0).getDate()) }
function mostRecent(now:Date,s:ListSettings){ if(s.mode==='once') return null; if(s.mode==='daily'){ let t=atTime(now,s.resetHour,s.resetMinute); if(t>now){ const y=new Date(t); y.setDate(y.getDate()-1); return y } return t } if(s.mode==='weekly'){ const d=new Date(now); const diff=(d.getDay()-s.resetWeekday+7)%7; d.setDate(d.getDate()-diff); d.setHours(s.resetHour,s.resetMinute,0,0); if(d>now) d.setDate(d.getDate()-7); return d } if(s.mode==='monthly'){ const y=now.getFullYear(); const m=now.getMonth(); let day=clamp(y,m,s.resetDayOfMonth); let dt=new Date(y,m,day,s.resetHour,s.resetMinute,0,0); if(dt>now){ const pm=(m-1+12)%12; const py=pm===11?y-1:y; day=clamp(py,pm,s.resetDayOfMonth); dt=new Date(py,pm,day,s.resetHour,s.resetMinute,0,0)} return dt } return null }

function routeFromHash():Route{
  const h = location.hash.replace(/^#\/?/,'')
  if(!h) return {name:'start'}
  const [a,b] = h.split('/')
  if(a==='lists' && b) return {name:'list', id:b}
  if(a==='lists') return {name:'lists'}
  if(a==='new') return {name:'new'}
  if(a==='archive') return {name:'archive'}
  if(a==='account') return {name:'account'}
  if(a==='shortcuts') return {name:'shortcuts'}
  if(a==='start') return {name:'start'}
  return {name:'start'}
}
function pushRoute(r:Route){ const h = r.name==='list'? `#/lists/${r.id}` : `#/${r.name}`; if(location.hash!==h) location.hash=h }

export default function App(){
  const [state,setState]=useState<AppState>(()=>{
    const raw=localStorage.getItem(STORAGE_KEY)
    if(raw){ try{ const s=JSON.parse(raw); s.lists?.forEach((l:any)=> l.tasks?.forEach((t:any)=> delete t.priority)); if(typeof s.archiveRetentionDays !== 'number') s.archiveRetentionDays = 30; s.theme = s.theme || { primary:'#B3D5FF' }; return s }catch{} }
    const l:List={ id:newId(), name:'Meine erste Liste', createdAt:Date.now(), tasks:[], settings: defaultSettings(), lastResetAt: Date.now() }
    return { lists:[l], snapshots:[], templates:[], activeListId:l.id, version:2, archiveRetentionDays:30, theme:{ primary:'#B3D5FF' } }
  })
  const [route,setRoute]=useState<Route>(routeFromHash())

  // Startscreen vs Resume
  useEffect(()=>{
    const resumed = sessionStorage.getItem('resume')==='1'
    if(!resumed){ pushRoute({name:'start'}) }
    sessionStorage.setItem('resume','1')
  },[])

  useEffect(()=>{ const onHash=()=> setRoute(routeFromHash()); window.addEventListener('hashchange', onHash); return ()=> window.removeEventListener('hashchange', onHash) },[])
  useEffect(()=>{ localStorage.setItem(STORAGE_KEY, JSON.stringify(state)) },[state])

  // Auto-purge archive
  useEffect(()=>{
    const now = Date.now()
    const keepMs = (state.archiveRetentionDays<=0? Infinity : state.archiveRetentionDays*24*60*60*1000)
    setState(s=>({...s, snapshots: s.snapshots.filter(sn=> now - sn.endedAt <= keepMs ) }))
  },[state.archiveRetentionDays])

  // Reset scheduler -> archive snapshots
  useEffect(()=>{
    const tick=()=> setState(prev=>{
      const now=new Date(); let changed=false; const newSnaps:Snapshot[]=[]
      const lists = prev.lists.map(l=>{
        const m=mostRecent(now,l.settings); if(!m) return l
        const last=new Date(l.lastResetAt??l.createdAt)
        if(last<m){
          changed=true
          const { total, completed, percent } = progress(l)
          newSnaps.push({ id:newId(), listId:l.id, listName:l.name, endedAt:Date.now(), total, completed, percent })
          const carry = l.settings.carryOver
          const newTasks = carry ? l.tasks.filter(t=>!t.checked).map(t=>({...t, checked:false})) : []
          return {...l, tasks: newTasks, lastResetAt: Date.now()}
        }
        return l
      })
      if(!changed) return prev
      return {...prev, lists, snapshots: [...newSnaps, ...prev.snapshots]}
    })
    tick(); const id=setInterval(tick, 30000); return ()=>clearInterval(id)
  },[])

  const active = useMemo(()=> state.lists.find(l=>l.id===state.activeListId) ?? state.lists[0], [state])

  // Mutations
  const addList=(name:string)=> setState(s=>{ const l:List={id:Math.random().toString(36).slice(2)+Date.now().toString(36),name,createdAt:Date.now(),tasks:[],settings:defaultSettings(), lastResetAt: Date.now()}; return {...s,lists:[l,...s.lists],activeListId:l.id} })
  const renameList=(id:string,name:string)=> setState(s=>({...s,lists:s.lists.map(l=> l.id===id?{...l,name}:l)}))
  const deleteList=(id:string)=> setState(s=>{ const lists=s.lists.filter(l=>l.id!==id); const activeId=lists[0]?.id; return {...s,lists,activeListId:activeId} })
  const setSettings=(id:string,patch:Partial<ListSettings>)=> setState(s=>({...s,lists:s.lists.map(l=> l.id===id?{...l,settings:{...l.settings,...patch}}:l)}))
  const togglePin=(id:string)=> setState(s=>({...s,lists:s.lists.map(l=> l.id===id?{...l,pinned:!l.pinned}:l)}))

  function parseTags(title:string){ const tags:string[]=[]; for(const m of title.matchAll(/#([\p{L}0-9_-]+)/gu)){ tags.push(m[1].toLowerCase()) } return tags }
  function stripTags(title:string){ return title.replace(/#[\p{L}0-9_-]+/gu,'').trim() }
  const addTask=(listId:string,title:string)=> setState(s=>({...s, lists: s.lists.map(l=> l.id!==listId? l : {...l, tasks: [{ id:Math.random().toString(36).slice(2)+Date.now().toString(36), title: stripTags(title), tags: parseTags(title), checked:false, createdAt: Date.now() }, ...l.tasks ] } ) }))
  const toggleTask=(listId:string,taskId:string)=> setState(s=>({...s, lists: s.lists.map(l=> l.id!==listId? l : {...l, tasks: l.tasks.map(t=> t.id===taskId? {...t, checked:!t.checked}:t) } ) }))
  const removeTask=(listId:string,taskId:string)=> setState(s=>({...s, lists: s.lists.map(l=> l.id!==listId? l : {...l, tasks: l.tasks.filter(t=> t.id!==taskId) } ) }))
  const endList=(id:string)=>{ const l=state.lists.find(x=>x.id===id); if(!l) return; const total=l.tasks.length, completed=l.tasks.filter(t=>t.checked).length, percent= total? Math.round(completed/total*100):0; const snap:Snapshot={id:Math.random().toString(36).slice(2)+Date.now().toString(36),listId:l.id,listName:l.name,endedAt:Date.now(),total,completed,percent}; setState(s=>({...s, snapshots:[snap, ...s.snapshots], lists: s.lists.map(x=> x.id===id? {...x, tasks:[], lastResetAt: Date.now()}: x) })); alert('Liste beendet und ins Archiv verschoben.'); }
  const deleteSnapshot=(id:string)=> setState(s=>({...s, snapshots: s.snapshots.filter(sn=> sn.id!==id) }))

  // UI Components
  const Header = ({children}:{children?:React.ReactNode}) => (
    <header className="sticky top-0 z-10 bg-baby-100/80 backdrop-blur border-b border-baby-200">
      <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <img src="/logo.svg" className="w-9 h-9" alt="Logo"/>
          <h1 className="text-2xl font-bold tracking-tight text-baby-900">What To Do</h1>
        </div>
        <AppMenu />
      </div>
      {children}
    </header>
  )

  function AppMenu(){
    const [open,setOpen]=useState(false)
    return <div className="relative">
      <button aria-label="Menu" className="btn btn-ghost" onClick={()=>setOpen(v=>!v)}>☰</button>
      {open && <div className="absolute right-0 mt-2 w-56 menu p-2" onMouseLeave={()=>setOpen(false)}>
        <button className="btn btn-ghost w-full text-left" onClick={()=>{ setOpen(false); pushRoute({name:'new'}) }}>Neue Liste</button>
        <button className="btn btn-ghost w-full text-left" onClick={()=>{ setOpen(false); pushRoute({name:'lists'}) }}>Meine Listen</button>
        <button className="btn btn-ghost w-full text-left" onClick={()=>{ setOpen(false); pushRoute({name:'archive'}) }}>Archiv</button>
        <button className="btn btn-ghost w-full text-left" onClick={()=>{ setOpen(false); pushRoute({name:'account'}) }}>Mein Account</button>
        <hr className="my-1"/>
        <button className="btn btn-ghost w-full text-left" onClick={()=>{ setOpen(false); exportState(state) }}>Export</button>
        <label className="btn btn-ghost w-full text-left cursor-pointer">
          Import
          <input type="file" accept=".json,application/json" hidden onChange={e=>importState(e,setState)} />
        </label>
      </div>}
    </div>
  }

  // Pages (Start, Lists, New, ListDetail, Archive, Account, Shortcuts)
  const Start = () => (<div className="min-h-screen bg-gradient-to-b from-baby-100 to-white"><div className="max-w-3xl mx-auto px-6 pt-24 pb-16 text-center"><img src="/logo.svg" alt="Logo" className="w-24 h-24 mx-auto mb-6"/><h1 className="text-5xl font-extrabold text-baby-900 mb-2">What To Do</h1><p className="text-baby-800 mb-10">Deine einfachen, wiederkehrenden To‑Do Listen – schön & übersichtlich.</p><div className="grid sm:grid-cols-2 gap-4"><button onClick={()=>pushRoute({name:'new'})} className="btn btn-primary text-lg py-4">Neue Liste</button><button onClick={()=>pushRoute({name:'lists'})} className="btn btn-ghost text-lg py-4">Meine Listen</button></div></div></div>)

  const ListsPage = () => {
    const ordered = useMemo(()=>{ const pinned=state.lists.filter(l=>l.pinned); const others=state.lists.filter(l=>!l.pinned); return [...pinned,...others] },[state.lists])
    return <div className="min-h-screen"><Header/><main className="max-w-6xl mx-auto px-4 py-6 grid lg:grid-cols-[260px_1fr] gap-6"><aside className="hidden lg:block"><div className="card p-3"><div className="flex items-center justify-between mb-2"><h3 className="font-semibold">Meine Listen</h3><button className="btn btn-primary" onClick={()=>pushRoute({name:'new'})}>+ Neu</button></div><ul className="space-y-1">{ordered.map(l=>{ const {percent}=progress(l); return <li key={l.id}><button onClick={()=>{ setState(s=>({...s,activeListId:l.id})); pushRoute({name:'list', id:l.id}) }} className="w-full text-left px-3 py-2 rounded-lg hover:bg-baby-100">{l.name} <span className="text-xs text-baby-700">• {percent}%</span></button></li> })}</ul></div></aside><section className="space-y-4"><div className="flex items-center justify-between"><h2 className="text-xl font-semibold">Übersicht</h2><div className="flex gap-2"><button className="btn btn-ghost" onClick={()=>pushRoute({name:'archive'})}>Archiv</button><button className="btn btn-primary" onClick={()=>pushRoute({name:'new'})}>+ Neue Liste</button></div></div><div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">{ordered.map(l=>{ const {percent}=progress(l); return <div key={l.id} className="card p-4"><div className="flex items-start justify-between"><div><div className="font-semibold">{l.name}</div><div className="progress mt-2"><div className="progress-fill" style={{width:`${percent}%`}}/></div></div><button title={l.pinned?'Unpinnen':'Anheften'} onClick={()=>togglePin(l.id)} className="ml-3 text-baby-800">{l.pinned?'📌':'📍'}</button></div><div className="mt-3 flex gap-2"><button className="btn btn-primary" onClick={()=>{ setState(s=>({...s,activeListId:l.id})); pushRoute({name:'list', id:l.id}) }}>Öffnen</button><button className="btn btn-ghost" onClick={()=>{ const name=prompt('Neuer Name:', l.name)||l.name; renameList(l.id, name) }}>Umbenennen</button><button className="btn btn-ghost" onClick={()=> endList(l.id)}>Beenden</button></div></div> })}</div></section></main></div>
  }

  const NewListPage = () => { const [name,setName]=useState('Neue Liste'); return <div className="min-h-screen"><Header/><main className="max-w-5xl mx-auto px-4 py-6"><h2 className="text-xl font-semibold mb-3">Neue Liste</h2><div className="card p-4 mb-4"><label className="block text-sm mb-1">Name</label><input className="input" value={name} onChange={e=>setName(e.target.value)} placeholder="Listentitel"/></div><div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4"><div className="card p-4 flex flex-col"><div className="font-semibold mb-2">Leere Liste</div><button className="btn btn-primary" onClick={()=>{ addList(name||'Neue Liste'); pushRoute({name:'lists'}) }}>Erstellen</button></div>{state.templates.length>0 && state.templates.map(t=>(<div key={t.id} className="card p-4"><div className="font-semibold mb-2">{t.name}</div><button className="btn btn-ghost" onClick={()=>{ addList(name||t.name); pushRoute({name:'lists'}) }}>Als Vorlage</button><div className="text-xs text-baby-700 mt-2">{t.titles.length} Aufgaben</div></div>))}</div></main></div> }

  const ListDetail = ({id}:{id:string}) => { const list=state.lists.find(l=>l.id===id); const [q,setQ]=useState(''); const inputRef=useRef<HTMLInputElement>(null); if(!list) return <div className="p-6">Liste nicht gefunden.</div>; const {total,completed,percent}=progress(list); const visible=list.tasks.filter(t=> t.title.toLowerCase().includes(q.toLowerCase())); return <div className="min-h-screen"><Header><div className="border-t border-baby-200"><div className="max-w-6xl mx-auto px-4 py-3"><div className="progress"><div className="progress-fill" style={{width:`${percent}%`}}/></div><div className="text-sm text-baby-800 mt-1">{completed}/{total} erledigt ({percent}%)</div></div></div></Header><main className="max-w-6xl mx-auto px-4 py-6 grid lg:grid-cols-[260px_1fr] gap-6"><aside className="hidden lg:block"><div className="card p-3"><div className="flex items-center justify-between mb-2"><h3 className="font-semibold">Meine Listen</h3><button className="btn btn-primary" onClick={()=>pushRoute({name:'new'})}>+ Neu</button></div><ul className="space-y-1">{state.lists.map(l=>(<li key={l.id}><button onClick={()=>{ setState(s=>({...s,activeListId:l.id})); pushRoute({name:'list', id:l.id}) }} className={`w-full text-left px-3 py-2 rounded-lg hover:bg-baby-100 ${l.id===list.id?'bg-baby-100':''}`}>{l.name}</button></li>))}</ul></div><div className="card p-3 mt-4"><h4 className="font-semibold mb-2">Einstellungen</h4><label className="block text-sm mb-1">Modus</label><select className="input" value={list.settings.mode} onChange={e=>setSettings(list.id,{mode:e.target.value as RepeatMode})}><option value="once">Einmalig</option><option value="daily">Täglich</option><option value="weekly">Wöchentlich</option><option value="monthly">Monatlich</option></select>{list.settings.mode!=='once' && <><div className="grid grid-cols-2 gap-2 mt-2"><div><label className="block text-sm mb-1">Stunde</label><input type="number" min={0} max={23} className="input" value={list.settings.resetHour} onChange={e=>setSettings(list.id,{resetHour:Number(e.target.value)})}/></div><div><label className="block text-sm mb-1">Minute</label><input type="number" min={0} max={59} className="input" value={list.settings.resetMinute} onChange={e=>setSettings(list.id,{resetMinute:Number(e.target.value)})}/></div></div>{list.settings.mode==='weekly' && <div className="mt-2"><label className="block text-sm mb-1">Wochentag</label><select className="input" value={list.settings.resetWeekday} onChange={e=>setSettings(list.id,{resetWeekday:Number(e.target.value)})}><option value={1}>Mo</option><option value={2}>Di</option><option value={3}>Mi</option><option value={4}>Do</option><option value={5}>Fr</option><option value={6}>Sa</option><option value={0}>So</option></select></div>}{list.settings.mode==='monthly' && <div className="mt-2"><label className="block text-sm mb-1">Tag</label><input type="number" min={1} max={31} className="input" value={list.settings.resetDayOfMonth} onChange={e=>setSettings(list.id,{resetDayOfMonth:Number(e.target.value)})}/></div>}<label className="mt-2 inline-flex items-center gap-2 text-sm"><input type="checkbox" checked={list.settings.carryOver} onChange={e=>setSettings(list.id,{carryOver:e.target.checked})}/> Unerledigte übernehmen</label></>}<hr className="my-3"/><button className="btn btn-ghost w-full" onClick={()=>endList(list.id)}>Beenden (ins Archiv)</button><button className="btn btn-ghost w-full" onClick={()=>{ setState(s=>({...s,lists:s.lists.map(l=> l.id===list.id?{...l,pinned:!l.pinned}:l)})) }}>{list.pinned?'Unpinnen':'Anheften'}</button><button className="btn btn-ghost w-full" onClick={()=>{ const name=prompt('Neuer Name:', list.name)||list.name; renameList(list.id,name) }}>Umbenennen</button><button className="btn btn-ghost w-full" onClick={()=>{ if(confirm('Liste löschen?')) deleteList(list.id) }}>Löschen</button></div></aside><section><div className="card p-4"><div className="flex items-center gap-2"><input ref={inputRef} className="input" placeholder="Neue Aufgaben" onKeyDown={e=>{ if(e.key==='Enter'){ const v=(e.target as HTMLInputElement).value.trim(); if(v){ addTask(list.id, v); (e.target as HTMLInputElement).value='' } } }} /><button className="btn btn-primary" onClick={()=>{ const v=inputRef.current?.value.trim(); if(v){ addTask(list.id, v); if(inputRef.current) inputRef.current.value='' }}}>Hinzufügen</button></div><div className="flex items-center gap-2 mt-3"><input className="input" placeholder="Suche…" value={q} onChange={e=>setQ(e.target.value)}/></div></div><ul className="mt-4 space-y-2">{visible.length===0 && <li className="text-baby-800 text-sm">Keine Aufgaben für diesen Filter.</li>}{visible.map(t=> (<li key={t.id} className="card p-3 flex items-center gap-3"><input type="checkbox" className="w-5 h-5" checked={t.checked} onChange={()=>toggleTask(list.id, t.id)}/><div className="flex-1"><div className={`text-sm ${t.checked?'line-through text-baby-700':''}`}>{t.title}</div><div className="mt-1 flex flex-wrap gap-1">{t.tags.map(tag=> <span key={tag} className="badge">#{tag}</span>)}</div></div><button className="text-baby-700 hover:text-red-600" onClick={()=>removeTask(list.id, t.id)}>Entfernen</button></li>))}</ul></section></main></div> }

  const ArchivePage = () => (<div className="min-h-screen"><Header/><main className="max-w-4xl mx-auto px-4 py-6"><div className="flex items-center justify-between mb-4"><h2 className="text-xl font-semibold">Archiv</h2><div className="flex items-center gap-3"><label className="text-sm">Autom. Löschen nach</label><select className="input w-auto" value={state.archiveRetentionDays} onChange={e=>setState(s=>({...s,archiveRetentionDays:Number(e.target.value)}))}><option value={0}>Nie</option><option value={7}>7 Tagen</option><option value={30}>30 Tagen</option><option value={90}>90 Tagen</option></select></div></div><ul className="space-y-2">{state.snapshots.length===0 && <li className="text-baby-800 text-sm">Keine Einträge.</li>}{state.snapshots.map(sn=> (<li key={sn.id} className="card p-3 flex items-center justify-between"><div><div className="font-medium">{sn.listName}</div><div className="text-sm text-baby-800">{new Date(sn.endedAt).toLocaleString()} · {sn.completed}/{sn.total} · {sn.percent}%</div></div><div className="flex items-center gap-2"><div className="w-40 progress"><div className="progress-fill" style={{width:`${sn.percent}%`}}/></div><button className="btn btn-ghost" onClick={()=>deleteSnapshot(sn.id)}>Löschen</button></div></li>))}</ul></main></div>)

  const AccountPage = () => { const [pushStatus,setPushStatus]=useState<'idle'|'enabled'|'denied'|'error'>('idle'); async function enablePush(){ try{ if(!('Notification' in window)) { alert('Keine Notifications verfügbar.'); return } const perm = await Notification.requestPermission(); if(perm!=='granted'){ setPushStatus('denied'); return } const reg = await navigator.serviceWorker.ready; await reg.pushManager.subscribe({ userVisibleOnly:true, applicationServerKey: new Uint8Array([]) }); setPushStatus('enabled'); alert('Push aktiviert (Demo – VAPID Key im Build nachrüsten).') }catch{ setPushStatus('error'); alert('Push fehlgeschlagen') } } async function disablePush(){ try{ const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription(); if(sub) await sub.unsubscribe(); setPushStatus('idle'); alert('Push deaktiviert.') }catch{ alert('Konnte Push nicht deaktivieren') } } return <div className="min-h-screen"><Header/><main className="max-w-3xl mx-auto px-4 py-6"><h2 className="text-xl font-semibold mb-3">Mein Account</h2>{supabaseAvailable()? <p className="text-sm text-baby-900 mb-2">Supabase ist konfiguriert. (Login/Team kannst du später ergänzen.)</p> : <p className="text-sm text-baby-800 mb-2">Supabase ist nicht konfiguriert.</p>}<div className="card p-4 space-y-2"><div className="font-medium">Benachrichtigungen</div><div className="flex gap-2"><button className="btn btn-primary" onClick={enablePush}>Push aktivieren</button><button className="btn btn-ghost" onClick={disablePush}>Push deaktivieren</button><span className="text-sm text-baby-800 self-center">Status: {pushStatus}</span></div></div><div className="card p-4 mt-4"><div className="font-medium mb-2">Branding</div><p className="text-sm text-baby-800">Feste Gestaltung: Babyblau + grüner Haken (Logo). Dark/Light‑Umschalter nicht aktiv.</p></div><div className="card p-4 mt-4"><div className="font-medium mb-2">Siri Kurzbefehle</div><p className="text-sm text-baby-800 mb-2">1) Öffne diese App als PWA. 2) In Safari „Zum Home‑Bildschirm“. 3) In der Kurzbefehle‑App: „Webseite öffnen“ → URL deiner App → als Kurzbefehl sichern. 4) Optional: „Text diktieren“ & an /#/lists übergeben.</p><a className="btn btn-ghost inline-block" href="#/shortcuts">Anleitung & Beispiele</a></div></main></div> }

  const ShortcutsPage = () => (<div className="min-h-screen"><Header/><main className="max-w-3xl mx-auto px-4 py-6 space-y-4"><h2 className="text-xl font-semibold">Siri Kurzbefehle</h2><ol className="list-decimal ml-6 space-y-2 text-baby-900"><li>PWA installieren: In Safari öffnen → Teilen → „Zum Home‑Bildschirm“.</li><li>Kurzbefehle‑App öffnen → Neuer Kurzbefehl → „Webseite öffnen“.</li><li>URL deiner App eintragen (z. B. <code>https://deine‑domain</code> oder lokal <code>http://localhost:5173</code>).</li><li>Optional: Als URL <code>https://…/#/lists</code> (Meine Listen) oder <code>https://…/#/new</code> verwenden.</li><li>Sprachtrigger vergeben („What To Do öffnen“).</li></ol></main></div>)

  function exportState(s:AppState){ const blob=new Blob([JSON.stringify(s,null,2)],{type:'application/json'}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download='what-to-do-export.json'; a.click(); URL.revokeObjectURL(url) }
  function importState(e:React.ChangeEvent<HTMLInputElement>, setter:React.Dispatch<React.SetStateAction<AppState>>){ const f=e.target.files?.[0]; if(!f) return; const r=new FileReader(); r.onload=()=>{ try{ const s=JSON.parse(String(r.result)); setter(s) }catch{ alert('Ungültige Datei') } }; r.readAsText(f) }

  if(route.name==='start') return <Start />
  if(route.name==='lists') return <ListsPage />
  if(route.name==='new') return <NewListPage />
  if(route.name==='archive') return <ArchivePage />
  if(route.name==='account') return <AccountPage />
  if(route.name==='shortcuts') return <ShortcutsPage />
  if(route.name==='list') return <ListDetail id={route.id}/>
  return <Start />
}
