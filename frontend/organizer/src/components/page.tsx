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
  onClick,
}: {
  label: string;
  value: string;
  detail: string;
  icon: string;
  tone?: string;
  onClick?: () => void;
}) {
  return (
    <Card className="stat-card">
      <div className={`stat-icon ${tone}`}>
        <Icon name={icon} />
      </div>
      <div className="stat-top">
        <span>{label}</span>
        <button onClick={onClick} aria-label={`Open ${label}`}>
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
  icon = "spark",
}: {
  title: string;
  message: string;
  action?: ReactNode;
  icon?: string;
}) {
  return (
    <div className="state-card">
      <div className="state-icon">
        <Icon name={icon} />
      </div>
      <h2>{title}</h2>
      <p>{message}</p>
      {action}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="state-card state-error" role="alert">
      <div className="state-icon">
        <Icon name="bell" />
      </div>
      <h2>We hit a little snag</h2>
      <p>{message}</p>
      <button className="btn btn-primary" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}
