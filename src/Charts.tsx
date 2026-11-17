import { useEffect, useRef } from 'react'
import { init, use, type ECharts, type EChartsCoreOption } from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, DataZoomComponent, MarkAreaComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { powerCurve } from './compare'
import { adjusted, displayValue, metricNames, metricUnit, timeLabel, type Metric, type Range, type Recording, type Units } from './model'

use([LineChart, GridComponent, TooltipComponent, DataZoomComponent, MarkAreaComponent, CanvasRenderer])

type ChartProps = {
  recordings: Recording[]
  seriesKey: Metric | 'powerCurve' | `dev:${string}`
  bounds: Range
  range: Range | null
  lap?: Range
  units: Units
  onCursor: (time: number | null) => void
  onRange: (range: Range | null) => void
}

function smoothPoints(recording: Recording, key: ChartProps['seriesKey'], units: Units, smoothing: number) {
  if (key === 'powerCurve') return powerCurve(recording)
  const data: Array<[number, number | null]> = []
  const samples = recording.samples
  let lastValid: number | undefined
  let windowStart = 0
  let sum = 0
  let count = 0
  const name = key.startsWith('dev:') ? key.slice(4) : null
  const values = samples.map(s => name ? s.developer?.[name] : s[key as Metric])
  for (let i = 0; i < samples.length; i++) {
    const p = samples[i]
    const time = adjusted(p, recording)
    const value = values[i]
    if (value === undefined) continue
    if (lastValid !== undefined && time - lastValid > 5_000) {
      data.push([lastValid + 1, null])
      windowStart = i
      sum = 0
      count = 0
    }
    sum += value
    count++
    while (windowStart < i && p.t - samples[windowStart].t > smoothing * 1000) {
      const stale = values[windowStart++]
      if (stale !== undefined) { sum -= stale; count-- }
    }
    const visible = smoothing ? sum / count : value
    data.push([time, name ? visible : displayValue(key as Metric, visible, units)])
    lastValid = time
  }
  return data
}

export function TelemetryChart(props: ChartProps & { smoothing: number; cursor: number | null }) {
  const { recordings, seriesKey, bounds, range, lap, units, onCursor, onRange, smoothing, cursor } = props
  const node = useRef<HTMLDivElement>(null)
  const instance = useRef<ECharts | null>(null)
  const gesture = useRef<number | null>(null)
  const focused = useRef(false)
  const latest = useRef(props)
  latest.current = props

  useEffect(() => {
    if (!node.current) return
    const chart = init(node.current, undefined, { renderer: 'canvas' })
    instance.current = chart
    const observer = new ResizeObserver(() => chart.resize())
    observer.observe(node.current)
    const renderer = chart.getZr()
    function position(x: number, y: number) {
      return chart.containPixel({ gridIndex: 0 }, [x, y])
        ? Number(chart.convertFromPixel({ xAxisIndex: 0 }, x)) : null
    }
    renderer.on('mousemove', e => {
      if (latest.current.seriesKey === 'powerCurve') return
      focused.current = true
      latest.current.onCursor(position(e.offsetX, e.offsetY))
    })
    renderer.on('globalout', () => {
      focused.current = false
      gesture.current = null
      latest.current.onCursor(null)
    })
    renderer.on('mousedown', e => { gesture.current = position(e.offsetX, e.offsetY) })
    renderer.on('mouseup', e => {
      const start = gesture.current
      gesture.current = null
      if (start === null || latest.current.seriesKey === 'powerCurve') return
      const end = position(e.offsetX, e.offsetY)
      const width = Math.abs(Number(chart.convertToPixel({ xAxisIndex: 0 }, start)) - e.offsetX)
      if (end !== null && width > 8) latest.current.onRange([Math.min(start, end), Math.max(start, end)])
    })
    renderer.on('dblclick', () => latest.current.onRange(null))
    return () => { observer.disconnect(); chart.dispose(); instance.current = null }
  }, [])

  useEffect(() => {
    const chart = instance.current
    if (!chart) return
    const curve = seriesKey === 'powerCurve'
    const timeRange = range ?? bounds
    const unit = curve ? 'W' : seriesKey.startsWith('dev:') ? '' : metricUnit(seriesKey as Metric, units)
    const series = recordings.filter(r => !r.hidden).map((r, index) => ({
      id: r.id, name: r.name, type: 'line', showSymbol: false, connectNulls: false, sampling: 'lttb',
      data: smoothPoints(r, seriesKey, units, smoothing), color: r.color,
      lineStyle: { width: 2, color: r.color, type: index % 2 && seriesKey === 'powerCurve' ? 'dashed' : 'solid' },
      itemStyle: { color: r.color },
      markArea: !curve && index === 0 && lap ? {
        silent: true, itemStyle: { color: 'rgba(79,70,229,.07)' }, data: [[{ xAxis: lap[0] }, { xAxis: lap[1] }]],
      } : undefined,
    }))
    const options: EChartsCoreOption = {
      animation: false, textStyle: { fontFamily: 'Inter, system-ui, sans-serif' },
      grid: { top: 29, bottom: 36, left: 51, right: 26 },
      xAxis: {
        type: curve ? 'log' : 'value', min: curve ? 1 : timeRange[0], max: curve ? undefined : Math.max(timeRange[0] + 1, timeRange[1]),
        axisTick: { show: false }, axisLine: { lineStyle: { color: '#dfe3ed' } },
        axisLabel: { color: '#687286', margin: 11, formatter: (t: number) => timeLabel(curve ? t : (t - bounds[0]) / 1000) },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value', scale: true, splitNumber: 4, name: unit, nameTextStyle: { color: '#687286', fontSize: 11 },
        axisLabel: { color: '#687286', formatter: (n: number) => Math.abs(n) >= 100 ? n.toFixed(0) : String(Number(n.toFixed(2))) },
        splitLine: { lineStyle: { color: '#e9ecf3', type: 'dashed' } },
      },
      tooltip: { trigger: 'axis', renderMode: 'richText', confine: true, axisPointer: { type: 'line', lineStyle: { color: '#9595c1' } }, valueFormatter: (v: unknown) => typeof v === 'number' ? `${v.toFixed(1)} ${unit}` : '—' },
      series,
    }
    chart.setOption(options, { notMerge: true })
  }, [recordings, seriesKey, bounds, range, lap, units, smoothing])

  useEffect(() => {
    const chart = instance.current
    if (!chart || focused.current || seriesKey === 'powerCurve') return
    if (cursor === null) {
      chart.dispatchAction({ type: 'hideTip' })
      return
    }
    const x = chart.convertToPixel({ xAxisIndex: 0 }, cursor)
    if (Number.isFinite(x)) chart.dispatchAction({ type: 'updateAxisPointer', x, y: 40 })
  }, [cursor, seriesKey])

  const label = seriesKey === 'powerCurve' ? 'Mean max power' : seriesKey.startsWith('dev:') ? seriesKey.slice(4) : metricNames[seriesKey as Metric]
  return <div ref={node} className="chart-canvas" role="img" aria-label={`${label} comparison chart`} />
}
