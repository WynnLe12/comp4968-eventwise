import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Badge, Button, Icon } from "../../components/ui";
import { bookingLabels, contractLabels } from "../../services/vendorRules";
import type { Vendor } from "../../types";
import { VendorAvatar } from "./VendorCard";
import { bookingTone, currency, dueDateLabel, isOverpaid } from "./vendorFormat";

/**
 * Read-only vendor details. Payment figures come from the server (calculated from
 * the vendor's expenses); expenses are viewed and edited on the Expenses page.
 */
export function VendorDrawer({
  vendor,
  onClose,
  onEdit,
  onViewExpenses,
}: {
  vendor: Vendor;
  onClose: () => void;
  onEdit: () => void;
  onViewExpenses: () => void;
}) {
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  return createPortal(
    <div
      className="drawer-backdrop"
      onMouseDown={onClose}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <aside
        ref={panelRef}
        className="vendor-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="vendor-drawer-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="drawer-head">
          <div className="drawer-head-left">
            <VendorAvatar vendor={vendor} />
            <div className="drawer-head-copy">
              <h2 id="vendor-drawer-title">{vendor.name}</h2>
              <p>{vendor.category || "Uncategorized"}</p>
              <Badge tone={bookingTone(vendor.bookingStatus)}>
                {bookingLabels[vendor.bookingStatus]}
              </Badge>
            </div>
          </div>
          <div className="drawer-head-actions">
            <Button variant="secondary" icon="edit" onClick={onEdit}>
              Edit
            </Button>
            <button type="button" className="drawer-close" onClick={onClose} aria-label="Close details">
              <Icon name="close" size={20} />
            </button>
          </div>
        </header>

        <section className="drawer-section" aria-labelledby="vendor-drawer-contact">
          <h3 id="vendor-drawer-contact">Contact</h3>
          <dl className="detail-list">
            <div>
              <dt>Contact name</dt>
              <dd>{vendor.contactName || <span className="detail-empty">Not provided</span>}</dd>
            </div>
            <div>
              <dt>Email</dt>
              <dd>
                {vendor.email ? (
                  <a href={`mailto:${vendor.email}`}>{vendor.email}</a>
                ) : (
                  <span className="detail-empty">Not provided</span>
                )}
              </dd>
            </div>
            <div>
              <dt>Phone</dt>
              <dd>
                {vendor.phone ? (
                  <a href={`tel:${vendor.phone}`}>{vendor.phone}</a>
                ) : (
                  <span className="detail-empty">Not provided</span>
                )}
              </dd>
            </div>
          </dl>
        </section>

        <section className="drawer-section" aria-labelledby="vendor-drawer-contract">
          <h3 id="vendor-drawer-contract">Contract</h3>
          <dl className="detail-list">
            <div>
              <dt>Status</dt>
              <dd>{contractLabels[vendor.contractStatus]}</dd>
            </div>
            <div>
              <dt>Quote amount</dt>
              <dd>{currency(vendor.quoteAmount)}</dd>
            </div>
            <div>
              <dt>Contract total</dt>
              <dd>{currency(vendor.contractTotal)}</dd>
            </div>
          </dl>
        </section>

        <section className="drawer-section" aria-labelledby="vendor-drawer-notes">
          <h3 id="vendor-drawer-notes">Notes</h3>
          {vendor.notes ? (
            <p className="vendor-notes">{vendor.notes}</p>
          ) : (
            <p className="detail-empty">No notes yet</p>
          )}
        </section>

        <section className="drawer-section" aria-labelledby="vendor-drawer-payments">
          <div className="drawer-section-title">
            <div>
              <h3 id="vendor-drawer-payments">Payment summary</h3>
              <p>Calculated from this vendor's expenses</p>
            </div>
            <button type="button" className="text-link" onClick={onViewExpenses}>
              View expenses
            </button>
          </div>
          <dl className="payment-grid">
            <div>
              <dt>Contract total</dt>
              <dd>{currency(vendor.contractTotal)}</dd>
            </div>
            <div>
              <dt>Paid</dt>
              <dd>{currency(vendor.paidTotal)}</dd>
            </div>
            <div>
              <dt>{isOverpaid(vendor) ? "Overpaid" : "Balance"}</dt>
              <dd>
                {isOverpaid(vendor)
                  ? currency(String(-Number(vendor.balance)))
                  : currency(vendor.balance)}
              </dd>
            </div>
            <div>
              <dt>Next due date</dt>
              <dd>{dueDateLabel(vendor.nextDueDate)}</dd>
            </div>
          </dl>
        </section>
      </aside>
    </div>,
    document.body,
  );
}
