'use strict';

const MONTH_NAMES = Object.freeze([
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]);

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function calendarChoiceAliases(kind, value) {
  const normalizedKind = clean(kind).toLowerCase();
  if (normalizedKind === 'month') {
    const month = Number(value);
    if (!Number.isInteger(month) || month < 1 || month > 12) return Object.freeze([]);
    const name = MONTH_NAMES[month - 1];
    return Object.freeze([name, name.slice(0, 3)]);
  }
  if (normalizedKind === 'year' || normalizedKind === 'day') {
    const numeric = Number(value);
    return Number.isInteger(numeric) ? Object.freeze([String(numeric)]) : Object.freeze([]);
  }
  return Object.freeze([]);
}

function buildCalendarExactClickFunction({ kind, aliases, action = 'choice' } = {}) {
  const normalizedKind = clean(kind).toLowerCase();
  if (!aliases.length) {
    throw new TypeError(`Calendar ${normalizedKind || action} requires exact aliases.`);
  }
  const payload = Object.freeze({
    kind: normalizedKind,
    aliases,
    action: clean(action).toLowerCase() || 'choice',
  });
  const ambiguousReason = `calendar_${payload.action}_ambiguous`;
  const notFoundReason = `calendar_${payload.action}_not_found`;
  const clickedReason = `exact_calendar_${payload.action}_clicked`;

  return `() => {
    const payload = ${JSON.stringify(payload)};
    const clean = (value) => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
    const normalize = (value) => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\\s+/g, ' ').trim();
    const expected = new Set(payload.aliases.map(normalize));
    const visible = (node) => {
      if (!node || node.nodeType !== 1) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
        && rect.width > 0 && rect.height > 0;
    };
    const deepElements = (root, output = []) => {
      for (const node of Array.from(root?.querySelectorAll?.('*') || [])) {
        output.push(node);
        if (node.shadowRoot) deepElements(node.shadowRoot, output);
      }
      return output;
    };
    const identityTexts = (node) => [
      node?.getAttribute?.('aria-label'),
      node?.getAttribute?.('title'),
      node?.textContent,
    ].map(clean).filter((value) => value && value.length <= 80);
    const surfaces = deepElements(document).filter((node) => {
      if (!visible(node)) return false;
      const role = normalize(node.getAttribute?.('role'));
      const modal = normalize(node.getAttribute?.('aria-modal')) === 'true';
      if (role !== 'dialog' && !modal) return false;
      const identity = identityTexts(node).map(normalize);
      return identity.some((value) => /\\b(?:date|calendar)\\b/.test(value))
        || node.querySelector?.('[aria-label*="Month" i], [aria-label*="Year" i], [role="grid"]');
    });
    if (surfaces.length !== 1) {
      return JSON.stringify({
        ok: false,
        reason: surfaces.length ? 'calendar_surface_ambiguous' : 'calendar_surface_not_found',
        surfaceCount: surfaces.length,
      });
    }
    const surface = surfaces[0];
    const clickableSelector = [
      'button', '[role="button"]', '[role="gridcell"]', '[role="option"]',
      '[role="menuitem"]', '[tabindex]', 'td',
    ].join(',');
    const owners = new Map();
    for (const raw of [surface, ...deepElements(surface)]) {
      if (!visible(raw)) continue;
      const owner = raw.closest?.(clickableSelector) || raw;
      if (!surface.contains(owner) || !visible(owner)) continue;
      if (owner.disabled || normalize(owner.getAttribute?.('aria-disabled')) === 'true') continue;
      const identityOwner = payload.action === 'mode' ? owner : raw;
      const identities = identityTexts(identityOwner).map(normalize);
      const exact = payload.action === 'mode'
        ? identities.some((value) => (
          expected.has(value)
            || [...expected].some((alias) => value.startsWith(alias + ' '))
        ))
        : identities.some((value) => expected.has(value));
      if (!exact) continue;
      const dispatchTarget = payload.action === 'mode' ? owner : raw;
      owners.set(dispatchTarget, dispatchTarget);
    }
    const rawCandidates = [...owners.values()];
    const candidates = payload.action === 'mode'
      ? rawCandidates
      : rawCandidates.filter((candidate) => !rawCandidates.some((other) => (
        other !== candidate && candidate.contains?.(other)
      )));
    if (!candidates.length && payload.action === 'mode') {
      const visibleIdentities = [surface, ...deepElements(surface)]
        .filter(visible)
        .flatMap(identityTexts)
        .map(normalize)
        .filter(Boolean);
      const modeAlreadyOpen = payload.kind === 'year'
        ? visibleIdentities.filter((value) => /^\\d{4}$/.test(value)).length >= 3
          || visibleIdentities.some((value) => /\\b(?:previous|next) decade\\b/.test(value))
        : payload.kind === 'month'
          ? visibleIdentities.filter((value) => /^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)$/.test(value)).length >= 6
          : false;
      if (modeAlreadyOpen) {
        return {
          ok: true,
          reason: 'calendar_' + payload.kind + '_mode_already_open',
          kind: payload.kind,
          aliases: payload.aliases,
          candidateCount: 0,
        };
      }
    }
    if (candidates.length !== 1) {
      return JSON.stringify({
        ok: false,
        reason: candidates.length
          ? ${JSON.stringify(ambiguousReason)}
          : ${JSON.stringify(notFoundReason)},
        kind: payload.kind,
        aliases: payload.aliases,
        candidateCount: candidates.length,
      });
    }
    const owner = candidates[0];
    const before = identityTexts(owner);
    owner.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior: 'auto' });
    owner.click();
    return JSON.stringify({
      ok: true,
      reason: ${JSON.stringify(clickedReason)},
      kind: payload.kind,
      aliases: payload.aliases,
      candidateCount: 1,
      ownerRole: clean(owner.getAttribute?.('role') || owner.tagName).toLowerCase(),
      ownerText: before[0] || null,
    });
  }`;
}

function buildCalendarChoiceFunction({ kind, value } = {}) {
  const normalizedKind = clean(kind).toLowerCase();
  return buildCalendarExactClickFunction({
    kind: normalizedKind,
    aliases: calendarChoiceAliases(normalizedKind, value),
    action: 'choice',
  });
}

function buildCalendarModeFunction({ kind } = {}) {
  const normalizedKind = clean(kind).toLowerCase();
  const label = normalizedKind === 'year' ? 'Year'
    : normalizedKind === 'month' ? 'Month'
      : null;
  if (!label) throw new TypeError('Calendar mode must be year or month.');
  return buildCalendarExactClickFunction({
    kind: normalizedKind,
    aliases: [`Choose ${label}`, `Select ${label}`, label],
    action: 'mode',
  });
}

function buildTemporalOwnerReadFunction({ accessibleName } = {}) {
  const expectedName = clean(accessibleName);
  if (!expectedName) throw new TypeError('Temporal owner readback requires an accessible name.');
  const payload = Object.freeze({ accessibleName: expectedName });
  return `() => {
    const payload = ${JSON.stringify(payload)};
    const clean = (value) => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
    const normalize = (value) => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\\s+/g, ' ').trim();
    const visible = (node) => {
      if (!node || node.nodeType !== 1) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
        && rect.width > 0 && rect.height > 0;
    };
    const deepElements = (root, output = []) => {
      for (const node of Array.from(root?.querySelectorAll?.('*') || [])) {
        output.push(node);
        if (node.shadowRoot) deepElements(node.shadowRoot, output);
      }
      return output;
    };
    const labelledByText = (node) => clean(
      String(node?.getAttribute?.('aria-labelledby') || '')
        .split(/\\s+/)
        .filter(Boolean)
        .map((id) => document.getElementById(id)?.textContent)
        .filter(Boolean)
        .join(' '),
    );
    const associatedLabel = (node) => {
      const explicit = node?.id
        ? deepElements(document).find((candidate) => (
          candidate.tagName === 'LABEL'
            && candidate.getAttribute?.('for') === node.id
        ))
        : null;
      return clean(explicit?.textContent || node?.closest?.('label')?.textContent);
    };
    const accessibleName = (node) => clean(
      node?.getAttribute?.('aria-label')
        || labelledByText(node)
        || associatedLabel(node)
        || node?.getAttribute?.('placeholder')
        || node?.getAttribute?.('title'),
    );
    const expected = normalize(payload.accessibleName);
    const owners = deepElements(document).filter((node) => {
      if (!visible(node)) return false;
      const tag = clean(node.tagName).toLowerCase();
      const role = normalize(node.getAttribute?.('role'));
      const ownerLike = ['input', 'select', 'textarea'].includes(tag)
        || ['combobox', 'textbox', 'spinbutton'].includes(role)
        || node.isContentEditable === true;
      return ownerLike && normalize(accessibleName(node)) === expected;
    });
    const unique = [...new Set(owners)];
    if (unique.length !== 1) {
      return {
        ok: false,
        reason: unique.length
          ? 'temporal_owner_ambiguous'
          : 'temporal_owner_not_found',
        candidateCount: unique.length,
        accessibleName: payload.accessibleName,
      };
    }
    const owner = unique[0];
    const valueNodes = [owner, ...deepElements(owner)].filter((node) => {
      const tag = clean(node.tagName).toLowerCase();
      return ['input', 'select', 'textarea'].includes(tag)
        || node.isContentEditable === true
        || node.hasAttribute?.('aria-valuetext')
        || node.hasAttribute?.('aria-valuenow')
        || node.hasAttribute?.('value');
    });
    const values = [...new Set(valueNodes.map((node) => clean(
      node.value
        ?? node.getAttribute?.('value')
        ?? node.getAttribute?.('aria-valuetext')
        ?? node.getAttribute?.('aria-valuenow')
        ?? node.textContent,
    )).filter(Boolean))];
    if (values.length > 1) {
      return {
        ok: false,
        reason: 'temporal_owner_value_ambiguous',
        candidateCount: 1,
        valueCandidateCount: values.length,
        accessibleName: accessibleName(owner),
        role: clean(owner.getAttribute?.('role') || owner.tagName).toLowerCase(),
      };
    }
    const value = values[0] || '';
    return {
      ok: true,
      reason: 'exact_temporal_owner_read',
      candidateCount: 1,
      valueCandidateCount: values.length,
      accessibleName: accessibleName(owner),
      role: clean(owner.getAttribute?.('role') || owner.tagName).toLowerCase(),
      value,
    };
  }`;
}

function buildCalendarCommitFunction({ accessibleName, expectedDate } = {}) {
  const ownerName = clean(accessibleName);
  const canonicalDate = clean(expectedDate);
  if (!ownerName || !/^\d{4}-\d{2}-\d{2}$/.test(canonicalDate)) {
    throw new TypeError('Calendar commit requires an exact owner name and canonical date.');
  }
  const payload = Object.freeze({
    accessibleName: ownerName,
    expectedDate: canonicalDate,
    confirmAliases: ['OK', 'Apply', 'Done', 'Select', 'Confirm', 'Save'],
  });
  return `async () => {
    const payload = ${JSON.stringify(payload)};
    const clean = (value) => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
    const normalize = (value) => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\\s+/g, ' ').trim();
    const normalizeDate = (value) => {
      const text = clean(value);
      let match = text.match(/\\b(\\d{4})[\\/-](\\d{1,2})[\\/-](\\d{1,2})\\b/);
      if (match) return [match[1], match[2].padStart(2, '0'), match[3].padStart(2, '0')].join('-');
      match = text.match(/\\b(\\d{1,2})[\\/-](\\d{1,2})[\\/-](\\d{4})\\b/);
      if (match) return [match[3], match[1].padStart(2, '0'), match[2].padStart(2, '0')].join('-');
      return null;
    };
    const visible = (node) => {
      if (!node || node.nodeType !== 1) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
        && rect.width > 0 && rect.height > 0;
    };
    const deepElements = (root, output = []) => {
      for (const node of Array.from(root?.querySelectorAll?.('*') || [])) {
        output.push(node);
        if (node.shadowRoot) deepElements(node.shadowRoot, output);
      }
      return output;
    };
    const labelledByText = (node) => clean(
      String(node?.getAttribute?.('aria-labelledby') || '')
        .split(/\\s+/)
        .filter(Boolean)
        .map((id) => document.getElementById(id)?.textContent)
        .filter(Boolean)
        .join(' '),
    );
    const associatedLabel = (node) => {
      const explicit = node?.id
        ? deepElements(document).find((candidate) => (
          candidate.tagName === 'LABEL' && candidate.getAttribute?.('for') === node.id
        ))
        : null;
      return clean(explicit?.textContent || node?.closest?.('label')?.textContent);
    };
    const accessibleName = (node) => clean(
      node?.getAttribute?.('aria-label')
        || labelledByText(node)
        || associatedLabel(node)
        || node?.getAttribute?.('placeholder')
        || node?.getAttribute?.('title'),
    );
    const ownerCandidates = deepElements(document).filter((node) => {
      if (!visible(node)) return false;
      const tag = clean(node.tagName).toLowerCase();
      const role = normalize(node.getAttribute?.('role'));
      return (
        ['input', 'select', 'textarea'].includes(tag)
          || ['combobox', 'textbox', 'spinbutton'].includes(role)
          || node.isContentEditable === true
      ) && normalize(accessibleName(node)) === normalize(payload.accessibleName);
    });
    const owners = [...new Set(ownerCandidates)];
    if (owners.length !== 1) {
      return {
        ok: false,
        reason: owners.length ? 'calendar_commit_owner_ambiguous' : 'calendar_commit_owner_not_found',
        candidateCount: owners.length,
      };
    }
    const owner = owners[0];
    const readOwnerDate = () => {
      const nodes = [owner, ...deepElements(owner)];
      const values = nodes.map((node) => (
        node.value
          ?? node.getAttribute?.('value')
          ?? node.getAttribute?.('aria-valuetext')
          ?? node.getAttribute?.('aria-valuenow')
          ?? ''
      )).map(clean).filter(Boolean);
      return values.map(normalizeDate).find(Boolean) || null;
    };
    const settle = async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await new Promise((resolve) => setTimeout(resolve, 40));
    };
    await settle();
    if (readOwnerDate() === payload.expectedDate) {
      return { ok: true, reason: 'exact_calendar_owner_already_committed', candidateCount: 0 };
    }
    const identityTexts = (node) => [
      node?.getAttribute?.('aria-label'),
      node?.getAttribute?.('title'),
      node?.textContent,
    ].map(clean).filter((value) => value && value.length <= 80);
    const surfaces = deepElements(document).filter((node) => {
      if (!visible(node)) return false;
      const role = normalize(node.getAttribute?.('role'));
      const modal = normalize(node.getAttribute?.('aria-modal')) === 'true';
      if (role !== 'dialog' && !modal) return false;
      const identity = identityTexts(node).map(normalize);
      return identity.some((value) => /\\b(?:date|calendar)\\b/.test(value))
        || node.querySelector?.('[aria-label*="Month" i], [aria-label*="Year" i], [role="grid"]');
    });
    if (surfaces.length !== 1) {
      return {
        ok: false,
        reason: surfaces.length ? 'calendar_commit_surface_ambiguous' : 'calendar_commit_surface_not_found',
        surfaceCount: surfaces.length,
      };
    }
    const expectedButtons = new Set(payload.confirmAliases.map(normalize));
    const buttons = [surfaces[0], ...deepElements(surfaces[0])].filter((node) => (
      visible(node)
        && (node.tagName === 'BUTTON' || normalize(node.getAttribute?.('role')) === 'button')
        && identityTexts(node).some((value) => expectedButtons.has(normalize(value)))
        && !node.disabled
        && normalize(node.getAttribute?.('aria-disabled')) !== 'true'
    ));
    const uniqueButtons = [...new Set(buttons)];
    if (uniqueButtons.length !== 1) {
      return {
        ok: false,
        reason: uniqueButtons.length
          ? 'calendar_commit_control_ambiguous'
          : 'calendar_commit_control_not_found',
        candidateCount: uniqueButtons.length,
      };
    }
    uniqueButtons[0].click();
    await settle();
    const committedDate = readOwnerDate();
    return {
      ok: committedDate === payload.expectedDate,
      reason: committedDate === payload.expectedDate
        ? 'exact_calendar_commit_observed'
        : 'calendar_commit_not_observed',
      candidateCount: 1,
    };
  }`;
}

function timeFieldResolverSource() {
  return `
    const fieldValue = (node) => [
      node?.value,
      node?.getAttribute?.('value'),
      node?.getAttribute?.('aria-valuetext'),
      node?.getAttribute?.('aria-valuenow'),
      node?.textContent,
    ].map(clean).find(Boolean) || '';
    const identityText = (node) => clean([
      node?.getAttribute?.('aria-label'),
      node?.getAttribute?.('title'),
      node?.getAttribute?.('placeholder'),
      node?.getAttribute?.('name'),
    ].filter(Boolean).join(' '));
    const isEditable = (node) => {
      const tag = clean(node?.tagName).toLowerCase();
      const role = clean(node?.getAttribute?.('role')).toLowerCase();
      return ['input', 'select', 'textarea'].includes(tag)
        || ['combobox', 'spinbutton', 'textbox'].includes(role)
        || node?.isContentEditable === true;
    };
    const isInteractive = (node) => {
      const tag = clean(node?.tagName).toLowerCase();
      const role = clean(node?.getAttribute?.('role')).toLowerCase();
      return isEditable(node)
        || tag === 'button'
        || ['button', 'option', 'radio', 'menuitem'].includes(role)
        || node?.hasAttribute?.('aria-haspopup');
    };
    const isDateLike = (node) => {
      const type = clean(node?.getAttribute?.('type')).toLowerCase();
      const identity = identityText(node);
      const value = fieldValue(node);
      return type === 'date'
        || (/\\bdate\\b/i.test(identity) && !/\\btime\\b/i.test(identity))
        || /\\b\\d{1,4}[/-]\\d{1,2}[/-]\\d{1,4}\\b/.test(value);
    };
    const isExplicitTime = (node) => {
      const type = clean(node?.getAttribute?.('type')).toLowerCase();
      const identity = identityText(node);
      return type === 'time'
        || (/\\btime\\b/i.test(identity) && !/\\bdate\\b|\\btime\\s*zone\\b|\\btimezone\\b/i.test(identity))
        || Boolean(normalizeTime(fieldValue(node)))
        || Boolean(normalizeTime(node?.getAttribute?.('placeholder')));
    };
    const resolveTimeField = (boundOwner) => {
      const scopes = [];
      let lastControlShapes = [];
      let cursor = boundOwner;
      for (let depth = 0; cursor && depth <= 5; depth += 1, cursor = cursor.parentElement) {
        scopes.push(cursor);
      }
      for (const scope of scopes) {
        const controls = [scope, ...deepElements(scope)].filter((node) => (
          isInteractive(node) && visible(node)
        ));
        const leaves = controls.filter((candidate) => !controls.some((other) => (
          other !== candidate && candidate.contains?.(other)
        )));
        lastControlShapes = leaves.slice(0, 16).map((node) => ({
          tag: clean(node.tagName).toLowerCase(),
          role: clean(node.getAttribute?.('role')).toLowerCase(),
          type: clean(node.getAttribute?.('type')).toLowerCase(),
          identity: identityText(node).slice(0, 80),
          valueKind: normalizeTime(fieldValue(node))
            ? 'time'
            : isDateLike(node)
              ? 'date'
              : fieldValue(node)
                ? 'other'
                : 'empty',
          sameOwner: node === boundOwner,
          hasPopup: node.hasAttribute?.('aria-haspopup') === true,
        }));
        const explicit = leaves.filter(isExplicitTime);
        if (explicit.length === 1) {
          return {
            field: explicit[0],
            candidateCount: 1,
            mode: 'explicit',
            controlShapes: lastControlShapes,
          };
        }
        if (explicit.length > 1) {
          return {
            field: null,
            candidateCount: explicit.length,
            mode: 'ambiguous',
            controlShapes: lastControlShapes,
          };
        }
        const editableLeaves = leaves.filter(isEditable);
        const alternatives = editableLeaves.filter((node) => node !== boundOwner && !isDateLike(node));
        if (
          alternatives.length === 1
          && editableLeaves.some((node) => node === boundOwner || isDateLike(node))
        ) {
          return {
            field: alternatives[0],
            candidateCount: 1,
            mode: 'paired-temporal',
            controlShapes: lastControlShapes,
          };
        }
      }
      return {
        field: null,
        candidateCount: 0,
        mode: 'not-found',
        controlShapes: lastControlShapes,
      };
    };`;
}

function buildBoundTemporalOwnerReadFunction({ valueKind = null } = {}) {
  const kind = clean(valueKind).toLowerCase();
  const payload = Object.freeze({ valueKind: kind || null });
  return `(owner) => {
    const payload = ${JSON.stringify(payload)};
    const clean = (value) => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
    const normalizeTime = (value) => {
      const match = clean(value).match(/\\b(\\d{1,2}):(\\d{2})(?::\\d{2})?\\s*(AM|PM)?\\b/i);
      if (!match) return null;
      let hour = Number(match[1]);
      const minute = Number(match[2]);
      const meridiem = String(match[3] || '').toUpperCase();
      if (minute < 0 || minute > 59 || hour < 0 || hour > 23) return null;
      if (meridiem) {
        if (hour < 1 || hour > 12) return null;
        if (meridiem === 'AM') hour = hour === 12 ? 0 : hour;
        if (meridiem === 'PM') hour = hour === 12 ? 12 : hour + 12;
      }
      return String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0');
    };
    const visible = (node) => {
      if (!node || node.nodeType !== 1) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
        && rect.width > 0 && rect.height > 0;
    };
    const deepElements = (root, output = []) => {
      for (const node of Array.from(root?.querySelectorAll?.('*') || [])) {
        output.push(node);
        if (node.shadowRoot) deepElements(node.shadowRoot, output);
      }
      return output;
    };
    if (!owner || owner.nodeType !== 1) {
      return { ok: false, reason: 'bound_temporal_owner_unavailable', candidateCount: 0 };
    }
    ${timeFieldResolverSource()}
    let exactOwner = owner;
    if (payload.valueKind === 'time') {
      const resolved = resolveTimeField(owner);
      if (!resolved.field) {
        return {
          ok: false,
          reason: resolved.candidateCount
            ? 'bound_time_owner_ambiguous'
            : 'bound_time_owner_not_found',
          candidateCount: resolved.candidateCount,
          controlShapes: resolved.controlShapes,
        };
      }
      exactOwner = resolved.field;
      const semanticTimes = [...new Set(
        [exactOwner, ...deepElements(exactOwner)]
          .flatMap((node) => [fieldValue(node), identityText(node)])
          .map(normalizeTime)
          .filter(Boolean),
      )];
      if (semanticTimes.length > 1) {
        return {
          ok: false,
          reason: 'bound_time_owner_value_ambiguous',
          candidateCount: 1,
          valueCandidateCount: semanticTimes.length,
        };
      }
      return {
        ok: true,
        reason: 'exact_bound_temporal_owner_read',
        candidateCount: 1,
        valueCandidateCount: semanticTimes.length,
        role: clean(exactOwner.getAttribute?.('role') || exactOwner.tagName).toLowerCase(),
        value: semanticTimes[0] || '',
      };
    }
    const valueNodes = [exactOwner, ...deepElements(exactOwner)].filter((node) => {
      const tag = clean(node.tagName).toLowerCase();
      return ['input', 'select', 'textarea'].includes(tag)
        || node.isContentEditable === true
        || node.hasAttribute?.('aria-valuetext')
        || node.hasAttribute?.('aria-valuenow')
        || node.hasAttribute?.('value');
    });
    const values = [...new Set(valueNodes.map((node) => clean(
      node.value
        ?? node.getAttribute?.('value')
        ?? node.getAttribute?.('aria-valuetext')
        ?? node.getAttribute?.('aria-valuenow')
        ?? node.textContent,
    )).filter(Boolean))];
    if (values.length > 1) {
      return {
        ok: false,
        reason: 'bound_temporal_owner_value_ambiguous',
        candidateCount: 1,
        valueCandidateCount: values.length,
      };
    }
    return {
      ok: true,
      reason: 'exact_bound_temporal_owner_read',
      candidateCount: 1,
      valueCandidateCount: values.length,
      role: clean(exactOwner.getAttribute?.('role') || exactOwner.tagName).toLowerCase(),
      value: values[0] || '',
    };
  }`;
}

function buildTimeOwnerOpenFunction({ expectedTime } = {}) {
  const time = clean(expectedTime);
  if (!time) throw new TypeError('Time owner opening requires an expected time.');
  const payload = Object.freeze({ expectedTime: time });
  return `async (owner) => {
    const payload = ${JSON.stringify(payload)};
    const clean = (value) => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
    const normalizeTime = (value) => {
      const match = clean(value).match(/\\b(\\d{1,2}):(\\d{2})(?::\\d{2})?\\s*(AM|PM)?\\b/i);
      if (!match) return null;
      let hour = Number(match[1]);
      const minute = Number(match[2]);
      const meridiem = String(match[3] || '').toUpperCase();
      if (minute < 0 || minute > 59 || hour < 0 || hour > 23) return null;
      if (meridiem) {
        if (hour < 1 || hour > 12) return null;
        if (meridiem === 'AM') hour = hour === 12 ? 0 : hour;
        if (meridiem === 'PM') hour = hour === 12 ? 12 : hour + 12;
      }
      return String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0');
    };
    const visible = (node) => {
      if (!node || node.nodeType !== 1) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
        && rect.width > 0 && rect.height > 0;
    };
    const deepElements = (root, output = []) => {
      for (const node of Array.from(root?.querySelectorAll?.('*') || [])) {
        output.push(node);
        if (node.shadowRoot) deepElements(node.shadowRoot, output);
      }
      return output;
    };
    ${timeFieldResolverSource()}
    if (!owner || owner.nodeType !== 1) {
      return { ok: false, reason: 'time_owner_unavailable', candidateCount: 0 };
    }
    const resolved = resolveTimeField(owner);
    if (!resolved.field) {
      return {
        ok: false,
        reason: resolved.candidateCount ? 'time_field_ambiguous' : 'time_field_not_found',
        candidateCount: resolved.candidateCount,
        controlShapes: resolved.controlShapes,
      };
    }
    const field = resolved.field;
    if (normalizeTime(fieldValue(field)) === normalizeTime(payload.expectedTime)) {
      return { ok: true, reason: 'exact_time_owner_already_committed', candidateCount: 1 };
    }
    if (field.disabled || clean(field.getAttribute?.('aria-disabled')).toLowerCase() === 'true') {
      return { ok: false, reason: 'exact_time_field_disabled', candidateCount: 1 };
    }
    field.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
    field.click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await new Promise((resolve) => setTimeout(resolve, 30));
    return {
      ok: true,
      reason: 'exact_time_field_clicked',
      candidateCount: 1,
      ownerRole: clean(field.getAttribute?.('role') || field.tagName).toLowerCase(),
      ownerText: identityText(field).slice(0, 80),
    };
  }`;
}

function buildTimeOptionSelectionFunction({ expectedTime, revealOnly = false } = {}) {
  const time = clean(expectedTime);
  if (!time) throw new TypeError('Time option selection requires an expected time.');
  const payload = Object.freeze({
    expectedTime: time,
    maxScrolls: 12,
    revealOnly: revealOnly === true,
  });
  return `async (owner) => {
    const payload = ${JSON.stringify(payload)};
    const clean = (value) => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
    const normalizeTime = (value) => {
      const match = clean(value).match(/\\b(\\d{1,2}):(\\d{2})(?::\\d{2})?\\s*(AM|PM)?\\b/i);
      if (!match) return null;
      let hour = Number(match[1]);
      const minute = Number(match[2]);
      const meridiem = String(match[3] || '').toUpperCase();
      if (minute < 0 || minute > 59 || hour < 0 || hour > 23) return null;
      if (meridiem) {
        if (hour < 1 || hour > 12) return null;
        if (meridiem === 'AM') hour = hour === 12 ? 0 : hour;
        if (meridiem === 'PM') hour = hour === 12 ? 12 : hour + 12;
      }
      return String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0');
    };
    const expected = normalizeTime(payload.expectedTime);
    const visible = (node) => {
      if (!node || node.nodeType !== 1) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
        && rect.width > 0 && rect.height > 0;
    };
    const actionOwner = (node) => node?.closest?.(
      '[role="option"],[role="menuitem"],[role="listitem"],[role="radio"],button,li,[tabindex]',
    ) || node;
    const deepElements = (root, output = []) => {
      for (const node of Array.from(root?.querySelectorAll?.('*') || [])) {
        output.push(node);
        if (node.shadowRoot) deepElements(node.shadowRoot, output);
      }
      return output;
    };
    ${timeFieldResolverSource()}
    const resolvedTimeField = resolveTimeField(owner);
    const timeField = resolvedTimeField.field;
    const valuesOf = (node) => [node, ...deepElements(node)].map((candidate) => (
      candidate.value
        ?? candidate.getAttribute?.('value')
        ?? candidate.getAttribute?.('aria-valuetext')
        ?? candidate.getAttribute?.('aria-valuenow')
        ?? ''
    )).map(clean).filter(Boolean);
    const ownerTime = () => valuesOf(timeField).map(normalizeTime).find(Boolean) || null;
    if (!owner || owner.nodeType !== 1 || !expected) {
      return { ok: false, reason: 'time_owner_or_value_unavailable', candidateCount: 0 };
    }
    if (!timeField) {
      return {
        ok: false,
        reason: resolvedTimeField.candidateCount ? 'time_field_ambiguous' : 'time_field_not_found',
        candidateCount: resolvedTimeField.candidateCount,
        controlShapes: resolvedTimeField.controlShapes,
      };
    }
    if (ownerTime() === expected) {
      return { ok: true, reason: 'exact_time_owner_already_committed', candidateCount: 0 };
    }
    const controlledIds = [
      timeField.getAttribute?.('aria-controls'),
      timeField.getAttribute?.('aria-owns'),
      ...deepElements(timeField).flatMap((node) => [
        node.getAttribute?.('aria-controls'),
        node.getAttribute?.('aria-owns'),
      ]),
    ].flatMap((value) => clean(value).split(/\\s+/)).filter(Boolean);
    const hasTimeSemantics = (node) => [node, ...deepElements(node)].some((candidate) => normalizeTime(
      candidate.getAttribute?.('aria-label')
        || candidate.getAttribute?.('title')
        || candidate.textContent,
    ));
    const findSurfaces = () => {
      const controlled = [...new Set(
        controlledIds.map((id) => document.getElementById(id)).filter(visible),
      )];
      const controlledTimeSurfaces = controlled.filter(hasTimeSemantics);
      const fallbackSurfaces = deepElements(document).filter((node) => (
        visible(node)
          && ['listbox', 'menu', 'dialog'].includes(clean(node.getAttribute?.('role')).toLowerCase())
          && hasTimeSemantics(node)
      ));
      return {
        controlled,
        controlledTimeSurfaces,
        fallbackSurfaces,
        surfaces: controlledTimeSurfaces.length
          ? controlledTimeSurfaces
          : [...new Set(fallbackSurfaces)],
      };
    };
    let popup = findSurfaces();
    let popupOpenedByTransaction = false;
    // Reuse an already-open associated popup. Click only when no time surface
    // is visible, so a focused/open combobox is never toggled closed by retry.
    if (popup.surfaces.length === 0) {
      timeField.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
      timeField.click();
      popupOpenedByTransaction = true;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await new Promise((resolve) => setTimeout(resolve, 30));
      popup = findSurfaces();
    }
    const {
      controlled,
      controlledTimeSurfaces,
      fallbackSurfaces,
      surfaces,
    } = popup;
    if (surfaces.length !== 1) {
      return {
        ok: false,
        reason: surfaces.length ? 'time_popup_ambiguous' : 'time_popup_not_found',
        surfaceCount: surfaces.length,
        controlledSurfaceCount: controlled.length,
        controlledTimeSurfaceCount: controlledTimeSurfaces.length,
          fallbackTimeSurfaceCount: fallbackSurfaces.length,
          popupOpenedByTransaction,
      };
    }
    const surface = surfaces[0];
    const observedValues = new Set();
    let scanCount = 0;
    let maximumScrollableCount = 0;
    let startScrollTop = 0;
    let endScrollTop = 0;
    const observeTimes = (nodes) => {
      for (const node of nodes) {
        const source = clean(
          node.getAttribute?.('aria-label')
            || node.getAttribute?.('title')
            || node.textContent,
        );
        for (const match of source.matchAll(/\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?\b/gi)) {
          const normalized = normalizeTime(match[0]);
          if (normalized) observedValues.add(normalized);
          if (observedValues.size >= 24) return;
        }
      }
    };
    const settle = async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await new Promise((resolve) => setTimeout(resolve, 30));
    };
    const initialScrollables = [surface, ...deepElements(surface)].filter((node) => (
      visible(node) && Number(node.scrollHeight) > Number(node.clientHeight) + 2
    ));
    maximumScrollableCount = initialScrollables.length;
    startScrollTop = initialScrollables.length
      ? Math.max(...initialScrollables.map((node) => Number(node.scrollTop) || 0))
      : 0;
    for (const scrollable of initialScrollables) {
      scrollable.scrollTop = 0;
      scrollable.dispatchEvent(new Event('scroll', { bubbles: true }));
    }
    if (initialScrollables.length) await settle();
    for (let attempt = 0; attempt <= payload.maxScrolls; attempt += 1) {
      const all = [surface, ...deepElements(surface)];
      scanCount += 1;
      observeTimes(all.filter((node) => visible(actionOwner(node))));
      const exact = all.filter((node) => normalizeTime(
        node.getAttribute?.('aria-label')
          || node.getAttribute?.('title')
          || node.textContent,
      ) === expected && visible(actionOwner(node)));
      const deepest = exact.filter((candidate) => !exact.some((other) => (
        other !== candidate && candidate.contains?.(other)
      )));
      const exactByOwner = new Map();
      for (const raw of deepest) {
        const target = actionOwner(raw);
        if (!exactByOwner.has(target)) exactByOwner.set(target, raw);
      }
      if (exactByOwner.size === 1) {
        const [[target, raw]] = [...exactByOwner.entries()];
        if (target.disabled || clean(target.getAttribute?.('aria-disabled')).toLowerCase() === 'true') {
          return { ok: false, reason: 'exact_time_option_disabled', candidateCount: 1 };
        }
        raw.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
        await settle();
        if (payload.revealOnly) {
          return {
            ok: true,
            reason: 'exact_time_option_revealed',
            candidateCount: 1,
            ownerRole: clean(target.getAttribute?.('role') || target.tagName).toLowerCase(),
            ownerText: clean(
              target.getAttribute?.('aria-label')
                || target.getAttribute?.('title')
                || target.textContent,
            ).slice(0, 80),
          };
        }
        raw.click();
        await settle();
        const committed = ownerTime();
        return {
          ok: committed === expected,
          reason: committed === expected
            ? 'exact_time_option_committed'
            : 'time_owner_not_committed',
          candidateCount: 1,
          ownerRole: clean(target.getAttribute?.('role') || target.tagName).toLowerCase(),
          ownerText: clean(
            target.getAttribute?.('aria-label')
              || target.getAttribute?.('title')
              || target.textContent,
          ).slice(0, 80),
        };
      }
      if (exactByOwner.size > 1) {
        return { ok: false, reason: 'exact_time_option_ambiguous', candidateCount: exactByOwner.size };
      }
      const scrollables = [surface, ...deepElements(surface)].filter((node) => (
        visible(node) && Number(node.scrollHeight) > Number(node.clientHeight) + 2
      ));
      maximumScrollableCount = Math.max(maximumScrollableCount, scrollables.length);
      let progressed = false;
      for (const scrollable of scrollables) {
        const before = Number(scrollable.scrollTop) || 0;
        const delta = Math.max(40, Math.floor((Number(scrollable.clientHeight) || 100) * 0.8));
        scrollable.scrollTop = Math.min(
          Number(scrollable.scrollHeight) || before,
          before + delta,
        );
        scrollable.dispatchEvent(new Event('scroll', { bubbles: true }));
        progressed = progressed || Number(scrollable.scrollTop) > before;
        endScrollTop = Math.max(endScrollTop, Number(scrollable.scrollTop) || 0);
      }
      if (!progressed) break;
      await settle();
    }
    return {
      ok: false,
      reason: 'exact_time_option_not_found',
      candidateCount: 0,
      observedValues: [...observedValues],
      scrollableCount: maximumScrollableCount,
      scanCount,
      startScrollTop,
      endScrollTop,
      controlledSurfaceCount: controlled.length,
      controlledTimeSurfaceCount: controlledTimeSurfaces.length,
      fallbackTimeSurfaceCount: fallbackSurfaces.length,
      popupOpenedByTransaction,
    };
  }`;
}

module.exports = {
  MONTH_NAMES,
  calendarChoiceAliases,
  buildCalendarExactClickFunction,
  buildCalendarChoiceFunction,
  buildCalendarModeFunction,
  buildTemporalOwnerReadFunction,
  buildCalendarCommitFunction,
  buildBoundTemporalOwnerReadFunction,
  buildTimeOwnerOpenFunction,
  buildTimeOptionSelectionFunction,
};
