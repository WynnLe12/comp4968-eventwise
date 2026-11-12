import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Field, Icon, Modal, SelectField } from "../../components/ui";
import {
  BOOKING_STATUSES,
  bookingLabels,
  bookingOptionDisabledReason,
  CONTRACT_STATUSES,
  contractLabels,
  contractOptionDisabledReason,
  emailError,
  FIELD_LIMITS,
  hasActiveContract,
  nameError,
  parseAmount,
  researchingNeedsConfirmation,
  type VendorField,
} from "../../services/vendorRules";
import type { BookingStatus, ContractStatus, Vendor, VendorStoredFields } from "../../types";

export type VendorFormInput = Omit<VendorStoredFields, "eventId">;

/** What the page returns when a save fails: shown in the banner, and inline when a field is named. */
export interface VendorFormSubmitError {
  message: string;
  field?: VendorField;
}

interface FormValues {
  name: string;
  category: string;
  contactName: string;
  email: string;
  phone: string;
  quoteAmount: string;
  contractTotal: string;
  bookingStatus: BookingStatus;
  contractStatus: ContractStatus;
}

type ValidatedField = "name" | "email" | "quoteAmount" | "contractTotal";
type FormErrors = Partial<Record<VendorField, string>>;

function initialValues(vendor: Vendor | null): FormValues {
  return {
    name: vendor?.name ?? "",
    category: vendor?.category ?? "",
    contactName: vendor?.contactName ?? "",
    email: vendor?.email ?? "",
    phone: vendor?.phone ?? "",
    quoteAmount: vendor?.quoteAmount == null ? "" : String(vendor.quoteAmount),
    contractTotal: vendor?.contractTotal == null ? "" : String(vendor.contractTotal),
    // New vendors start as Researching with no contract.
    bookingStatus: vendor?.bookingStatus ?? "researching",
    contractStatus: vendor?.contractStatus ?? "none",
  };
}

function validate(field: ValidatedField, values: FormValues) {
  switch (field) {
    case "name":
      return nameError(values.name);
    case "email":
      return emailError(values.email);
    case "quoteAmount":
      return parseAmount(values.quoteAmount, "Quote amount").error;
    case "contractTotal":
      return values.contractStatus === "none"
        ? ""
        : parseAmount(values.contractTotal, "Contract total").error;
  }
}

const VALIDATED_FIELDS: ValidatedField[] = ["name", "email", "quoteAmount", "contractTotal"];

export function VendorForm({
  formId,
  vendor,
  onSubmit,
}: {
  formId: string;
  /** The vendor being edited, or null when adding. */
  vendor: Vendor | null;
  onSubmit: (input: VendorFormInput) => Promise<VendorFormSubmitError | null>;
}) {
  const [values, setValues] = useState<FormValues>(() => initialValues(vendor));
  const [errors, setErrors] = useState<FormErrors>({});
  const [banner, setBanner] = useState("");
  const [statusNote, setStatusNote] = useState("");
  const [confirmResearching, setConfirmResearching] = useState(false);
  const [focusErrors, setFocusErrors] = useState(0);
  const submitting = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);

  // After a failed submit, move focus to the first field with an error.
  useEffect(() => {
    if (focusErrors) formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [focusErrors]);

  const set = <K extends keyof FormValues>(field: K, value: FormValues[K]) => {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: "" }));
  };

  const validateOnBlur = (field: ValidatedField) =>
    setErrors((current) => ({ ...current, [field]: validate(field, values) }));

  const changeQuote = (text: string) => {
    set("quoteAmount", text);
    if (text.trim() !== "" && values.bookingStatus === "researching") {
      set("bookingStatus", "quoted");
      setStatusNote("Changed to Quoted because a quote was entered.");
    }
  };

  const changeContractStatus = (next: ContractStatus) => {
    set("contractStatus", next);
    if (next === "none") set("contractTotal", "");
    if (next === "signed" && values.bookingStatus !== "booked") {
      set("bookingStatus", "booked");
      setStatusNote("Changed to Booked because the contract is signed.");
    }
  };

  const changeBookingStatus = (next: BookingStatus) => {
    if (
      next === "researching" &&
      researchingNeedsConfirmation(values.quoteAmount.trim() !== "", values.contractStatus)
    ) {
      setConfirmResearching(true);
      return;
    }
    set("bookingStatus", next);
    setStatusNote("");
  };

  const moveToResearching = () => {
    setValues((current) => ({
      ...current,
      bookingStatus: "researching",
      quoteAmount: "",
      contractStatus: "none",
      contractTotal: "",
    }));
    setErrors((current) => ({ ...current, quoteAmount: "", contractTotal: "" }));
    setStatusNote("");
    setConfirmResearching(false);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting.current) return;

    const nextErrors: FormErrors = {};
    for (const field of VALIDATED_FIELDS) nextErrors[field] = validate(field, values);
    setErrors(nextErrors);
    if (Object.values(nextErrors).some(Boolean)) {
      setBanner("Please fix the highlighted fields and try again.");
      setFocusErrors((count) => count + 1);
      return;
    }

    setBanner("");
    submitting.current = true;
    const failure = await onSubmit({
      name: values.name.trim(),
      category: values.category.trim(),
      contactName: values.contactName.trim(),
      email: values.email.trim(),
      phone: values.phone.trim(),
      quoteAmount: parseAmount(values.quoteAmount, "Quote amount").value,
      contractTotal:
        values.contractStatus === "none"
          ? null
          : parseAmount(values.contractTotal, "Contract total").value,
      bookingStatus: values.bookingStatus,
      contractStatus: values.contractStatus,
    });
    submitting.current = false;

    // On failure everything the user typed stays in place.
    if (failure) {
      setBanner(failure.message);
      if (failure.field) setErrors((current) => ({ ...current, [failure.field!]: failure.message }));
    }
  };

  const statusState = { bookingStatus: values.bookingStatus, contractStatus: values.contractStatus };
  const noContract = values.contractStatus === "none";

  const bookingHint =
    statusNote ||
    (values.contractStatus === "signed"
      ? "Cancel the contract first to change the booking status."
      : hasActiveContract(values.contractStatus)
        ? "Cancel the contract first to move back to Researching or decline."
        : undefined);

  const contractHint =
    values.bookingStatus === "researching"
      ? "Add a quote first to add a contract."
      : values.bookingStatus === "declined" && values.contractStatus !== "cancelled"
        ? "Declined vendors can't take on a contract."
        : undefined;

  return (
    <form id={formId} ref={formRef} onSubmit={submit} noValidate className="vendor-form">
      {banner && (
        <div className="form-error-banner" role="alert">
          <Icon name="alert" size={17} />
          <span>{banner}</span>
        </div>
      )}

      <Field
        label="Business name"
        name="name"
        placeholder="e.g. Rosewood Bakery"
        value={values.name}
        onChange={(event) => set("name", event.target.value)}
        onBlur={() => validateOnBlur("name")}
        error={errors.name}
        maxLength={FIELD_LIMITS.name}
        autoComplete="organization"
        required
      />
      <div className="form-row">
        <Field
          label="Category"
          name="category"
          placeholder="e.g. Catering"
          value={values.category}
          onChange={(event) => set("category", event.target.value)}
          error={errors.category}
          maxLength={FIELD_LIMITS.category}
        />
        <Field
          label="Contact name"
          name="contactName"
          placeholder="Full name"
          value={values.contactName}
          onChange={(event) => set("contactName", event.target.value)}
          error={errors.contactName}
          maxLength={FIELD_LIMITS.contactName}
          autoComplete="name"
        />
      </div>
      <div className="form-row">
        <Field
          label="Email"
          name="email"
          type="email"
          placeholder="hello@vendor.com"
          value={values.email}
          onChange={(event) => set("email", event.target.value)}
          onBlur={() => validateOnBlur("email")}
          error={errors.email}
          maxLength={FIELD_LIMITS.email}
          autoComplete="email"
        />
        <Field
          label="Phone"
          name="phone"
          type="tel"
          placeholder="(555) 000-0000"
          value={values.phone}
          onChange={(event) => set("phone", event.target.value)}
          error={errors.phone}
          maxLength={FIELD_LIMITS.phone}
          autoComplete="tel"
        />
      </div>
      <div className="form-row">
        <Field
          label="Quote amount"
          name="quoteAmount"
          inputMode="decimal"
          placeholder="0.00"
          value={values.quoteAmount}
          onChange={(event) => changeQuote(event.target.value)}
          onBlur={() => validateOnBlur("quoteAmount")}
          error={errors.quoteAmount}
        />
        <Field
          label="Contract total"
          name="contractTotal"
          inputMode="decimal"
          placeholder="0.00"
          value={values.contractTotal}
          onChange={(event) => set("contractTotal", event.target.value)}
          onBlur={() => validateOnBlur("contractTotal")}
          error={errors.contractTotal}
          disabled={noContract}
          hint={noContract ? "Add a contract first" : undefined}
        />
      </div>
      <div className="form-row">
        <SelectField
          label="Contract status"
          name="contractStatus"
          value={values.contractStatus}
          onChange={(event) => changeContractStatus(event.target.value as ContractStatus)}
          error={errors.contractStatus}
          hint={contractHint}
          options={CONTRACT_STATUSES.map((status) => ({
            value: status,
            label: status === "none" ? "No contract" : contractLabels[status],
            disabled: Boolean(contractOptionDisabledReason(status, statusState)),
          }))}
        />
        <SelectField
          label="Booking status"
          name="bookingStatus"
          value={values.bookingStatus}
          onChange={(event) => changeBookingStatus(event.target.value as BookingStatus)}
          error={errors.bookingStatus}
          hint={bookingHint}
          options={BOOKING_STATUSES.map((status) => ({
            value: status,
            label: bookingLabels[status],
            disabled: Boolean(bookingOptionDisabledReason(status, statusState)),
          }))}
        />
      </div>

      {confirmResearching && (
        <Modal
          title="Move back to Researching?"
          onClose={() => setConfirmResearching(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirmResearching(false)}>
                Cancel
              </Button>
              <Button onClick={moveToResearching}>Move to Researching</Button>
            </>
          }
        >
          <p className="modal-copy">
            Moving {values.name.trim() || "this vendor"} back to Researching clears its quote
            amount
            {values.contractStatus === "cancelled" ? " and the cancelled contract details" : ""}.
          </p>
        </Modal>
      )}
    </form>
  );
}
