import * as React from 'react';

/**
 * Returns props that make a non-interactive element (e.g. `<tr>`, `<div>`)
 * behave like a clickable button for keyboard + screen-reader users.
 *
 * Spread the result onto the element: `<TableRow {...clickableRowProps(() => doX())} />`.
 *
 * - `tabIndex={0}` — focusable via keyboard Tab.
 * - `role="button"` — announced as a button by screen readers.
 * - `onKeyDown` — Enter / Space triggers the click handler (prevents default
 *   scroll for Space, matching native button behavior).
 */
export function clickableRowProps<T>(onClick: () => T): {
  tabIndex: number;
  role: 'button';
  onClick: () => T;
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
} {
  return {
    tabIndex: 0,
    role: 'button',
    onClick,
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onClick();
      }
    },
  };
}

/**
 * FIX (BUG-HUNT B12/B2-03+B2-14): props that make a sortable `<th>`
 * keyboard-accessible WITHOUT overriding its native columnheader role.
 *
 * Spread onto the `<TableHead>`:
 * `<TableHead {...sortableHeaderProps('qty', 'QTY', sortKey, sortDir, toggleSort)}>`
 *
 * Deliberately NOT `role="button"` — that strips columnheader semantics and
 * makes the th's own `aria-sort` meaningless to assistive tech. The th keeps
 * its role; sortability is signaled by `aria-sort` + tabIndex + Enter/Space.
 */
export function sortableHeaderProps<K extends string>(
  key: K,
  label: string,
  activeKey: K | null | undefined,
  dir: 'asc' | 'desc',
  onToggle: (key: K) => void,
): {
  tabIndex: number;
  'aria-label': string;
  'aria-sort': 'ascending' | 'descending' | 'none';
  onClick: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
} {
  return {
    tabIndex: 0,
    'aria-label': `Urutkan menurut ${label}`,
    'aria-sort': activeKey === key ? (dir === 'asc' ? 'ascending' : 'descending') : 'none',
    onClick: () => onToggle(key),
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onToggle(key);
      }
    },
  };
}
