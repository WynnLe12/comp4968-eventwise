import type { ReactNode } from "react";
import { Button, Field, Icon, Modal } from "./ui";
import { CreateEventModal } from "../features/events/components/CreateEventModal";
import type { CreateEventResult } from "../features/events/services/eventApi";

export type ModalName = "template" | "expense" | "vendor" | "guest" | "event";

type FormModal = Exclude<ModalName, "template" | "event">;

const forms: Record<FormModal, { title: string; body: ReactNode; saved: string }> = {
  expense: {
    title: "Add an expense",
    saved: "Expense added",
    body: (
      <>
        <div className="form-row">
          <Field label="Vendor or expense" placeholder="e.g. Rosewood Bakery" />
          <Field label="Category" placeholder="Select category" />
        </div>
        <div className="form-row">
          <Field label="Total amount" placeholder="$0.00" />
          <Field label="Amount paid" placeholder="$0.00" />
        </div>
        <div className="form-row">
          <Field label="Payment status" placeholder="Unpaid" />
          <Field label="Next due date" type="date" />
        </div>
        <Field label="Notes" placeholder="Optional notes or payment details" />
      </>
    ),
  },
  vendor: {
    title: "Add a vendor",
    saved: "Vendor added",
    body: (
      <>
        <Field label="Business name" placeholder="e.g. Rosewood Bakery" />
        <div className="form-row">
          <Field label="Category" placeholder="Select category" />
          <Field label="Contact name" placeholder="Full name" />
        </div>
        <div className="form-row">
          <Field label="Email" type="email" placeholder="hello@vendor.com" />
          <Field label="Phone" placeholder="(555) 000-0000" />
        </div>
        <div className="form-row">
          <Field label="Quote amount" placeholder="$0.00" />
          <Field label="Contract status" placeholder="Not signed" />
        </div>
      </>
    ),
  },
  guest: {
    title: "Add a guest",
    saved: "Guest added",
    body: (
      <>
        <div className="form-row">
          <Field label="First name" placeholder="First name" />
          <Field label="Last name" placeholder="Last name" />
        </div>
        <div className="form-row">
          <Field label="Email" type="email" placeholder="guest@example.com" />
          <Field label="Group" placeholder="Family, friends..." />
        </div>
        <label className="check-field">
          <input type="checkbox" />
          <div>
            <b>Allow a plus-one</b>
            <span>This guest can add one person when they RSVP.</span>
          </div>
        </label>
        <label className="check-field">
          <input type="checkbox" defaultChecked />
          <div>
            <b>Send an invitation</b>
            <span>Email this guest your RSVP link.</span>
          </div>
        </label>
      </>
    ),
  },

};

export function AppModal({
  modal,
  onClose,
  onSaved,
  onEventCreated,
  onEventSessionExpired,
}: {
  modal: ModalName | null;
  onClose: () => void;
  onSaved: (message: string) => void;
  onEventCreated?: (result: CreateEventResult) => Promise<boolean>;
  onEventSessionExpired?: () => void;
}) {
  if (!modal) return null;

  if (modal === "event") return <CreateEventModal
    onClose={onClose} onComplete={() => onSaved("Event created")}
    onCreated={onEventCreated ?? (async () => false)}
    onSessionExpired={onEventSessionExpired ?? onClose}
  />;

  if (modal === "template") {
    return (
      <Modal
        title="Replace budget allocations?"
        onClose={onClose}
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              Keep my custom amounts
            </Button>
            <Button onClick={() => onSaved("Wedding template applied")}>Replace allocations</Button>
          </>
        }
      >
        <div className="warning-box">
          <Icon name="bell" />
          <div>
            <b>This will overwrite your custom allocations</b>
            <p>
              Your total budget will stay at $35,000, but category percentages and amounts will be
              reset to the Wedding Essentials defaults.
            </p>
          </div>
        </div>
        <p className="modal-copy">You can edit any category again after applying the template.</p>
      </Modal>
    );
  }

  const { title, body, saved } = forms[modal];
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => onSaved(saved)}>
            Save
          </Button>
        </>
      }
    >
      {body}
    </Modal>
  );
}
