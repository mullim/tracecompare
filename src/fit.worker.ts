import { parseFit } from './parsers'

self.onmessage = async (event: MessageEvent<ArrayBuffer>) => {
  try {
    self.postMessage({ recording: await parseFit(event.data) })
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
}
