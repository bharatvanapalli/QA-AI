import { useState, useEffect } from 'react';
import { WifiOff, X } from 'lucide-react';

/**
 * Shows a single persistent amber banner when the backend becomes unreachable,
 * instead of N individual "Failed to fetch" error toasts. Listens for the
 * `qaai:connectivity` custom event emitted by apiClient.js normaliseError().
 * Auto-clears when the next successful request restores connectivity.
 */
export default function ConnectivityBanner() {
  const [offline, setOffline] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    function handle(e) {
      const online = e.detail?.online ?? true;
      setOffline(!online);
      // Reset dismiss so banner reappears if connectivity drops again after being closed.
      if (!online) setDismissed(false);
    }
    window.addEventListener('qaai:connectivity', handle);
    return () => window.removeEventListener('qaai:connectivity', handle);
  }, []);

  if (!offline || dismissed) return null;

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="flex items-center gap-3 px-4 py-2.5 bg-warn-100 border-b border-warn-300 text-warn-800 text-sm"
    >
      <WifiOff className="w-4 h-4 shrink-0 text-warn-600" aria-hidden="true" />
      <span className="flex-1">
        <strong className="font-semibold">Server connection lost.</strong>{' '}
        Some features may be unavailable. The page will recover automatically once the server is back.
      </span>
      <button
        type="button"
        aria-label="Dismiss connection warning"
        onClick={() => setDismissed(true)}
        className="shrink-0 rounded p-1 hover:bg-warn-200 focus-visible:outline-none focus-visible:shadow-ring text-warn-700"
      >
        <X className="w-4 h-4" aria-hidden="true" />
      </button>
    </div>
  );
}
