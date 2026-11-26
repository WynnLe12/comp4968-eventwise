import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "../../components/page";
import { Badge, Button, Card, Icon, Modal } from "../../components/ui";
import { useResource } from "../../hooks/useResource";
import {
  createTask,
  deleteTask,
  generateTasksFromTemplate,
  listTasks,
  setTaskCompleted,
  TaskServiceError,
  TaskValidationError,
  updateTask,
} from "../../services/taskService";
import type { Task, TaskList } from "../../types";
import { formatCalendarDate } from "../../utils/dateFormat";
import { listEventMembers, type EventMember } from "../collaboration/collaborationApi";
import { useEvents } from "../events/EventsContext";
import { TaskForm, type AssigneeOption, type TaskFormSubmitError } from "./TaskForm";
import {
  changedFields,
  filterTasks,
  initials,
  inputOf,
  isDueThisWeek,
  isOverdue,
  localToday,
  progressOf,
  replaceTask,
  type AssigneeFilter,
  type TaskDraft,
  type TaskTab,
} from "./taskRules";
import "./tasks.css";

type ToastTone = "success" | "error";
type Toast = (message: string, tone?: ToastTone) => void;

const TASK_FORM_ID = "task-form";
const TABS: { id: TaskTab; label: string }[] = [
  { id: "all", label: "All tasks" },
  { id: "open", label: "To do" },
  { id: "done", label: "Completed" },
];

function errorMessage(reason: unknown, fallback: string) {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

const isNotFound = (reason: unknown) => reason instanceof TaskServiceError && reason.status === 404;

/** Per-browser memory of "don't suggest the checklist for this event again". Storage can be blocked, so it fails quietly. */
const suggestionKey = (eventId: string) => `eventwise.tasks.suggestionDismissed.${eventId}`;

function readSuggestionDismissed(eventId: string | null): boolean {
  if (!eventId) return false;
  try {
    return window.localStorage.getItem(suggestionKey(eventId)) === "1";
  } catch {
    return false;
  }
}

function saveSuggestionDismissed(eventId: string) {
  try {
    window.localStorage.setItem(suggestionKey(eventId), "1");
  } catch {
    // Not saved, so the hint comes back on the next visit. That's acceptable.
  }
}

function memberLabel(m: EventMember): string {
  const name = m.displayName ?? (m.role === "OWNER" ? "Event owner" : "Co-planner");
  return m.is_self ? `${name} (you)` : name;
}

function momentum(open: number, dueThisWeek: number, overdue: number): string {
  if (open === 0) return "Everything is done. Nice work.";
  const parts = [];
  if (overdue) parts.push(`${overdue} overdue`);
  parts.push(dueThisWeek === 1 ? "1 task due this week" : `${dueThisWeek} tasks due this week`);
  return `${parts.join(" · ")}.`;
}

/** Edit / Complete or Reopen / Delete. Closes on Escape and outside clicks. */
function TaskMenu({
  task, canDelete, onEdit, onToggle, onDelete,
}: {
  task: Task;
  canDelete: boolean;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", outside);
    wrapRef.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
    return () => document.removeEventListener("mousedown", outside);
  }, [open]);

  const choose = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  return (
    <div
      className="task-menu-wrap"
      ref={wrapRef}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
          triggerRef.current?.focus();
        }
      }}
    >
      <button
        ref={triggerRef}
        className={`icon-btn${open ? " open" : ""}`}
        aria-label={`More options for ${task.title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="more" />
      </button>
      {open && (
        <div className="task-menu" role="menu">
          <button role="menuitem" onClick={choose(onEdit)}><Icon name="edit" size={15} /> Edit</button>
          <button role="menuitem" onClick={choose(onToggle)}>
            <Icon name="check" size={15} /> {task.isCompleted ? "Reopen" : "Mark complete"}
          </button>
          {canDelete && (
            <button role="menuitem" className="danger" onClick={choose(onDelete)}>
              <Icon name="trash" size={15} /> Delete
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function Tasks({ onToast = () => {} }: { onToast?: Toast }) {
  const { selectedEvent, userId } = useEvents();
  // Remount per account and event so no state leaks from one event to the next.
  return <EventTasks key={JSON.stringify([userId, selectedEvent?.event_id ?? null])} onToast={onToast} />;
}

function EventTasks({ onToast }: { onToast: Toast }) {
  const { selectedEvent, userId, status: eventsStatus } = useEvents();
  const eventId = selectedEvent?.event_id ?? null;
  const isOwner = selectedEvent?.role === "OWNER";
  const hasTemplate = Boolean(selectedEvent?.template_id);

  const loadTasks = useCallback(
    () => (eventId ? listTasks(eventId) : Promise.resolve<TaskList>({ tasks: [], progress: progressOf([]) })),
    [eventId],
  );
  const { data, loading, error, reload, update } = useResource(loadTasks);
  const tasks = useMemo(() => data?.tasks ?? [], [data]);

  // The assignee list and filter. If it fails, tasks still work, just without names to pick.
  const loadMembers = useCallback(
    () => (eventId && userId ? listEventMembers(eventId, userId) : Promise.resolve<EventMember[]>([])),
    [eventId, userId],
  );
  const { data: members } = useResource(loadMembers);
  const assignees: AssigneeOption[] = useMemo(
    () => (members ?? []).map((m) => ({ memberId: m.member_id, label: memberLabel(m) })),
    [members],
  );
  const myMemberId = members?.find((m) => m.is_self)?.member_id ?? null;
  const ownerMemberId = members?.find((m) => m.role === "OWNER")?.member_id ?? null;

  const [tab, setTab] = useState<TaskTab>("all");
  const [assigneeFilter, setAssigneeFilter] = useState<AssigneeFilter>("all");
  /** undefined = closed, null = adding, Task = editing. */
  const [editing, setEditing] = useState<Task | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<Task | null>(null);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState<ReadonlySet<string>>(new Set());
  const [generating, setGenerating] = useState(false);
  const [suggestionDismissed, setSuggestionDismissed] = useState(() => readSuggestionDismissed(eventId));

  // Once any suggested task is on the list, the checklist has been used, so stop offering it.
  const usedTemplate = useMemo(() => tasks.some((t) => t.source === "TEMPLATE"), [tasks]);
  const showSuggestionHint = hasTemplate && tasks.length > 0 && !usedTemplate && !suggestionDismissed;

  const today = localToday();
  const progress = useMemo(() => progressOf(tasks), [tasks]);
  const dueThisWeek = useMemo(() => tasks.filter((t) => isDueThisWeek(t, today)).length, [tasks, today]);
  const overdue = useMemo(() => tasks.filter((t) => isOverdue(t, today)).length, [tasks, today]);
  const visible = useMemo(
    () => filterTasks(tasks, tab, assigneeFilter, myMemberId),
    [tasks, tab, assigneeFilter, myMemberId],
  );

  // ---- List updates ------------------------------------------------------

  const setTasks = (change: (current: Task[]) => Task[]) =>
    update((current) => {
      const next = change(current.tasks);
      return { tasks: next, progress: progressOf(next) };
    });
  const put = (task: Task) => setTasks((current) => replaceTask(current, task));
  const drop = (taskId: string) => setTasks((current) => current.filter((t) => t.id !== taskId));

  // ---- Actions -----------------------------------------------------------

  const toggle = async (task: Task) => {
    if (!eventId || toggling.has(task.id)) return;
    const done = !task.isCompleted;
    setToggling((s) => new Set(s).add(task.id));
    put({ ...task, isCompleted: done, completedAt: done ? task.completedAt : null }); // optimistic
    try {
      put(await setTaskCompleted(eventId, task.id, done));
    } catch (reason) {
      if (isNotFound(reason)) drop(task.id);
      else put(task); // put the checkbox back
      onToast(errorMessage(reason, "We couldn't update that task."), "error");
    } finally {
      setToggling((s) => {
        const next = new Set(s);
        next.delete(task.id);
        return next;
      });
    }
  };

  const save = async (draft: TaskDraft): Promise<TaskFormSubmitError | null> => {
    if (!eventId) return { message: "Select an event first." };
    const target = editing;
    setSaving(true);
    try {
      if (target) {
        const changes = changedFields(target, draft);
        if (Object.keys(changes).length) put(await updateTask(eventId, target.id, changes));
        onToast("Task updated");
      } else {
        put(await createTask(eventId, inputOf(draft)));
        onToast("Task added");
      }
      setEditing(undefined);
      return null;
    } catch (reason) {
      if (reason instanceof TaskValidationError) return { message: reason.message, fields: reason.fields };
      if (target && isNotFound(reason)) {
        drop(target.id);
        setEditing(undefined);
        onToast("This task was deleted by someone else.", "error");
        return null;
      }
      return { message: errorMessage(reason, "We couldn't save this task.") };
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!eventId || !deleting) return;
    const target = deleting;
    setSaving(true);
    try {
      await deleteTask(eventId, target.id);
      drop(target.id);
      onToast("Task deleted");
    } catch (reason) {
      if (isNotFound(reason)) drop(target.id);
      else onToast(errorMessage(reason, "We couldn't delete this task."), "error");
    } finally {
      setSaving(false);
      setDeleting(null);
    }
  };

  const generate = async () => {
    if (!eventId) return;
    setGenerating(true);
    try {
      const result = await generateTasksFromTemplate(eventId);
      update(() => ({ tasks: result.tasks, progress: progressOf(result.tasks) }));
      if (result.created) {
        onToast(result.created === 1 ? "Added 1 suggested task" : `Added ${result.created} suggested tasks`);
      } else if (result.tasks.some((t) => t.source === "TEMPLATE")) {
        onToast("The suggested checklist is already added");
      } else {
        // The template has no checklist items, so there is nothing to keep suggesting.
        setSuggestionDismissed(true);
        onToast("There's no suggested checklist for this type of event yet.");
      }
    } catch (reason) {
      onToast(errorMessage(reason, "We couldn't add the suggested checklist."), "error");
    } finally {
      setGenerating(false);
    }
  };

  // ---- Pieces ------------------------------------------------------------

  const addButton = <Button icon="plus" onClick={() => setEditing(null)}>Add task</Button>;

  const dismissSuggestion = () => {
    setSuggestionDismissed(true);
    if (eventId) saveSuggestionDismissed(eventId);
  };

  const formModal = editing !== undefined && (
    <Modal
      title={editing ? "Edit task" : "Add a task"}
      onClose={() => setEditing(undefined)}
      footer={
        <>
          <Button variant="secondary" onClick={() => setEditing(undefined)}>Cancel</Button>
          <Button type="submit" form={TASK_FORM_ID} disabled={saving}>
            {saving ? "Saving..." : editing ? "Save changes" : "Save task"}
          </Button>
        </>
      }
    >
      <TaskForm key={editing?.id ?? "new"} formId={TASK_FORM_ID} task={editing} assignees={assignees} defaultAssigneeId={ownerMemberId} onSubmit={save} />
    </Modal>
  );

  const deleteModal = deleting && (
    <Modal
      title="Delete this task?"
      onClose={() => setDeleting(null)}
      footer={
        <>
          <Button variant="secondary" onClick={() => setDeleting(null)}>Cancel</Button>
          <Button variant="danger" onClick={confirmDelete} disabled={saving}>
            {saving ? "Deleting..." : "Delete task"}
          </Button>
        </>
      }
    >
      <p>"{deleting.title}" will be removed for everyone on the planning team. This can't be undone.</p>
    </Modal>
  );

  const suggestionHint = showSuggestionHint && (
    <div className="task-suggestion">
      <Icon name="check" size={16} />
      <p>There's a suggested checklist for this type of event. Add it to fill in the usual planning tasks.</p>
      <div className="task-suggestion-actions">
        <Button variant="secondary" onClick={generate} disabled={generating}>
          {generating ? "Adding..." : "Add checklist"}
        </Button>
        <Button variant="ghost" onClick={dismissSuggestion} disabled={generating}>Dismiss</Button>
      </div>
    </div>
  );

  // ---- States ------------------------------------------------------------

  if (!eventId) {
    return (
      <>
        <PageHeader page="tasks" />
        {eventsStatus === "loading" ? (
          <LoadingState label="Loading your events..." />
        ) : (
          <EmptyState icon="calendar" title="Select an event" message="Choose an event in the sidebar to see its tasks." />
        )}
      </>
    );
  }

  if (loading) {
    return (
      <>
        <PageHeader page="tasks" />
        <LoadingState label="Loading tasks..." />
      </>
    );
  }

  if (error) {
    const forbidden = error instanceof TaskServiceError && error.status === 403;
    return (
      <>
        <PageHeader page="tasks" />
        {forbidden ? (
          <EmptyState
            icon="lock"
            title="You don't have access to this event"
            message="Ask the event owner to add you as a co-planner, or switch to another event."
          />
        ) : (
          <ErrorState message={errorMessage(error, "We couldn't load your tasks.")} onRetry={reload} />
        )}
      </>
    );
  }

  if (!tasks.length) {
    return (
      <>
        <PageHeader page="tasks" />
        <EmptyState
          icon="check"
          title="No tasks yet"
          message={hasTemplate
            ? "Start from the suggested checklist for this type of event, or add your own tasks."
            : "Add the first task to start a shared checklist for your planning team."}
          action={hasTemplate ? (
            // A blank list is where the suggestion helps most, so it leads and "Add task" steps back.
            <div className="task-empty-actions">
              <Button icon="check" onClick={generate} disabled={generating}>
                {generating ? "Adding..." : "Add the suggested checklist"}
              </Button>
              <Button variant="secondary" icon="plus" onClick={() => setEditing(null)}>Add my own task</Button>
            </div>
          ) : addButton}
        />
        {formModal}
      </>
    );
  }

  return (
    <>
      <PageHeader page="tasks" action={addButton} />
      <div className="task-progress-card">
        <div>
          <strong>{progress.completed} of {progress.total}</strong>
          <span>tasks complete</span>
        </div>
        <div
          className="wide-progress"
          role="progressbar"
          aria-label="Tasks complete"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress.percentComplete}
        >
          <i style={{ width: `${progress.percentComplete}%` }} />
        </div>
        <b>{progress.percentComplete}%</b>
        <span>{momentum(progress.open, dueThisWeek, overdue)}</span>
      </div>
      {suggestionHint}
      <Card>
        <div className="table-toolbar">
          <div className="tabs" role="tablist" aria-label="Filter tasks by status">
            {TABS.map((t) => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
          <div className="toolbar-actions">
            <label className="task-filter">
              <span className="sr-only">Assignee</span>
              <select value={assigneeFilter} onChange={(e) => setAssigneeFilter(e.target.value)}>
                <option value="all">All assignees</option>
                {myMemberId && <option value="me">Assigned to me</option>}
                <option value="none">Unassigned</option>
                {assignees.map((a) => <option key={a.memberId} value={a.memberId}>{a.label}</option>)}
              </select>
            </label>
          </div>
        </div>
        <div className="checklist">
          {visible.length === 0 && <p className="task-none">No tasks match these filters.</p>}
          {visible.map((t) => {
            const late = isOverdue(t, today);
            const name = t.assignee?.displayName ?? (t.assignee ? (t.assignee.role === "OWNER" ? "Event owner" : "Co-planner") : null);
            return (
              <div className={`checklist-row${t.isCompleted ? " done" : ""}`} key={t.id}>
                <button
                  className="task-check"
                  onClick={() => toggle(t)}
                  disabled={toggling.has(t.id)}
                  aria-pressed={t.isCompleted}
                  aria-label={`Mark ${t.title} ${t.isCompleted ? "incomplete" : "complete"}`}
                >
                  {t.isCompleted && "✓"}
                </button>
                <div
                  className="task-main"
                  role="button"
                  tabIndex={0}
                  title="Edit task"
                  aria-label={`Edit ${t.title}`}
                  onClick={() => setEditing(t)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setEditing(t);
                    }
                  }}
                >
                  <b>{t.title}</b>
                  {late && <Badge tone="danger">Overdue</Badge>}
                  {t.description && <small>{t.description}</small>}
                </div>
                <span className={`assignee${t.assignee ? "" : " none"}`} title={name ?? "Unassigned"} aria-label={name ? `Assigned to ${name}` : "Unassigned"}>
                  {t.assignee ? initials(name) : "–"}
                </span>
                <span className={late ? "task-due late" : "task-due"}>
                  {t.isCompleted ? "Completed" : formatCalendarDate(t.dueDate, "No due date")}
                </span>
                <TaskMenu
                  task={t}
                  canDelete={isOwner}
                  onEdit={() => setEditing(t)}
                  onToggle={() => toggle(t)}
                  onDelete={() => setDeleting(t)}
                />
              </div>
            );
          })}
        </div>
      </Card>
      {formModal}
      {deleteModal}
    </>
  );
}
