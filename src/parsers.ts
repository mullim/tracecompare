import { type Lap, type Sample, type Recording } from './model'

const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined
function timestamp(value: unknown) {
  const ms = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(ms) ? ms : undefined
}

function coordinates(lat: unknown, lon: unknown) {
  const latitude = number(lat)
  const longitude = number(lon)
  return latitude !== undefined && longitude !== undefined && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180
    ? { lat: latitude, lon: longitude } : {}
}

function positiveHeartRate(value?: number) {
  return value && value > 0 ? value : undefined
}

export type Decoded = Pick<Recording, 'device' | 'samples' | 'laps' | 'source'>

export async function parseFit(bytes: ArrayBuffer): Promise<Decoded> {
  const { default: FitParser, getFitGarminProductDisplayName } = await import('fit-file-parser')
  const data = await new FitParser({ force: false, mode: 'list' }).parseAsync(bytes)
  const fields = data.file_ids?.[0] as Record<string, unknown> | undefined
  const manufacturer = fields?.manufacturer
  const garmin = manufacturer === 'garmin' ? number(fields?.garmin_product) ?? number(fields?.product) : undefined
  const device = (typeof fields?.product_name === 'string' && fields.product_name.trim())
    || (garmin !== undefined && getFitGarminProductDisplayName(garmin))
    || (typeof manufacturer === 'string' && manufacturer.replaceAll('_', ' ')) || 'FIT device'
  const developerNames = new Set([
    ...(data.field_descriptions ?? []).flatMap(field => typeof field.field_name === 'string' ? [field.field_name] : []),
    'gps_accuracy', 'vertical_oscillation', 'stance_time', 'stance_time_balance', 'vertical_ratio', 'step_length',
    'left_torque_effectiveness', 'right_torque_effectiveness', 'left_pedal_smoothness', 'right_pedal_smoothness', 'left_pco', 'right_pco',
  ])
  const samples: Sample[] = []
  for (const record of data.records ?? []) {
    const r = record as Record<string, unknown>
    const t = timestamp(r.timestamp)
    if (t === undefined) continue
    const developer: Record<string, number> = Object.create(null)
    for (const key of developerNames) {
      const value = number(r[key])
      if (value !== undefined) developer[key] = value
    }
    samples.push({
      t, ...coordinates(r.position_lat, r.position_long),
      hr: positiveHeartRate(number(r.heart_rate)),
      speed: number(r.enhanced_speed) ?? number(r.speed),
      distance: number(r.distance),
      elevation: number(r.enhanced_altitude) ?? number(r.altitude),
      power: number(r.power), cadence: number(r.cadence),
      battery: number(r.battery_soc) ?? number(r.device_battery),
      developer: Object.keys(developer).length ? developer : undefined,
    })
  }
  const laps: Lap[] = []
  for (const lap of data.laps ?? []) {
    const start = timestamp(lap.start_time)
    const end = timestamp(lap.timestamp)
    if (start !== undefined && end !== undefined && start < end) laps.push({ start, end })
  }
  return normalize({ samples, laps, device, source: 'FIT' })
}

function child(el: Element, name: string) {
  return Array.from(el.children).find(node => node.localName === name)
}
function readNumber(input: string | null | undefined) {
  return input?.trim() ? number(Number(input)) : undefined
}
function direct(el: Element, name: string) {
  return readNumber(child(el, name)?.textContent)
}
function descendants(el: Document | Element, name: string) {
  return Array.from(el.getElementsByTagNameNS('*', name))
}

export function parseXml(text: string, format: 'tcx' | 'gpx'): Decoded {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  const root = doc.documentElement
  if (root.localName !== (format === 'tcx' ? 'TrainingCenterDatabase' : 'gpx') || descendants(doc, 'parsererror').length) {
    throw new Error(`Invalid ${format.toUpperCase()} document.`)
  }
  const samples: Sample[] = []
  const laps: Lap[] = []
  let device = 'GPX track'
  if (format === 'tcx') {
    device = descendants(doc, 'Creator').map(el => child(el, 'Name')?.textContent?.trim()).find(Boolean) || 'TCX device'
    for (const lap of descendants(doc, 'Lap')) {
      const start = timestamp(lap.getAttribute('StartTime'))
      const duration = direct(lap, 'TotalTimeSeconds')
      const points = descendants(lap, 'Trackpoint')
      for (const p of points) {
        const t = timestamp(child(p, 'Time')?.textContent)
        if (t === undefined) continue
        const position = child(p, 'Position')
        const hr = child(p, 'HeartRateBpm')
        samples.push({
          t, ...coordinates(position && direct(position, 'LatitudeDegrees'), position && direct(position, 'LongitudeDegrees')),
          hr: positiveHeartRate(hr && direct(hr, 'Value')),
          speed: readNumber(descendants(p, 'Speed')[0]?.textContent),
          power: readNumber(descendants(p, 'Watts')[0]?.textContent),
          cadence: direct(p, 'Cadence') ?? readNumber(descendants(p, 'RunCadence')[0]?.textContent),
          elevation: direct(p, 'AltitudeMeters'), distance: direct(p, 'DistanceMeters'),
        })
      }
      const end = timestamp(child(points.at(-1) ?? lap, 'Time')?.textContent) ?? (start !== undefined && duration !== undefined ? start + duration * 1000 : undefined)
      if (start !== undefined && end !== undefined && start < end) laps.push({ start, end })
    }
  } else {
    for (const p of descendants(doc, 'trkpt')) {
      const t = timestamp(child(p, 'time')?.textContent)
      if (t === undefined) continue
      samples.push({
        t, ...coordinates(readNumber(p.getAttribute('lat')), readNumber(p.getAttribute('lon'))),
        hr: positiveHeartRate(readNumber(descendants(p, 'hr')[0]?.textContent)),
        cadence: readNumber(descendants(p, 'cad')[0]?.textContent),
        power: readNumber(descendants(p, 'power')[0]?.textContent),
        elevation: direct(p, 'ele'),
      })
    }
  }
  return normalize({ samples, laps, device, source: format.toUpperCase() })
}

export function metersBetween(a: Sample, b: Sample) {
  if (a.lat === undefined || a.lon === undefined || b.lat === undefined || b.lon === undefined) return undefined
  const radians = Math.PI / 180
  const dLat = (b.lat - a.lat) * radians
  const dLon = (b.lon - a.lon) * radians
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * radians) * Math.cos(b.lat * radians) * Math.sin(dLon / 2) ** 2
  return 12_742_008.8 * Math.asin(Math.sqrt(Math.min(1, h)))
}

function normalize(decoded: Decoded): Decoded {
  const byTime = new Map<number, Sample>()
  for (const point of decoded.samples) {
    const combined = { ...byTime.get(point.t) }
    for (const [key, value] of Object.entries(point)) {
      if (value !== undefined) Object.assign(combined, { [key]: value })
    }
    byTime.set(point.t, combined as Sample)
  }
  const samples = [...byTime.values()].sort((a, b) => a.t - b.t)
  if (samples.length < 2) throw new Error('This file needs at least two timestamped workout samples.')
  if (samples.length > 200_000) throw new Error('This workout exceeds the 200,000-sample limit.')
  if (samples.at(-1)!.t - samples[0].t > 7 * 86_400_000) throw new Error('A single recording can span up to seven days.')

  const deriveDistance = !samples.some(s => s.distance !== undefined)
  const deriveSpeed = !samples.some(s => s.speed !== undefined)
  let distance = 0
  for (let i = 1; i < samples.length; i++) {
    const elapsed = (samples[i].t - samples[i - 1].t) / 1000
    const segment = elapsed <= 60 ? metersBetween(samples[i - 1], samples[i]) : undefined
    if (segment === undefined) continue
    distance += segment
    if (deriveDistance) {
      if (i === 1) samples[0].distance = 0
      samples[i].distance = distance
    }
    if (deriveSpeed) samples[i].speed = segment / elapsed
  }
  return { ...decoded, samples }
}
