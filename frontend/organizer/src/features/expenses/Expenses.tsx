import { useEffect, useState } from "react";
import { Badge, Button, Card, Icon } from "../../components/ui";
import { EmptyState, PageHeader, StatCard } from "../../components/page";
import { expensesSeed } from "../../data/mockData";
import { ExpenseActions } from "./ExpenseActions";
import { ExpenseForm } from "./ExpenseForm";
import { expenseSummary } from "./expenseDraft";
import type { Expense } from "../../types";

// Session-only data, retained when navigating away and back. Refresh restores samples.
let sessionExpenses = expensesSeed.map((expense) => ({ ...expense }));
const currency = (amount: number) =>
  amount.toLocaleString("en-US", { style: "currency", currency: "USD" });

const filters = ["All", "Unpaid", "Deposit", "Paid"];

function statusTone(status: string) {
  if (status === "Paid") return "success";
  if (status === "Unpaid") return "danger";
  return "warning";
}

export function Expenses() {
  const [filter, setFilter] = useState("All");
  const [search, setSearch] = useState("");
  const [expenses, setExpenses] = useState<Expense[]>(() => sessionExpenses);
  const [adding, setAdding] = useState(false);
  const [toast, setToast] = useState("");
  const summary = expenseSummary(expenses);
  const onAdd = () => setAdding(true);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const saveExpense = (expense: Expense) => {
    sessionExpenses = [...sessionExpenses, expense];
    setExpenses(sessionExpenses);
    setSearch("");
    setFilter("All");
    setAdding(false);
    setToast("Expense added");
  };

  const query = search.trim().toLowerCase();
  const rows = expenses.filter(
    (expense) =>
      (filter === "All" || expense.status.includes(filter)) &&
      expense.vendor.toLowerCase().includes(query),
  );
  return (
    <>
      <PageHeader
        page="expenses"
        action={
          <Button onClick={onAdd} icon="plus">
            Add expense
          </Button>
        }
      />
      <div className="stat-grid expenses-stats">
        <StatCard label="Total expenses" value={currency(summary.total)} detail={expenses.length + " expenses"} icon="receipt" />
        <StatCard
          label="Paid so far"
          value={currency(summary.paid)}
          detail={summary.paidPercent + "% of expenses"}
          icon="check"
          tone="mint"
        />
        <StatCard
          label="Outstanding"
          value={currency(summary.outstanding)}
          detail={summary.openCount + " open expenses"}
          icon="clock"
          tone="coral"
        />
        <StatCard
          label="Due this month"
          value={currency(summary.dueThisMonth)}
          detail={summary.dueCount + " expenses"}
          icon="calendar"
          tone="gold"
        />
      </div>
      <Card>
        <div className="table-toolbar">
          <div className="tabs">
            {filters.map((x) => (
              <button className={filter === x ? "active" : ""} onClick={() => setFilter(x)} key={x}>
                {x}
              </button>
            ))}
          </div>
          <div className="toolbar-actions">
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
          </div>
        </div>
        <div className="table-wrap">
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
                      title="No matching expenses"
                      message="Try another search or clear your filters."
                      action={
                        <Button
                          onClick={() => {
                            setSearch("");
                            setFilter("All");
                          }}
                        >
                          Clear filters
                        </Button>
                      }
                    />
                  </td>
                </tr>
              )}
              {rows.map((x) => (
                <tr key={x.id}>
                  <td>
                    <b>{x.vendor}</b>
                  </td>
                  <td>{x.category}</td>
                  <td>${x.total.toLocaleString()}</td>
                  <td>${x.paid.toLocaleString()}</td>
                  <td>
                    <b>${(x.total - x.paid).toLocaleString()}</b>
                  </td>
                  <td>{x.due}</td>
                  <td>
                    <Badge tone={statusTone(x.status)}>{x.status}</Badge>
                  </td>
                  <td>
                    <ExpenseActions expense={x} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="pagination">
          <span>
            Showing {rows.length} of {expenses.length} expenses
          </span>
          <div>
            <button>‹</button>
            <button className="active">1</button>
            <button>›</button>
          </div>
        </div>
      </Card>
      {adding && <ExpenseForm onSave={saveExpense} onClose={() => setAdding(false)} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </>
  );
}
