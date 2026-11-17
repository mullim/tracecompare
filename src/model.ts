export const metricNames = {
  hr: 'Heart rate',
  speed: 'Speed',
  distance: 'Distance',
  elevation: 'Elevation',
  power: 'Power',
  cadence: 'Cadence',
  battery: 'Battery',
} as const

export type Metric = keyof typeof metricNames
export const metrics = Object.keys(metricNames) as Metric[]
export type Sample = { t: number; lat?: number; lon?: number; developer?: Record<string, number> } & Partial<Record<Metric, number>>
export type Lap = { start: number; end: number }
export type Recording = {
  id: string
  name: string
  device: string
  source: string
  offset: number
  color: string
  hidden?: boolean
  samples: Sample[]
  laps: Lap[]
}
export type Project = { version: 1; title: string; recordings: Recording[]; reference: string }
export type Original = { id: string; name: string; bytes: Uint8Array }
export type Workspace = { project: Project; originals: Original[] }
export type Range = [number, number]
export type Units = 'metric' | 'imperial'
export const colors = ['#5148e5', '#e36538', '#008977', '#487aa8', '#a84486', '#8f6518']
export const maxRecordings = 8
export const maxFileBytes = 25 * 1024 * 1024

export function blank(): Workspace {
  return { project: { version: 1, title: 'New comparison', recordings: [], reference: '' }, originals: [] }
}

export function adjusted(sample: Sample, recording: Recording) {
  return sample.t + recording.offset * 1000
}

export function extent(recordings: Recording[]): Range {
  if (!recordings.length) return [0, 1_000]
  return [
    Math.min(...recordings.map(r => adjusted(r.samples[0], r))),
    Math.max(...recordings.map(r => adjusted(r.samples.at(-1)!, r))),
  ]
}

export function timeLabel(seconds: number) {
  const s = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(s / 60)
  const rest = String(s % 60).padStart(2, '0')
  return minutes >= 60 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`
}

export function metricUnit(metric: Metric, units: Units) {
  const labels = { hr: 'bpm', speed: units === 'metric' ? 'km/h' : 'mph', distance: units === 'metric' ? 'km' : 'mi', elevation: units === 'metric' ? 'm' : 'ft', power: 'W', cadence: 'rpm', battery: '%' }
  return labels[metric]
}

export function displayValue(metric: Metric, value: number, units: Units) {
  if (metric === 'distance') return value / (units === 'metric' ? 1000 : 1609.344)
  if (metric === 'speed') return value * (units === 'metric' ? 3.6 : 2.236936)
  if (metric === 'elevation' && units === 'imperial') return value * 3.28084
  return value
}

export function signed(value: number, digits = 1) {
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}`
}
