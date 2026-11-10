import { Badge, Button, Card, Icon } from "../../components/ui";
import { PageHeader } from "../../components/page";

const vendors = [
  { initials: "WH", name: "The Willow House", category: "Venue & Catering", contract: "$12,800", balance: "$7,800", due: "Jun 15", tone: "purple" },
  { initials: "LP", name: "Lumen Photography", category: "Photo & Video", contract: "$4,200", balance: "$2,100", due: "Aug 01", tone: "coral" },
  { initials: "FF", name: "Fleur & Fern", category: "Flowers & Decor", contract: "$2,850", balance: "$2,000", due: "Aug 20", tone: "pink" },
  { initials: "BN", name: "Blue Note Collective", category: "Music & Entertainment", contract: "$1,800", balance: "$1,800", due: "Jul 10", tone: "blue" },
  { initials: "PS", name: "Paperfolk Studio", category: "Stationery", contract: "$640", balance: "$0", due: "Paid", tone: "gold" },
];

const summary = [
  { value: 5, label: "Booked vendors" },
  { value: 8, label: "Quotes received" },
  { value: 4, label: "Signed contracts" },
  { value: 3, label: "Upcoming payments", warning: true },
];

export function Vendors({ onAdd }: { onAdd: () => void }) {
  return (
    <>
      <PageHeader
        page="vendors"
        action={
          <Button onClick={onAdd} icon="plus">
            Add vendor
          </Button>
        }
      />
      <div className="summary-strip">
        {summary.map((s) => (
          <div className={s.warning ? "warning" : undefined} key={s.label}>
            <b>{s.value}</b>
            <span>{s.label}</span>
          </div>
        ))}
      </div>
      <div className="vendor-grid">
        {vendors.map((v) => (
          <Card className="vendor-card" key={v.name}>
            <div className="vendor-top">
              <div className={`vendor-avatar ${v.tone}`}>{v.initials}</div>
              <button className="icon-btn" aria-label="More options">
                <Icon name="more" />
              </button>
            </div>
            <h3>{v.name}</h3>
            <Badge>{v.category}</Badge>
            <div className="vendor-contact">
              <span>
                <Icon name="mail" size={15} />
                hello@{v.name.toLowerCase().split(" ").join("")}.com
              </span>
              <span>
                <Icon name="file" size={15} />
                Contract signed
              </span>
            </div>
            <div className="vendor-amounts">
              <div>
                <small>Contract</small>
                <b>{v.contract}</b>
              </div>
              <div>
                <small>Balance</small>
                <b>{v.balance}</b>
              </div>
            </div>
            <div className="vendor-due">
              <span>Next due</span>
              <b>{v.due}</b>
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}
