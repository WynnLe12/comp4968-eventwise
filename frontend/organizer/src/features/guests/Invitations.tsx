import { useState } from "react";
import { Button, Card, Field } from "../../components/ui";
import { PageHeader } from "../../components/page";

export function Invitations() {
  const [preview, setPreview] = useState(false);
  return (
    <>
      <PageHeader
        page="invitations"
        action={
          <Button variant="secondary" onClick={() => setPreview(!preview)} icon="eye">
            {preview ? "Edit invitation" : "Preview RSVP form"}
          </Button>
        }
      />
      {preview ? (
        <div className="rsvp-page">
          <div className="rsvp-flower one" />
          <div className="rsvp-flower two" />
          <div className="rsvp-invite">
            <small>TOGETHER WITH THEIR FAMILIES</small>
            <h2>
              Maya <i>&</i> Eli
            </h2>
            <p>joyfully invite you to celebrate their wedding</p>
            <strong>September 20, 2025</strong>
            <span>The Willow House · Portland, Oregon</span>
            <div className="rsvp-form">
              <h3>Will you be joining us?</h3>
              <div className="rsvp-options">
                <button>Joyfully accepts</button>
                <button>Regretfully declines</button>
              </div>
              <Field label="Your full name" placeholder="Start typing your name" />
              <Button>Continue</Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="invite-builder">
          <Card className="invite-preview">
            <div className="paper-invite">
              <small>TOGETHER WITH THEIR FAMILIES</small>
              <h2>
                Maya <i>&</i> Eli
              </h2>
              <p>joyfully invite you to celebrate their wedding</p>
              <strong>SEPTEMBER 20, 2025</strong>
              <span>The Willow House · Portland, Oregon</span>
              <button>RSVP</button>
            </div>
          </Card>
          <Card className="invite-settings">
            <h3>Invitation details</h3>
            <Field label="Event title" defaultValue="Maya & Eli’s Wedding" />
            <Field label="RSVP deadline" type="date" defaultValue="2025-08-15" />
            <label className="field">
              <span>Welcome message</span>
              <textarea defaultValue="We can’t wait to celebrate with you! Please respond by August 15." />
            </label>
            <label className="settings-toggle">
              <div>
                <b>Allow plus-ones</b>
                <span>Only for guests marked as eligible</span>
              </div>
              <input type="checkbox" defaultChecked />
            </label>
            <label className="settings-toggle">
              <div>
                <b>Collect meal choices</b>
                <span>Ask each attending guest</span>
              </div>
              <input type="checkbox" defaultChecked />
            </label>
            <Button>Save invitation</Button>
            <Button variant="secondary" icon="link">
              Copy RSVP link
            </Button>
          </Card>
        </div>
      )}
    </>
  );
}
