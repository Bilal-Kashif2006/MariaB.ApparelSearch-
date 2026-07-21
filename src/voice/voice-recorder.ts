// Ported from Dhaaga's extension/src/voice.ts — plain MediaRecorder capture,
// no backend dependency of its own.
import { MAX_RECORDING_MS } from '../config';

export type RecordingFinished = (blob: Blob, mimeType: string) => void | Promise<void>;

export function preferredAudioMimeType(): string {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  return types.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

export class VoiceRecorder {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private autoStopTimer: number | null = null;
  private cancelled = false;

  constructor(private readonly onFinished: RecordingFinished) {}

  get isRecording(): boolean {
    return this.recorder?.state === 'recording';
  }

  async start(): Promise<void> {
    if (this.isRecording) return;
    this.cancelled = false;
    this.chunks = [];
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = preferredAudioMimeType();
    this.recorder = mimeType ? new MediaRecorder(this.stream, { mimeType }) : new MediaRecorder(this.stream);

    this.recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    });
    this.recorder.addEventListener(
      'stop',
      () => {
        const actualType = this.recorder?.mimeType || mimeType || 'audio/webm';
        const blob = new Blob(this.chunks, { type: actualType });
        this.cleanup();
        if (!this.cancelled) void this.onFinished(blob, actualType);
      },
      { once: true },
    );
    this.recorder.addEventListener('error', () => this.cleanup(), { once: true });
    this.recorder.start(750);
    this.autoStopTimer = window.setTimeout(() => this.stop(), MAX_RECORDING_MS);
  }

  stop(): void {
    if (this.recorder?.state === 'recording') this.recorder.stop();
  }

  cancel(): void {
    this.cancelled = true;
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    else this.cleanup();
  }

  private cleanup(): void {
    if (this.autoStopTimer !== null) window.clearTimeout(this.autoStopTimer);
    this.autoStopTimer = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
  }
}
