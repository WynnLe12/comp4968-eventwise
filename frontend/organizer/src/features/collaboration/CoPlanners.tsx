import { Button, Card, Icon } from "../../components/ui";
import { PageHeader } from "../../components/page";

const people = [
  { initials: "MB", name: "Maya Bennett", email: "maya@example.com", role: "Owner" },
  { initials: "EC", name: "Eli Carter", email: "eli@example.com", role: "Full access" },
  { initials: "JW", name: "Jessica Wu", email: "jessica@example.com", role: "Guest manager" },
];

const roles = ["Owner", "Full access", "Guest manager", "View only"];

export function CoPlanners() {
  return (
    <>
      <PageHeader page="coplanners" action={<Button icon="userplus">Invite co-planner</Button>} />
      <Card>
        <div className="card-head">
          <div>
            <h3>Planning team</h3>
            <p>3 people have access to this event</p>
          </div>
        </div>
        <div className="people-list">
          {people.map((p, i) => (
            <div className="person-row" key={p.name}>
              <span>{p.initials}</span>
              <div>
                <b>
                  {p.name} {i === 0 && <small>You</small>}
                </b>
                <p>{p.email}</p>
              </div>
              <select defaultValue={p.role} disabled={i === 0} aria-label={`${p.name} role`}>
                {roles.map((role) => (
                  <option key={role}>{role}</option>
                ))}
              </select>
              {i > 0 ? (
                <button className="icon-btn danger" aria-label={`Remove ${p.name}`}>
                  <Icon name="trash" />
                </button>
              ) : (
                <i />
              )}
            </div>
          ))}
        </div>
      </Card>
      <Card className="permissions-card">
        <div className="stat-icon purple">
          <Icon name="userplus" />
        </div>
        <div>
          <h3>Role permissions</h3>
          <p>
            Full access can manage everything except billing and deleting the event. Guest managers
            can only view and edit guests, invitations, and RSVPs.
          </p>
        </div>
        <Button variant="secondary">View permissions</Button>
      </Card>
    </>
  );
}
