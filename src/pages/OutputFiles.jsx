import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { FileCode, Folder, Copy, Check, Download } from 'lucide-react';
import api from '../lib/apiClient';
import { BASE_URL } from '../lib/apiClient';
import { useProject } from '../store/project';
import { useToast } from '../lib/useToast';
import PageHeader from '../components/PageHeader';
import EmptyState from '../components/EmptyState';
import Button from '../components/ui/Button';
import { tokenizeTs, TOKEN_CLASSES } from '../lib/highlightTs';

export default function OutputFiles() {
  const { current } = useProject();
  const toast = useToast();
  const [files, setFiles] = useState([]);
  const [persisted, setPersisted] = useState([]);
  const [activeName, setActiveName] = useState(null);
  const [activeContent, setActiveContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    if (!current) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await api.get(`/projects/${current.id}/output-files`);
      setFiles(res.files || []);
      setPersisted(res.persisted || []);
      if ((res.files || []).length && !activeName) {
        setActiveName(res.files[0].name);
      }
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }, [current, toast, activeName]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!current || !activeName) {
      setActiveContent('');
      return;
    }
    (async () => {
      try {
        // The list endpoint returns nested paths like "tests/qaai-ui/foo.spec.ts".
        // We must hit the /file/* viewer route (which captures the nested path),
        // NOT the legacy /:name route whose regex rejects slashes. Per-segment
        // encoding preserves the path structure while still escaping any
        // special chars in individual segments.
        const encoded = activeName.split('/').map(encodeURIComponent).join('/');
        const res = await api.get(`/projects/${current.id}/output-files/file/${encoded}`);
        setActiveContent(res.content || '');
      } catch (err) {
        // Disk read failed — fall back to the persisted spec code if this is
        // a flat name that matches a TestCase row's synthetic filename.
        const p = persisted.find((x) => `${x.id.replace(/[^a-zA-Z0-9_-]/g, '_')}.spec.ts` === activeName);
        setActiveContent(p?.specCode || '');
      }
    })();
  }, [current, activeName, persisted]);

  // Pre-tokenise the active file content once per change; the render path
  // just maps tokens to <span>s. For files up to a few thousand lines this is
  // sub-millisecond and avoids re-tokenising on unrelated re-renders.
  const highlighted = useMemo(() => {
    if (!activeContent) return null;
    return tokenizeTs(activeContent);
  }, [activeContent]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(activeContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (_) {}
  };

  const [downloading, setDownloading] = useState(false);
  const downloadZip = useCallback(async () => {
    if (!current) return;
    setDownloading(true);
    try {
      const resp = await fetch(
        `${BASE_URL}/projects/${current.id}/output-files/download.zip`,
        { credentials: 'include' }
      );
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(text || `Download failed (HTTP ${resp.status})`);
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const safe = current.name.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'qaai-project';
      a.href = url;
      a.download = `${safe}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success('Project zip downloaded.');
    } catch (err) {
      toast.error(err.message, { title: 'Download failed' });
    } finally {
      setDownloading(false);
    }
  }, [current, toast]);

  if (!current) {
    return (
      <div className="flex flex-col h-full">
        <PageHeader title="Output Files" />
        <EmptyState icon={FileCode} title="No project selected" message="Activate a project." />
      </div>
    );
  }

  const totalFiles = files.length + persisted.filter((p) => !files.some((f) => f.name.includes(p.id))).length;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <PageHeader title="Output Files" subtitle={`${totalFiles} generated spec file${totalFiles === 1 ? '' : 's'}`}>
        <Button size="sm" onClick={downloadZip} disabled={!totalFiles || downloading} loading={downloading}>
          <Download className="w-3.5 h-3.5" />
          Download project.zip
        </Button>
      </PageHeader>

      <main className="flex-1 grid grid-cols-[300px_1fr] overflow-hidden bg-ink-50">
        <aside className="border-r border-ink-200 bg-white overflow-y-auto">
          <div className="px-3 py-2 text-xs font-bold text-ink-700 uppercase tracking-wider flex items-center gap-1.5">
            <Folder className="w-3.5 h-3.5" />
            playwright/tests
          </div>
          {loading ? (
            <div className="text-xs text-ink-500 px-3">Loading…</div>
          ) : totalFiles === 0 ? (
            <EmptyState
              icon={FileCode}
              title="No specs generated"
              message="Specs are generated when you run approved test cases."
            />
          ) : (
            <>
              {files.map((f) => (
                <button
                  key={f.name}
                  onClick={() => setActiveName(f.name)}
                  className={`flex items-center gap-2 w-full text-left px-3 py-2 border-b border-ink-100 hover:bg-ink-50 ${
                    activeName === f.name ? 'bg-ink-50' : ''
                  }`}
                >
                  <FileCode className="w-3.5 h-3.5 text-ink-500" />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-mono text-ink-900 truncate">{f.name}</div>
                    <div className="text-2xs text-ink-500">
                      {(f.sizeBytes / 1024).toFixed(1)} KB · {new Date(f.mtime).toLocaleString()}
                    </div>
                  </div>
                </button>
              ))}
            </>
          )}
        </aside>

        <section className="overflow-y-auto p-4">
          {!activeName ? (
            <EmptyState icon={FileCode} title="Select a spec" message="Pick a generated spec from the left." />
          ) : (
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="font-mono text-xs text-ink-700">{activeName}</span>
                <button
                  onClick={copy}
                  className="text-xs text-ink-600 hover:text-ink-900 inline-flex items-center gap-1"
                >
                  {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <pre className="rounded-lg bg-ink-900 text-ink-100 text-xs p-4 overflow-x-auto font-mono leading-relaxed">
                {highlighted ? (
                  highlighted.map((t, i) => (
                    <span key={i} className={TOKEN_CLASSES[t.kind] || ''}>{t.text}</span>
                  ))
                ) : (
                  <span className="text-ink-500 italic">// File empty or not found.</span>
                )}
              </pre>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
