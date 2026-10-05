import ortJsepModuleUrl from '../../node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.mjs?url'
import ortJsepWasmUrl from '../../node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.wasm?url'

export type KokoroRequest = {
  id: number
  type: 'load' | 'generate'
  text?: string
  voice?: string
  speed?: number
}

export type KokoroResponse =
  | { type: 'progress'; progress: number }
  | { type: 'ready'; id: number; voices: string[] }
  | { type: 'audio'; id: number; audio: Blob }
  | { type: 'error'; id: number; error: string }

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<KokoroRequest>) => void) | null
  postMessage: (message: KokoroResponse) => void
}

let model: import('kokoro-js').KokoroTTS | null = null
let queue = Promise.resolve()

async function handle(request: KokoroRequest) {
  try {
    if (!model) {
      const { KokoroTTS, env } = await import('kokoro-js')
      const { env: transformersEnv } = await import('@huggingface/transformers')
      const wasm = transformersEnv.backends.onnx.wasm
      if (!wasm) throw new Error('Kokoro WASM backend is unavailable')
      wasm.numThreads = 1
      env.wasmPaths = { mjs: ortJsepModuleUrl, wasm: ortJsepWasmUrl }
      model = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
        dtype: 'q8',
        device: 'wasm',
        progress_callback: (event: unknown) => {
          const progress = (event as { progress?: number })?.progress
          if (typeof progress === 'number') scope.postMessage({ type: 'progress', progress: progress / 100 })
        },
      })
    }
    if (request.type === 'load') {
      scope.postMessage({ type: 'ready', id: request.id, voices: Object.keys(model.voices) })
    } else {
      const audio = await model.generate(request.text!, {
        voice: request.voice as keyof typeof model.voices,
        speed: request.speed,
      })
      scope.postMessage({ type: 'audio', id: request.id, audio: audio.toBlob() })
    }
  } catch (error) {
    scope.postMessage({ type: 'error', id: request.id, error: String((error as Error)?.message ?? error) })
  }
}

scope.onmessage = ({ data }) => {
  queue = queue.then(() => handle(data))
}