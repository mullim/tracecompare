import { strFromU8, strToU8, unzip, zip } from 'fflate'
import { blank, colors, maxFileBytes, maxRecordings, metrics, type Project, type Recording, type Sample, type Workspace } from './model'

const maxArchiveBytes = (maxRecordings * maxFileBytes) + 256 * 1024 * 1024
const safeColor = /^#[\da-f]{6}$/i
const safeId = /^[a-zA-Z\d-]{1,64}$/
const invalid = 'This file is not a supported TraceCompare project.'
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

function validatedProject(value: unknown): Project {
  if (!object(value) || value.version !== 1 || typeof value.title !== 'string' || typeof value.reference !== 'string'
    || !Array.isArray(value.recordings) || value.recordings.length > maxRecordings) throw new Error(invalid)
  const seen = new Set<string>()
  const recordings: Recording[] = value.recordings.map((r: unknown, index: number) => {
    if (!object(r) || typeof r.id !== 'string' || !safeId.test(r.id) || seen.has(r.id) || typeof r.name !== 'string'
      || typeof r.device !== 'string' || typeof r.source !== 'string' || !Array.isArray(r.samples)
      || r.samples.length < 2 || r.samples.length > 200_000 || !Array.isArray(r.laps)) throw new Error(invalid)
    seen.add(r.id)
    let lastTime = -Infinity
    const samples = r.samples.map((p: unknown): Sample => {
      if (!object(p) || !finite(p.t) || p.t <= lastTime || Math.abs(p.t) > 8.64e15) throw new Error(invalid)
      lastTime = p.t
      const sample: Sample = { t: p.t }
      for (const metric of metrics) if (finite(p[metric])) sample[metric] = p[metric]
      if (finite(p.lat) && finite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180) {
        sample.lat = p.lat; sample.lon = p.lon
      }
      if (object(p.developer)) {
        sample.developer = Object.fromEntries(Object.entries(p.developer).filter((pair): pair is [string, number] => finite(pair[1])))
      }
      return sample
    })
    if (samples.at(-1)!.t - samples[0].t > 7 * 86_400_000) throw new Error(invalid)
    return {
      id: r.id, name: r.name.slice(0, 200), device: r.device.slice(0, 100), source: r.source.slice(0, 12),
      offset: finite(r.offset) ? Math.max(-3600, Math.min(3600, r.offset)) : 0,
      color: typeof r.color === 'string' && safeColor.test(r.color) ? r.color : colors[index % colors.length],
      hidden: r.hidden === true, samples,
      laps: r.laps.flatMap((lap: unknown) => object(lap) && finite(lap.start) && finite(lap.end) && lap.start < lap.end
        ? [{ start: lap.start, end: lap.end }] : []),
    }
  })
  return { version: 1, title: value.title.slice(0, 120) || blank().project.title, reference: seen.has(value.reference) ? value.reference : recordings[0]?.id ?? '', recordings }
}

export async function pack(workspace: Workspace) {
  const entries: Record<string, Uint8Array> = {
    'comparison.json': strToU8(JSON.stringify({ project: workspace.project, files: workspace.originals.map(({ id, name }) => ({ id, name })) })),
  }
  for (const file of workspace.originals) entries[`originals/${file.id}`] = file.bytes
  return new Promise<Uint8Array>((resolve, reject) => zip(entries, { level: 5 }, (error, result) => error ? reject(error) : resolve(result)))
}

export async function unpack(bytes: Uint8Array): Promise<Workspace> {
  if (bytes.byteLength > maxArchiveBytes) throw new Error('This project archive is too large.')
  let inflated = 0
  let entries = 0
  const files = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    unzip(bytes, {
      filter: (file) => {
        const recognized = file.name === 'comparison.json' || /^originals\/[a-zA-Z\d-]{1,64}$/.test(file.name)
        if (!recognized) return false
        entries++
        inflated += file.originalSize
        return entries <= maxRecordings + 1 && inflated <= maxArchiveBytes
          && (file.name === 'comparison.json' || file.originalSize <= maxFileBytes)
      },
    }, (error, result) => error ? reject(error) : resolve(result))
  })
  if (!files['comparison.json'] || inflated > maxArchiveBytes || entries > maxRecordings + 1) throw new Error(invalid)
  const manifest: unknown = JSON.parse(strFromU8(files['comparison.json']))
  if (!object(manifest) || !Array.isArray(manifest.files) || manifest.files.length > maxRecordings) throw new Error(invalid)
  const project = validatedProject(manifest.project)
  const originals = manifest.files.map((item: unknown) => {
    if (!object(item) || typeof item.id !== 'string' || !project.recordings.some(r => r.id === item.id)
      || typeof item.name !== 'string' || !files[`originals/${item.id}`]) throw new Error(invalid)
    return { id: item.id, name: item.name, bytes: files[`originals/${item.id}`] }
  })
  return { project, originals }
}

export function publishedWorkspace(workspace: Workspace, includeGps: boolean): Workspace {
  const recordings = workspace.project.recordings.filter(r => !r.hidden)
  const anchor = Math.min(...recordings.map(r => r.samples[0].t))
  return {
    project: {
      ...workspace.project,
      recordings: recordings.map(r => {
        const sourceName = workspace.originals.find(file => file.id === r.id)?.name.replace(/\.[^.]+$/, '')
        return {
          ...r, name: r.name === sourceName ? r.device : r.name,
          samples: r.samples.map(({ t, lat, lon, developer, ...metrics }) => ({
            ...metrics, t: t - anchor, ...(includeGps ? { lat, lon } : {}),
          })),
          laps: r.laps.map(lap => ({ start: lap.start - anchor, end: lap.end - anchor })),
        }
      }),
    },
    originals: [],
  }
}

async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('tracecompare', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('workspace')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function localRestore(): Promise<Workspace | undefined> {
  const db = await database()
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('workspace').objectStore('workspace').get('current')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  } finally { db.close() }
}

export async function localSave(workspace: Workspace) {
  const db = await database()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('workspace', 'readwrite')
      tx.objectStore('workspace').put(workspace, 'current')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } finally { db.close() }
}

export function download(bytes: Uint8Array, name: string) {
  const blob = new Blob([new Uint8Array(bytes)], { type: 'application/zip' })
  const href = URL.createObjectURL(blob)
  const location = document.createElement('a')
  location.href = href
  location.download = name
  location.click()
  setTimeout(() => URL.revokeObjectURL(href), 10_000)
}
