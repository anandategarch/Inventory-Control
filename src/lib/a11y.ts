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
