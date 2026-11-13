import { useState } from "react";
import { Badge, Button, Card, Icon } from "../../components/ui";
import { EmptyState, PageHeader, StatCard } from "../../components/page";
import { expensesSeed } from "../../data/mockData";
import { ExpenseActions } from "./ExpenseActions";

const filters = ["All", "Unpaid", "Deposit", "Paid"];

function statusTone(status: string) {
  if (status === "Paid") return "success";
  if (status === "Unpaid") return "danger";
  return "warning";
}

export function Expenses({ onAdd }: { onAdd: () => void }) {
  const [filter, setFilter] = useState("All");
  const [search, setSearch] = useState("");
  const expenses = expensesSeed;

  if (!expenses.length)
    return (
      <>
        <PageHeader page="expenses" />
        <EmptyState
          title="No expenses yet"
          message="Add your first quote, deposit, or payment to start tracking your spending."
          action={
            <Button onClick={onAdd} icon="plus">
              Add expense
            </Button>
          }
        />
      </>
    );

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
        <StatCard label="Total expenses" value="$22,290" detail="Across 5 vendors" icon="receipt" />
        <StatCard
          label="Paid so far"
          value="$8,590"
          detail="39% of expenses"
          icon="check"
          tone="mint"
        />
        <StatCard
          label="Outstanding"
          value="$13,700"
          detail="4 open payments"
          icon="clock"
          tone="coral"
        />
        <StatCard
          label="Due this month"
          value="$3,950"
          detail="2 payments"
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
                <tr key={x.vendor}>
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
    </>
  );
}
