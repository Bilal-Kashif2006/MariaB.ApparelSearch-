import Groq, { toFile } from 'groq-sdk';

const WHISPER_MODEL = process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3-turbo';

export async function transcribeAudio(
  client: Groq,
  audio: Buffer,
  mimeType: string,
): Promise<string> {
  const extension = mimeType.split('/')[1]?.split(';')[0] || 'webm';
  const file = await toFile(audio, `voice-query.${extension}`, { type: mimeType });
  const transcription = await client.audio.transcriptions.create({
    file,
    model: WHISPER_MODEL,
    response_format: 'json',
  });
  return transcription.text;
}
