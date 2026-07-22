import { STORE_ASSISTANT_LABEL } from './shared/store';

// Ported from Dhaaga's extension/src/microphone.ts. MV3 popups can't
// reliably keep a getUserMedia permission grant across popup close/reopen —
// this dedicated tab is where the one-time browser permission prompt
// actually sticks.
export {}; // force module scope — otherwise top-level `status` collides with the ambient window.status global

const enableButton = mustElement<HTMLButtonElement>('enable-microphone');
const closeButton = mustElement<HTMLButtonElement>('close-setup');
const message = mustElement('permission-message');
const status = mustElement('permission-status');

function mustElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing microphone setup element: ${id}`);
  return element as T;
}

function showReady(): void {
  status.textContent = `Microphone is ready. Return to the ${STORE_ASSISTANT_LABEL} popup and tap the mic again.`;
  status.className = 'status success';
  message.textContent = `Permission granted. ${STORE_ASSISTANT_LABEL} will access the microphone only when you tap the mic button.`;
  enableButton.hidden = true;
  closeButton.hidden = false;
  closeButton.focus();
}

function errorMessage(error: unknown): string {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone access is blocked. Use the microphone control in Chrome’s address bar or site settings, allow access, then try again.';
  }
  if (name === 'NotFoundError') {
    return 'No microphone was found. Connect or enable one in your system settings, then try again.';
  }
  return 'Chrome could not open the microphone. Check your browser and system microphone settings, then try again.';
}

async function enableMicrophone(): Promise<void> {
  enableButton.disabled = true;
  status.className = 'status';
  status.textContent = 'Waiting for Chrome…';
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Media devices are unavailable');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    showReady();
  } catch (error) {
    status.textContent = errorMessage(error);
    status.className = 'status error';
    enableButton.disabled = false;
  }
}

enableButton.addEventListener('click', () => void enableMicrophone());
closeButton.addEventListener('click', () => window.close());

if (navigator.permissions) {
  void navigator.permissions
    .query({ name: 'microphone' as PermissionName })
    .then((permission) => {
      if (permission.state === 'granted') showReady();
    })
    .catch(() => undefined);
}
