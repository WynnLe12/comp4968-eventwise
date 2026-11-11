import { Badge, Button, Card, Icon } from "../../components/ui";
import { PageHeader } from "../../components/page";

const templates = [
  {
    name: "Wedding Essentials",
    description: "A balanced plan for a beautiful, full-service wedding.",
    type: "Wedding",
    budget: "42% venue · 14% photo · 12% decor",
    art: "wedding",
    label: "M&E",
  },
  {
    name: "Milestone Birthday",
    description: "A joyful celebration with room for food, music, and fun.",
    type: "Birthday",
    budget: "35% venue · 25% food · 15% entertainment",
    art: "birthday",
    label: "60",
  },
  {
    name: "Sweet Baby Shower",
    description: "A warm, welcoming plan for a memorable afternoon.",
    type: "Baby shower",
    budget: "30% venue · 28% food · 18% decor",
    art: "baby",
    label: "OH BABY",
  },
  {
    name: "Polished Corporate",
    description: "Professional planning for launches, retreats, and gatherings.",
    type: "Corporate",
    budget: "38% venue · 22% catering · 15% production",
    art: "corporate",
    label: "TEAM",
  },
];

export function Templates({ applyTemplate }: { applyTemplate: () => void }) {
  return (
    <>
      <PageHeader
        page="templates"
        action={
          <Button variant="secondary" icon="plus">
            Create template
          </Button>
        }
      />
      <div className="template-intro">
        <div>
          <Icon name="spark" size={22} />
        </div>
        <p>
          <b>Smart starting points, made flexible.</b>
          <br />
          Each template includes recommended budget percentages, a task checklist, and a sample
          timeline. You can edit everything after applying it.
        </p>
      </div>
      <div className="template-grid">
        {templates.map((t, i) => (
          <Card className="template-card" key={t.name}>
            <div className={`template-art ${t.art}`}>
              <span>{t.label}</span>
              <Badge>{t.type}</Badge>
            </div>
            <div className="template-content">
              <h3>{t.name}</h3>
              <p>{t.description}</p>
              <div className="template-details">
                <small>DEFAULT BUDGET</small>
                <span>{t.budget}</span>
              </div>
              <div className="template-meta">
                <span>
                  <Icon name="check" size={15} />
                  28 tasks
                </span>
                <span>
                  <Icon name="clock" size={15} />
                  12 milestones
                </span>
              </div>
              <Button variant={i === 0 ? "primary" : "secondary"} onClick={applyTemplate}>
                {i === 0 ? "Applied to this event" : "Use this template"}{" "}
                {i > 0 && <Icon name="arrow" size={15} />}
              </Button>
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}
