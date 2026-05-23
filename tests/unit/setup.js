import '@testing-library/jest-dom/vitest';

// jsdom doesn't ship a matchMedia implementation; several components query it
// (or read it via Tailwind's `prefers-reduced-motion` keyframe guard). Stub
// the API so tests don't crash on first render.
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}
