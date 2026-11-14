import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";

const FOCUSABLE =
  'input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

export function Modal({
  title,
  children,
  onClose,
  footer,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // Move focus into the dialog on open (first field in the body, else the dialog),
  // and give it back to whatever had it when the dialog closes.
  useEffect(() => {
    // Keep the original opener when Strict Mode repeats this effect's setup.
    const previous = previousFocusRef.current ?? document.activeElement as HTMLElement | null;
    previousFocusRef.current = previous;
    const dialog = dialogRef.current;
    const target = dialog?.querySelector<HTMLElement>(`.modal-body :is(${FOCUSABLE})`) ?? dialog;
    target?.focus();
    return () => {
      // Strict Mode also runs cleanup while the dialog is still mounted.
      // Restoring focus then blurs untouched fields and creates validation errors.
      if (dialog?.isConnected) return;
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  // Rendered into <body> so modals opened from inside other modals or cards are never clipped.
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={onClose}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          // Stop here so an outer modal or drawer doesn't close too.
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <div className="eyebrow">EventWise</div>
            <h2>{title}</h2>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
