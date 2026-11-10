# Workspace tabs

Horizontal page sections use `public/workspace-tabs.js` and `workspace-tabs.css`.
The component enhances existing buttons in place; each feature keeps its click handler,
data loading, permissions, hash routing and panel visibility logic.

- Tracks: neutral border, pale green moving selection, optional icons and live counts.
- Size: 32 px buttons on desktop with a fine pointer; 44 px on phones and coarse pointers.
- Navigation: Left/Right follow the reading direction; Home/End move focus; Enter/Space activate.
- Overflow: touch scrolling and previous/next buttons; the focused or selected tab is revealed.
- Accessibility: page sections use tabs/tabpanel; status and period filters use toolbar/pressed buttons.
- Motion: short selection and panel transitions; reduced motion removes both.

To adopt a new horizontal section, add its track selector to `workspace-tabs.js` and give
each button an `aria-controls` target (or add the existing IDs to `panelIds`). Use the
feature's `active` / `is-on` class, or its controlled `aria-selected` state. Keep vertical
navigation, view mode switches and date filters separate from page sections.

`SouliaTabs.enhance(track)` mounts one track; `SouliaTabs.refresh()` schedules a single
refresh for the next frame. New tracks, permissions, label/count changes and resizing
are observed automatically. Detached tracks release their observers and animations.

`table-viewport.js` fits long order tables below their real tools and above pagination.
It restores normal page scrolling outside supported tables, on phones and in short windows.
`order-density.css` reduces spacing on screen; customer text and print layouts keep their sizes.

Validation: `backend/test/browser/workspace-tabs.cjs`, `order-density.cjs`,
`compact-pages.cjs` and `supplier-labels-page.cjs`.
