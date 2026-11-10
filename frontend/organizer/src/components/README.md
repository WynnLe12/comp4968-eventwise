# Shared EventWise UI

These JavaScript components and styles were selectively extracted from
`figma-source/src/components/ui.tsx` and `figma-source/src/index.css`.
The source remains unchanged. No application, feature pages, routes, navigation,
mock data, or business logic are included.

## Setup and dependencies

The destination is currently a scaffold without a package manifest or build setup.
This extraction does not install dependencies, configure AWS Amplify, or create
another React application.

- **React:** the source uses React 19. Components use JavaScript JSX and need a
  JSX-capable build setup with the automatic React JSX runtime.
- **React DOM:** required by the eventual browser application to mount React.
- **Tailwind CSS 4:** the CSS entry imports `tailwindcss`. Its Preflight reset is
  part of the original appearance, including box sizing and default margin removal.
  Retain it instead of introducing another CSS framework or duplicating its reset.
- **Build integration:** if the application uses Vite, Tailwind 4 uses
  `@tailwindcss/vite`. Configure it alongside React's JSX integration when the
  application tooling is approved. Other bundlers need their matching Tailwind 4
  integration. No Tailwind configuration file is required by these extracted styles.
- **Fonts:** `styles/index.css` retains the original Google Fonts URL for Nunito
  (400/500/600/700/800) and Fredoka (500/600/700). Loading those fonts needs network
  access. The source's Modal heading references Fraunces without loading it; that
  declaration is preserved, including its existing browser fallback.

TypeScript, React Router, icon packages, dialog libraries, and Figma plugins are
not dependencies of these components. Installation and package/build configuration
changes require separate approval. AWS Amplify can host the eventual compiled
React application; these files have no hosting-specific dependencies.

## Import and reuse

Import global styles **once** from the eventual organizer application entry point:

```jsx
import "./styles/index.css";
```

Example imports from a module directly under `src/`:

```jsx
import { Badge, Button, Card, Field, Modal } from "./components/ui/index.js";
// A direct component import also works:
import { Icon } from "./components/ui/Icon.jsx";

export function SharedUiExample({ onAdd }) {
  return (
    <Card className="example-card">
      <Badge tone="success">Ready</Badge>
      <Field label="Name" placeholder="Enter a name" />
      <Button icon="plus" onClick={onAdd}>Add</Button>
    </Card>
  );
}
```

Control a modal by mounting/unmounting it in the caller:

```jsx
{open && (
  <Modal
    title="Confirm action"
    onClose={() => setOpen(false)}
    footer={<Button onClick={onConfirm}>Confirm</Button>}
  >
    <p>Review your changes.</p>
  </Modal>
)}
```

## Component props

All children/footer props accept React content. Existing behavior and prop
contracts are preserved; native HTML props are not automatically forwarded.

| Component | Props | Defaults / notes |
| --- | --- | --- |
| `Icon` | `name`, `size` | Size 18; inline SVG; unknown names fall back to `grid` |
| `Button` | `children`, `variant`, `icon`, `onClick`, `type` | Variant `primary`; type `button`; variants: `primary`, `secondary`, `ghost`, `danger`; source supports `button` and `submit` types |
| `Badge` | `children`, `tone` | Tone `neutral`; additional styled tones: `success`, `warning`, `danger` |
| `Card` | `children`, `className` | Extra class defaults to an empty string; spacing comes from its content or caller classes |
| `Modal` | `title`, `children`, `onClose`, `footer` | Footer optional; backdrop mouse-down and close button call `onClose` |
| `Field` | `label`, `placeholder`, `type`, `defaultValue` | Type `text`; uncontrolled labeled input; `defaultValue` can be a string or number |

`Field` does not currently expose controlled `value`/`onChange` props. `Button`
does not currently forward attributes such as `disabled`. `Modal` preserves the
source implementation: it does not add a focus trap, Escape handler, dialog ARIA
attributes, or scroll locking. Review those interactions before production use.

There is no separate shared Select or Table in the source. Their feature markup
was deliberately excluded, along with application-specific layout components.

## Global styles and tokens

All global CSS lives in **`styles/index.css`**. It contains the Google Fonts and
Tailwind imports first, followed by commented sections for base styles, design
tokens, shared UI components, responsive styles, and final theme overrides.
Keep that section order to preserve the original cascade. Add future shared
styles to the appropriate section in this same file.

The source's 1100px and 820px rules apply to excluded application layouts and
features, so they are not copied. Mixed selector groups are narrowed to shared
selectors. Selected declarations, hover/focus behavior, and their relative
cascade order are preserved. Feature-specific backgrounds and page layouts
are excluded.

### Original palette

| Token | Value |
| --- | --- |
| `--ink` | `#29243d` |
| `--muted` | `#6f697c` |
| `--line` | `#e9e2ee` |
| `--purple` | `#7958e8` |
| `--purple-dark` | `#5f3fd0` |
| `--lavender` | `#f0ebff` |
| `--coral`, `--pink` | `#ff6b9a` |
| `--mint` | `#71c8b5` |
| `--gold` | `#ffc857` |
| `--paper` | `#fff` |

### Shared value aliases

The source has no general spacing scale. These aliases name existing values;
they do not standardize or change unrelated dimensions.

| Token | Value |
| --- | --- |
| `--background-page` | `#fff9f0` |
| `--font-body` | `"Nunito", sans-serif` |
| `--font-heading` | `"Fredoka", "Nunito", sans-serif` |
| `--control-height` | `38px` |
| `--padding-button` | `0 14px` |
| `--gap-button` | `7px` |
| `--gap-field` | `6px` |
| `--radius-button` | `12px` |
| `--radius-input` | `11px` |
| `--radius-card` | `18px` |
| `--radius-modal` | `22px` |
| `--shadow-card` | `0 5px 18px rgb(78 49 112 / 6%)` |
| `--shadow-button` | `0 5px 13px rgb(121 88 232 / 24%)` |
| `--shadow-modal` | `0 25px 70px #2419324d` |

Use the tokens in shared CSS:

```css
.example-card {
  padding: 20px;
  color: var(--ink);
  background: var(--paper);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-card);
}
```

Base defaults remain in Tailwind's `base` layer. Component classes and final
heading theme rules retain the source's unlayered cascade behavior, so they can
override Tailwind utilities. Check specificity before adding utility overrides.

## Future additions and validation

Add genuinely reusable presentational components to `components/ui/`, and export
them from `ui/index.js`. Keep feature data, routing, and business rules in their
existing feature modules. Use `.jsx` for components and `.js` for exports; no
TypeScript setup is needed. Keep global CSS loaded once through `styles/index.css`.

Once the organizer's application tooling is configured, run its build and
available checks, then review fonts, hover/focus states, modal interactions, and
mobile sizing in a browser. The current scaffold has no build/test scripts, so
a production build and browser preview cannot yet be run here.
