import { formatCalendarDate } from "../../utils/dateFormat";
import { useCallback, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useResource } from "../../hooks/useResource";
import { vendorService } from "../../services/vendorService";
import { expenseService } from "../../services/expenseService";
import { Badge, Button, Card, Icon } from "../../components/ui";
import { EmptyState, ErrorState, LoadingState, PageHeader, StatCard } from "../../components/page";
import { useEvents } from "../events/EventsContext";
import { useEventCategories } from "../categories/useEventCategories";
import type { Expense } from "../../types";
import { ExpenseDeleteDialog } from "./ExpenseDeleteDialog";
import { ExpenseForm } from "./ExpenseForm";
import { ExpenseActions } from "./ExpenseActions";
import { expenseSummary, matchesExpenseSummary, type ExpenseSummaryFilter } from "./expenseDraft";

const currency = (amount: number) =>
  amount.toLocaleString("en-US", { style: "currency", currency: "USD" });

const filters = ["All", "Unpaid", "Deposit", "Paid"];

function statusTone(status: string) {
  if (status === "Paid") return "success";
  if (status === "Unpaid") return "danger";
  return "warning";
}

export function Expenses() {
  const { selectedId, userId } = useEvents();
  if (!selectedId || !userId) return <EmptyState title="Select an event" message="Choose an event to manage its expenses." />;
  return <EventExpenses key={JSON.stringify([userId, selectedId])} eventId={selectedId} accountId={userId} />;
}

function EventExpenses({ eventId, accountId }: { eventId: string; accountId: string }) {
  const [params, setParams] = useSearchParams();
  const vendorId = params.get("vendorId") || null;
  const loadVendors = useCallback(() => vendorService.list(eventId), [eventId]);
  const { data: vendorData, loading: vendorsLoading, error: vendorsError, reload: reloadVendors } = useResource(loadVendors);
  const vendors = vendorData ?? [];
  const selectedVendor = vendors.find((vendor) => vendor.id === vendorId);
  const vendorNames = new Map(vendors.map((vendor) => [vendor.id, vendor.name]));
  const { categories, loading: categoriesLoading, error: categoriesError, retry: retryCategories } = useEventCategories(eventId, accountId);
  const [categoryId, setCategoryId] = useState("");
  const [filter, setFilter] = useState("All");
  const [search, setSearch] = useState("");
  const [summaryFilter, setSummaryFilter] = useState<ExpenseSummaryFilter>("all");
  const loadExpenses = useCallback(() => expenseService.list(eventId), [eventId]);
  const { data: expenseData, loading: expensesLoading, error: expensesError, reload: reloadExpenses, update: updateExpenses } = useResource(loadExpenses);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [deleting, setDeleting] = useState<Expense | null>(null);
  const [notice, setNotice] = useState("");
  const expenses = expenseData ?? [];
  const vendorExpenses = vendorId ? expenses.filter((expense) => expense.vendorId === vendorId) : expenses;
  const summary = expenseSummary(vendorExpenses);

  const clearTableFilters = () => {
    setCategoryId("");
    setFilter("All");
    setSearch("");
    setSummaryFilter("all");
  };

  const saveExpense = async (expense: Expense) => {
    if (expense.eventId !== eventId || !expense.categoryId) throw new Error("Reopen this expense in its own event and choose a category.");
    if (editing && expense.id !== editing.id) throw new Error("Reopen the expense before saving.");
    const input = {
      categoryId: expense.categoryId, vendorId: expense.vendorId, description: expense.vendor,
      committedAmount: expense.total.toFixed(2), dueDate: expense.dueDate ?? null,
    };
    const saved = editing ? await expenseService.update(eventId, editing.id, input) : await expenseService.create(eventId, input);
    updateExpenses(current => editing ? current.map(row => row.id === saved.id ? saved : row) : [saved, ...current.filter(row => row.id !== saved.id)]);
    clearTableFilters();
    setAdding(false);
    setNotice(editing ? "Expense updated." : "Expense added.");
    setEditing(null);
  };

  const deleteExpense = async () => {
    if (!deleting || deleting.eventId !== eventId) throw new Error("Reopen this expense in its own event.");
    await expenseService.remove(eventId, deleting.id);
    updateExpenses(current => current.filter(row => row.id !== deleting.id));
    setDeleting(null);
    setNotice("Expense deleted.");
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
  const hasTableFilters = summaryFilter !== "all" || filter !== "All" || Boolean(search.trim()) || Boolean(categoryId);
  const hasFilters = hasTableFilters || Boolean(vendorId);
  const query = search.trim().toLowerCase();
  const rows = vendorExpenses.filter(
    (expense) =>
      (!categoryId || expense.categoryId === categoryId) &&
      (filter === "All" || expense.status.includes(filter)) &&
      (expense.vendor.toLowerCase().includes(query) ||
        (vendorNames.get(expense.vendorId ?? "") ?? "").toLowerCase().includes(query)) &&
      matchesExpenseSummary(expense, summaryFilter),
  );
  if (expensesLoading) return <LoadingState label="Loading expenses..." />;
  if (expensesError) return <ErrorState message={expensesError instanceof Error ? expensesError.message : "Couldn\'t load expenses."} onRetry={reloadExpenses} />;

  return (
    <>
      <PageHeader
        page="expenses"
        action={
          <Button icon="plus" disabled={vendorsLoading || Boolean(vendorsError) || Boolean(vendorId && !selectedVendor)} onClick={() => { setNotice(""); setEditing(null); setAdding(true); }}>
            Add expense
          </Button>
        }
      />
      <p className="feature-preview-notice" role="status">You can add, edit, delete, and view saved expenses. Recording payments will be available next.</p>
      {notice && <p role="status">{notice}</p>}
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
            <select className="filter-btn expense-category-filter"
              aria-label="Filter expenses by category" value={categoryId}
              aria-describedby={categoriesLoading || categoriesError || categories.length === 0 ? "expense-category-filter-status" : undefined}
              disabled={categoriesLoading || Boolean(categoriesError) || categories.length === 0}
              onChange={event => setCategoryId(event.target.value)}>
              <option value="">{categoriesLoading ? "Loading categories..." : "All categories"}</option>
              {categoryId && !categories.some(category => category.categoryId === categoryId) &&
                <option value={categoryId} disabled>Category unavailable</option>}
              {categories.map(category => <option key={category.categoryId} value={category.categoryId}>{category.name}</option>)}
            </select>
            {hasFilters && (
              <button type="button" className="filter-btn expense-clear-filters" onClick={clearFilters}>
                Clear filters
              </button>
            )}
          </div>
        </div>
        <div id="expense-category-filter-status" className="expense-category-filter-status">
          {categoriesError ? <p role="alert">{categoriesError} <button type="button" className="btn btn-ghost" onClick={retryCategories}>Retry categories</button></p>
            : categoriesLoading ? <small role="status">Loading this event's category filters...</small>
            : categories.length === 0 ? <small role="status">No budget categories are available for this event.</small> : null}
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
                        vendorId && vendorExpenses.length === 0 ? "No expenses linked to this vendor" : expenses.length === 0 ? "No expenses yet" : "No matching expenses"}
                      message={expenses.length === 0 ? "This event has no saved expenses yet." : vendorId && vendorExpenses.length === 0 ? "Clear the vendor filter to see other expenses." : "Try another search or clear your filters."}
                      action={hasFilters ?
                        <Button
                          onClick={clearFilters}
                        >
                          Clear filters
                        </Button> : undefined
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
                    <ExpenseActions vendorName={vendorNames.get(x.vendorId ?? "")} expense={x} readOnly allowEdit allowDelete onEdit={() => { setNotice(""); setEditing(x); }} onRecordPayment={() => {}} onDelete={() => { setNotice(""); setDeleting(x); }} />
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
      {deleting && <ExpenseDeleteDialog key={deleting.id} expense={deleting} onConfirm={deleteExpense} onClose={() => setDeleting(null)} />}
      {(adding || editing) && <ExpenseForm key={editing?.id ?? "new"} eventId={eventId} accountId={accountId} vendors={vendors}
        expense={editing ?? undefined} defaultVendorId={selectedVendor?.id} onSave={saveExpense}
        onClose={() => { setAdding(false); setEditing(null); }} />}
    </>
  );
}
