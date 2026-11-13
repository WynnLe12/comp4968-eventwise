import type { ReactNode } from "react";
import { Badge, Icon } from "../../components/ui";
import { bookingLabels, contractLabels, moneyToNumber } from "../../services/vendorRules";
import type { Vendor } from "../../types";
import { avatarTone, bookingTone, currency, initials, isOverpaid, nextDueLabel } from "./vendorFormat";

export function VendorAvatar({ vendor }: { vendor: Vendor }) {
  return (
    <div className={`vendor-avatar ${avatarTone(vendor.id)}`} aria-hidden="true">
      {initials(vendor.name)}
    </div>
  );
}

export function VendorCard({
  vendor,
  onOpen,
  actions,
}: {
  vendor: Vendor;
  onOpen: () => void;
  /** The kebab menu, rendered in the card's top-right corner. */
  actions: ReactNode;
}) {
  const contractTotal = moneyToNumber(vendor.contractTotal);
  const hasContract = contractTotal !== null;
  const paidPercent =
    contractTotal !== null && contractTotal > 0
      ? Math.min(Math.max((Number(vendor.paidTotal) / contractTotal) * 100, 0), 100)
      : 0;
  const overpaid = isOverpaid(vendor);
  const hasContact = Boolean(vendor.contactName || vendor.email || vendor.phone);

  return (
    <article
      className="card vendor-card vendor-card-clickable"
      tabIndex={0}
      aria-label={`${vendor.name}, ${bookingLabels[vendor.bookingStatus]}. Open details`}
      onClick={onOpen}
      onKeyDown={(event) => {
        // Only when the card itself has focus, so Enter on a link or the menu keeps working.
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="vendor-top">
        <VendorAvatar vendor={vendor} />
        {actions}
      </div>
      <h3>{vendor.name}</h3>
      <div className="vendor-badges">
        <Badge>{vendor.category || "Uncategorized"}</Badge>
        <Badge tone={bookingTone(vendor.bookingStatus)}>{bookingLabels[vendor.bookingStatus]}</Badge>
      </div>

      {hasContact && (
        <div className="vendor-contact">
          {vendor.contactName && (
            <span>
              <Icon name="users" size={15} />
              {vendor.contactName}
            </span>
          )}
          {vendor.email && (
            <a href={`mailto:${vendor.email}`} onClick={(event) => event.stopPropagation()}>
              <Icon name="mail" size={15} />
              <span className="vendor-contact-text">{vendor.email}</span>
            </a>
          )}
          {vendor.phone && (
            <a href={`tel:${vendor.phone}`} onClick={(event) => event.stopPropagation()}>
              <Icon name="phone" size={15} />
              {vendor.phone}
            </a>
          )}
        </div>
      )}

      <div className={`vendor-contract-status${hasContact ? "" : " no-contact"}`}>
        <Icon name="file" size={15} />
        Contract {contractLabels[vendor.contractStatus].toLowerCase()}
      </div>

      <div className="vendor-amounts">
        <div>
          <small>{hasContract ? "Contract" : "Quote"}</small>
          <b>{currency(vendor.contractTotal ?? vendor.quoteAmount)}</b>
        </div>
        <div>
          <small>{overpaid ? "Overpaid" : "Balance"}</small>
          <b>{overpaid ? currency(String(-Number(vendor.balance))) : currency(vendor.balance)}</b>
        </div>
      </div>

      {hasContract && (
        <div className="vendor-paid-progress">
          <div
            role="progressbar"
            aria-label="Paid so far"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(paidPercent)}
          >
            <span style={{ width: `${paidPercent}%` }} />
          </div>
          <small>
            {currency(vendor.paidTotal)} paid of {currency(vendor.contractTotal)}
          </small>
        </div>
      )}

      <div className="vendor-due">
        <span>Next due</span>
        <b>{nextDueLabel(vendor)}</b>
      </div>
    </article>
  );
}
