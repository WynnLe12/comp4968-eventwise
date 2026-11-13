import type { ReactNode } from "react";
import { pageTitles } from "../routes/navigation";
import type { Page } from "../types";
import { Card, Icon } from "./ui";

export function PageHeader({ page, action }: { page: Page; action?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1>{pageTitles[page][0]}</h1>
        <p>{pageTitles[page][1]}</p>
      </div>
      {action}
    </div>
  );
}

export function StatCard({
  label,
  value,
  detail,
  icon,
  tone = "purple",
  selected,
  onClick,
}: {
  label: string;
  value: string;
  detail: string;
  icon: string;
  tone?: string;
  selected?: boolean;
  onClick?: () => void;
}) {
  return (
    <Card className={selected ? "stat-card stat-card-selected" : "stat-card"}>
      <div className={`stat-icon ${tone}`}>
        <Icon name={icon} />
      </div>
      <div className="stat-top">
        <span>{label}</span>
        <button onClick={onClick} aria-label={`Open ${label}`} aria-pressed={selected}>
          <Icon name="chevron" size={15} />
        </button>
      </div>
      <strong>{value}</strong>
      <small>{detail}</small>
    </Card>
  );
}

export function LoadingState({ label = "Loading your event..." }: { label?: string }) {
  return (
    <div className="state-card" role="status">
      <span className="state-spinner" />
      <h2>{label}</h2>
      <p>Just a moment while EventWise gets things ready.</p>
    </div>
  );
}

export function EmptyState({
  title,
  message,
  action,
}: {
  title: string;
  message: string;
  action?: ReactNode;
}) {
  return (
    <div className="state-card">
      <div className="state-icon">
        <Icon name="spark" />
      </div>
      <h2>{title}</h2>
      <p>{message}</p>
      {action}
    </div>
  );
}
