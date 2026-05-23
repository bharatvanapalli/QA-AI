import React from 'react';
import { Cpu } from 'lucide-react';
import ProjectProviderSection from './ProjectProviderSection';

/**
 * Settings → AI Provider.
 *
 * Dedicated tab for the per-project provider choice. Lifted out of the
 * Claude / Gemini API pages because users were confused seeing a "pick
 * Claude or Gemini" toggle on a page already labeled with one specific
 * provider — the toggle is project-scoped, not provider-scoped, so it
 * belongs on its own tab.
 *
 * Flow:
 *   1. Settings → AI Provider — pick which provider this project uses.
 *   2. Settings → {chosen provider} API — paste the key, save.
 */
export default function AiProviderSettings() {
  return (
    <div className="max-w-3xl space-y-6">
      <header>
        <div className="flex items-center gap-2">
          <Cpu className="w-5 h-5 text-accent-600" aria-hidden="true" />
          <h2 className="text-xl font-bold text-ink-900">AI Provider</h2>
        </div>
        <p className="text-sm text-ink-500 mt-1">
          Choose which LLM provider runs every agent (Architect, Planner, Conductor,
          Critic, Supervisor, Analyst, Reporter, RCA Chat) for the active project.
          The chosen provider must have a valid API key configured on its own settings tab.
        </p>
      </header>

      <ProjectProviderSection />

      <div className="rounded-md bg-info-50 border border-info-200 text-info-900 text-xs p-3 space-y-1">
        <div className="font-semibold">How this works</div>
        <ol className="list-decimal pl-5 space-y-0.5">
          <li>Pick a provider here.</li>
          <li>Go to <strong>Settings → Claude API</strong> or <strong>Settings → Gemini API</strong> and save a key for it.</li>
          <li>Run agents from <strong>Run Suite</strong> — they'll route through your chosen provider.</li>
        </ol>
      </div>
    </div>
  );
}
