import { useState } from "react";
import { Badge, Button, Card, Icon } from "../../components/ui";
import { PageHeader } from "../../components/page";

const tasks = [
  { title: "Book ceremony musicians", tag: "Vendors", due: "Jun 02", owner: "EC" },
  { title: "Finalize venue contract", tag: "Venue", due: "Completed", owner: "MB" },
  { title: "Send invitation reminder", tag: "Guests", due: "Jun 05", owner: "MB" },
  { title: "Confirm floral mockup", tag: "Decor", due: "Jun 08", owner: "EC" },
  { title: "Create wedding website", tag: "Invitations", due: "Completed", owner: "MB" },
  { title: "Choose signature cocktails", tag: "Catering", due: "Jun 12", owner: "MB" },
];

export function Tasks() {
  const [done, setDone] = useState<number[]>([1, 4]);
  const toggle = (i: number) =>
    setDone(done.includes(i) ? done.filter((x) => x !== i) : [...done, i]);

  return (
    <>
      <PageHeader page="tasks" action={<Button icon="plus">Add task</Button>} />
      <div className="task-progress-card">
        <div>
          <strong>24 of 36</strong>
          <span>tasks complete</span>
        </div>
        <div className="wide-progress">
          <i style={{ width: "67%" }} />
        </div>
        <b>67%</b>
        <span>Great momentum. Four tasks are due this week.</span>
      </div>
      <Card>
        <div className="table-toolbar">
          <div className="tabs">
            <button className="active">All tasks</button>
            <button>To do</button>
            <button>Completed</button>
          </div>
          <div className="toolbar-actions">
            <button className="filter-btn">
              All assignees <Icon name="down" size={14} />
            </button>
            <Button variant="ghost" icon="more">
              Sort
            </Button>
          </div>
        </div>
        <div className="checklist">
          {tasks.map((t, i) => (
            <div className={`checklist-row ${done.includes(i) ? "done" : ""}`} key={t.title}>
              <button
                className="task-check"
                onClick={() => toggle(i)}
                aria-label={`Mark ${t.title} ${done.includes(i) ? "incomplete" : "complete"}`}
              >
                {done.includes(i) && "✓"}
              </button>
              <div>
                <b>{t.title}</b>
                <Badge>{t.tag}</Badge>
              </div>
              <span className="assignee">{t.owner}</span>
              <span>{t.due}</span>
              <button className="icon-btn" aria-label="More options">
                <Icon name="more" />
              </button>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
