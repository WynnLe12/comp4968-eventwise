import { formatCalendarDate } from "../../utils/dateFormat";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useResource } from "../../hooks/useResource";
import { vendorService } from "../../services/vendorService";
import { mockExpenseStore } from "../../services/mockExpenseStore";
import { Badge, Button, Card, Icon } from "../../components/ui";
import { EmptyState, ErrorState, PageHeader, StatCard } from "../../components/page";
import { CURRENT_EVENT_ID } from "../../data/mockData";
import { ExpenseActions } from "./ExpenseActions";
import { ExpenseForm } from "./ExpenseForm";
import { ExpenseDeleteDialog } from "./ExpenseDeleteDialog";
import { ExpensePaymentForm } from "./ExpensePaymentForm";
import { recordExpensePayment, validateExpensePayment, type PaymentDraft, type PaymentErrors } from "./expensePayments";
import { expenseSummary, matchesExpenseSummary, type ExpenseSummaryFilter } from "./expenseDraft";
import type { Expense } from "../../types";

const currency = (amount: number) =>
  amount.toLocaleString("en-US", { style: "currency", currency: "USD" });

const filters = ["All", "Unpaid", "Deposit", "Paid"];

function statusTone(status: string) {
  if (status === "Paid") return "success";
  if (status === "Unpaid") return "danger";
  return "warning";
}

export function Expenses() {
  const [params, setParams] = useSearchParams();
  const vendorId = params.get("vendorId") || null;
  const loadVendors = useCallback(() => vendorService.list(CURRENT_EVENT_ID), []);
  const { data: vendorData, loading: vendorsLoading, error: vendorsError, reload: reloadVendors } = useResource(loadVendors);
  const vendors = vendorData ?? [];
  const selectedVendor = vendors.find((vendor) => vendor.id === vendorId);
  const vendorNames = new Map(vendors.map((vendor) => [vendor.id, vendor.name]));
  const [filter, setFilter] = useState("All");
  const [search, setSearch] = useState("");
  const [summaryFilter, setSummaryFilter] = useState<ExpenseSummaryFilter>("all");
  const [expenses, setExpenses] = useState<Expense[]>(() => mockExpenseStore.list(CURRENT_EVENT_ID));
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [paying, setPaying] = useState<Expense | null>(null);
  const [deleting, setDeleting] = useState<Expense | null>(null);
  const [toast, setToast] = useState("");
  const vendorExpenses = vendorId ? expenses.filter((expense) => expense.vendorId === vendorId) : expenses;
  const summary = expenseSummary(vendorExpenses);
  const onAdd = () => setAdding(true);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const saveExpense = (expense: Expense) => {
    mockExpenseStore.save(CURRENT_EVENT_ID, expense);
    setExpenses(mockExpenseStore.list(CURRENT_EVENT_ID));
    setSearch("");
    setFilter("All");
    setSummaryFilter("all");
    setAdding(false);
    setToast(editing ? "Expense updated" : "Expense added");
    setEditing(null);
  };

  const savePayment = (draft: PaymentDraft): PaymentErrors => {
    const current = mockExpenseStore.list(CURRENT_EVENT_ID).find((expense) => expense.id === paying?.id);
    if (!current) return { amount: "This expense is no longer available." };
    const errors = validateExpensePayment(current, draft);
    if (Object.keys(errors).length) return errors;
    const updated = recordExpensePayment(current, draft);
    mockExpenseStore.save(CURRENT_EVENT_ID, updated);
    setExpenses(mockExpenseStore.list(CURRENT_EVENT_ID));
    setFilter("All");
    setSummaryFilter("all");
    setPaying(null);
    setToast("Payment recorded");
    return {};
  };

  const confirmDelete = (): string | undefined => {
    if (!deleting) return "Choose an expense to delete.";
    try {
      mockExpenseStore.remove(CURRENT_EVENT_ID, deleting.id);
    } catch (error) {
      return error instanceof Error ? error.message : "Unable to delete this expense.";
    }
    setExpenses(mockExpenseStore.list(CURRENT_EVENT_ID));
    setDeleting(null);
    setToast("Expense deleted");
    return undefined;
  };

  const clearTableFilters = () => {
    setFilter("All");
    setSearch("");
    setSummaryFilter("all");
  };

  const selectSummaryFilter = (next: ExpenseSummaryFilter) => {
    clearTableFilters();
    setSummaryFilter(next);
  };

  const clearVendorFilter = () => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.delete("vendorId");
      return next;
    }, { replace: true });
  };
  const clearFilters = () => {
    clearTableFilters();
    clearVendorFilter();
  };
  const hasTableFilters = summaryFilter !== "all" || filter !== "All" || Boolean(search.trim());
  const hasFilters = hasTableFilters || Boolean(vendorId);
  const query = search.trim().toLowerCase();
  const rows = vendorExpenses.filter(
    (expense) =>
      (filter === "All" || expense.status.includes(filter)) &&
      (expense.vendor.toLowerCase().includes(query) ||
        (vendorNames.get(expense.vendorId ?? "") ?? "").toLowerCase().includes(query)) &&
      matchesExpenseSummary(expense, summaryFilter),
  );
  return (
    <>
      <PageHeader
        page="expenses"
        action={
          <Button onClick={onAdd} icon="plus" disabled={vendorsLoading || Boolean(vendorsError) || Boolean(vendorId && !selectedVendor)}>
            Add expense
          </Button>
        }
      />
      {vendorsError ? (
        <ErrorState message="We couldn't load vendors. Retry to link expenses to a vendor." onRetry={reloadVendors} />
      ) : null}
      <div className="stat-grid expenses-stats">
        <StatCard label="Total expenses" value={currency(summary.total)} detail={vendorExpenses.length + (vendorExpenses.length === 1 ? " expense" : " expenses")} icon="receipt" selected={!hasTableFilters} onClick={() => selectSummaryFilter("all")} />
        <StatCard
          label="Paid so far"
          value={currency(summary.paid)}
          detail={summary.paidPercent + "% of expenses"}
          icon="check"
          selected={summaryFilter === "paid"}
          onClick={() => selectSummaryFilter("paid")}
          tone="mint"
        />
        <StatCard
          label="Outstanding"
          value={currency(summary.outstanding)}
          detail={summary.openCount + (summary.openCount === 1 ? " open expense" : " open expenses")}
          icon="clock"
          selected={summaryFilter === "outstanding"}
          onClick={() => selectSummaryFilter("outstanding")}
          tone="coral"
        />
        <StatCard
          label="Due this month"
          value={currency(summary.dueThisMonth)}
          detail={summary.dueCount + (summary.dueCount === 1 ? " expense" : " expenses")}
          icon="calendar"
          selected={summaryFilter === "due"}
          onClick={() => selectSummaryFilter("due")}
          tone="gold"
        />
      </div>
      <Card>
        <div className="table-toolbar expense-toolbar">
          <div className="tabs">
            {filters.map((x) => (
              <button
                className={summaryFilter === "all" && filter === x ? "active" : ""}
                aria-pressed={summaryFilter === "all" && filter === x}
                onClick={() => {
                  setFilter(x);
                  setSummaryFilter("all");
                }}
                key={x}
              >
                {x}
              </button>
            ))}
          </div>
          <div className="toolbar-actions">
            {vendorId && (
              <span className="expense-vendor-filter">
                Vendor: {selectedVendor?.name ?? (vendorsLoading ? "Loading..." : "Unavailable")}
                <button type="button" aria-label="Clear vendor filter" onClick={clearVendorFilter}>
                  <Icon name="close" size={14} />
                </button>
              </span>
            )}
            <label className="search-input">
              <Icon name="search" />
              <input
                type="search"
                aria-label="Search expenses"
                placeholder="Search expenses"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <button className="filter-btn">
              All categories <Icon name="down" size={14} />
            </button>
            {hasFilters && (
              <button type="button" className="filter-btn expense-clear-filters" onClick={clearFilters}>
                Clear filters
              </button>
            )}
          </div>
        </div>
        <div className="table-wrap expense-table">
          <table>
            <thead>
              <tr>
                <th>Vendor / Expense</th>
                <th>Category</th>
                <th>Total</th>
                <th>Paid</th>
                <th>Balance due</th>
                <th>Due date</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8}>
                    <EmptyState
                      title={vendorId && !vendorsLoading && !selectedVendor ? "Vendor unavailable" :
                        vendorId && vendorExpenses.length === 0 ? "No expenses linked to this vendor" : "No matching expenses"}
                      message={vendorId && vendorExpenses.length === 0 ? "Add an expense for this vendor or clear the vendor filter." : "Try another search or clear your filters."}
                      action={
                        <Button
                          onClick={clearFilters}
                        >
                          Clear filters
                        </Button>
                      }
                    />
                  </td>
                </tr>
              )}
              {rows.map((x) => (
                <tr key={x.id} className="expense-row">
                  <td>
                    <b>{x.vendor}</b>
                    {x.vendorId && <span className="expense-linked-vendor">{vendorNames.get(x.vendorId) ?? "Vendor unavailable"}</span>}
                  </td>
                  <td>{x.category}</td>
                  <td>{currency(x.total)}</td>
                  <td>{currency(x.paid)}</td>
                  <td>
                    <b>{currency((Math.round(x.total * 100) - Math.round(x.paid * 100)) / 100)}</b>
                  </td>
                  <td>{formatCalendarDate(x.dueDate ?? x.due, "No due date")}</td>
                  <td>
                    <Badge tone={statusTone(x.status)}>{x.status}</Badge>
                  </td>
                  <td>
                    <ExpenseActions vendorName={vendorNames.get(x.vendorId ?? "")} expense={x} onEdit={() => setEditing(x)} onRecordPayment={() => setPaying(x)} onDelete={() => setDeleting(x)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="pagination">
          <span>
            Showing {rows.length} of {vendorExpenses.length} {vendorExpenses.length === 1 ? "expense" : "expenses"}
          </span>
          <div>
            <button>‹</button>
            <button className="active">1</button>
            <button>›</button>
          </div>
        </div>
      </Card>
      {(adding || editing) && (
        <ExpenseForm
          key={editing?.id ?? "new"}
          expense={editing ?? undefined}
          vendors={vendors}
          defaultVendorId={selectedVendor?.id}
          onSave={saveExpense}
          onClose={() => {
            setAdding(false);
            setEditing(null);
          }}
        />
      )}
      {paying && (
        <ExpensePaymentForm
          key={paying.id} expense={paying}
          onSave={savePayment} onClose={() => setPaying(null)}
        />
      )}
      {deleting && (
        <ExpenseDeleteDialog
          key={deleting.id} expense={deleting}
          onConfirm={confirmDelete} onClose={() => setDeleting(null)}
        />
      )}
      {toast && <div className="toast" role="status">{toast}</div>}
    </>
  );
}
