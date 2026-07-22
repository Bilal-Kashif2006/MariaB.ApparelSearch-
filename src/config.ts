// Voice search talks to a small local proxy (see server/) that holds the
// Groq API key server-side — see server/README or the repo root README for
// how to run it. Update this if you ever deploy the proxy elsewhere.
export const VOICE_API_BASE_URL = 'http://localhost:8787';
// Shared by both /voice-intent and /text-intent — both run the same
// LLM intent-extraction round-trip under the hood.
export const INTENT_REQUEST_TIMEOUT_MS = 20_000;
export const MAX_RECORDING_MS = 15_000;
export const MAX_AUDIO_BYTES = 5 * 1024 * 1024;
export const CONVERSATION_KEY = 'bareezeConversation';
export const LAYOUT_KEY = 'bareezeExpandedLayout';
// Chat history older than this is treated as stale and reset on next open
// (same threshold Resham uses) rather than resuming a months-old thread.
export const CONVERSATION_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
