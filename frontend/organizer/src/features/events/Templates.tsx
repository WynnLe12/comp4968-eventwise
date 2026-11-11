import { useEffect, useState } from "react";
import { Badge, Button, Card, Icon, Modal } from "../../components/ui";
import { EmptyState, LoadingState, PageHeader } from "../../components/page";
import { getEventTemplate, listEventTemplates } from "../../services/eventTemplates";
import type { EventTemplateDetails } from "../../types/eventTemplates";

// Presentation only: all template names, IDs and budget data come from the API.
const artwork: Record<string, { art: string; label: string }> = {
  wedding: { art: "wedding", label: "I DO" },
  baby_shower: { art: "baby", label: "OH BABY" },
  birthday: { art: "birthday", label: "PARTY" },
  corporate: { art: "corporate", label: "TEAM" },
  other: { art: "corporate", label: "YOUR EVENT" },
};

function LoadError({ retry }: { retry: () => void }) {
  return (
    <div role="alert">
      <EmptyState title="Couldn't load templates" message="Please try again."
        action={<Button onClick={retry}>Retry</Button>} />
    </div>
  );
}

function TemplateDetails({ id, onClose }: { id: string; onClose: () => void }) {
  const [template, setTemplate] = useState<EventTemplateDetails | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setTemplate(null);
    setError(false);
    getEventTemplate(id, controller.signal).then(result => {
      if (!controller.signal.aborted) setTemplate(result);
    }).catch(() => {
      if (!controller.signal.aborted) setError(true);
    });
    return () => controller.abort();
  }, [id, attempt]);

  return (
    <Modal title={template ? `${template.name} budget defaults` : "Template details"} onClose={onClose}
      footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      {error ? <LoadError retry={() => setAttempt(value => value + 1)} />
        : !template ? <LoadingState label="Loading template..." /> : (
          <>
            {template.categories.length === 0 ? (
              <EmptyState title="No budget defaults yet" message="Categories for this template are not available yet." />
            ) : (
              <div className="table-wrap">
                <table className="template-category-table">
                  <thead><tr><th scope="col">Category</th><th scope="col">Allocation</th></tr></thead>
                  <tbody>{template.categories.map(category => (
                    <tr key={category.templateCategoryId}>
                      <td>{category.name}</td><td>{Number(category.defaultPercentage)}%</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </>
        )}
    </Modal>
  );
}

export function Templates() {
  const [templates, setTemplates] = useState<EventTemplateDetails[] | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setTemplates(null);
    setError(false);
    listEventTemplates(controller.signal)
      .then(templates => Promise.all(templates.map(template => getEventTemplate(template.templateId, controller.signal))))
      .then(result => {
      if (!controller.signal.aborted) setTemplates(result);
    }).catch(() => {
      if (!controller.signal.aborted) setError(true);
    });
    return () => controller.abort();
  }, [attempt]);

  return (
    <>
      <PageHeader page="templates" />
      <div className="template-intro">
        <div><Icon name="spark" size={22} /></div>
        <p><b>Find a starting point for your event.</b><br />Browse event types and their default budget allocations.</p>
      </div>
      {error ? <LoadError retry={() => setAttempt(value => value + 1)} />
        : templates === null ? <LoadingState label="Loading templates..." />
        : templates.length === 0 ? (
          <EmptyState title="No templates available" message="Please check back later." />
        ) : (
          <div className="template-grid">
            {templates.map(template => {
              const art = artwork[template.templateKey] ?? artwork.other;
              return (
                <Card className="template-card" key={template.templateId}>
                  <div className={`template-art ${art.art}`}><span>{art.label}</span><Badge>{template.name}</Badge></div>
                  <div className="template-content">
                    <h3>{template.name}</h3>
                    <div className="template-details">
                      <small>DEFAULT BUDGET</small>
                      <span>{template.categories.length > 0
                        ? template.categories.map(category => `${Number(category.defaultPercentage)}% ${category.name}`).join(" · ")
                        : "No budget defaults yet"}</span>
                    </div>
                    <Button variant="secondary" onClick={() => setSelectedId(template.templateId)}>View budget defaults</Button>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      {selectedId && <TemplateDetails key={selectedId} id={selectedId} onClose={() => setSelectedId(null)} />}
    </>
  );
}
