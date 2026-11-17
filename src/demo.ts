import { colors, type Sample, type Workspace } from './model'
import { metersBetween } from './parsers'

const route: Array<[number, number]> = [
  [-73.9769, 40.7678], [-73.9748, 40.7690], [-73.9734, 40.7701], [-73.9723, 40.7718],
  [-73.9716, 40.7734], [-73.9694, 40.7754], [-73.9666, 40.7773], [-73.9629, 40.7811],
  [-73.9617, 40.7832], [-73.9630, 40.7853], [-73.9660, 40.7844], [-73.9685, 40.7825],
  [-73.9701, 40.7806], [-73.9712, 40.7792], [-73.9715, 40.7779], [-73.9740, 40.7760],
  [-73.9751, 40.7740], [-73.9765, 40.7724], [-73.9778, 40.7701], [-73.9769, 40.7678],
]
const start = Date.UTC(2026, 9, 24, 12, 15)
const duration = 33 * 60 + 18

export function demo(): Workspace {
  const recordings = ['Garmin Forerunner 970', 'Apple Watch Ultra'].map((device, index) => {
    const samples: Sample[] = []
    let distance = 0
    for (let elapsed = 0; elapsed <= duration; elapsed += 2) {
      const position = Math.min(route.length - 1.00001, elapsed / duration * (route.length - 1))
      const segment = Math.floor(position)
      const fraction = position - segment
      const [firstLon, firstLat] = route[segment]
      const [lastLon, lastLat] = route[segment + 1]
      const deviation = index ? 0.00006 + 0.00006 * Math.sin(elapsed / 70) + 0.00033 * Math.exp(-((elapsed - 1160) ** 2) / 6500) : 0
      const move = Math.sin(elapsed / 38)
      const t = start + elapsed * 1000
      const point: Sample = {
        t,
        lon: firstLon + fraction * (lastLon - firstLon) + deviation,
        lat: firstLat + fraction * (lastLat - firstLat) - deviation * 0.33,
        hr: Math.round(116 + Math.min(26, elapsed / 16) + 9 * Math.sin((elapsed - index * 9) / 113) + move * 3 + index * (2 + Math.sin(elapsed / 53) * 4)),
        speed: 2.94 + move * 0.31 + Math.sin(elapsed / 113) * 0.34 + index * 0.045,
        elevation: 25 + 11 * Math.sin(elapsed / 160) + elapsed / 1800 + index * 1.4,
        cadence: Math.round(166 + move * 4 + Math.sin(elapsed / 18) * 2 + index),
        power: Math.round(232 + move * 17 + Math.sin(elapsed / 91) * 20 + index * 9),
      }
      if (samples.length) distance += (metersBetween(samples.at(-1)!, point) ?? 0) * (index ? 1.016 : 1)
      point.distance = distance
      if (index && elapsed > 1470 && elapsed < 1493) delete point.hr
      samples.push(point)
    }
    return {
      id: `demo-${index}`, name: device, device, source: 'Demo', color: colors[index], offset: 0, samples,
      laps: [0, 480, 960, 1440].map((s, i) => ({ start: start + s * 1000, end: start + ([480, 960, 1440, duration][i]) * 1000 })),
    }
  })
  return { project: { version: 1, title: 'Morning park loop', recordings, reference: recordings[0].id }, originals: [] }
}
