import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Icon } from "../../components/ui";
import {
  BOOKING_STATUSES,
  bookingLabels,
  bookingOptionDisabledReason,
  CONTRACT_STATUSES,
  contractLabels,
  contractOptionDisabledReason,
} from "../../services/vendorRules";
import type { BookingStatus, ContractStatus, Vendor } from "../../types";

type Submenu = "booking" | "contract" | null;

function MenuItem({
  children,
  onSelect,
  disabledReason = "",
  className = "",
  checked,
}: {
  children: ReactNode;
  onSelect: () => void;
  /** When set, the item is disabled and this text is shown as its tooltip. */
  disabledReason?: string;
  className?: string;
  checked?: boolean;
}) {
  const disabled = Boolean(disabledReason);
  return (
    <span className="vendor-menu-option" data-tooltip={disabledReason || undefined}>
      <button
        type="button"
        role={checked === undefined ? "menuitem" : "menuitemradio"}
        aria-checked={checked}
        className={`${className}${checked ? " active" : ""}`}
        disabled={disabled}
        onClick={onSelect}
      >
        {children}
        {disabled && <span className="sr-only">. {disabledReason}</span>}
      </button>
    </span>
  );
}

export function VendorActions({
  vendor,
  onView,
  onEdit,
  onDelete,
  onViewExpenses,
  onBookingStatus,
  onContractStatus,
}: {
  vendor: Vendor;
  onView: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onViewExpenses: () => void;
  onBookingStatus: (status: BookingStatus) => void;
  onContractStatus: (status: ContractStatus) => void;
}) {
  const [open, setOpen] = useState(false);
  const [submenu, setSubmenu] = useState<Submenu>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = (restoreFocus = false) => {
    setOpen(false);
    setSubmenu(null);
    if (restoreFocus) triggerRef.current?.focus();
  };

  const enabledItems = () =>
    Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);

  // Focus the first enabled item whenever the menu or a submenu opens.
  useEffect(() => {
    if (open) enabledItems()[0]?.focus();
  }, [open, submenu]);

  // Close when clicking anywhere outside this menu.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = enabledItems();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        items[(current + step + items.length) % items.length]?.focus();
        break;
      }
      case "Home":
        event.preventDefault();
        items[0]?.focus();
        break;
      case "End":
        event.preventDefault();
        items.at(-1)?.focus();
        break;
      case "Enter":
        event.preventDefault();
        items[current]?.click();
        break;
      case "ArrowLeft":
        if (submenu) {
          event.preventDefault();
          setSubmenu(null);
        }
        break;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        if (submenu) setSubmenu(null);
        else close(true);
        break;
      case "Tab":
        close();
        break;
    }
  };

  const run = (action: () => void) => () => {
    close(true);
    action();
  };


  return (
    <div className="vendor-menu-wrap" ref={wrapRef} onClick={(event) => event.stopPropagation()}>
      <button
        ref={triggerRef}
        type="button"
        className={`icon-btn vendor-menu-trigger${open ? " open" : ""}`}
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Actions for ${vendor.name}`}
      >
        <Icon name="more" />
      </button>

      {open && (
        <div
          className="vendor-menu"
          ref={menuRef}
          role="menu"
          aria-label={
            submenu === "booking"
              ? "Booking status"
              : submenu === "contract"
                ? "Contract status"
                : `Actions for ${vendor.name}`
          }
          onKeyDown={onMenuKeyDown}
        >
          {submenu === null && (
            <>
              <MenuItem onSelect={run(onView)}>
                <Icon name="eye" size={16} /> View details
              </MenuItem>
              <MenuItem onSelect={run(onEdit)}>
                <Icon name="edit" size={16} /> Edit vendor
              </MenuItem>
              <MenuItem
                disabledReason={vendor.email ? "" : "Add an email address to contact this vendor"}
                onSelect={run(() => {
                  window.location.href = `mailto:${vendor.email}`;
                })}
              >
                <Icon name="mail" size={16} /> Email vendor
              </MenuItem>
              <MenuItem onSelect={run(onViewExpenses)}>
                <Icon name="receipt" size={16} /> View expenses
              </MenuItem>
              <MenuItem className="vendor-menu-sub" onSelect={() => setSubmenu("booking")}>
                Booking status <span aria-hidden="true">›</span>
              </MenuItem>
              <MenuItem className="vendor-menu-sub" onSelect={() => setSubmenu("contract")}>
                Contract status <span aria-hidden="true">›</span>
              </MenuItem>
              <MenuItem className="vendor-menu-danger" onSelect={run(onDelete)}>
                <Icon name="trash" size={16} /> Delete vendor
              </MenuItem>
            </>
          )}

          {submenu !== null && (
            <>
              <MenuItem className="vendor-menu-back" onSelect={() => setSubmenu(null)}>
                <span aria-hidden="true">‹</span>{" "}
                {submenu === "booking" ? "Booking status" : "Contract status"}
              </MenuItem>
              {submenu === "booking"
                ? BOOKING_STATUSES.map((status) => (
                    <MenuItem
                      key={status}
                      checked={vendor.bookingStatus === status}
                      disabledReason={bookingOptionDisabledReason(status, vendor)}
                      onSelect={run(() => onBookingStatus(status))}
                    >
                      {bookingLabels[status]}
                      {vendor.bookingStatus === status && <Icon name="tick" size={14} />}
                    </MenuItem>
                  ))
                : CONTRACT_STATUSES.map((status) => (
                    <MenuItem
                      key={status}
                      checked={vendor.contractStatus === status}
                      disabledReason={contractOptionDisabledReason(status, vendor)}
                      onSelect={run(() => onContractStatus(status))}
                    >
                      {contractLabels[status]}
                      {vendor.contractStatus === status && <Icon name="tick" size={14} />}
                    </MenuItem>
                  ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
