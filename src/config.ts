// Voice search talks to a small local proxy (see server/) that holds the
// Groq API key server-side — see server/README or the repo root README for
// how to run it. Update this if you ever deploy the proxy elsewhere.
export const VOICE_API_BASE_URL = 'http://localhost:8787';
// Shared by both /voice-intent and /text-intent — both run the same
// LLM intent-extraction round-trip under the hood.
export const INTENT_REQUEST_TIMEOUT_MS = 20_000;
export const MAX_RECORDING_MS = 15_000;
export const MAX_AUDIO_BYTES = 5 * 1024 * 1024;
