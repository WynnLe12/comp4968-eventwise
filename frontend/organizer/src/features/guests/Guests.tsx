import { useState } from "react";
import { Badge, Button, Card, Icon } from "../../components/ui";
import { EmptyState, PageHeader } from "../../components/page";
import { guestsSeed } from "../../data/mockData";

function rsvpTone(rsvp: string) {
  if (rsvp === "Attending") return "success";
  if (rsvp === "Declined") return "danger";
  return "neutral";
}

const initials = (name: string) =>
  name
    .split(" ")
    .map((x) => x[0])
    .slice(0, 2)
    .join("");

export function Guests({ onAdd }: { onAdd: () => void }) {
  const [query, setQuery] = useState("");
  const guests = guestsSeed;

  if (!guests.length)
    return (
      <>
        <PageHeader page="guests" />
        <EmptyState
          title="Your guest list is ready to grow"
          message="Add guests one by one or import a list to begin collecting RSVPs."
          action={
            <Button onClick={onAdd} icon="plus">
              Add guest
            </Button>
          }
        />
      </>
    );

  const filtered = guests.filter((x) => x.name.toLowerCase().includes(query.toLowerCase()));
  return (
    <>
      <PageHeader
        page="guests"
        action={
          <>
            <Button variant="secondary" icon="upload">
              Import guests
            </Button>
            <Button onClick={onAdd} icon="plus">
              Add guest
            </Button>
          </>
        }
      />
      <div className="guest-summary">
        <div>
          <div className="guest-ring">
            <strong>86</strong>
            <span>responses</span>
          </div>
        </div>
        <div>
          <b>72</b>
          <span>Attending</span>
          <i className="green" />
        </div>
        <div>
          <b>14</b>
          <span>Declined</span>
          <i className="coral" />
        </div>
        <div>
          <b>34</b>
          <span>Awaiting</span>
          <i className="gray" />
        </div>
        <div>
          <b>120</b>
          <span>Total invited</span>
        </div>
      </div>
      <Card>
        <div className="table-toolbar">
          <div className="search-input">
            <Icon name="search" />
            <input
              placeholder="Search guests..."
              aria-label="Search guests"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="toolbar-actions">
            <button className="filter-btn">
              All groups <Icon name="down" size={14} />
            </button>
            <button className="filter-btn">
              RSVP status <Icon name="down" size={14} />
            </button>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>
                  <input type="checkbox" aria-label="Select all guests" />
                </th>
                <th>Guest / Household</th>
                <th>Group</th>
                <th>Party size</th>
                <th>RSVP</th>
                <th>Meal choice</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((g) => (
                <tr key={g.name}>
                  <td>
                    <input type="checkbox" aria-label={`Select ${g.name}`} />
                  </td>
                  <td>
                    <div className="guest-name">
                      <span>{initials(g.name)}</span>
                      <b>
                        {g.name}
                        {g.name === "Sofia Martinez" && <small> + plus-one</small>}
                      </b>
                    </div>
                  </td>
                  <td>{g.group}</td>
                  <td>{g.party}</td>
                  <td>
                    <Badge tone={rsvpTone(g.rsvp)}>{g.rsvp}</Badge>
                  </td>
                  <td>{g.meal}</td>
                  <td>
                    <button className="icon-btn" aria-label="More options">
                      <Icon name="more" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="pagination">
          <span>{filtered.length} households · 120 total guests</span>
          <Button variant="ghost" icon="download">
            Export CSV
          </Button>
        </div>
      </Card>
    </>
  );
}
