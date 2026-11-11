import { Button, Card, Icon } from "../../components/ui";
import { PageHeader } from "../../components/page";

const alerts = [
  {
    title: "Payment due in 7 days",
    body: "Your $2,100 payment to Lumen Photography is due June 2.",
    date: "May 26",
    icon: "receipt",
    tone: "warning",
    action: "View expense",
    unread: true,
  },
  {
    title: "Flowers & Decor is over budget",
    body: "Current expenses are $350 above your category allocation.",
    date: "May 24",
    icon: "wallet",
    tone: "danger",
    action: "Review budget",
    unread: true,
  },
  {
    title: "12 guests haven’t responded",
    body: "Your RSVP deadline is 3 weeks away. Send a friendly reminder.",
    date: "May 22",
    icon: "users",
    tone: "purple",
    action: "Send reminder",
    unread: true,
  },
  {
    title: "Contract date detected",
    body: "We found a final payment date in your Blue Note Collective contract.",
    date: "May 19",
    icon: "scan",
    tone: "mint",
    action: "Review contract",
    unread: false,
  },
];

const alertSettings = [
  { label: "Payment due dates", on: true },
  { label: "Budget overspending", on: true },
  { label: "Guest RSVP updates", on: true },
  { label: "Task deadlines", on: true },
  { label: "Contract dates", on: false },
];

export function Alerts() {
  return (
    <>
      <PageHeader page="alerts" action={<Button variant="ghost">Mark all as read</Button>} />
      <div className="alert-layout">
        <div className="alert-list">
          {alerts.map((a) => (
            <Card className={`alert-item ${a.unread ? "unread" : ""}`} key={a.title}>
              <div className={`stat-icon ${a.tone}`}>
                <Icon name={a.icon} />
              </div>
              <div>
                <div>
                  <h3>{a.title}</h3>
                  <span>{a.date}</span>
                </div>
                <p>{a.body}</p>
                <button className="text-link">
                  {a.action} <Icon name="arrow" size={14} />
                </button>
              </div>
              <button className="icon-btn" aria-label="More options">
                <Icon name="more" />
              </button>
            </Card>
          ))}
        </div>
        <Card className="alert-settings">
          <h3>Alert settings</h3>
          <p>Choose what EventWise keeps an eye on.</p>
          {alertSettings.map((s) => (
            <label className="settings-toggle" key={s.label}>
              <span>{s.label}</span>
              <input type="checkbox" defaultChecked={s.on} />
            </label>
          ))}
        </Card>
      </div>
    </>
  );
}
