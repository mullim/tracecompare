import { adjusted, extent, type Metric, type Range, type Recording, type Sample } from './model'
import { metersBetween } from './parsers'

export function lowerBound(samples: Sample[], time: number) {
  let lo = 0
  let hi = samples.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (samples[mid].t < time) lo = mid + 1
    else hi = mid
  }
  return lo
}

export function sampleAt(recording: Recording, time: number, tolerance = 2_000) {
  const target = time - recording.offset * 1000
  const i = lowerBound(recording.samples, target)
  const before = recording.samples[i - 1]
  const after = recording.samples[i]
  const closest = !before ? after : !after ? before : target - before.t <= after.t - target ? before : after
  return closest && Math.abs(closest.t - target) <= tolerance ? closest : undefined
}

export function overlap(a: Recording, b: Recording): Range {
  const [as, ae] = extent([a])
  const [bs, be] = extent([b])
  return [Math.max(as, bs), Math.min(ae, be)]
}

export function compareMetric(reference: Recording, recording: Recording, metric: Metric) {
  if (reference.id === recording.id) return null
  const [start, end] = overlap(reference, recording)
  if (end <= start) return null
  let bias = 0
  let error = 0
  let paired = 0
  let referenceCount = 0
  let missed = 0
  const step = Math.max(1_000, Math.ceil((end - start) / 24_000 / 1000) * 1000)
  for (let time = start; time <= end; time += step) {
    const a = sampleAt(reference, time, step === 1000 ? 1_500 : 2_000)?.[metric]
    if (a === undefined) continue
    referenceCount++
    const b = sampleAt(recording, time, step === 1000 ? 1_500 : 2_000)?.[metric]
    if (b === undefined) {
      missed++
      continue
    }
    bias += b - a
    error += Math.abs(b - a)
    paired++
  }
  return paired ? { bias: bias / paired, mae: error / paired, coverage: paired / referenceCount, paired, missingSeconds: missed * step / 1000 } : null
}

export function gpsDifference(reference: Recording, recording: Recording) {
  const [start, end] = overlap(reference, recording)
  const step = Math.max(1_000, Math.ceil((end - start) / 24_000 / 1000) * 1000)
  const distances: number[] = []
  for (let t = start; t <= end; t += step) {
    const a = sampleAt(reference, t, 1500)
    const b = sampleAt(recording, t, 1500)
    const distance = a && b && metersBetween(a, b)
    if (distance !== undefined) distances.push(distance)
  }
  if (!distances.length) return null
  distances.sort((a, b) => a - b)
  return { median: distances[Math.floor(distances.length / 2)], max: distances.at(-1)!, count: distances.length }
}

export function average(recording: Recording, metric: Metric, range?: Range) {
  let sum = 0
  let count = 0
  for (const sample of recording.samples) {
    const value = sample[metric]
    const t = adjusted(sample, recording)
    if (value === undefined || (range && (t < range[0] || t > range[1]))) continue
    sum += value
    count++
  }
  return count ? sum / count : undefined
}

export function totalDistance(recording: Recording) {
  const first = recording.samples.find(p => p.distance !== undefined)?.distance
  const last = recording.samples.findLast(p => p.distance !== undefined)?.distance
  return last === undefined ? undefined : Math.max(0, last - (first ?? 0))
}

export function suggestOffset(reference: Recording, target: Recording): { offset: number; metric: Metric } | null {
  for (const metric of ['power', 'speed', 'cadence'] as const) {
    const [start, end] = extent([reference])
    const step = Math.max(1_000, Math.ceil((end - start) / 2500 / 1000) * 1000)
    const points = []
    for (let t = start; t <= end; t += step) {
      const value = sampleAt(reference, t)?.[metric]
      if (value !== undefined) points.push([t, value])
    }
    if (points.length < 20) continue
    const candidates: Array<{ offset: number; score: number }> = []
    for (let lag = -30; lag <= 30; lag++) {
      const offset = target.offset + lag
      let n = 0, x = 0, y = 0, xx = 0, yy = 0, xy = 0
      for (const [t, a] of points) {
        const b = sampleAt(target, t - lag * 1000)?.[metric]
        if (b === undefined) continue
        n++
        x += a; y += b; xx += a * a; yy += b * b; xy += a * b
      }
      const variance = (n * xx - x * x) * (n * yy - y * y)
      if (n >= Math.max(20, points.length * 0.5) && variance > 0) {
        candidates.push({ offset, score: (n * xy - x * y) / Math.sqrt(variance) - 0.1 * (1 - n / points.length) })
      }
    }
    candidates.sort((a, b) => b.score - a.score)
    const best = candidates[0]
    const rival = best && candidates.find(c => Math.abs(c.offset - best.offset) > 2)
    if (best && rival && best.score >= 0.6 && best.score - rival.score >= 0.025) return { offset: best.offset, metric }
  }
  return null
}

export function powerCurve(recording: Recording) {
  const [start, end] = extent([recording])
  const durations = [1, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600]
  const length = Math.min(7 * 86_400, Math.floor((end - start) / 1000) + 1)
  const sums = new Float64Array(length + 1)
  const missing = new Uint32Array(length + 1)
  for (let i = 0; i < length; i++) {
    const power = sampleAt(recording, start + i * 1000, 1500)?.power
    sums[i + 1] = sums[i] + (power ?? 0)
    missing[i + 1] = missing[i] + Number(power === undefined)
  }
  return durations.flatMap(window => {
    let max = -Infinity
    for (let i = window; i <= length; i++) {
      if (missing[i] === missing[i - window]) max = Math.max(max, (sums[i] - sums[i - window]) / window)
    }
    return Number.isFinite(max) ? [[window, max]] : []
  })
}
