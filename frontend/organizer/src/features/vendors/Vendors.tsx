import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "../../components/page";
import { Button, Card, Icon, Modal } from "../../components/ui";
import { CURRENT_EVENT_ID } from "../../data/mockData";
import { useResource } from "../../hooks/useResource";
import { pagePath } from "../../routes/navigation";
import {
  BOOKING_STATUSES,
  bookingLabels,
  deleteConflictFor,
  RESET_TO_RESEARCHING,
  researchingNeedsConfirmation,
  type VendorDeleteConflict,
} from "../../services/vendorRules";
import {
  vendorService,
  VendorDeleteConflictError,
  VendorServiceError,
  VendorValidationError,
} from "../../services/vendorService";
import type { BookingStatus, ContractStatus, Vendor, VendorUpdateInput } from "../../types";
import { VendorActions } from "./VendorActions";
import { VendorCard } from "./VendorCard";
import { VendorDrawer } from "./VendorDrawer";
import { VendorForm, type VendorFormInput, type VendorFormSubmitError } from "./VendorForm";
import "./vendors.css";

export type ToastTone = "success" | "error";
type BookingFilter = "all" | BookingStatus;
type SortKey = "name" | "due" | "balance";

const VENDOR_FORM_ID = "vendor-form";

function errorMessage(reason: unknown, fallback: string) {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

function sortVendors(list: Vendor[], sort: SortKey) {
  return [...list].sort((a, b) => {
    if (sort === "due") {
      // Earliest due first; vendors with nothing due go last.
      if (a.nextDueDate !== b.nextDueDate) {
        if (!a.nextDueDate) return 1;
        if (!b.nextDueDate) return -1;
        return a.nextDueDate.localeCompare(b.nextDueDate);
      }
    } else if (sort === "balance") {
      // Largest outstanding balance first; vendors without a contract go last.
      const diff = (b.balance ?? -1) - (a.balance ?? -1);
      if (diff !== 0) return diff;
    }
    return a.name.localeCompare(b.name);
  });
}

export function Vendors({
  onToast,
}: {
  onToast: (message: string, tone?: ToastTone) => void;
}) {
  const navigate = useNavigate();
  const loadVendors = useCallback(() => vendorService.list(CURRENT_EVENT_ID), []);
  const { data, loading, error, reload, update } = useResource(loadVendors);
  const vendors = useMemo(() => data ?? [], [data]);

  const [query, setQuery] = useState("");
  const [bookingFilter, setBookingFilter] = useState<BookingFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [sort, setSort] = useState<SortKey>("name");

  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** undefined = closed, null = adding, Vendor = editing. */
  const [editing, setEditing] = useState<Vendor | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<{
    vendor: Vendor;
    conflict: VendorDeleteConflict | null;
  } | null>(null);
  const [researchTarget, setResearchTarget] = useState<Vendor | null>(null);
  const [saving, setSaving] = useState(false);

  // ---- Derived data -------------------------------------------------------

  // Summary metrics always use every vendor of the event, never the filtered list.
  const metrics = useMemo(
    () => ({
      booked: vendors.filter((v) => v.bookingStatus === "booked").length,
      quotes: vendors.filter((v) => v.quoteAmount !== null).length,
      signed: vendors.filter((v) => v.contractStatus === "signed").length,
      upcoming: vendors.filter((v) => v.nextDueDate !== null && (v.balance ?? 0) > 0).length,
    }),
    [vendors],
  );

  const tabCounts = useMemo(() => {
    const counts: Record<BookingFilter, number> = {
      all: vendors.length,
      researching: 0,
      quoted: 0,
      booked: 0,
      declined: 0,
    };
    for (const vendor of vendors) counts[vendor.bookingStatus] += 1;
    return counts;
  }, [vendors]);

  const categories = useMemo(
    () => [...new Set(vendors.map((v) => v.category).filter(Boolean))].sort(),
    [vendors],
  );
  // If the selected category disappears (vendor edited or deleted), fall back to all.
  const activeCategory = categories.includes(categoryFilter) ? categoryFilter : "all";

  const visibleVendors = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = vendors.filter(
      (vendor) =>
        (!needle ||
          vendor.name.toLowerCase().includes(needle) ||
          vendor.contactName.toLowerCase().includes(needle)) &&
        (bookingFilter === "all" || vendor.bookingStatus === bookingFilter) &&
        (activeCategory === "all" || vendor.category === activeCategory),
    );
    return sortVendors(matches, sort);
  }, [vendors, query, bookingFilter, activeCategory, sort]);

  const selectedVendor = selectedId ? vendors.find((v) => v.id === selectedId) : undefined;

  const clearFilters = () => {
    setQuery("");
    setBookingFilter("all");
    setCategoryFilter("all");
  };

  // ---- Mutations ----------------------------------------------------------

  const replaceVendor = (next: Vendor) =>
    update((list) => list.map((item) => (item.id === next.id ? next : item)));

  const viewExpenses = (vendor: Vendor) => {
    setSelectedId(null);
    setDeleting(null);
    navigate(`${pagePath("expenses")}?vendorId=${encodeURIComponent(vendor.id)}`);
  };

  const saveVendor = async (input: VendorFormInput): Promise<VendorFormSubmitError | null> => {
    setSaving(true);
    try {
      if (editing) {
        replaceVendor(await vendorService.update(editing.id, input));
        onToast("Vendor updated");
      } else {
        const created = await vendorService.create({ ...input, eventId: CURRENT_EVENT_ID });
        update((list) => [...list, created]);
        onToast("Vendor added");
      }
      setEditing(undefined);
      return null;
    } catch (reason) {
      if (reason instanceof VendorValidationError) {
        return { message: reason.message, field: reason.field };
      }
      const message = errorMessage(reason, "We couldn't save this vendor. Please try again.");
      onToast(message, "error");
      return { message };
    } finally {
      setSaving(false);
    }
  };

  const applyUpdate = async (vendor: Vendor, input: VendorUpdateInput, successMessage: string) => {
    setSaving(true);
    try {
      replaceVendor(await vendorService.update(vendor.id, input));
      onToast(successMessage);
      return true;
    } catch (reason) {
      onToast(errorMessage(reason, "We couldn't update this vendor. Please try again."), "error");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const changeBookingStatus = (vendor: Vendor, status: BookingStatus) => {
    if (status === vendor.bookingStatus) return;
    if (
      status === "researching" &&
      researchingNeedsConfirmation(vendor.quoteAmount !== null, vendor.contractStatus)
    ) {
      setResearchTarget(vendor);
      return;
    }
    void applyUpdate(vendor, { bookingStatus: status }, "Booking status updated");
  };

  const changeContractStatus = (vendor: Vendor, status: ContractStatus) => {
    if (status === vendor.contractStatus) return;
    void applyUpdate(
      vendor,
      { contractStatus: status, ...(status === "none" ? { contractTotal: null } : {}) },
      "Contract status updated",
    );
  };

  const confirmResearching = async () => {
    if (!researchTarget) return;
    if (await applyUpdate(researchTarget, RESET_TO_RESEARCHING, "Booking status updated")) {
      setResearchTarget(null);
    }
  };

  // Protected vendors go straight to the explanation; the rest get a confirmation.
  const startDelete = (vendor: Vendor) =>
    setDeleting({ vendor, conflict: deleteConflictFor(vendor) });

  const confirmDelete = async () => {
    if (!deleting) return;
    const { vendor } = deleting;
    setSaving(true);
    try {
      await vendorService.remove(vendor.id);
      update((list) => list.filter((item) => item.id !== vendor.id));
      if (selectedId === vendor.id) setSelectedId(null);
      setDeleting(null);
      onToast("Vendor deleted");
    } catch (reason) {
      if (reason instanceof VendorDeleteConflictError) {
        setDeleting({ vendor, conflict: reason.conflict });
      } else {
        onToast(errorMessage(reason, "We couldn't delete this vendor. Please try again."), "error");
      }
    } finally {
      setSaving(false);
    }
  };

  const markAsCancelled = async () => {
    if (!deleting) return;
    const done = await applyUpdate(
      deleting.vendor,
      { contractStatus: "cancelled", bookingStatus: "declined" },
      "Vendor marked as cancelled",
    );
    if (done) setDeleting(null);
  };

  // ---- Page states --------------------------------------------------------

  const addButton = (
    <Button onClick={() => setEditing(null)} icon="plus">
      Add vendor
    </Button>
  );

  const vendorFormModal = editing !== undefined && (
    <Modal
      title={editing ? "Edit vendor" : "Add a vendor"}
      onClose={() => setEditing(undefined)}
      footer={
        <>
          <Button variant="secondary" onClick={() => setEditing(undefined)}>
            Cancel
          </Button>
          <Button type="submit" form={VENDOR_FORM_ID} disabled={saving}>
            {saving ? "Saving..." : editing ? "Save changes" : "Save vendor"}
          </Button>
        </>
      }
    >
      <VendorForm
        key={editing?.id ?? "new"}
        formId={VENDOR_FORM_ID}
        vendor={editing}
        onSubmit={saveVendor}
      />
    </Modal>
  );

  if (loading) {
    return (
      <>
        <PageHeader page="vendors" />
        <LoadingState label="Loading vendors..." />
      </>
    );
  }

  if (error) {
    const forbidden = error instanceof VendorServiceError && error.status === 403;
    return (
      <>
        <PageHeader page="vendors" />
        {forbidden ? (
          <EmptyState
            icon="lock"
            title="You don't have access to this event"
            message="Ask the event owner to add you as a co-planner, or switch to another event."
          />
        ) : (
          <ErrorState
            message={errorMessage(error, "We couldn't load your vendors.")}
            onRetry={reload}
          />
        )}
      </>
    );
  }

  if (!vendors.length) {
    return (
      <>
        <PageHeader page="vendors" />
        <EmptyState
          icon="store"
          title="No vendors yet"
          message="Add your first vendor to start comparing quotes and tracking contracts."
          action={addButton}
        />
        {vendorFormModal}
      </>
    );
  }

  return (
    <>
      <PageHeader page="vendors" action={addButton} />

      <div className="summary-strip vendor-summary" aria-label="Vendor summary">
        <div>
          <b>{metrics.booked}</b>
          <span>Booked vendors</span>
        </div>
        <div>
          <b>{metrics.quotes}</b>
          <span>Quotes received</span>
        </div>
        <div>
          <b>{metrics.signed}</b>
          <span>Signed contracts</span>
        </div>
        <div className="warning">
          <b>{metrics.upcoming}</b>
          <span>Upcoming payments</span>
        </div>
      </div>

      <Card className="vendor-toolbar">
        <div className="vendor-toolbar-top">
          <label className="search-input">
            <Icon name="search" />
            <span className="sr-only">Search vendors</span>
            <input
              type="search"
              placeholder="Search vendors or contacts..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <label className="vendor-select">
            <span className="sr-only">Category</span>
            <select value={activeCategory} onChange={(event) => setCategoryFilter(event.target.value)}>
              <option value="all">All categories</option>
              {categories.map((category) => (
                <option value={category} key={category}>
                  {category}
                </option>
              ))}
            </select>
          </label>
          <label className="vendor-select">
            <span className="sr-only">Sort vendors</span>
            <select value={sort} onChange={(event) => setSort(event.target.value as SortKey)}>
              <option value="name">Sort: Name</option>
              <option value="due">Sort: Next due date</option>
              <option value="balance">Sort: Balance</option>
            </select>
          </label>
        </div>
        <div className="tabs vendor-tabs" role="group" aria-label="Filter by booking status">
          {(["all", ...BOOKING_STATUSES] as const).map((status) => (
            <button
              type="button"
              key={status}
              className={bookingFilter === status ? "active" : ""}
              aria-pressed={bookingFilter === status}
              onClick={() => setBookingFilter(status)}
            >
              {status === "all" ? "All" : bookingLabels[status]}
              <span>{tabCounts[status]}</span>
            </button>
          ))}
        </div>
      </Card>

      {visibleVendors.length ? (
        <div className="vendor-grid">
          {visibleVendors.map((vendor) => (
            <VendorCard
              key={vendor.id}
              vendor={vendor}
              onOpen={() => setSelectedId(vendor.id)}
              actions={
                <VendorActions
                  vendor={vendor}
                  onView={() => setSelectedId(vendor.id)}
                  onEdit={() => setEditing(vendor)}
                  onDelete={() => startDelete(vendor)}
                  onViewExpenses={() => viewExpenses(vendor)}
                  onBookingStatus={(status) => changeBookingStatus(vendor, status)}
                  onContractStatus={(status) => changeContractStatus(vendor, status)}
                />
              }
            />
          ))}
        </div>
      ) : (
        <Card className="vendor-filter-empty">
          <Icon name="search" />
          <h2>No vendors match your filters</h2>
          <p>Try another search, booking status, or category.</p>
          <Button variant="secondary" onClick={clearFilters}>
            Clear filters
          </Button>
        </Card>
      )}

      {selectedVendor && (
        <VendorDrawer
          vendor={selectedVendor}
          onClose={() => setSelectedId(null)}
          onEdit={() => {
            setSelectedId(null);
            setEditing(selectedVendor);
          }}
          onViewExpenses={() => viewExpenses(selectedVendor)}
        />
      )}

      {vendorFormModal}

      {researchTarget && (
        <Modal
          title="Move back to Researching?"
          onClose={() => setResearchTarget(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setResearchTarget(null)}>
                Cancel
              </Button>
              <Button onClick={confirmResearching} disabled={saving}>
                {saving ? "Updating..." : "Move to Researching"}
              </Button>
            </>
          }
        >
          <p className="modal-copy">
            Moving {researchTarget.name} back to Researching clears its quote amount
            {researchTarget.contractStatus === "cancelled" ? " and the cancelled contract details" : ""}
            .
          </p>
        </Modal>
      )}

      {deleting && (
        <DeleteVendorModal
          vendor={deleting.vendor}
          conflict={deleting.conflict}
          saving={saving}
          onClose={() => setDeleting(null)}
          onDelete={confirmDelete}
          onMarkCancelled={markAsCancelled}
          onViewExpenses={() => viewExpenses(deleting.vendor)}
        />
      )}
    </>
  );
}

function DeleteVendorModal({
  vendor,
  conflict,
  saving,
  onClose,
  onDelete,
  onMarkCancelled,
  onViewExpenses,
}: {
  vendor: Vendor;
  conflict: VendorDeleteConflict | null;
  saving: boolean;
  onClose: () => void;
  onDelete: () => void;
  onMarkCancelled: () => void;
  onViewExpenses: () => void;
}) {
  if (conflict === "signed-contract") {
    return (
      <Modal
        title={`${vendor.name} can't be deleted`}
        onClose={onClose}
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={onMarkCancelled} disabled={saving}>
              {saving ? "Updating..." : "Mark as cancelled"}
            </Button>
          </>
        }
      >
        <div className="vendor-conflict">
          <Icon name="lock" size={20} />
          <p className="modal-copy">
            {vendor.name} is booked with a signed contract. Mark it as cancelled instead: the
            contract becomes Cancelled and the vendor Declined, and its contract and payment
            history stay with this event.
          </p>
        </div>
      </Modal>
    );
  }

  if (conflict === "recorded-expenses") {
    return (
      <Modal
        title={`${vendor.name} can't be deleted`}
        onClose={onClose}
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={onViewExpenses}>View expenses</Button>
          </>
        }
      >
        <div className="vendor-conflict">
          <Icon name="receipt" size={20} />
          <p className="modal-copy">
            {vendor.name} has expenses recorded against it. Remove its payments and upcoming
            expenses first, then you can delete the vendor.
          </p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title={`Delete ${vendor.name}?`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onDelete} disabled={saving}>
            {saving ? "Deleting..." : "Delete"}
          </Button>
        </>
      }
    >
      <p className="modal-copy">
        {vendor.name} will be permanently removed from this event. This can't be undone.
      </p>
    </Modal>
  );
}
