import React, { useState, useEffect } from 'react';
import { Cpu, CheckCircle2, XCircle, RefreshCw, Server, HelpCircle } from 'lucide-react';
import Button from '../../components/ui/Button';
import ProjectProviderSection from './ProjectProviderSection';

export default function CopilotSettings() {
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState(null);

  const testConnection = async () => {
    setTesting(true);
    setStatus(null);
    try {
      const res = await fetch('http://127.0.0.1:5005/health');
      if (res.ok) {
        const data = await res.json();
        setStatus({ ok: true, data });
      } else {
        setStatus({ ok: false, error: `HTTP ${res.status}: ${res.statusText}` });
      }
    } catch (err) {
      setStatus({ ok: false, error: err.message || 'Connection refused on http://127.0.0.1:5005' });
    } finally {
      setTesting(false);
    }
  };

  useEffect(() => {
    testConnection();
  }, []);

  return (
    <div className="max-w-3xl space-y-6">
      <header>
        <div className="flex items-center gap-2">
          <Cpu className="w-5 h-5 text-accent-600" aria-hidden="true" />
          <h2 className="text-xl font-bold text-ink-900">GitHub Copilot (VS Code Bridge)</h2>
        </div>
        <p className="text-sm text-ink-500 mt-1">
          Route QAAI agents through your active VS Code GitHub Copilot session. Zero API keys required.
        </p>
      </header>

      <ProjectProviderSection />

      <div className="rounded-lg border border-ink-200 bg-white p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Server className="w-5 h-5 text-info-600" />
            <h3 className="font-semibold text-ink-900">VS Code Bridge Server Status</h3>
          </div>
          <Button size="sm" variant="outline" onClick={testConnection} loading={testing}>
            <RefreshCw className="w-3.5 h-3.5" /> Test Bridge Connection
          </Button>
        </div>

        {status && (
          <div className={`p-4 rounded-md border text-sm flex items-start gap-3 ${status.ok ? 'bg-success-50 border-success-200 text-success-900' : 'bg-danger-50 border-danger-200 text-danger-900'}`}>
            {status.ok ? <CheckCircle2 className="w-5 h-5 text-success-600 shrink-0 mt-0.5" /> : <XCircle className="w-5 h-5 text-danger-600 shrink-0 mt-0.5" />}
            <div>
              <div className="font-semibold">{status.ok ? 'Copilot Bridge Connected!' : 'Copilot Bridge Not Found'}</div>
              <p className="text-xs mt-1">
                {status.ok
                  ? `Active on http://127.0.0.1:5005 (${status.data?.bridge || 'QAAI Copilot Bridge'}). Ready to process AI requests via VS Code.`
                  : `${status.error}. Ensure VS Code is open with the QAAI Copilot Bridge extension installed.`}
              </p>
            </div>
          </div>
        )}

        <div className="rounded-md bg-ink-50 border border-ink-200 text-xs p-4 space-y-2 text-ink-700">
          <div className="font-semibold text-ink-900 flex items-center gap-1.5">
            <HelpCircle className="w-4 h-4 text-accent-600" /> Quick Setup Instructions:
          </div>
          <ol className="list-decimal pl-5 space-y-1">
            <li>Ensure <strong>GitHub Copilot Extension</strong> is installed and signed in inside VS Code.</li>
            <li>Install the <strong>qaai-copilot-bridge-1.0.0.vsix</strong> file in VS Code (Extensions → <code>...</code> → Install from VSIX).</li>
            <li>Click <strong>Test Bridge Connection</strong> above to verify connection.</li>
            <li>Select <strong>GitHub Copilot (VS Code Bridge)</strong> in the Active AI Provider dropdown above.</li>
          </ol>
        </div>
      </div>
    </div>
  );
}
