import { Button, Card, Icon } from "../../components/ui";
import { PageHeader, StatCard } from "../../components/page";
import { budgetDefaults } from "../../data/mockData";
import type { Page } from "../../types";

const weekTasks = [
  { title: "Finalize dinner menu", due: "May 28", owner: "MB", done: false },
  { title: "Confirm ceremony music", due: "Jun 02", owner: "EC", done: false },
  { title: "Send final guest reminder", due: "Jun 05", owner: "MB", done: false },
  { title: "Book rehearsal dinner", due: "Jun 08", owner: "MB", done: true },
];

const snapshotSpend = [12800, 4200, 2850, 1800];

const upcoming = [
  { month: "MAY", day: "28", title: "Menu tasting", detail: "The Willow House", tone: "coral" },
  { month: "JUN", day: "02", title: "Photographer payment", detail: "$2,100 due", tone: "purple" },
  { month: "JUN", day: "10", title: "Invitation deadline", detail: "Send final batch", tone: "mint" },
];

export function Dashboard({ go }: { go: (p: Page) => void }) {
  return (
    <>
      <PageHeader
        page="dashboard"
        action={
          <Button onClick={() => go("events")} icon="plus">
            Create event
          </Button>
        }
      />
      <div className="dashboard-banner">
        <div>
          <div className="eyebrow">YOUR BIG DAY</div>
          <h2>Maya & Eli’s Wedding</h2>
          <p>The Willow House · September 20, 2025</p>
          <div className="banner-meta">
            <span>
              <b>125</b> days to go
            </span>
            <span>
              <b>68%</b> planned
            </span>
          </div>
        </div>
        <div className="banner-art">
          <i />
          <i />
          <i />
          <span>
            M <small>&</small> E
          </span>
        </div>
      </div>
      <div className="stat-grid">
        <StatCard
          label="Total budget"
          value="$35,000"
          detail="$31,240 allocated"
          icon="wallet"
          onClick={() => go("budget")}
        />
        <StatCard
          label="Guest responses"
          value="86 / 120"
          detail="72% responded"
          icon="users"
          tone="coral"
          onClick={() => go("guests")}
        />
        <StatCard
          label="Tasks complete"
          value="24 / 36"
          detail="4 due this week"
          icon="check"
          tone="mint"
          onClick={() => go("tasks")}
        />
        <StatCard
          label="Upcoming payments"
          value="$4,950"
          detail="3 due in 30 days"
          icon="receipt"
          tone="gold"
          onClick={() => go("expenses")}
        />
      </div>
      <div className="dashboard-columns">
        <Card>
          <div className="card-head">
            <div>
              <h3>Budget snapshot</h3>
              <p>How your spending is tracking</p>
            </div>
            <button className="text-link" onClick={() => go("budget")}>
              View budget <Icon name="arrow" size={14} />
            </button>
          </div>
          <div className="budget-snapshot">
            <div className="big-donut">
              <div>
                <strong>$22.4k</strong>
                <span>spent</span>
              </div>
            </div>
            <div className="legend-list">
              {budgetDefaults.slice(0, 4).map((category, i) => (
                <div key={category.name}>
                  <i style={{ background: category.color }} />
                  <span>{category.name}</span>
                  <b>${snapshotSpend[i].toLocaleString()}</b>
                </div>
              ))}
            </div>
          </div>
        </Card>
        <Card>
          <div className="card-head">
            <div>
              <h3>Tasks this week</h3>
              <p>Small steps, big progress</p>
            </div>
            <button className="icon-btn" onClick={() => go("tasks")} aria-label="Go to tasks">
              <Icon name="plus" />
            </button>
          </div>
          <div className="task-list">
            {weekTasks.map((task) => (
              <div className={`task-row ${task.done ? "done" : ""}`} key={task.title}>
                <button>{task.done ? "✓" : ""}</button>
                <div>
                  <b>{task.title}</b>
                  <small>Due {task.due}</small>
                </div>
                <span>{task.owner}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
      <Card>
        <div className="card-head">
          <div>
            <h3>Next up</h3>
            <p>Payments and milestones coming your way</p>
          </div>
          <button className="text-link" onClick={() => go("timeline")}>
            Full timeline <Icon name="arrow" size={14} />
          </button>
        </div>
        <div className="upcoming-row">
          {upcoming.map((item) => (
            <div className="upcoming-item" key={item.title}>
              <div className={`date-box ${item.tone}`}>
                <small>{item.month}</small>
                <b>{item.day}</b>
              </div>
              <div>
                <b>{item.title}</b>
                <span>{item.detail}</span>
              </div>
              <Icon name="chevron" size={16} />
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
