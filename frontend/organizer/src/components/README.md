# Shared EventWise UI

Shared React components live in `ui/` and use TypeScript/TSX. Import from
`./components/ui` from the application root, or `../../components/ui` from a feature.
The barrel `ui/index.ts` exports Badge, Button, Card, Field, Icon, and Modal.
Direct imports such as `./components/ui/Button` also work. Each component has one
implementation; the former monolithic `ui.tsx` has been consolidated here.

| Component | Props |
| --- | --- |
| Icon | name, optional size (18 by default); unknown names fall back to grid |
| Button | children, optional variant, icon, onClick, type |
| Badge | children, optional tone |
| Card | children, optional className |
| Field | label, optional placeholder, type, defaultValue |
| Modal | title, children, onClose, optional footer |

Button variants are primary, secondary, ghost, and danger. Native props are not
automatically forwarded. Field remains an uncontrolled input; feature forms
still need data collection and API integration. Modal retains dialog ARIA
attributes, backdrop dismissal and its labeled close button. Focus trapping,
Escape handling and scroll locking remain future accessibility work.

Global styles load once in `src/main.tsx` from `src/styles/index.css`.
The merge retains feature styles, responsive rules, Google Fonts (including
Fraunces), and shared design tokens from dev. Keep shared styles and tokens
in that file and feature logic in the existing feature folders.

Run `npm run typecheck` and `npm run build` from `frontend/organizer`.
