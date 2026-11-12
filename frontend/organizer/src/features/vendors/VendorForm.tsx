import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Field, Icon, Modal, SelectField, TextAreaField } from "../../components/ui";
import {
  applyStatusRules,
  BOOKING_STATUSES,
  bookingLabels,
  bookingOptionDisabledReason,
  CONTRACT_STATUSES,
  contractLabels,
  contractOptionDisabledReason,
  emailError,
  hasActiveContract,
  MAX_LENGTH,
  moneyTextError,
  nameError,
  researchingNeedsConfirmation,
  textError,
  toMoney,
} from "../../services/vendorRules";
import type {
  BookingStatus,
  ContractStatus,
  Vendor,
  VendorField,
  VendorFieldErrors,
  VendorFields,
  VendorUpdateInput,
} from "../../types";

/** What the page returns when a save fails: the banner message, plus inline messages by field. */
export interface VendorFormSubmitError {
  message: string;
  fields?: VendorFieldErrors;
}

/** What the inputs hold: always text, so typing is never interrupted. */
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
  notes: string;
}

/** A new vendor starts as Researching with no contract. */
const NEW_VENDOR: VendorFields = {
  name: "",
  category: null,
  contactName: null,
  email: null,
  phone: null,
  quoteAmount: null,
  contractTotal: null,
  bookingStatus: "RESEARCHING",
  contractStatus: "NOT_STARTED",
  notes: null,
};

const FIELD_ORDER: VendorField[] = [
  "name",
  "category",
  "contactName",
  "email",
  "phone",
  "quoteAmount",
  "contractTotal",
  "contractStatus",
  "bookingStatus",
  "notes",
];

function savedFields(vendor: Vendor | null): VendorFields {
  if (!vendor) return NEW_VENDOR;
  const fields = {} as Record<string, unknown>;
  for (const key of FIELD_ORDER) fields[key] = vendor[key];
  return fields as unknown as VendorFields;
}

function initialValues(saved: VendorFields): FormValues {
  return {
    name: saved.name,
    category: saved.category ?? "",
    contactName: saved.contactName ?? "",
    email: saved.email ?? "",
    phone: saved.phone ?? "",
    quoteAmount: saved.quoteAmount ?? "",
    contractTotal: saved.contractTotal ?? "",
    bookingStatus: saved.bookingStatus,
    contractStatus: saved.contractStatus,
    notes: saved.notes ?? "",
  };
}

/** The vendor the form describes, in the API's shape: trimmed, empty text as null, money as "0.00". */
function toFields(values: FormValues): VendorFields {
  const text = (value: string) => value.trim() || null;
  const money = (value: string) => toMoney(value) ?? null;
  return {
    name: values.name.trim(),
    category: text(values.category),
    contactName: text(values.contactName),
    email: text(values.email),
    phone: text(values.phone),
    quoteAmount: money(values.quoteAmount),
    contractTotal: values.contractStatus === "NOT_STARTED" ? null : money(values.contractTotal),
    bookingStatus: values.bookingStatus,
    contractStatus: values.contractStatus,
    notes: text(values.notes),
  };
}

/** POST sends every field; PATCH sends only the fields that changed. */
function requestBody(fields: VendorFields, saved: VendorFields, isNew: boolean): VendorUpdateInput {
  if (isNew) return fields;
  const changes: Record<string, unknown> = {};
  for (const key of FIELD_ORDER) {
    if (fields[key] !== saved[key]) changes[key] = fields[key];
  }
  return changes as VendorUpdateInput;
}

function fieldError(field: VendorField, values: FormValues) {
  switch (field) {
    case "name":
      return nameError(values.name);
    case "email":
      return emailError(values.email);
    case "category":
    case "contactName":
    case "phone":
    case "notes":
      return textError(field, values[field].trim());
    case "quoteAmount":
      return moneyTextError(values.quoteAmount);
    case "contractTotal":
      return values.contractStatus === "NOT_STARTED" ? "" : moneyTextError(values.contractTotal);
    default:
      return "";
  }
}

export function VendorForm({
  formId,
  vendor,
  onSubmit,
}: {
  formId: string;
  /** The vendor being edited, or null when adding. */
  vendor: Vendor | null;
  onSubmit: (body: VendorUpdateInput) => Promise<VendorFormSubmitError | null>;
}) {
  const [saved] = useState(() => savedFields(vendor));
  const [values, setValues] = useState<FormValues>(() => initialValues(saved));
  const [errors, setErrors] = useState<VendorFieldErrors>({});
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

  const validateOnBlur = (field: VendorField) =>
    setErrors((current) => ({ ...current, [field]: fieldError(field, values) }));

  const changeQuote = (text: string) => {
    set("quoteAmount", text);
    if (text.trim() !== "" && values.bookingStatus === "RESEARCHING") {
      set("bookingStatus", "QUOTED");
      setStatusNote("Changed to Quoted because a quote was entered.");
    }
  };

  const changeContractStatus = (next: ContractStatus) => {
    set("contractStatus", next);
    if (next === "NOT_STARTED") set("contractTotal", "");
    if (next === "SIGNED" && values.bookingStatus === "QUOTED") {
      set("bookingStatus", "BOOKED");
      setStatusNote("Changed to Booked because the contract is signed.");
    }
  };

  const changeBookingStatus = (next: BookingStatus) => {
    if (
      next === "RESEARCHING" &&
      researchingNeedsConfirmation({
        quoteAmount: values.quoteAmount.trim() || null,
        contractStatus: values.contractStatus,
      })
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
      bookingStatus: "RESEARCHING",
      quoteAmount: "",
      contractStatus: "NOT_STARTED",
      contractTotal: "",
    }));
    setErrors((current) => ({ ...current, quoteAmount: "", contractTotal: "" }));
    setStatusNote("");
    setConfirmResearching(false);
  };

  const showErrors = (nextErrors: VendorFieldErrors, message: string) => {
    setErrors(nextErrors);
    setBanner(message);
    setFocusErrors((count) => count + 1);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting.current) return;

    // Same checks as the server, so most problems show up without a request.
    const nextErrors: VendorFieldErrors = {};
    for (const field of FIELD_ORDER) {
      const message = fieldError(field, values);
      if (message) nextErrors[field] = message;
    }
    const fields = toFields(values);
    const body = requestBody(fields, saved, vendor === null);
    if (!Object.keys(nextErrors).length) {
      Object.assign(nextErrors, applyStatusRules(saved, body as Partial<VendorFields>).fields);
    }
    if (Object.keys(nextErrors).length) {
      showErrors(nextErrors, "Please fix the highlighted fields and try again.");
      return;
    }

    setErrors({});
    setBanner("");
    submitting.current = true;
    const failure = await onSubmit(body);
    submitting.current = false;

    // On failure everything the user typed stays in place.
    if (failure) {
      if (failure.fields && Object.keys(failure.fields).length) showErrors(failure.fields, failure.message);
      else setBanner(failure.message);
    }
  };

  const formState = toFields(values);
  const noContract = values.contractStatus === "NOT_STARTED";

  const bookingHint =
    statusNote ||
    (values.contractStatus === "SIGNED"
      ? "Cancel the contract first to change the booking status."
      : hasActiveContract(values.contractStatus)
        ? "Cancel the contract first to move back to Researching or decline."
        : undefined);

  const contractHint =
    values.bookingStatus === "RESEARCHING"
      ? "Add a quote first to add a contract."
      : values.bookingStatus === "DECLINED" && !hasActiveContract(values.contractStatus)
        ? "Declined vendors can't take on an active contract."
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
        maxLength={MAX_LENGTH.name}
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
          onBlur={() => validateOnBlur("category")}
          error={errors.category}
          maxLength={MAX_LENGTH.category}
        />
        <Field
          label="Contact name"
          name="contactName"
          placeholder="Full name"
          value={values.contactName}
          onChange={(event) => set("contactName", event.target.value)}
          onBlur={() => validateOnBlur("contactName")}
          error={errors.contactName}
          maxLength={MAX_LENGTH.contactName}
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
          maxLength={MAX_LENGTH.email}
          autoComplete="email"
        />
        <Field
          label="Phone"
          name="phone"
          type="tel"
          placeholder="(555) 000-0000"
          value={values.phone}
          onChange={(event) => set("phone", event.target.value)}
          onBlur={() => validateOnBlur("phone")}
          error={errors.phone}
          maxLength={MAX_LENGTH.phone}
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
            label: contractLabels[status],
            disabled: Boolean(contractOptionDisabledReason(status, formState)),
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
            disabled: Boolean(bookingOptionDisabledReason(status, formState)),
          }))}
        />
      </div>
      <TextAreaField
        label="Notes"
        name="notes"
        rows={3}
        placeholder="Anything to remember about this vendor"
        value={values.notes}
        onChange={(event) => set("notes", event.target.value)}
        onBlur={() => validateOnBlur("notes")}
        error={errors.notes}
        maxLength={MAX_LENGTH.notes}
      />

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
            {values.contractStatus === "CANCELLED" ? " and the cancelled contract details" : ""}.
          </p>
        </Modal>
      )}
    </form>
  );
}
