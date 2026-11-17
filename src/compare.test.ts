import { describe, expect, it } from 'vitest'
import { FitBaseType, FitEncoder } from 'fit-file-parser/encoder'
import { compareMetric, gpsDifference, powerCurve, suggestOffset } from './compare'
import { demo } from './demo'
import { type Recording } from './model'
import { parseFit } from './parsers'
import { pack, publishedWorkspace, unpack } from './workspace'

const example = demo()
const start = Date.UTC(2026, 0, 1)

function recording(id: string, clockShift: number, missing = false): Recording {
  const r = example.project.recordings[0]
  return {
    ...r, id, name: id, laps: [],
    samples: Array.from({ length: 90 }, (_, t) => ({
      t: start + 1000 * (t + clockShift), speed: 3 + (t === 16 ? 1 : 0) + (t >= 39 && t < 45 ? .5 : 0),
      hr: missing && t >= 20 && t < 30 ? undefined : 140 + clockShift,
      power: t < 10 ? 0 : t < 20 ? 100 : undefined,
    })),
  }
}

describe('workout comparisons', () => {
  it('aligns the clock using speed without shifting away heart rate differences', () => {
    const a = recording('a', 0)
    const b = recording('b', 7)
    expect(suggestOffset(a, b)).toEqual({ offset: -7, metric: 'speed' })
    expect(compareMetric(a, { ...b, offset: -7 }, 'hr')).toMatchObject({ bias: 7, paired: 90 })
  })

  it('counts missing data and rejects nonoverlapping recordings', () => {
    const a = recording('a', 0)
    const b = recording('b', 0, true)
    expect(compareMetric(a, b, 'hr')).toMatchObject({ bias: 0, paired: 80, missingSeconds: 10 })
    expect(compareMetric(a, { ...b, offset: 1000 }, 'hr')).toBeNull()
  })

  it('keeps zero power and excludes incomplete power windows', () => {
    expect(powerCurve(recording('a', 0))).toEqual([[1, 100], [5, 100], [10, 100], [15, 1000 / 15]])
  })

  it('calculates GPS separation from matched records', () => {
    const a = { ...recording('a', 0), samples: recording('a', 0).samples.map(s => ({ ...s, lat: 40, lon: -73 })) }
    const b = { ...a, id: 'b', samples: a.samples.map(s => ({ ...s, lat: 40.0001 })) }
    expect(gpsDifference(a, b)?.median).toBeCloseTo(11.12, 1)
  })
})

describe('project files', () => {
  it('preserves original files in a private ZIP', async () => {
    const [r] = example.project.recordings
    const workspace = { ...example, originals: [{ id: r.id, name: 'original.fit', bytes: Uint8Array.of(1, 2, 3) }] }
    const output = await unpack(await pack(workspace))
    expect(output.originals).toEqual(workspace.originals)
    expect(output.project.recordings[0].samples).toEqual(r.samples)
    expect(output.project.reference).toBe(r.id)
  })

  it('removes sensitive values from a public snapshot by default', async () => {
    const [a, b] = example.project.recordings
    const workspace = {
      project: { ...example.project, recordings: [{ ...a, name: 'private_2026-11-17', samples: a.samples.map(s => ({ ...s, developer: { gps_altitude: 20 } })) }, { ...b, hidden: true }] },
      originals: [{ id: a.id, name: 'private_2026-11-17.fit', bytes: Uint8Array.of(1, 2, 3) }],
    }
    const preview = await unpack(await pack(publishedWorkspace(workspace, false)))
    expect(preview.originals).toEqual([])
    expect(preview.project.recordings).toHaveLength(1)
    const [r] = preview.project.recordings
    expect(r.name).toBe(a.device)
    expect(r.samples[0].t).toBe(0)
    expect(r.samples[0]).not.toHaveProperty('lat')
    expect(r.samples[0]).not.toHaveProperty('developer')
    expect(publishedWorkspace(workspace, true).project.recordings[0].samples[0].lat).toBe(a.samples[0].lat)
  })

  it('reads signed FIT coordinates, timestamps and zero watts from binary data', async () => {
    const encoder = new FitEncoder()
    const seconds = FitEncoder.toFitTimestamp(new Date(start))
    for (let i = 0; i < 2; i++) encoder.writeMessage(20, [
      { number: 253, size: 4, baseType: FitBaseType.Uint32, value: seconds + i },
      { number: 0, size: 4, baseType: FitBaseType.Sint32, value: Math.round(40 * 2 ** 31 / 180) },
      { number: 1, size: 4, baseType: FitBaseType.Sint32, value: Math.round(-73 * 2 ** 31 / 180) },
      { number: 3, size: 1, baseType: FitBaseType.Uint8, value: 138 },
      { number: 7, size: 2, baseType: FitBaseType.Uint16, value: i * 10 },
    ])
    const fit = await parseFit(new Uint8Array(encoder.close()).buffer)
    expect(fit.samples).toHaveLength(2)
    expect(fit.samples[0]).toMatchObject({ t: start, hr: 138, power: 0 })
    expect(fit.samples[0].lat).toBeCloseTo(40, 5)
    expect(fit.samples[0].lon).toBeCloseTo(-73, 5)
  })
})
