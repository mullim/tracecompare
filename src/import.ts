import { maxFileBytes, type Original, type Recording } from './model'
import { parseXml, type Decoded } from './parsers'

export async function openRecording(file: File): Promise<{ recording: Omit<Recording, 'color' | 'offset'>; original: Original }> {
  const ext = file.name.split('.').at(-1)?.toLowerCase()
  if (!['fit', 'tcx', 'gpx'].includes(ext ?? '')) throw new Error('Choose a FIT, TCX, or GPX workout.')
  if (file.size > maxFileBytes) throw new Error('This file exceeds 25 MB.')
  const buffer = await file.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let decoded: Decoded
  if (ext === 'fit') {
    decoded = await new Promise<Decoded>((resolve, reject) => {
      const worker = new Worker(new URL('./fit.worker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = ({ data }) => {
        worker.terminate()
        if (data.error) reject(new Error(data.error))
        else resolve(data.recording)
      }
      worker.onerror = () => {
        worker.terminate()
        reject(new Error('The FIT decoder could not open this file.'))
      }
      const transferable = buffer.slice(0)
      worker.postMessage(transferable, [transferable])
    })
  } else {
    decoded = parseXml(new TextDecoder().decode(bytes), ext as 'gpx' | 'tcx')
  }
  const id = crypto.randomUUID()
  return { recording: { id, name: file.name.replace(/\.[^.]+$/, ''), ...decoded }, original: { id, name: file.name, bytes } }
}
