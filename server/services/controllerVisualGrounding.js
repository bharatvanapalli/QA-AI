'use strict';

function clean(value) {
  return String(value == null ? '' : value).trim();
}

/**
 * Resolves visual pixel coordinates for a target using live DOM bounding box
 * extraction across standard elements, canvas, SVG icons, and text nodes.
 */
async function resolveVisualTargetCoordinates(page, { targetText, targetRole, selector } = {}) {
  if (!page) return null;
  const targetLabel = clean(targetText).toLowerCase();
  if (!targetLabel && !selector) return null;

  try {
    const visualBox = await page.evaluate(({ label, sel, role }) => {
      function getVisibleBoundingBox(el) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight && rect.bottom > 0) {
          return {
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            centerX: Math.round(rect.left + rect.width / 2),
            centerY: Math.round(rect.top + rect.height / 2),
          };
        }
        return null;
      }

      // 1. Selector match
      if (sel) {
        try {
          const el = document.querySelector(sel);
          if (el) {
            const box = getVisibleBoundingBox(el);
            if (box) return { ...box, source: 'selector_match' };
          }
        } catch (_) {}
      }

      // 2. Scan interactive elements, SVG icons, and buttons
      const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], input, select, textarea, svg, [role="checkbox"], [role="switch"], [role="tab"], canvas, div[tabindex]'));
      for (const el of candidates) {
        const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || '').trim().toLowerCase();
        if (label && (text === label || text.includes(label))) {
          const box = getVisibleBoundingBox(el);
          if (box) return { ...box, source: 'semantic_text_match' };
        }
      }

      // 3. Fallback: Full body text-node search for label
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
      let textNode;
      while ((textNode = walker.nextNode())) {
        const val = (textNode.nodeValue || '').trim().toLowerCase();
        if (label && val.includes(label)) {
          const parent = textNode.parentElement;
          if (parent) {
            const box = getVisibleBoundingBox(parent);
            if (box) return { ...box, source: 'text_parent_node' };
          }
        }
      }

      return null;
    }, { label: targetLabel, sel: selector || null, role: targetRole || null });

    if (visualBox && visualBox.centerX > 0 && visualBox.centerY > 0) {
      return {
        ...visualBox,
        confidence: 0.95,
      };
    }
    return null;
  } catch (_) {
    return null;
  }
}

/**
 * Dispatches real physical mouse interactions to pixel coordinates.
 */
async function dispatchPhysicalMouseAction(page, { x, y, actionType = 'click', clickCount = 1, button = 'left' } = {}) {
  if (!page || typeof x !== 'number' || typeof y !== 'number') return false;
  try {
    await page.mouse.move(x, y);
    if (actionType === 'dblclick' || clickCount === 2) {
      await page.mouse.dblclick(x, y, { button });
    } else if (actionType === 'rightclick' || button === 'right') {
      await page.mouse.click(x, y, { button: 'right' });
    } else {
      await page.mouse.click(x, y, { button: 'left', clickCount: 1 });
    }
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  resolveVisualTargetCoordinates,
  dispatchPhysicalMouseAction,
};
