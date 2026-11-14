import { Button, Modal } from "../../components/ui";
import type { Vendor } from "../../types";
import type { ContractExpenseChoice, ContractExpensePlan } from "../../services/vendorExpenseContract";
import { currency } from "./vendorFormat";

export function ContractExpensePrompt({ vendor, plan, busy = false, onChoose, onClose }: {
  vendor: Vendor;
  plan: ContractExpensePlan;
  busy?: boolean;
  onChoose: (choice: ContractExpenseChoice) => void;
  onClose: () => void;
}) {
  const creating = plan.mode === "create";
  const single = plan.mode === "single";
  const linkedTotal = (plan.expenses.reduce((sum, expense) => sum + Math.round(expense.total * 100), 0) / 100).toFixed(2);
  return (
    <Modal
      title={creating ? "Add this contract to expenses?" : single ? "Update the linked expense too?" : "Review the expense breakdown"}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>{creating ? "Not now" : "Cancel"}</Button>
          {!creating && (
            <Button variant="secondary" onClick={() => onChoose("keep")} disabled={busy}>
              {single ? "Keep expense unchanged" : "Keep expenses unchanged"}
            </Button>
          )}
          <Button onClick={() => onChoose(creating ? "create" : single ? "sync" : "review")} disabled={busy}>
            {busy ? "Adding..." : creating ? "Add expense" : single ? "Update both" : "Review breakdown"}
          </Button>
        </>
      }
    >
      <div className="vendor-contract-identity">
        <strong>{vendor.name}</strong>
        <span>{vendor.category || "Uncategorized"}</span>
      </div>
      {creating ? (
        <p className="modal-copy">
          Add "{vendor.name} contract" for <strong className="vendor-contract-amount">{currency(plan.total)}</strong>?
          It will start unpaid. You can set a due date and record payments from Expenses.
        </p>
      ) : single ? (
        <p className="modal-copy">
          Update "{plan.expenses[0]!.vendor}" from <strong className="vendor-contract-amount">{currency(linkedTotal)}</strong> to <strong className="vendor-contract-amount">{currency(plan.total)}</strong> too?
          Its payments and due date will be kept.
        </p>
      ) : (
        <p className="modal-copy">
          The new contract is <strong className="vendor-contract-amount">{currency(plan.total)}</strong>. There are {plan.expenses.length} linked expenses
          totaling <strong className="vendor-contract-amount">{currency(linkedTotal)}</strong>, which may be installments.
          Save the contract and review their breakdown before changing the expenses.
        </p>
      )}
    </Modal>
  );
}
