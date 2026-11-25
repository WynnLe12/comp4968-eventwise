import { useCallback } from "react";
import { Badge, Button, Card, Icon } from "../../components/ui";
import { ErrorState, StatCard } from "../../components/page";
import { useResource } from "../../hooks/useResource";
import { formatCalendarDate } from "../../utils/dateFormat";
import { useEvents } from "../events/EventsContext";
import { eventDate, eventInitials, eventRole } from "../events/eventPresentation";
import type { Page } from "../../types";
import { formatMoney, getDashboard, type EventDashboard } from "./dashboardApi";

const cents = (amount: string) => Math.round(Number(amount) * 100);
const percent = (part: string, whole: string) =>
  cents(whole) > 0 ? Math.min(100, Math.round((cents(part) / cents(whole)) * 100)) : 0;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function BudgetSnapshot({ budget }: { budget: EventDashboard["budget"] }) {
  if (!budget.categories.length) return <p className="dashboard-empty">No budget categories yet.</p>;
  return (
    <div className="task-list">
      {budget.categories.map((category) => (
        <div key={category.categoryId}>
          <div className="task-row">
            <div>
              <b>{category.categoryName}</b>
              <small>
                {formatMoney(category.committedTotal)} committed of {formatMoney(category.plannedAmount)} planned ·{" "}
                {formatMoney(category.paidTotal)} paid
              </small>
            </div>
            {category.isOverBudget && (
              <div className="dashboard-flag">
                <Badge tone="danger">
                  Over by {formatMoney(((cents(category.committedTotal) - cents(category.plannedAmount)) / 100).toFixed(2))}
                </Badge>
              </div>
            )}
          </div>
          <div className={category.isOverBudget ? "progress coral" : "progress"}>
            <i style={{ width: `${percent(category.committedTotal, category.plannedAmount)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function UpcomingTasks({ tasks }: { tasks: EventDashboard["tasks"] }) {
  if (!tasks.nextDue.length) {
    return <p className="dashboard-empty">{tasks.total ? "No open tasks with a due date." : "No tasks yet."}</p>;
  }
  return (
    <div className="task-list">
      {tasks.nextDue.map((task) => (
        <div className="task-row" key={task.taskId}>
          <div>
            <b>{task.title}</b>
            <small>Due {formatCalendarDate(task.dueDate)} · {task.assigneeName ?? "Unassigned"}</small>
          </div>
        </div>
      ))}
    </div>
  );
}

function UpcomingPayments({ payments }: { payments: EventDashboard["payments"] }) {
  if (!payments.items.length) return <p className="dashboard-empty">No payments due in the next {payments.windowDays} days.</p>;
  return (
    <div className="task-list">
      {payments.items.map((payment) => (
        <div className="task-row" key={payment.expenseId}>
          <div>
            <b>{payment.description}</b>
            <small>
              {payment.vendorName ? `${payment.vendorName} · ` : ""}{payment.categoryName} · due {formatCalendarDate(payment.dueDate)}
            </small>
          </div>
          {payment.isOverdue && <div className="dashboard-flag"><Badge tone="danger">Overdue</Badge></div>}
          <b>{formatMoney(payment.outstandingAmount)}</b>
        </div>
      ))}
    </div>
  );
}

export function Dashboard({ go }: { go: (p: Page) => void }) {
  const { eventDetails: selectedEvent, openCreate, openEdit } = useEvents();
  const eventId = selectedEvent?.event_id;
  const load = useCallback(() => (eventId ? getDashboard(eventId) : Promise.resolve(null)), [eventId]);
  const { data, loading, error, reload } = useResource<EventDashboard | null>(load);
  if (!selectedEvent) return null;

  const loadingText = loading ? "Loading..." : "";
  const guests = data?.guests;
  const dueTotal = data ? formatMoney(((cents(data.payments.overdueTotal) + cents(data.payments.upcomingTotal)) / 100).toFixed(2)) : "--";

  return (
    <>
      <div role="toolbar" aria-label="Event actions" style={{ display: "flex", justifyContent: "flex-end", flexWrap: "wrap", gap: 9, marginBottom: 16 }}>
        <Button variant="secondary" onClick={() => go("events")} icon="grid">View events</Button>
        <Button onClick={openCreate} icon="plus">Create event</Button>
        {selectedEvent.role === "OWNER" && <Button variant="secondary" onClick={openEdit}>Edit event</Button>}
      </div>
      <div className="dashboard-banner">
        <div>
          <div className="eyebrow">YOUR EVENT</div>
          <h2>{selectedEvent.name}</h2>
          <p>{selectedEvent.venue ?? "Venue not set"} / {eventDate(selectedEvent.event_date)}</p>
          <div className="banner-meta"><span>{eventRole(selectedEvent.role)}</span><span>{selectedEvent.template_id ? `Template ID: ${selectedEvent.template_id}` : "No template"}</span></div>
        </div>
        <div className="banner-art"><i /><i /><i /><span>{eventInitials(selectedEvent.name)}</span></div>
      </div>

      {error ? (
        <ErrorState
          message={error instanceof Error ? error.message : "Unable to load the dashboard. Please try again."}
          onRetry={reload}
        />
      ) : (
        <>
          <div className="stat-grid">
            <StatCard
              label="Total budget"
              value={data ? formatMoney(data.budget.eventBudget) : selectedEvent.total_budget}
              detail={data ? `${formatMoney(data.budget.committedTotal)} committed · ${formatMoney(data.budget.paidTotal)} paid` : loadingText || "Event budget"}
              icon="wallet"
              onClick={() => go("budget")}
            />
            <StatCard
              label="Guest responses"
              value={guests ? `${guests.rsvp.ACCEPTED} / ${guests.expectedHeadcount}` : "--"}
              detail={guests
                ? `People accepted · ${plural(guests.records, "guest")} + ${plural(guests.plusOnes, "plus-one")}`
                : loadingText || "Guest information unavailable"}
              icon="users"
              tone="coral"
              onClick={() => go("guests")}
            />
            <StatCard
              label="Tasks complete"
              value={data ? `${data.tasks.percentComplete}%` : "--"}
              detail={data ? `${data.tasks.completed} of ${plural(data.tasks.total, "task")}${data.tasks.overdue ? ` · ${data.tasks.overdue} overdue` : ""}` : loadingText || "Task information unavailable"}
              icon="check"
              tone="mint"
              onClick={() => go("tasks")}
            />
            <StatCard
              label="Upcoming payments"
              value={dueTotal}
              detail={data ? `${plural(data.payments.upcomingCount, "payment")} in ${data.payments.windowDays} days · ${data.payments.overdueCount} overdue` : loadingText || "Payment information unavailable"}
              icon="receipt"
              tone="gold"
              onClick={() => go("expenses")}
            />
          </div>
          <div className="dashboard-columns">
            <Card>
              <div className="card-head"><div><h3>Budget snapshot</h3>
                <p>{data ? `${formatMoney(data.budget.remainingBudget)} left of ${formatMoney(data.budget.eventBudget)}` : loadingText}</p></div>
                <button className="text-link" onClick={() => go("budget")}>View budget <Icon name="arrow" size={14} /></button>
              </div>
              {data && <BudgetSnapshot budget={data.budget} />}
            </Card>
            <Card>
              <div className="card-head"><div><h3>Upcoming tasks</h3><p>{data ? "Open tasks, nearest due date first" : loadingText}</p></div>
                <button className="text-link" onClick={() => go("tasks")}>All tasks <Icon name="arrow" size={14} /></button>
              </div>
              {data && <UpcomingTasks tasks={data.tasks} />}
            </Card>
          </div>
          <Card>
            <div className="card-head"><div><h3>Payments due</h3>
              <p>{data ? `Overdue and due in the next ${data.payments.windowDays} days` : loadingText}</p></div>
              <button className="text-link" onClick={() => go("expenses")}>View expenses <Icon name="arrow" size={14} /></button>
            </div>
            {data && <UpcomingPayments payments={data.payments} />}
          </Card>
        </>
      )}
    </>
  );
}
