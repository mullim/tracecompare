import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react'
import { Activity, ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpRight, Check, ChevronDown, CircleHelp, Cloud, Crosshair, Eye, EyeOff, FileUp, FolderOpen, GitCompare, GitFork, HeartPulse, Link2, LockKeyhole, Map, Plus, RotateCcw, SlidersHorizontal, Timer, Trash2, X } from 'lucide-react'
import type { User } from '@supabase/supabase-js'
import { average, compareMetric, gpsDifference, sampleAt, suggestOffset, totalDistance } from './compare'
import { cloud, deleteCloud, listCloud, openCloud, openPublic, publishCloud, revokeCloud, saveCloud, signIn, signOut, type CloudSet } from './cloud'
import { demo } from './demo'
import { openRecording } from './import'
import { blank, colors, displayValue, extent, maxRecordings, metricNames, metrics, metricUnit, signed, timeLabel, type Metric, type Project, type Range, type Recording, type Units, type Workspace } from './model'
import { download, localRestore, localSave, pack, publishedWorkspace, unpack } from './workspace'
import './style.css'

const RouteMap = lazy(() => import('./RouteMap').then(m => ({ default: m.RouteMap })))
const TelemetryChart = lazy(() => import('./Charts').then(m => ({ default: m.TelemetryChart })))
type Stream = Metric | 'powerCurve' | `dev:${string}`
type View = 'compare' | 'saved'
type Notice = { type: 'error' | 'success'; message: string }
type Modal = 'share' | 'account' | null
const requestedShare = new URLSearchParams(location.search).get('share')
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i

function message(error: unknown) {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : 'Something went wrong.'
}

function shareUrl(id: string) {
  const url = new URL(location.href)
  url.search = ''
  url.hash = ''
  url.searchParams.set('share', id)
  return url.href
}

function ModalPanel({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  return <dialog ref={dialog} onCancel={close} aria-label={title} className="modal">
    <header><h2>{title}</h2><button className="icon-button" type="button" onClick={close} aria-label="Close dialog"><X size={19} /></button></header>
    {children}
  </dialog>
}

export default function App() {
  const [workspace, setWorkspace] = useState<Workspace>(() => requestedShare ? blank() : demo())
  const [hydrated, setHydrated] = useState(false)
  const [publicError, setPublicError] = useState('')
  const [view, setView] = useState<View>('compare')
  const [units, setUnits] = useState<Units>('metric')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState(false)
  const [dropping, setDropping] = useState(false)
  const [stream, setStream] = useState<Stream>('hr')
  const [range, setRange] = useState<Range | null>(null)
  const [cursor, setCursor] = useState<number | null>(null)
  const [smoothing, setSmoothing] = useState(0)
  const [selectedLap, setSelectedLap] = useState<number | null>(null)
  const [showSecond, setShowSecond] = useState(false)
  const [user, setUser] = useState<User | null>(null)
  const [cloudId, setCloudId] = useState<string | null>(null)
  const [saved, setSaved] = useState<CloudSet[]>([])
  const [modal, setModal] = useState<Modal>(null)
  const [gpsInShare, setGpsInShare] = useState(false)
  const [link, setLink] = useState('')
  const [settings, setSettings] = useState(true)
  const [offsets, setOffsets] = useState<Array<{ id: string; offset: number; metric: Metric }> | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const importing = useRef(false)
  const { project, originals } = workspace
  const recordings = project.recordings
  const readOnly = Boolean(requestedShare)
  const visible = useMemo(() => recordings.filter(r => !r.hidden), [recordings])
  const reference = recordings.find(r => r.id === project.reference) ?? visible[0]
  const shift = reference?.offset ?? 0
  const lap = selectedLap === null ? undefined : reference?.laps[selectedLap]
  const lapRange = useMemo<Range | undefined>(() => lap ? [lap.start + shift * 1000, lap.end + shift * 1000] : undefined, [lap, shift])
  const bounds = useMemo(() => extent(visible), [visible])
  const gps = visible.some(r => r.samples.some(s => s.lat !== undefined && s.lon !== undefined))
  const example = recordings.length > 0 && recordings.every(r => r.source === 'Demo')
  const streams = useMemo<Stream[]>(() => [
    ...metrics.filter(key => visible.some(r => r.samples.some(p => p[key] !== undefined))),
    ...(visible.some(r => r.samples.some(p => p.power !== undefined)) ? ['powerCurve' as const] : []),
    ...[...new Set(visible.flatMap(r => r.samples.flatMap(p => Object.keys(p.developer ?? {}))))].slice(0, 24).map(k => `dev:${k}` as const),
  ], [visible])
  const chosen = streams.includes(stream) ? stream : streams[0]
  const secondary = streams.find(k => k !== chosen && k !== 'powerCurve' && !k.startsWith('dev:'))
  const showCloud = Boolean(user && cloud)
  const comparison = visible.find(r => r.id !== reference?.id)
  const gpsStats = useMemo(() => reference && comparison ? gpsDifference(reference, comparison) : null, [reference, comparison])
  const statistic = useMemo(() => (
    reference && chosen && metrics.includes(chosen as Metric)
      ? visible.map(r => compareMetric(reference, r, chosen as Metric))
      : []
  ), [reference, chosen, visible])
  const summaries = useMemo(() => chosen && metrics.includes(chosen as Metric) ? visible.map(r => average(r, chosen as Metric, lapRange ?? range ?? undefined)) : [], [visible, chosen, lapRange, range])

  useEffect(() => {
    let active = true
    const load = requestedShare
      ? uuid.test(requestedShare) ? openPublic(requestedShare) : Promise.reject(new Error('This comparison link is invalid.'))
      : localRestore()
    load.then(restored => { if (active && restored) setWorkspace(restored) })
      .catch(error => { if (active && requestedShare) setPublicError(message(error)) })
      .finally(() => { if (active) setHydrated(true) })
    return () => { active = false }
  }, [])
  useEffect(() => {
    if (!hydrated || readOnly) return
    const timeout = setTimeout(() => void localSave(workspace).catch(() => undefined), 250)
    return () => clearTimeout(timeout)
  }, [hydrated, readOnly, workspace])
  useEffect(() => {
    if (!cloud) return
    const { data: { subscription } } = cloud.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
      if (!session) { setCloudId(null); setSaved([]) }
    })
    return () => subscription.unsubscribe()
  }, [])

  const inform = (message: string, type: Notice['type'] = 'success') => setNotice({ type, message })
  const resetFocus = () => { setSelectedLap(null); setRange(null); setCursor(null); setOffsets(null) }
  const update = (fn: (p: Project) => Project) => setWorkspace(w => ({ ...w, project: fn(w.project) }))
  const setRecording = (id: string, fn: (r: Recording) => Recording) => update(p => ({ ...p, recordings: p.recordings.map(r => r.id === id ? fn(r) : r) }))
  const chartRange = useCallback((next: Range | null) => setRange(next), [])
  const chartCursor = useCallback((next: number | null) => setCursor(next), [])
  const switchWorkspace = (next: Workspace, id: string | null = null) => {
    setWorkspace(next); setCloudId(id); setView('compare'); setLink(''); resetFocus()
  }

  async function task(fn: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    setNotice(null)
    try { await fn() } catch (error) { inform(message(error), 'error') }
    finally { setBusy(false) }
  }

  async function files(input: FileList | File[]) {
    if (!input.length || importing.current) return
    importing.current = true
    await task(async () => {
      const incoming = Array.from(input)
      const signature = incoming.length === 1 ? new Uint8Array(await incoming[0].slice(0, 4).arrayBuffer()) : null
      const isArchive = signature?.[0] === 0x50 && signature[1] === 0x4b && signature[2] === 0x03 && signature[3] === 0x04
      if (incoming.length === 1 && (isArchive || /\.zip$/i.test(incoming[0].name))) {
        switchWorkspace(await unpack(new Uint8Array(await incoming[0].arrayBuffer())))
        inform('Project opened.')
        return
      }
      const base = example ? blank() : workspace
      const accepted = incoming.slice(0, Math.max(0, maxRecordings - base.project.recordings.length))
      const errors = incoming.length > accepted.length ? [`Up to ${maxRecordings} recordings per comparison.`] : []
      const added = []
      for (const file of accepted) {
        try { added.push(await openRecording(file)) }
        catch (error) { errors.push(`${file.name}: ${message(error)}`) }
      }
      if (added.length) {
        const used = new Set(base.project.recordings.map(r => r.color))
        const next = [...base.project.recordings]
        for (const { recording } of added) {
          const color = colors.find(c => !used.has(c)) ?? colors[next.length % colors.length]
          used.add(color)
          next.push({ ...recording, color, offset: 0 })
        }
        setWorkspace({
          project: { ...base.project, title: base.project.recordings.length ? base.project.title : 'Workout comparison', reference: base.project.reference || next[0].id, recordings: next },
          originals: [...base.originals, ...added.map(a => a.original)],
        })
        if (example) setCloudId(null)
        setView('compare')
        resetFocus()
      }
      if (errors.length) inform(errors.join(' '), 'error')
      else inform(`${added.length} recording${added.length === 1 ? '' : 's'} added.`)
    })
    importing.current = false
  }

  function onFiles(e: ChangeEvent<HTMLInputElement>) {
    if (e.currentTarget.files) void files(Array.from(e.currentTarget.files))
    e.currentTarget.value = ''
  }

  function toggleRecording(recording: Recording) {
    if (!recording.hidden && visible.length <= 1) return
    update(p => ({
      ...p,
      reference: !recording.hidden && p.reference === recording.id ? visible.find(r => r.id !== recording.id)?.id ?? '' : p.reference,
      recordings: p.recordings.map(r => r.id === recording.id ? { ...r, hidden: !r.hidden } : r),
    }))
    resetFocus()
  }

  function removeRecording(id: string) {
    const keep = recordings.filter(r => r.id !== id)
    setWorkspace({
      project: { ...project, recordings: keep, reference: project.reference === id ? (keep.find(r => !r.hidden) ?? keep[0])?.id ?? '' : project.reference },
      originals: originals.filter(o => o.id !== id),
    })
    resetFocus()
  }

  function editTitle(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const field = e.currentTarget.elements.namedItem('title')
    if (field instanceof HTMLInputElement) field.blur()
  }

  function autoAlign() {
    if (!reference) return
    const suggestions = visible.filter(r => r.id !== reference.id).flatMap(r => {
      const result = suggestOffset(reference, r)
      return result && result.offset !== r.offset ? [{ id: r.id, ...result }] : []
    })
    setOffsets(suggestions)
  }

  async function refreshSaved() {
    setSaved(await listCloud())
  }

  function savedView() {
    setView('saved')
    if (showCloud) void task(refreshSaved)
  }

  async function save() {
    if (!showCloud) { setModal('account'); return }
    await task(async () => {
      const id = await saveCloud(workspace, cloudId)
      setCloudId(id)
      inform('Comparison saved to your account.')
    })
  }

  async function makeLink() {
    await task(async () => {
      if (!visible.length) throw new Error('Show at least one recording to publish.')
      const id = await saveCloud(workspace, cloudId)
      setCloudId(id)
      const publicId = await publishCloud(publishedWorkspace(workspace, gpsInShare), id)
      setLink(shareUrl(publicId))
      inform('Public link created.')
    })
  }

  async function exportProject() {
    await task(async () => download(await pack(workspace), (project.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'comparison') + '.zip'))
  }

  const pretty = (metric: Metric, value?: number, digits = 1) => value === undefined ? '—' : `${displayValue(metric, value, units).toFixed(digits)} ${metricUnit(metric, units)}`
  const difference = reference && comparison ? (() => {
    const a = totalDistance(reference)
    const b = totalDistance(comparison)
    return a !== undefined && b !== undefined ? b - a : undefined
  })() : undefined

  return <>
    <header className="topbar">
      <div className="topbar-inner">
        <button className="brand" type="button" onClick={() => setView('compare')} aria-label="TraceCompare home">
          <span className="brand-icon"><Activity size={24} strokeWidth={2.4} /></span><strong>Trace<span>Compare</span></strong>
        </button>
        {!readOnly && <nav aria-label="Main navigation">
          <button type="button" className={view === 'compare' ? 'nav-active' : ''} onClick={() => setView('compare')}><GitCompare size={16} /> Compare</button>
          <button type="button" className={view === 'saved' ? 'nav-active' : ''} onClick={savedView}><FolderOpen size={17} /> Saved sets</button>
        </nav>}
        <div className="top-actions">
          <a href="https://github.com/mullim/tracecompare" target="_blank" rel="noreferrer" className="icon-button github" aria-label="GitHub source"><GitFork size={20} /></a>
          {!readOnly && <button type="button" className="button top-account" onClick={() => setModal('account')}>
            <Cloud size={17} />{user ? 'Account' : 'Sign in'}
          </button>}
          {readOnly && <a href={location.pathname} className="button top-account">New comparison <ArrowUpRight size={15} /></a>}
        </div>
      </div>
    </header>

    <main className="main">
      {notice && <div className={`notice ${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}>
        {notice.type === 'error' ? <CircleHelp size={18} /> : <Check size={18} />}<span>{notice.message}</span>
        <button type="button" className="icon-button" onClick={() => setNotice(null)} aria-label="Dismiss message"><X size={16} /></button>
      </div>}
      {readOnly && !hydrated ? <div className="card empty">Loading shared comparison…</div>
        : publicError ? <div className="card empty"><Link2 size={27} /><h1>Comparison unavailable</h1><p>{publicError}</p><a className="button primary" href={location.pathname}>Open TraceCompare</a></div>
        : view === 'saved' ? <section className="saved-page">
          <button type="button" className="plain back" onClick={() => setView('compare')}><ArrowLeft size={16} /> Back to comparison</button>
          <h1>Saved sets</h1>
          {!showCloud ? <div className="card empty"><Cloud size={30} /><h2>Take comparisons across devices</h2><p>Sign in to save your comparisons and create public links.</p><button className="button primary" type="button" onClick={() => setModal('account')}>Sign in</button></div>
            : <div className="card saved-list">{!saved.length ? <div className="empty"><FolderOpen size={28} /><h2>{busy ? 'Loading sets…' : 'No saved sets yet'}</h2><p>Use Save set on a comparison to add it here.</p></div>
              : saved.map(item => <div key={item.id} className="saved-row">
                <button type="button" className="plain saved-title" onClick={() => void task(async () => switchWorkspace(await openCloud(item.id), item.id))}><FolderOpen size={19} /><span><strong>{item.title}</strong><small>{new Date(item.updated_at).toLocaleDateString()} · {Math.max(1, Math.round(item.bytes / 1024))} KB</small></span></button>
                {item.share_id && <><a className="button small" href={shareUrl(item.share_id)} target="_blank" rel="noreferrer"><Link2 size={15} /> Open link</a>
                  <button type="button" className="button small" onClick={() => void task(async () => { await revokeCloud(item.id); await refreshSaved(); inform('Public link revoked.') })}>Revoke link</button></>}
                <button type="button" className="icon-button danger" aria-label={`Delete ${item.title}`} onClick={() => {
                  if (confirm(`Delete “${item.title}” from your account and revoke its link?`)) void task(async () => {
                    await deleteCloud(item.id); if (cloudId === item.id) setCloudId(null); await refreshSaved(); inform('Saved set deleted.')
                  })
                }}><Trash2 size={17} /></button>
              </div>)}
            </div>}
        </section>
        : <>
          <section className="page-heading">
            <div>
              <div className="eyebrow">{readOnly ? 'SHARED COMPARISON' : 'WORKOUT COMPARISON'}</div>
              {readOnly ? <h1>{project.title}</h1> : <form className="title-form" onSubmit={editTitle}>
                <input aria-label="Comparison title" name="title" value={project.title} maxLength={120} onChange={e => update(p => ({ ...p, title: e.target.value }))} />
              </form>}
              <div className="page-subtitle">
                {recordings.length ? <><span>{recordings.length} recording{recordings.length === 1 ? '' : 's'}</span><i /><span>{timeLabel((bounds[1] - bounds[0]) / 1000)} elapsed</span>{example && <><i /><span>Example data</span></>}</> : 'Compare recordings from the same workout.'}
              </div>
            </div>
            <div className="heading-actions">
              {recordings.length > 0 && <button type="button" className="button" disabled={busy} onClick={() => void exportProject()}><ArrowDownToLine size={17} /> Export</button>}
              {!readOnly && recordings.length > 0 && <>
                <button type="button" className="button" disabled={busy} onClick={() => void save()}><Cloud size={17} /> Save set</button>
                <button type="button" className="button primary" disabled={busy} onClick={() => { setLink(''); setGpsInShare(false); setModal(showCloud ? 'share' : 'account') }}><Link2 size={17} /> Share set</button>
              </>}
            </div>
          </section>
          <input type="file" multiple accept=".fit,.tcx,.gpx,.zip" ref={fileInput} onChange={onFiles} className="sr-only" tabIndex={-1} aria-label="Import comparison files" />
          <div className="layout">
            <aside className="sidebar" aria-label="Comparison settings">
              <section className="card recordings">
                <div className="card-header">
                  <div className="header-title"><Activity size={18} /><h2>Recordings</h2><span className="count">{recordings.length}</span></div>
                  {!readOnly && recordings.length > 0 && <button type="button" className="icon-button" aria-label="Add recording" disabled={busy} onClick={() => fileInput.current?.click()}><Plus size={19} /></button>}
                </div>
                {recordings.map(r => <div key={r.id} className={`recording ${r.hidden ? 'muted-recording' : ''}`}>
                  <div className="recording-icon" style={{ '--recording-color': r.color } as React.CSSProperties}><Activity size={19} /></div>
                  <div className="recording-info">
                    {readOnly ? <strong>{r.name}</strong> : <input aria-label={`Label for ${r.device}`} value={r.name} maxLength={200} onChange={e => setRecording(r.id, prev => ({ ...prev, name: e.target.value }))} />}
                    <small>{r.id === reference?.id ? 'Reference' : (r.source === 'Demo' ? 'Comparison' : r.source)}{r.offset ? ` · ${signed(r.offset, 0)} s` : ''}</small>
                  </div>
                  {!readOnly && <div className="recording-actions">
                    <button type="button" className="icon-button" aria-label={`${r.hidden ? 'Show' : 'Hide'} ${r.name}`} disabled={!r.hidden && visible.length <= 1} onClick={() => toggleRecording(r)}>{r.hidden ? <EyeOff size={16} /> : <Eye size={16} />}</button>
                    <button type="button" className="icon-button danger" aria-label={`Remove ${r.name}`} onClick={() => removeRecording(r.id)}><X size={15} /></button>
                  </div>}
                </div>)}
                {!readOnly && <button type="button" className={`dropzone ${dropping ? 'dropping' : ''}`} disabled={busy}
                  onClick={() => fileInput.current?.click()} onDragOver={e => { e.preventDefault(); setDropping(true) }}
                  onDragLeave={() => setDropping(false)} onDrop={e => { e.preventDefault(); setDropping(false); void files(e.dataTransfer.files) }}>
                  <FileUp size={20} /><span>{busy ? 'Working…' : 'Drop workout files'}</span><small>FIT, TCX, GPX or project ZIP</small>
                </button>}
              </section>
              <section className="card settings">
                <button type="button" className="card-header settings-heading" onClick={() => setSettings(v => !v)} aria-expanded={settings}>
                  <span className="header-title"><SlidersHorizontal size={18} /><h2>Settings</h2></span><ChevronDown size={16} className={settings ? '' : 'collapsed'} />
                </button>
                {settings && <div className="settings-content">
                  <label><span>Units</span><select value={units} onChange={e => setUnits(e.target.value as Units)}><option value="metric">Metric</option><option value="imperial">Imperial</option></select></label>
                  {visible.length > 1 && !readOnly && <label><span>Reference</span><select value={reference?.id ?? ''} onChange={e => { update(p => ({ ...p, reference: e.target.value })); resetFocus() }}>
                    {visible.map(r => <option value={r.id} key={r.id}>{r.name}</option>)}</select></label>}
                  {chosen && <label><span>Smoothing</span><select value={smoothing} onChange={e => setSmoothing(Number(e.target.value))}><option value={0}>Off</option><option value={3}>3 seconds</option><option value={10}>10 seconds</option><option value={30}>30 seconds</option></select></label>}
                  {visible.length > 1 && !readOnly && <div className="align-section">
                    {visible.filter(r => r.id !== reference?.id).map(r => <label key={r.id}><span title={r.name}>{r.name}</span>
                      <input type="number" min={-3600} max={3600} step={1} value={r.offset} aria-label={`Time offset in seconds for ${r.name}`}
                        onChange={e => { const offset = Math.min(3600, Math.max(-3600, Math.round(Number(e.target.value) || 0))); setRecording(r.id, prev => ({ ...prev, offset })); resetFocus() }} /></label>)}
                    <button type="button" className="button small" onClick={autoAlign}><Timer size={15} /> Auto-align</button>
                    {offsets && <div className="alignment-result">
                      {offsets.length ? <>{offsets.map(o => <small key={o.id}>{visible.find(r => r.id === o.id)?.name}: {signed(o.offset, 0)} s using {metricNames[o.metric].toLowerCase()}</small>)}
                        <button type="button" className="button small primary" onClick={() => {
                          update(p => ({ ...p, recordings: p.recordings.map(r => ({ ...r, offset: offsets.find(o => o.id === r.id)?.offset ?? r.offset })) })); resetFocus()
                        }}>Apply offsets</button></> : <small>No confident change within ±30 s. Use a manual offset if needed.</small>}
                    </div>}
                  </div>}
                </div>}
              </section>
              {!readOnly && <div className="sidebar-footer">
                <button type="button" className="plain" onClick={() => switchWorkspace(blank())}><Plus size={15} /> New comparison</button>
                {!example && <button type="button" className="plain" onClick={() => switchWorkspace(demo())}><RotateCcw size={14} /> Load example</button>}
              </div>}
            </aside>
            <div className="analysis">
              {!visible.length ? <div className="card empty first-empty"><GitCompare size={32} /><h2>Add a workout recording</h2><p>Upload recordings from the same workout to compare GPS, heart rate, speed, and more.</p>
                {!readOnly && <button className="button primary" type="button" onClick={() => fileInput.current?.click()}><FileUp size={17} /> Import files</button>}
              </div> : <>
                <section className="overview" aria-label="Comparison overview">
                  <Overview title="Elapsed time" value={timeLabel((bounds[1] - bounds[0]) / 1000)} icon={<Timer size={19} />} />
                  <Overview title="Reference distance" value={pretty('distance', reference && totalDistance(reference), 2)} icon={<Map size={18} />} />
                  <Overview title="Distance difference" value={difference === undefined ? '—' : `${signed(displayValue('distance', difference, units), 2)} ${metricUnit('distance', units)}`} icon={<GitCompare size={19} />} />
                  <Overview title="Median GPS separation" value={gpsStats ? pretty('elevation', gpsStats.median) : '—'} icon={<Crosshair size={18} />} />
                </section>
                {gps && <section className="card route-panel">
                  <div className="card-header route-head">
                    <span className="header-title"><Map size={18} /><h2>GPS tracks</h2></span>
                    <div className="legend">{visible.map(r => <span key={r.id} title={r.name}><i style={{ background: r.color }} />{r.name}</span>)}</div>
                  </div>
                  <Suspense fallback={<div className="map-shell map-placeholder">Loading map…</div>}><RouteMap recordings={recordings} cursor={cursor} /></Suspense>
                </section>}
                {chosen && <section className="card telemetry">
                  <div className="card-header">
                    <span className="header-title"><HeartPulse size={18} /><h2>Telemetry</h2></span>
                    <div className="chart-actions">
                      {secondary && <button type="button" className="button small" onClick={() => setShowSecond(v => !v)}>{showSecond ? 'Hide second chart' : 'Add second chart'}</button>}
                      {range && <button type="button" className="button small" onClick={() => setRange(null)}><RotateCcw size={14} /> Reset zoom</button>}
                    </div>
                  </div>
                  <div className="metric-tabs" role="group" aria-label="Telemetry metric">
                    {streams.map(s => <button key={s} type="button" aria-pressed={s === chosen} onClick={() => setStream(s)}>{streamLabel(s)}</button>)}
                  </div>
                  {reference && reference.laps.length > 0 && <div className="laps" aria-label="Laps">
                    <span>Laps</span><button type="button" aria-pressed={selectedLap === null} onClick={() => { setSelectedLap(null); setRange(null) }}>All</button>
                    {reference.laps.map((lap, i) => <button type="button" key={i} title={timeLabel((lap.end - lap.start) / 1000)} aria-pressed={selectedLap === i} onClick={() => {
                      setSelectedLap(selectedLap === i ? null : i); setRange(selectedLap === i ? null : [lap.start + shift * 1000, lap.end + shift * 1000])
                    }}>{i + 1}</button>)}
                  </div>}
                  <Suspense fallback={<div className="chart-canvas map-placeholder">Loading chart…</div>}>
                    <TelemetryChart recordings={visible} seriesKey={chosen} bounds={bounds} range={range} lap={lapRange} units={units} smoothing={smoothing}
                      cursor={cursor} onCursor={chartCursor} onRange={chartRange} />
                    {showSecond && secondary && <><div className="second-title">{streamLabel(secondary)}</div>
                      <TelemetryChart recordings={visible} seriesKey={secondary} bounds={bounds} range={range} lap={lapRange} units={units} smoothing={smoothing}
                        cursor={cursor} onCursor={chartCursor} onRange={chartRange} /></>}
                  </Suspense>
                  <div className="chart-footer">{chosen === 'powerCurve' ? 'Peak average power by uninterrupted duration.' : 'Drag a time range to zoom. Double-click to reset.'}</div>
                </section>}
                {!!summaries.length && chosen && <section className="card results">
                  <div className="card-header"><span className="header-title"><GitCompare size={18} /><h2>{streamLabel(chosen)} comparison</h2></span></div>
                  <div className="table-scroll"><table>
                    <thead><tr><th>Recording</th><th>{cursor === null ? 'Current' : timeLabel((cursor - bounds[0]) / 1000)}</th>
                      <th>{selectedLap === null ? (range ? 'Window avg' : 'Average') : `Lap ${selectedLap + 1} avg`}</th><th title="Recording minus reference">Bias</th><th title="Mean absolute error">Abs. error</th><th title="Paired samples divided by valid reference samples">Coverage</th><th>Missing</th></tr></thead>
                    <tbody>{visible.map((r, i) => {
                      const stats = statistic[i]
                      const metric = chosen as Metric
                      return <tr key={r.id}>
                        <th scope="row"><span className="dot" style={{ background: r.color }} />{r.name}{r.id === reference?.id && <span className="reference-tag">REF</span>}</th>
                        <td>{pretty(metric, cursor === null ? undefined : sampleAt(r, cursor)?.[metric])}</td><td>{pretty(metric, summaries[i])}</td>
                        <td>{stats ? `${signed(displayValue(metric, stats.bias, units))} ${metricUnit(metric, units)}` : '—'}</td>
                        <td>{pretty(metric, stats?.mae)}</td><td>{stats ? `${(stats.coverage * 100).toFixed(1)}%` : '—'}</td><td>{stats ? `~${stats.missingSeconds} s` : '—'}</td>
                      </tr>
                    })}</tbody>
                  </table></div>
                  <p className="results-note">Bias, error, and coverage use the full overlap with the reference. Zoom and lap selection update the averages.</p>
                </section>}
              </>}
            </div>
          </div>
        </>}
      <footer className="footer"><span>TraceCompare</span><span>Workout analysis runs in your browser.</span></footer>
    </main>
    {modal === 'account' && <ModalPanel title={user ? 'Your account' : 'Sign in to TraceCompare'} close={() => setModal(null)}>
      {notice?.type === 'error' && <p className="dialog-error" role="alert">{notice.message}</p>}
      {user ? <><p>{user.email}</p><button className="button" type="button" onClick={() => void task(async () => { await signOut(); setModal(null); inform('Signed out.') })}>Sign out</button></>
        : cloud ? <><p>Save comparisons privately and create public links.</p><button className="button primary" disabled={busy} type="button" onClick={() => void task(signIn)}>Continue with Google <ArrowRight size={17} /></button></>
          : <p>Cloud accounts are unavailable on this deployment. You can still compare workouts and export a ZIP to reopen later.</p>}
    </ModalPanel>}
    {modal === 'share' && <ModalPanel title="Share this comparison" close={() => setModal(null)}>
      <p>Anyone with the link can view the published charts. The original workout files stay private.</p>
      {notice?.type === 'error' && <p className="dialog-error" role="alert">{notice.message}</p>}
      <label className="checkbox"><input type="checkbox" checked={gpsInShare} onChange={e => setGpsInShare(e.target.checked)} /> Include GPS tracks</label>
      {link ? <div className="copy-row"><input aria-label="Public comparison URL" readOnly value={link} onFocus={e => e.target.select()} /><button className="button primary" type="button" onClick={() => void task(async () => { await navigator.clipboard.writeText(link); inform('Public link copied.') })}>Copy</button></div>
        : <button className="button primary" type="button" disabled={busy} onClick={() => void makeLink()}><Link2 size={16} /> Publish link</button>}
      <div className="privacy-label"><LockKeyhole size={14} /> Hidden recordings and start dates are excluded.</div>
    </ModalPanel>}
  </>
}

function Overview({ title, value, icon }: { title: string; value: string; icon: ReactNode }) {
  return <div className="card overview-card"><span className="overview-icon">{icon}</span><div><span>{title}</span><strong>{value}</strong></div></div>
}

function streamLabel(stream: Stream) {
  if (stream === 'powerCurve') return 'Mean max power'
  if (stream.startsWith('dev:')) return stream.slice(4).replaceAll('_', ' ')
  return metricNames[stream as Metric]
}
