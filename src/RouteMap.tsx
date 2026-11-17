import { useEffect, useMemo, useRef, useState } from 'react'
import * as maplibregl from 'maplibre-gl'
import type { GeoJSONSource, StyleSpecification } from 'maplibre-gl'
import type { Feature, FeatureCollection, LineString, Point } from 'geojson'
import 'maplibre-gl/dist/maplibre-gl.css'
import { Expand, Minus, Plus } from 'lucide-react'
import { sampleAt } from './compare'
import type { Recording } from './model'

const defaultStyle: StyleSpecification = {
  version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#e9eff0' } }],
}
type Routes = FeatureCollection<LineString, { color: string; name: string }>
type Pins = FeatureCollection<Point, { color: string }>
const styleUrl = import.meta.env.VITE_MAP_STYLE || 'https://tiles.openfreemap.org/styles/positron'

export function RouteMap({ recordings, cursor }: { recordings: Recording[]; cursor: number | null }) {
  const root = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLDivElement>(null)
  const map = useRef<maplibregl.Map | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState(false)
  const [fallback, setFallback] = useState(false)
  const data = useMemo<Routes>(() => {
    const features: Routes['features'] = []
    for (const recording of recordings) {
      if (recording.hidden) continue
      let segment: number[][] = []
      let lastTime: number | undefined
      const flush = () => {
        if (segment.length > 1) features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: segment }, properties: { color: recording.color, name: recording.name } })
        segment = []
      }
      for (const p of recording.samples) {
        if (p.lat === undefined || p.lon === undefined) continue
        if (lastTime !== undefined && p.t - lastTime > 60_000) flush()
        segment.push([p.lon, p.lat])
        lastTime = p.t
      }
      flush()
    }
    return { type: 'FeatureCollection', features }
  }, [recordings])
  const bounds = useMemo(() => {
    const box = new maplibregl.LngLatBounds()
    const first = data.features[0]?.geometry.coordinates[0]?.[0]
    if (first === undefined) return box
    for (const route of data.features) {
      for (const [lon, lat] of route.geometry.coordinates) {
        const wrapped = first + ((lon - first + 540) % 360) - 180
        box.extend([wrapped, lat])
      }
    }
    return box
  }, [data])
  const boundsRef = useRef(bounds)
  boundsRef.current = bounds
  function fit(instance: maplibregl.Map, b = boundsRef.current) {
    if (!b.isEmpty()) instance.fitBounds(b, { padding: 36, maxZoom: 16, duration: 0 })
  }
  useEffect(() => {
    if (!canvas.current) return
    let ended = false
    const abort = new AbortController()
    async function setup() {
      let style = defaultStyle
      try {
        const response = await fetch(styleUrl, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(3000)]) })
        if (response.ok) style = await response.json()
        else setFallback(true)
      } catch {
        if (!ended) setFallback(true)
      }
      if (ended || !canvas.current) return
      try {
        const current = new maplibregl.Map({ container: canvas.current, style, attributionControl: { compact: true }, cooperativeGestures: true })
        map.current = current
        current.on('load', () => {
          current.addSource('workout-tracks', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
          current.addSource('workout-cursor', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
          current.addLayer({ id: 'track-border', type: 'line', source: 'workout-tracks', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-width': 7, 'line-color': '#fff' } })
          current.addLayer({ id: 'tracks', type: 'line', source: 'workout-tracks', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-width': 3.5, 'line-color': ['get', 'color'] } })
          current.addLayer({ id: 'cursor', type: 'circle', source: 'workout-cursor', paint: { 'circle-radius': 6, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } })
          setReady(true)
        })
      } catch { setError(true) }
    }
    const resize = new ResizeObserver(() => map.current?.resize())
    resize.observe(canvas.current)
    void setup()
    return () => {
      ended = true
      abort.abort()
      resize.disconnect()
      map.current?.remove()
      map.current = null
    }
  }, [])
  useEffect(() => {
    if (!ready || !map.current) return
    map.current.getSource<GeoJSONSource>('workout-tracks')?.setData(data)
    fit(map.current, bounds)
  }, [ready, data, bounds])
  useEffect(() => {
    if (!ready) return
    const features: Array<Feature<Point, { color: string }>> = []
    if (cursor !== null) {
      for (const recording of recordings) {
        if (recording.hidden) continue
        const p = sampleAt(recording, cursor, 3500)
        if (p?.lat !== undefined && p.lon !== undefined) features.push({
          type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] }, properties: { color: recording.color },
        })
      }
    }
    map.current?.getSource<GeoJSONSource>('workout-cursor')?.setData({ type: 'FeatureCollection', features } satisfies Pins)
  }, [cursor, ready, recordings])
  return <div className="map-shell" ref={root}>
    <div ref={canvas} className="map-canvas" aria-label="GPS tracks map" />
    {error && <RouteSvg data={data} />}
    {!ready && !error && <div className="map-message">Loading map…</div>}
    {(ready && fallback || error) && <div className="map-note">Route only</div>}
    {ready && <div className="map-buttons">
      <button type="button" aria-label="Map zoom in" onClick={() => map.current?.zoomIn()}><Plus size={16} /></button>
      <button type="button" aria-label="Map zoom out" onClick={() => map.current?.zoomOut()}><Minus size={16} /></button>
      <button type="button" aria-label="Fit GPS tracks" onClick={() => map.current && fit(map.current)}><Expand size={15} /></button>
    </div>}
  </div>
}

function RouteSvg({ data }: { data: Routes }) {
  const coordinates = data.features.flatMap(f => f.geometry.coordinates)
  if (!coordinates.length) return null
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const [x, y] of coordinates) {
    minX = Math.min(x, minX); maxX = Math.max(x, maxX)
    minY = Math.min(y, minY); maxY = Math.max(y, maxY)
  }
  const lonScale = Math.max(0.02, Math.cos((minY + maxY) * Math.PI / 360))
  const scale = Math.min(550 / Math.max(0.000001, (maxX - minX) * lonScale), 260 / Math.max(0.000001, maxY - minY))
  const project = ([x, y]: number[]) => [300 + (x - (minX + maxX) / 2) * lonScale * scale, 155 - (y - (minY + maxY) / 2) * scale].join(',')
  return <svg className="map-fallback" viewBox="0 0 600 310" aria-label="GPS track outline">
    {data.features.map((f, i) => <polyline key={i} points={f.geometry.coordinates.map(project).join(' ')} fill="none" stroke={f.properties.color} strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />)}
  </svg>
}
